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


def _read_youtube(target: str, timeout: float) -> dict[str, Any]:
    """Read metadata plus Thai/English captions; use configured speech transcription as fallback."""
    channel = get_channel("youtube")
    if channel is None:
        raise ValueError("YouTube channel is not bundled")
    metadata = run_action(channel, "read", {"target": target}, timeout=timeout)
    if not metadata.get("ok"):
        return metadata

    # Agent-Reach's upstream default subtitle languages omit Thai. Prefer Thai first.
    captions = run_action(
        channel,
        "subtitle",
        {"target": target, "lang": "th,th-TH,en,en-US,en-GB,en-orig,zh-Hans"},
        timeout=timeout,
    )
    source = "youtube_subtitles"
    if not captions.get("ok"):
        # Audio transcription is optional and only runs when the user configured a provider.
        transcript = run_action(channel, "transcribe", {"target": target}, timeout=min(timeout, 1800))
        if transcript.get("ok"):
            captions = transcript
            source = "speech_transcription"
        else:
            item = (metadata.get("items") or [{}])[0]
            raw = item.get("raw") if isinstance(item.get("raw"), dict) else {}
            item["raw"] = {
                **raw,
                "content_status": "metadata_only",
                "content_warning": "Video captions were unavailable and speech transcription is not configured or failed. Do not summarize the video as watched; only title and description were retrieved.",
                "caption_error": (captions.get("error") or {}).get("message"),
                "transcription_error": (transcript.get("error") or {}).get("message"),
            }
            return metadata

    caption_items = captions.get("items") or []
    caption_text = "\n".join(
        str(item.get("text") or "") for item in caption_items if item.get("text")
    ).strip()
    item = (metadata.get("items") or [{}])[0]
    item["text"] = "\n\n[VIDEO TRANSCRIPT / CAPTIONS]\n" + caption_text if caption_text else item.get("text")
    raw = item.get("raw") if isinstance(item.get("raw"), dict) else {}
    caption_raw = (caption_items[0].get("raw") if caption_items and isinstance(caption_items[0].get("raw"), dict) else {})
    item["raw"] = {**raw, "content_status": "transcript_available", "transcript_source": source, "transcript_language": caption_raw.get("lang")}
    return metadata


def handle(request: dict[str, Any]) -> dict[str, Any]:
    operation = request.get("operation")
    if operation == "channels":
        return _channels()
    if operation == "read":
        target = request.get("url")
        if not isinstance(target, str) or not target:
            raise ValueError("url is required")
        if get_channel("youtube") is not None and get_channel("youtube").can_handle(target):
            timeout = request.get("timeout", 180)
            if isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or timeout <= 0 or timeout > 1800:
                raise ValueError("timeout must be between 0 and 1800 seconds")
            return _read_youtube(target, float(timeout))
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
