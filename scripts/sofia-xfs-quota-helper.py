#!/usr/bin/env python3
"""Root-owned, fixed-protocol XFS project-quota helper for Sofia's remote runner.

Install as root:root 0750 under a root-owned, non-writable directory.
Configuration is read only from /etc/sofia-runner/quota-helper.json.
"""
import fcntl
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import uuid
from pathlib import Path

CONFIG = Path("/etc/sofia-runner/quota-helper.json")
MAX_INPUT = 16 * 1024
PROJECT_ID_MIN = 200000
PROJECT_ID_MAX = 299999
INODE_LIMIT = 20000
COMMAND_TIMEOUT = 20


class HelperError(Exception):
    pass


def fail(message):
    raise HelperError(message)


def run(argv, timeout=COMMAND_TIMEOUT):
    result = subprocess.run(
        argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
        stderr=subprocess.PIPE, text=True, timeout=timeout, check=False,
        env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C", "LC_ALL": "C"},
    )
    if result.returncode != 0:
        fail("host quota command failed: " + Path(argv[0]).name)
    return result.stdout


def secure_directory(path):
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode):
        fail("configured path is not a real directory")
    if info.st_uid != 0 or info.st_mode & 0o022:
        fail("configured directory must be root-owned and not group/world writable")


def load_config():
    if os.geteuid() != 0:
        fail("helper must run as root")
    info = CONFIG.lstat()
    if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
        fail("configuration must be a root-owned regular file not writable by group/others")
    if info.st_size > 4096:
        fail("configuration file is too large")
    config = json.loads(CONFIG.read_text(encoding="utf-8"))
    if not isinstance(config, dict) or set(config) != {"workspace_root", "state_root"}:
        fail("configuration has an unexpected schema")
    root = Path(config["workspace_root"])
    state = Path(config["state_root"])
    if not root.is_absolute() or not state.is_absolute():
        fail("configured paths must be absolute")
    root = root.resolve(strict=True)
    state.mkdir(mode=0o700, parents=True, exist_ok=True)
    state = state.resolve(strict=True)
    secure_directory(root)
    secure_directory(state)
    if root == state or root in state.parents or state in root.parents:
        fail("workspace and state directories must be separate")
    return root, state


def check_xfs(root):
    fs_type = run(["findmnt", "-n", "-o", "FSTYPE", "--target", str(root)]).strip()
    options = run(["findmnt", "-n", "-o", "OPTIONS", "--target", str(root)]).strip().split(",")
    if fs_type != "xfs" or not ({"prjquota", "pquota"} & set(options)):
        fail("workspace root must be on XFS mounted with project quota enabled")
    state = run(["xfs_quota", "-x", "-c", "state", str(root)])
    project_state = re.search(r"Project quota state:\\s*ON", state, re.IGNORECASE)
    project_enforcement = re.search(r"Project quota enforcement:\\s*ON", state, re.IGNORECASE)
    if not project_state or not project_enforcement:
        fail("XFS project quota accounting and enforcement are not both ON")


