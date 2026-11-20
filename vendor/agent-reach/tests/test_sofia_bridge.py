"""Unit tests for Sofia's read-only Agent-Reach boundary."""
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sofia_bridge import _read_youtube, handle, is_mutating_action


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




class EmptyYouTubeTranscriptTests(unittest.TestCase):
    def test_empty_captions_fall_back_to_speech_transcription(self):
        metadata = {"ok": True, "items": [{"title": "Short", "text": "description", "raw": {}}]}
        empty_captions = {"ok": True, "items": []}
        transcript = {"ok": True, "items": [{"text": "เนื้อหาที่ถอดเสียงได้", "raw": {"lang": "th"}}]}
        with patch("sofia_bridge.get_channel", return_value=object()), patch(
            "sofia_bridge.run_action", side_effect=[metadata, empty_captions, transcript]
        ) as run:
            result = _read_youtube("https://www.youtube.com/shorts/abcdefghijk", 180)
        self.assertIn("เนื้อหาที่ถอดเสียงได้", result["items"][0]["text"])
        self.assertEqual(result["items"][0]["raw"]["content_status"], "transcript_available")
        self.assertEqual(result["items"][0]["raw"]["transcript_source"], "speech_transcription")
        self.assertEqual(run.call_count, 3)

    def test_empty_captions_and_empty_transcription_are_metadata_only(self):
        metadata = {"ok": True, "items": [{"title": "Short", "text": "description", "raw": {}}]}
        empty_captions = {"ok": True, "items": []}
        empty_transcript = {"ok": True, "items": []}
        with patch("sofia_bridge.get_channel", return_value=object()), patch(
            "sofia_bridge.run_action", side_effect=[metadata, empty_captions, empty_transcript]
        ):
            result = _read_youtube("https://www.youtube.com/shorts/abcdefghijk", 180)
        raw = result["items"][0]["raw"]
        self.assertEqual(raw["content_status"], "metadata_only")
        self.assertIn("Do not summarize the video as watched", raw["content_warning"])


class ReadOnlyDispatchBoundaryTests(unittest.TestCase):
    def test_handle_rejects_financial_and_account_mutations_before_dispatch(self):
        for action in ("checkout", "transfer_funds", "pay_invoice", "send_message", "delete_comment"):
            with self.subTest(action=action), patch("sofia_bridge.get_channel", return_value=object()), patch(
                "sofia_bridge.run_action"
            ) as dispatch:
                with self.assertRaisesRegex(ValueError, "not enabled"):
                    handle({
                        "channel": "example",
                        "action": action,
                        "params": {"amount": 100},
                    })
                dispatch.assert_not_called()

    def test_handle_dispatches_read_only_action(self):
        channel = object()
        expected = {"ok": True, "items": []}
        with patch("sofia_bridge.get_channel", return_value=channel), patch(
            "sofia_bridge.run_action", return_value=expected
        ) as dispatch:
            result = handle({
                "channel": "example",
                "action": "search",
                "params": {"query": "Sofia"},
            })
        self.assertEqual(result, expected)
        dispatch.assert_called_once_with(channel, "search", {"query": "Sofia"}, timeout=30.0)
