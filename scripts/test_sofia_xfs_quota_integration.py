#!/usr/bin/env python3
"""Opt-in destructive integration test for a dedicated, disposable XFS quota mount.

Run only on a disposable host after installing/configuring the root-owned helper:
  SOFIA_XFS_QUOTA_INTEGRATION=1
  SOFIA_XFS_QUOTA_HELPER=/usr/local/sbin/sofia-xfs-quota-helper
  SOFIA_XFS_TEST_ROOT=/var/lib/sofia-runner/workspaces
  python3 scripts/test_sofia_xfs_quota_integration.py

This test intentionally fills one isolated project workspace to its hard block
and inode limits. It refuses to run without explicit opt-in and root privileges.
"""
import errno
import json
import os
import subprocess
import unittest
import uuid
from pathlib import Path

OPT_IN = os.environ.get("SOFIA_XFS_QUOTA_INTEGRATION") == "1"
HELPER = os.environ.get("SOFIA_XFS_QUOTA_HELPER")
ROOT = os.environ.get("SOFIA_XFS_TEST_ROOT")
BYTE_LIMIT = 8 * 1024 * 1024
INODE_LIMIT = 20_000
TIMEOUT = 90


def helper_call(payload):
    result = subprocess.run(
        [HELPER, "--stdio-json"],
        input=json.dumps(payload),
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=TIMEOUT,
        check=False,
        env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C", "LC_ALL": "C"},
    )
    if result.returncode != 0:
        raise RuntimeError("quota helper failed: " + result.stderr[-500:])
    try:
        response = json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise RuntimeError("quota helper returned malformed JSON") from error
    if not isinstance(response, dict) or response.get("ok") is not True:
        raise RuntimeError("quota helper returned an unsuccessful response")
    return response


@unittest.skipUnless(OPT_IN, "set SOFIA_XFS_QUOTA_INTEGRATION=1 on a disposable XFS host")
class XfsQuotaEnforcementIntegrationTests(unittest.TestCase):
    def test_block_and_inode_hard_limits_are_enforced_and_released(self):
        if os.geteuid() != 0:
            self.fail("integration test must run as root")
        if not HELPER or not Path(HELPER).is_absolute() or not os.path.isfile(HELPER):
            self.fail("SOFIA_XFS_QUOTA_HELPER must be an absolute installed helper path")
        if not ROOT or not Path(ROOT).is_absolute() or not os.path.isdir(ROOT):
            self.fail("SOFIA_XFS_TEST_ROOT must be an existing dedicated workspace root")
        root = Path(ROOT).resolve(strict=True)
        run_id = str(uuid.uuid4())
        workspace = root / ("run-" + run_id)
        created = False
        allocation_attempted = False
        try:
            probe = helper_call({"operation": "probe", "workspaceRoot": str(root)})
            self.assertEqual(probe.get("filesystemType"), "xfs")
            self.assertIs(probe.get("projectQuotaEnabled"), True)
            allocation_attempted = True
            response = helper_call({
                "operation": "create",
                "runId": run_id,
                "workspaceRoot": str(root),
                "hardQuotaBytes": BYTE_LIMIT,
                "hardQuotaInodes": INODE_LIMIT,
            })
            created = True
            self.assertEqual(response.get("runId"), run_id)
            self.assertEqual(response.get("workspacePath"), str(workspace))
            self.assertEqual(response.get("quotaBytes"), BYTE_LIMIT)
            self.assertEqual(response.get("quotaInodes"), INODE_LIMIT)
            self.assertTrue(workspace.is_dir())

            payload = workspace / "block-limit.bin"
            fd = os.open(payload, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            block_rejected = False
            try:
                chunk = b"x" * (256 * 1024)
                while True:
                    os.write(fd, chunk)
            except OSError as error:
                block_rejected = error.errno in (errno.EDQUOT, errno.ENOSPC)
                if not block_rejected:
                    raise
            finally:
                os.close(fd)
            self.assertTrue(block_rejected, "XFS did not reject writes at the project block hard limit")
            payload.unlink(missing_ok=True)

            inode_rejected = False
            created_files = 0
            try:
                while created_files < INODE_LIMIT + 2:
                    (workspace / ("inode-" + str(created_files))).touch(exist_ok=False)
                    created_files += 1
            except OSError as error:
                inode_rejected = error.errno in (errno.EDQUOT, errno.ENOSPC)
                if not inode_rejected:
                    raise
            self.assertTrue(inode_rejected, "XFS did not reject file creation at the project inode hard limit")
            self.assertLess(created_files, INODE_LIMIT + 2)
        finally:
            if created or workspace.exists():
                helper_call({"operation": "dispose", "runId": run_id, "workspacePath": str(workspace)})
            elif allocation_attempted:
                helper_call({"operation": "abort", "runId": run_id, "workspaceRoot": str(root)})


if __name__ == "__main__":
    unittest.main()
