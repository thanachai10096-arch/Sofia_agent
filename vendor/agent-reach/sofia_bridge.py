"""In-process Agent-Reach adapter for Sofia; no external CLI is invoked."""
from __future__ import annotations
import base64
import json
import re
import sys
from typing import Any
from agent_reach.channels import get_all_channels, get_channel
from agent_reach.runtime.dispatch import run_action

# Agent-Reach action names vary by channel (for example create_post,
# send_message, or delete_comment). Match verb tokens, not only exact names.
MUTATING_ACTIONS = {
    "post", "publish", "comment", "like", "follow", "unfollow", "send", "dm",
    "delete", "upload", "create", "buy", "purchase", "write", "reply", "share",
    "retweet", "repost", "subscribe", "unsubscribe", "edit", "update", "remove",
    "star", "bookmark", "save", "connect", "invite", "accept", "decline",
    "transfer", "checkout", "order", "pay",
}


def is_mutating_action(name: str) -> bool:
    """Return True for mutating action names, including compound snake/kebab names."""
    tokens = set(re.findall(r"[a-z0-9]+", name.lower()))
    return bool(tokens & MUTATING_ACTIONS)


def _channels() -> dict[str, Any]:
    items = []
    for channel in get_all_channels():
        items.append({
            "name": channel.name,
            "description": channel.description,
            "level": channel.level,
            "actions": [
                {"name": action.name, "description": action.help,
                 "params": [{"name": p.name, "description": p.help,
                             "required": p.required, "type": getattr(p.type, "__name__", "string")}
                            for p in action.params]}
                for action in channel.actions if not is_mutating_action(action.name)
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
            raise ValueError("No channel can read this URL")
        return run_action(channel, "read", {"target": target})
    channel_name, action_name = request.get("channel"), request.get("action")
    params = request.get("params", {})
    if not isinstance(channel_name, str) or not isinstance(action_name, str):
        raise ValueError("channel and action are required")
    if not isinstance(params, dict):
        raise ValueError("params must be an object")
    if is_mutating_action(action_name):
        raise ValueError("This Agent-Reach action is not enabled in Sofia's read-only integration")
    channel = get_channel(channel_name)
    if channel is None:
        raise ValueError("Unknown channel: " + channel_name)
    timeout = request.get("timeout", 30)
    if isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or timeout <= 0 or timeout > 1800:
        raise ValueError("timeout must be between 0 and 1800 seconds")
    return run_action(channel, action_name, params, timeout=float(timeout))


def main() -> int:
    try:
        if len(sys.argv) != 3 or sys.argv[1] not in ("--request-json", "--request-base64"):
            raise ValueError("Expected --request-json or --request-base64 and a request")
        if sys.argv[1] == "--request-base64":
            raw_request = base64.b64decode(sys.argv[2], validate=True).decode("utf-8")
        else:
            raw_request = sys.argv[2]
        request = json.loads(raw_request)
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
