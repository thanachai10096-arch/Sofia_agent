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
        healthy = "Project quota state on /mnt (device)\nAccounting: ON\nEnforcement: ON\n"
        accounting_only = "Project quota state on /mnt (device)\nAccounting: ON\nEnforcement: OFF\n"
        other_quotas_only = "User quota state on /mnt\nAccounting: ON\nEnforcement: ON\nGroup quota state on /mnt\nAccounting: ON\nEnforcement: ON\n"
        self.assertTrue(HELPER.project_quota_is_enforced(healthy))
        self.assertFalse(HELPER.project_quota_is_enforced(accounting_only))
        self.assertFalse(HELPER.project_quota_is_enforced(other_quotas_only))

    def test_project_quota_state_stops_before_following_quota_sections(self):
        state = ("Project quota state on /mnt\nAccounting: ON\nEnforcement: ON\n"
                 "User quota state on /mnt\nAccounting: OFF\nEnforcement: OFF\n")
        self.assertTrue(HELPER.project_quota_is_enforced(state))
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

    def test_project_id_collision_detects_hash_prefixed_report_rows(self):
        run_id = "123e4567-e89b-42d3-a456-426614174003"
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "workspaces"
            state = Path(temp) / "state"
            root.mkdir()
            state.mkdir()
            def report_existing(argv, timeout=HELPER.COMMAND_TIMEOUT):
                if "report -p -n" in " ".join(argv):
                    return "#200000 0 0 0 00\n"
                return ""
            with patch.object(HELPER, "run", side_effect=report_existing):
                with self.assertRaises(HELPER.HelperError):
                    HELPER.create(root, state, {
                        "runId": run_id,
                        "hardQuotaBytes": 8 * 1024 * 1024,
                        "hardQuotaInodes": HELPER.INODE_LIMIT,
                    })
            self.assertEqual(HELPER.load_allocations(state), {})


    def test_abort_recovers_interrupted_create_and_releases_project_id(self):
        run_id = "123e4567-e89b-42d3-a456-426614174004"
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "workspaces"
            state = Path(temp) / "state"
            root.mkdir()
            state.mkdir()

            def fail_after_workspace_creation(argv, timeout=HELPER.COMMAND_TIMEOUT):
                if "project -s" in " ".join(argv):
                    raise HELPER.HelperError("simulated interruption after mkdir")
                return ""

            with patch.object(HELPER, "run", side_effect=fail_after_workspace_creation):
                with self.assertRaises(HELPER.HelperError):
                    HELPER.create(root, state, {
                        "runId": run_id,
                        "hardQuotaBytes": 8 * 1024 * 1024,
                        "hardQuotaInodes": HELPER.INODE_LIMIT,
                    })

            workspace = root / ("run-" + run_id)
            self.assertTrue(workspace.is_dir())
            self.assertEqual(HELPER.load_allocations(state)[run_id]["status"], "needs_recovery")

            with patch.object(HELPER, "run", return_value="") as run_mock:
                reply = HELPER.dispose(root, state, {
                    "runId": run_id,
                }, abort=True)

            self.assertEqual(reply["runId"], run_id)
            self.assertFalse(workspace.exists())
            self.assertNotIn(run_id, HELPER.load_allocations(state))
            self.assertTrue(any("limit -p bhard=0 ihard=0" in " ".join(call.args[0]) for call in run_mock.call_args_list))

    def test_failed_quota_reset_keeps_allocation_reserved_until_retry(self):
        run_id = "123e4567-e89b-42d3-a456-426614174005"
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "workspaces"
            state = Path(temp) / "state"
            root.mkdir()
            state.mkdir()
            workspace = root / ("run-" + run_id)
            workspace.mkdir()
            HELPER.save_allocations(state, {
                run_id: {
                    "project_id": HELPER.PROJECT_ID_MIN,
                    "workspace": str(workspace),
                    "bytes": 8 * 1024 * 1024,
                    "inodes": HELPER.INODE_LIMIT,
                    "status": "active",
                }
            })

            def fail_reset(argv, timeout=HELPER.COMMAND_TIMEOUT):
                if "limit -p bhard=0 ihard=0" in " ".join(argv):
                    raise HELPER.HelperError("simulated quota reset failure")
                return ""

            with patch.object(HELPER, "run", side_effect=fail_reset):
                with self.assertRaises(HELPER.HelperError):
                    HELPER.dispose(root, state, {
                        "runId": run_id,
                        "workspacePath": str(workspace),
                    })

            self.assertFalse(workspace.exists())
            self.assertIn(run_id, HELPER.load_allocations(state))

            with patch.object(HELPER, "run", return_value=""):
                reply = HELPER.dispose(root, state, {
                    "runId": run_id,
                        "workspacePath": str(workspace),
                })

            self.assertEqual(reply["runId"], run_id)
            self.assertNotIn(run_id, HELPER.load_allocations(state))


    def test_partial_workspace_removal_keeps_reservation_for_safe_retry(self):
        run_id = "123e4567-e89b-42d3-a456-426614174006"
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "workspaces"
            state = Path(temp) / "state"
            root.mkdir()
            state.mkdir()
            workspace = root / ("run-" + run_id)
            workspace.mkdir()
            (workspace / "partial").write_text("data", encoding="utf-8")
            HELPER.save_allocations(state, {
                run_id: {
                    "project_id": HELPER.PROJECT_ID_MIN,
                    "workspace": str(workspace),
                    "bytes": 8 * 1024 * 1024,
                    "inodes": HELPER.INODE_LIMIT,
                    "status": "active",
                }
            })

            real_rmtree = HELPER.shutil.rmtree
            def partially_remove(path):
                real_rmtree(path)
                raise OSError("simulated interruption after tree removal")

            with patch.object(HELPER, "run", return_value=""), patch.object(HELPER.shutil, "rmtree", side_effect=partially_remove):
                with self.assertRaises(OSError):
                    HELPER.dispose(root, state, {
                        "runId": run_id,
                        "workspacePath": str(workspace),
                    })

            self.assertFalse(workspace.exists())
            self.assertIn(run_id, HELPER.load_allocations(state))

            with patch.object(HELPER, "run", return_value="") as run_mock:
                reply = HELPER.dispose(root, state, {
                    "runId": run_id,
                    "workspacePath": str(workspace),
                })

            self.assertEqual(reply["runId"], run_id)
            self.assertNotIn(run_id, HELPER.load_allocations(state))
            reset_calls = [call for call in run_mock.call_args_list if "limit -p bhard=0 ihard=0" in " ".join(call.args[0])]
            self.assertEqual(len(reset_calls), 1)


    def test_atomic_state_write_failure_preserves_previous_registry(self):
        with tempfile.TemporaryDirectory() as temp:
            state = Path(temp) / "state"
            state.mkdir()
            original = {"run-a": {"project_id": HELPER.PROJECT_ID_MIN}}
            target = state / "allocations.json"
            target.write_text('{"previous":true}', encoding="utf-8")

            with patch.object(HELPER.os, "replace", side_effect=OSError("simulated crash before replace")):
                with self.assertRaises(OSError):
                    HELPER.save_allocations(state, original)

            self.assertEqual(target.read_text(encoding="utf-8"), '{"previous":true}')
            self.assertEqual(list(state.glob("allocations.*.tmp")), [])

    def test_allocation_state_rejects_duplicate_project_ids_and_unknown_status(self):
        with tempfile.TemporaryDirectory() as temp:
            state = Path(temp)
            duplicate = {
                "123e4567-e89b-42d3-a456-426614174010": {
                    "project_id": HELPER.PROJECT_ID_MIN,
                    "workspace": "/mnt/work/run-a",
                    "bytes": 8 * 1024 * 1024,
                    "inodes": HELPER.INODE_LIMIT,
                    "status": "active",
                },
                "123e4567-e89b-42d3-a456-426614174011": {
                    "project_id": HELPER.PROJECT_ID_MIN,
                    "workspace": "/mnt/work/run-b",
                    "bytes": 8 * 1024 * 1024,
                    "inodes": HELPER.INODE_LIMIT,
                    "status": "active",
                },
            }
            (state / "allocations.json").write_text(__import__("json").dumps(duplicate), encoding="utf-8")
            with self.assertRaises(HELPER.HelperError):
                HELPER.load_allocations(state)

            duplicate.pop("123e4567-e89b-42d3-a456-426614174011")
            duplicate["123e4567-e89b-42d3-a456-426614174010"]["status"] = "finished"
            (state / "allocations.json").write_text(__import__("json").dumps(duplicate), encoding="utf-8")
            with self.assertRaises(HELPER.HelperError):
                HELPER.load_allocations(state)

    def test_project_id_range_is_fixed_and_bounded(self):
        self.assertEqual(HELPER.PROJECT_ID_MIN, 200000)
        self.assertEqual(HELPER.PROJECT_ID_MAX, 299999)
        self.assertEqual(HELPER.INODE_LIMIT, 20000)


if __name__ == "__main__":
    unittest.main()
