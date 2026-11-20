"""In-process Agent-Reach adapter for Sofia.

This bridge imports the vendored upstream package directly. It does not invoke
or require the separately installed agent-reach CLI.
"""
from __future__ import annotations

import json
import sys
from typing import Any

from agent_reach.channels import get_all_channels, get_channel
from agent_reach.runtime.dispatch import run_action


def _channels() -> dict[str, Any]:
    items = []
    for channel in get_all_channels():
        items.append({
            "name": channel.name,
            "description": channel.description,
            "level": channel.level,
            "actions": [
                {
                    "name": action.name,
                    "description": action.description,
                    "params": [
                        {
                            "name": param.name,
                            "description": param.description,
                            "required": param.required,
                            "type": getattr(param.type, "__name__", "string"),
                            "default": param.default,
                        }
                        for param in action.params
                    ],
                }
                for action in channel.actions
            ],
        })
    return {"ok": True, "channels": items}


def handle(request: dict[str, Any]) -> dict[str, Any]:
    operation = request.get("operation")
    if operation == "channels":
        return _channels()

    if operation == "read":
        target = request.get("url")
        if not isinstance(target, str) or not target:
            raise ValueError("url is required")
        readers = [ch for ch in get_all_channels() if any(a.name == "read" for a in ch.actions)]
        specific = [ch for ch in readers if ch.name != "web"]
        channel = next((ch for ch in specific if ch.can_handle(target)), None)
        channel = channel or next((ch for ch in readers if ch.name == "web"), None)
        if channel is None:
            raise ValueError("No installed channel can read this URL")
        return run_action(channel, "read", {"target": target})

    channel_name = request.get("channel")
    action_name = request.get("action")
    params = request.get("params", {})
    if not isinstance(channel_name, str) or not isinstance(action_name, str):
        raise ValueError("channel and action are required")
    if not isinstance(params, dict):
        raise ValueError("params must be an object")
    channel = get_channel(channel_name)
    if channel is None:
        raise ValueError("Unknown channel: " + channel_name)
    timeout = request.get("timeout", 30)
    if isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or timeout <= 0 or timeout > 1800:
        raise ValueError("timeout must be between 0 and 1800 seconds")
    return run_action(channel, action_name, params, timeout=float(timeout))


def main() -> int:
    try:
        if len(sys.argv) != 2 or sys.argv[1] != "--request-json":
            raise ValueError("Expected --request-json followed by a JSON request")
        raw = sys.stdin.read() if not sys.stdin.isatty() else ""
        if raw:
            request = json.loads(raw)
        else:
            raise ValueError("Request JSON must be supplied on stdin")
        if not isinstance(request, dict):
            raise ValueError("Request must be a JSON object")
        result = handle(request)
        print(json.dumps(result, ensure_ascii=False, default=str))
        return 0
    except Exception as exc:  # noqa: BLE001 - normalized bridge boundary
        print(json.dumps({"ok": False, "error": {"code": "BRIDGE_ERROR", "message": str(exc)[:500]}}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
