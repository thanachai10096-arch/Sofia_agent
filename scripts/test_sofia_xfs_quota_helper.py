"""Unit tests for the fixed-protocol XFS quota helper (no root or XFS mount required)."""
import importlib.util
import unittest
import tempfile
from unittest.mock import patch
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
        sample = "#123456 0 0 524288 00 [------]"
        self.assertEqual(HELPER.extract_hard_limit(sample, 123456), 524288)

    def test_hard_limit_parser_rejects_missing_duplicate_and_non_numeric_rows(self):
        with self.assertRaises(HELPER.HelperError):
            HELPER.extract_hard_limit("header only", 123456)
        with self.assertRaises(HELPER.HelperError):
            HELPER.extract_hard_limit("123456 0 0 unlimited 00\n123456 0 0 1 00", 123456)
        with self.assertRaises(HELPER.HelperError):
            HELPER.extract_hard_limit("123456 0 0 unlimited 00", 123456)


    def test_project_quota_state_requires_both_accounting_and_enforcement(self):
        healthy = "Project quota state on /mnt (device)\\nAccounting: ON\\nEnforcement: ON\\n"
        accounting_only = "Project quota state on /mnt (device)\\nAccounting: ON\\nEnforcement: OFF\\n"
        other_quotas_only = "User quota state on /mnt\\nAccounting: ON\\nEnforcement: ON\\nGroup quota state on /mnt\\nAccounting: ON\\nEnforcement: ON\\n"
        self.assertTrue(HELPER.project_quota_is_enforced(healthy))
        self.assertFalse(HELPER.project_quota_is_enforced(accounting_only))
        self.assertFalse(HELPER.project_quota_is_enforced(other_quotas_only))
    def test_strict_json_rejects_duplicate_keys_and_non_finite_numbers(self):
        with self.assertRaises(HELPER.HelperError):
            HELPER.strict_json_loads('{"operation":"probe","operation":"dispose"}')
        with self.assertRaises(HELPER.HelperError):
            HELPER.strict_json_loads('{"hardQuotaBytes":NaN}')

    def test_create_persists_verified_allocation_and_dispose_releases_it(self):
        run_id = "123e4567-e89b-42d3-a456-426614174000"
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "workspaces"
            state = Path(temp) / "state"
            root.mkdir()
            state.mkdir()
            with patch.object(HELPER, "run", return_value=""), patch.object(HELPER, "verify_quota") as verify:
                reply = HELPER.create(root, state, {
                    "runId": run_id,
                    "hardQuotaBytes": 8 * 1024 * 1024,
                    "hardQuotaInodes": HELPER.INODE_LIMIT,
                })
                verify.assert_called_once()
                workspace = root / ("run-" + run_id)
                self.assertEqual(reply["workspacePath"], str(workspace))
                self.assertTrue(workspace.is_dir())
                allocation = HELPER.load_allocations(state)[run_id]
                self.assertEqual(allocation["status"], "active")
                self.assertEqual(allocation["project_id"], HELPER.PROJECT_ID_MIN)
                dispose_reply = HELPER.dispose(root, state, {
                    "runId": run_id,
                    "workspacePath": str(workspace),
                })
                self.assertEqual(dispose_reply["runId"], run_id)
                self.assertFalse(workspace.exists())
                self.assertNotIn(run_id, HELPER.load_allocations(state))

    def test_untracked_workspace_root_entry_blocks_allocation(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "workspaces"
            root.mkdir()
            (root / "unexpected").mkdir()
            with self.assertRaises(HELPER.HelperError):
                HELPER.assert_workspace_registry_consistent(root, {})
    def test_create_refuses_preexisting_workspace_without_claiming_it(self):
        run_id = "123e4567-e89b-42d3-a456-426614174002"
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "workspaces"
            state = Path(temp) / "state"
            root.mkdir()
            state.mkdir()
            existing = root / ("run-" + run_id)
            existing.mkdir()
            with patch.object(HELPER, "run", return_value=""):
                with self.assertRaises(HELPER.HelperError):
                    HELPER.create(root, state, {
                        "runId": run_id,
                        "hardQuotaBytes": 8 * 1024 * 1024,
                        "hardQuotaInodes": HELPER.INODE_LIMIT,
                    })
            self.assertTrue(existing.is_dir())
            self.assertEqual(HELPER.load_allocations(state), {})
    def test_failed_create_keeps_project_id_reserved_for_recovery(self):
        run_id = "123e4567-e89b-42d3-a456-426614174001"
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "workspaces"
            state = Path(temp) / "state"
            root.mkdir()
            state.mkdir()
            def fail_project_assignment(argv, timeout=HELPER.COMMAND_TIMEOUT):
                if "project -s" in " ".join(argv):
                    raise HELPER.HelperError("simulated project assignment failure")
                return ""
            with patch.object(HELPER, "run", side_effect=fail_project_assignment), patch.object(HELPER, "verify_quota"):
                with self.assertRaises(HELPER.HelperError):
                    HELPER.create(root, state, {
                        "runId": run_id,
                        "hardQuotaBytes": 8 * 1024 * 1024,
                        "hardQuotaInodes": HELPER.INODE_LIMIT,
                    })
            allocation = HELPER.load_allocations(state)[run_id]
            self.assertEqual(allocation["status"], "needs_recovery")
            self.assertEqual(allocation["project_id"], HELPER.PROJECT_ID_MIN)

    def test_project_id_range_is_fixed_and_bounded(self):
        self.assertEqual(HELPER.PROJECT_ID_MIN, 200000)
        self.assertEqual(HELPER.PROJECT_ID_MAX, 299999)
        self.assertEqual(HELPER.INODE_LIMIT, 20000)


if __name__ == "__main__":
    unittest.main()
