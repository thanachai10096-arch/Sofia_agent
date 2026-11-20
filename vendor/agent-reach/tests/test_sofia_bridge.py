"""Unit tests for Sofia's read-only Agent-Reach boundary."""
import unittest

from sofia_bridge import is_mutating_action


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
