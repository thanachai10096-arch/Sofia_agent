"""Unit tests for Sofia's read-only Agent-Reach boundary."""
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sofia_bridge import _read_youtube, is_mutating_action


class MutatingActionGuardTests(unittest.TestCase):
    def test_blocks_compound_mutation_names(self):
        for action in (
            "post", "create_post", "send_message", "delete_comment",
            "publish-video", "reply_to_comment", "upload_file",
            "purchase_item", "follow_user", "retweet",
        ):
            with self.subTest(action=action):
                self.assertTrue(is_mutating_action(action))

    def test_allows_research_actions(self):
        for action in ("search", "read", "get", "list", "fetch", "subtitles", "metadata"):
            with self.subTest(action=action):
                self.assertFalse(is_mutating_action(action))


if __name__ == "__main__":
    unittest.main()


class YouTubeReadTests(unittest.TestCase):
    def test_read_includes_thai_captions(self):
        metadata = {"ok": True, "items": [{"title": "Short", "text": "description", "raw": {}}]}
        captions = {"ok": True, "items": [{"text": "นี่คือคำบรรยายภาษาไทย", "raw": {"lang": "th"}}]}
        with patch("sofia_bridge.get_channel", return_value=object()), patch(
            "sofia_bridge.run_action", side_effect=[metadata, captions]
        ) as run:
            result = _read_youtube("https://www.youtube.com/shorts/abcdefghijk", 180)
        self.assertTrue(result["ok"])
        self.assertIn("นี่คือคำบรรยายภาษาไทย", result["items"][0]["text"])
        self.assertEqual(result["items"][0]["raw"]["transcript_source"], "youtube_subtitles")
        self.assertIn("th,th-TH", run.call_args_list[1].args[2]["lang"])

    def test_does_not_claim_video_was_read_without_transcript(self):
        metadata = {"ok": True, "items": [{"title": "Short", "text": "description", "raw": {}}]}
        unavailable = {"ok": False, "error": {"message": "no subtitles"}}
        no_provider = {"ok": False, "error": {"message": "no provider configured"}}
        with patch("sofia_bridge.get_channel", return_value=object()), patch(
            "sofia_bridge.run_action", side_effect=[metadata, unavailable, no_provider]
        ):
            result = _read_youtube("https://www.youtube.com/shorts/abcdefghijk", 180)
        raw = result["items"][0]["raw"]
        self.assertEqual(raw["content_status"], "metadata_only")
        self.assertIn("Do not summarize the video as watched", raw["content_warning"])


