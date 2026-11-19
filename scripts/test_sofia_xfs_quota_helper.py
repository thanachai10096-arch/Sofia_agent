"""Unit tests for the fixed-protocol XFS quota helper (no root or XFS mount required)."""
import importlib.util
import unittest
from pathlib import Path

MODULE_PATH = Path(__file__).with_name("sofia-xfs-quota-helper.py")
SPEC = importlib.util.spec_from_file_location("sofia_xfs_quota_helper", MODULE_PATH)
HELPER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(HELPER)


class QuotaHelperTests(unittest.TestCase):
    def test_run_id_requires_canonical_uuid(self):
        value = "123e4567-e89b-42d3-a456-426614174000"
        self.assertEqual(HELPER.validate_run_id(value), value)
        with self.assertRaises(HELPER.HelperError):
            HELPER.validate_run_id("../outside")
        with self.assertRaises(HELPER.HelperError):
            HELPER.validate_run_id(value.upper() + "extra")

    def test_hard_limit_parser_reads_the_hard_column_only(self):
        sample = "123456 0 0 524288 00 [------]"
        self.assertEqual(HELPER.extract_hard_limit(sample, 123456), 524288)

    def test_hard_limit_parser_rejects_missing_duplicate_and_non_numeric_rows(self):
        with self.assertRaises(HELPER.HelperError):
            HELPER.extract_hard_limit("header only", 123456)
        with self.assertRaises(HELPER.HelperError):
            HELPER.extract_hard_limit("123456 0 0 unlimited 00\n123456 0 0 1 00", 123456)
        with self.assertRaises(HELPER.HelperError):
            HELPER.extract_hard_limit("123456 0 0 unlimited 00", 123456)

    def test_project_id_range_is_fixed_and_bounded(self):
        self.assertEqual(HELPER.PROJECT_ID_MIN, 200000)
        self.assertEqual(HELPER.PROJECT_ID_MAX, 299999)
        self.assertEqual(HELPER.INODE_LIMIT, 20000)


if __name__ == "__main__":
    unittest.main()