def locked_state(state_root):
    lock_path = state_root / "allocations.lock"
    fd = os.open(lock_path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o077:
        os.close(fd)
        fail("allocation lock is not a private root-owned regular file")
    fcntl.flock(fd, fcntl.LOCK_EX)
    return fd


def load_allocations(state_root):
    path = state_root / "allocations.json"
    try:
        info = path.lstat()
    except FileNotFoundError:
        return {}
    if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o077:
        fail("allocation state is not a private root-owned regular file")
    if info.st_size > 4 * 1024 * 1024:
        fail("allocation state is too large")
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        fail("allocation state is malformed")
    return data


def save_allocations(state_root, data):
    target = state_root / "allocations.json"
    temp = state_root / ("allocations." + uuid.uuid4().hex + ".tmp")
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(data, stream, sort_keys=True)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, target)
        dir_fd = os.open(state_root, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(dir_fd)
        finally:
            os.close(dir_fd)
    finally:
        try:
            temp.unlink()
        except FileNotFoundError:
            pass


def validate_run_id(value):
    try:
        parsed = uuid.UUID(value)
    except (ValueError, TypeError, AttributeError):
        fail("runId must be a UUID")
    if str(parsed) != value.lower():
        fail("runId must use canonical UUID format")
    return str(parsed)


def quota_report(root, project_id):
    # Query only this numeric project; never parse human-readable names.
    return run(["xfs_quota", "-x", "-c", "quota -p -n -v " + str(project_id), str(root)])


def verify_quota(root, project_id, bytes_limit, inode_limit):
    output = quota_report(root, project_id)
    # xfs_quota's verbose project quota row reports used, soft, hard for blocks
    # and inodes. Require both hard limits to appear as exact numeric values.
    rows = [line.split() for line in output.splitlines() if line.strip().split() and line.split()[0] == str(project_id)]
    if len(rows) != 1:
        fail("cannot uniquely read back project quota limits")
    numbers = []
    for token in rows[0][1:]:
        if token.isdigit():
            numbers.append(int(token))
    if bytes_limit not in numbers and (bytes_limit + 1023) // 1024 not in numbers:
        fail("XFS block hard limit read-back did not match request")
    if inode_limit not in numbers:
        fail("XFS inode hard limit read-back did not match request")


def create(root, state_root, request):
    run_id = validate_run_id(request["runId"])
    byte_limit = request["hardQuotaBytes"]
    inode_limit = request["hardQuotaInodes"]
    if type(byte_limit) is not int or byte_limit < 1024 * 1024 or type(inode_limit) is not int or inode_limit != INODE_LIMIT:
        fail("requested quota limits are outside host policy")
    allocations = load_allocations(state_root)
    if run_id in allocations:
        fail("runId already has an allocation")
    used = {entry.get("project_id") for entry in allocations.values() if isinstance(entry, dict)}
    project_id = next((candidate for candidate in range(PROJECT_ID_MIN, PROJECT_ID_MAX + 1) if candidate not in used), None)
    if project_id is None:
        fail("project ID allocation range exhausted")
    workspace = root / ("run-" + run_id)
    workspace.mkdir(mode=0o700)
    try:
        run(["xfs_quota", "-x", "-c", "project -s -p " + str(workspace) + " " + str(project_id), str(root)])
        run(["xfs_quota", "-x", "-c", "limit -p bhard=" + str(byte_limit) + "B ihard=" + str(inode_limit) + " " + str(project_id), str(root)])
        verify_quota(root, project_id, byte_limit, inode_limit)
        allocations[run_id] = {"project_id": project_id, "workspace": str(workspace), "bytes": byte_limit, "inodes": inode_limit}
        save_allocations(state_root, allocations)
    except Exception:
        # Keep any uncertain allocation recorded for operator recovery; never recycle its ID.
        allocations[run_id] = {"project_id": project_id, "workspace": str(workspace), "bytes": byte_limit, "inodes": inode_limit, "needs_recovery": True}
        save_allocations(state_root, allocations)
        raise
    return {"ok": True, "runId": run_id, "workspacePath": str(workspace), "quotaBytes": byte_limit, "quotaInodes": inode_limit}


def dispose(root, state_root, request, abort=False):
    run_id = validate_run_id(request["runId"])
    allocations = load_allocations(state_root)
    entry = allocations.get(run_id)
    if entry is None:
        return {"ok": True, "runId": run_id}
    if not isinstance(entry, dict) or set(entry) - {"project_id", "workspace", "bytes", "inodes", "needs_recovery"}:
        fail("allocation record is malformed")
    workspace = root / ("run-" + run_id)
    if entry.get("workspace") != str(workspace) or type(entry.get("project_id")) is not int:
        fail("allocation record does not match canonical workspace")
    if not abort and request.get("workspacePath") != str(workspace):
        fail("dispose workspace path does not match run identity")
    try:
        info = workspace.lstat()
        if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode):
            fail("workspace is not a real directory")
        run(["xfs_quota", "-x", "-c", "project -C -p " + str(workspace) + " " + str(entry["project_id"]), str(root)])
        shutil.rmtree(workspace)
        # Reset both limits before returning the project ID to the allocator.
        run(["xfs_quota", "-x", "-c", "limit -p bhard=0B ihard=0 " + str(entry["project_id"]), str(root)])
    except FileNotFoundError:
        pass
    allocations.pop(run_id, None)
    save_allocations(state_root, allocations)
    return {"ok": True, "runId": run_id}


def main():
    if len(sys.argv) != 2 or sys.argv[1] != "--stdio-json":
        fail("only --stdio-json is supported")
    raw = sys.stdin.buffer.read(MAX_INPUT + 1)
    if len(raw) > MAX_INPUT:
        fail("request exceeds size limit")
    request = json.loads(raw.decode("utf-8"))
    if not isinstance(request, dict) or not isinstance(request.get("operation"), str):
        fail("request must be a JSON object with an operation")
    root, state_root = load_config()
    check_xfs(root)
    lock_fd = locked_state(state_root)
    try:
        operation = request["operation"]
        if operation == "probe" and set(request) == {"operation", "workspaceRoot"}:
            if str(root) != str(Path(request["workspaceRoot"]).resolve(strict=True)):
                fail("probe root does not match host configuration")
            reply = {"ok": True, "filesystemType": "xfs", "projectQuotaEnabled": True}
        elif operation == "create" and set(request) == {"operation", "runId", "workspaceRoot", "hardQuotaBytes", "hardQuotaInodes"}:
            if str(root) != str(Path(request["workspaceRoot"]).resolve(strict=True)):
                fail("create root does not match host configuration")
            reply = create(root, state_root, request)
        elif operation == "dispose" and set(request) == {"operation", "runId", "workspacePath"}:
            reply = dispose(root, state_root, request)
        elif operation == "abort" and set(request) == {"operation", "runId", "workspaceRoot"}:
            if str(root) != str(Path(request["workspaceRoot"]).resolve(strict=True)):
                fail("abort root does not match host configuration")
            reply = dispose(root, state_root, request, abort=True)
        else:
            fail("unknown operation or unexpected request fields")
        sys.stdout.write(json.dumps(reply, separators=(",", ":")) + "\\n")
    finally:
        os.close(lock_fd)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        sys.stderr.write("sofia-xfs-quota-helper: " + str(error)[:500] + "\\n")
        sys.exit(1)
