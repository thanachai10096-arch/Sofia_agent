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

def reject_duplicate_keys(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            fail("JSON object contains a duplicate key")
        result[key] = value
    return result

def strict_json_loads(value):
    return json.loads(
        value,
        object_pairs_hook=reject_duplicate_keys,
        parse_constant=lambda _value: fail("JSON contains a non-finite number"),
    )


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
    current = CONFIG.parent
    while True:
        secure_directory(current)
        parent = current.parent
        if parent == current:
            break
        current = parent
    info = CONFIG.lstat()
    if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
        fail("configuration must be a root-owned regular file not writable by group/others")
    if info.st_size > 4096:
        fail("configuration file is too large")
    config = strict_json_loads(CONFIG.read_text(encoding="utf-8"))
    if not isinstance(config, dict) or set(config) != {"workspace_root", "state_root"}:
        fail("configuration has an unexpected schema")
    if not isinstance(config["workspace_root"], str) or not isinstance(config["state_root"], str):
        fail("configured paths must be strings")
    root_input = Path(config["workspace_root"])
    state_input = Path(config["state_root"])
    if not root_input.is_absolute() or not state_input.is_absolute():
        fail("configured paths must be absolute")
    root = root_input.resolve(strict=True)
    if str(root_input) != str(root):
        fail("workspace root must be canonical and contain no symlink components")
    state = state_input.resolve(strict=True)
    if str(state_input) != str(state):
        fail("state root must be canonical and contain no symlink components")
    for configured in (root, state):
        current = configured
        while True:
            secure_directory(current)
            parent = current.parent
            if parent == current:
                break
            current = parent
    if not re.fullmatch(r"[A-Za-z0-9_./-]+", str(root)):
        fail("workspace root may contain only safe path characters")
    if root == state or root in state.parents or state in root.parents:
        fail("workspace and state directories must be separate")
    return root, state


def project_quota_is_enforced(state):
    section = re.search(
        r"Project quota state[\s\S]*?(?=\n(?:User|Group) quota state|\Z)",
        state,
        re.IGNORECASE,
    )
    if not section:
        return False
    body = section.group(0)
    return bool(re.search(r"Accounting:\s*ON", body, re.IGNORECASE) and re.search(r"Enforcement:\s*ON", body, re.IGNORECASE))

def check_xfs(root):
    fs_type = run(["findmnt", "-n", "-o", "FSTYPE", "--target", str(root)]).strip()
    options = run(["findmnt", "-n", "-o", "OPTIONS", "--target", str(root)]).strip().split(",")
    if fs_type != "xfs" or not ({"prjquota", "pquota"} & set(options)):
        fail("workspace root must be on XFS mounted with project quota enabled")
    state = run(["xfs_quota", "-x", "-c", "state", str(root)])
    if not project_quota_is_enforced(state):
        fail("XFS project quota accounting and enforcement are not both ON")


def locked_state(state_root):
    lock_path = state_root / "allocations.lock"
    fd = os.open(lock_path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077 or info.st_nlink != 1:
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
    if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077 or info.st_nlink != 1:
        fail("allocation state is not a private, singly-linked regular file")
    if info.st_size > 4 * 1024 * 1024:
        fail("allocation state is too large")
    data = strict_json_loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        fail("allocation state is malformed")
    seen_ids = set()
    for run_id, entry in data.items():
        if validate_run_id(run_id) != run_id or not isinstance(entry, dict):
            fail("allocation state contains an invalid run record")
        if set(entry) - {"project_id", "workspace", "bytes", "inodes", "status"}:
            fail("allocation state contains unknown record fields")
        project_id = entry.get("project_id")
        if type(project_id) is not int or not PROJECT_ID_MIN <= project_id <= PROJECT_ID_MAX or project_id in seen_ids:
            fail("allocation state contains an invalid or duplicate project ID")
        if not isinstance(entry.get("workspace"), str) or not entry["workspace"].startswith("/"):
            fail("allocation state contains an invalid workspace path")
        if type(entry.get("bytes")) is not int or entry["bytes"] < 1024 * 1024:
            fail("allocation state contains an invalid byte quota")
        if entry.get("inodes") != INODE_LIMIT or type(entry.get("inodes")) is not int:
            fail("allocation state contains an invalid inode quota")
        if entry.get("status") not in {"allocating", "active", "needs_recovery"}:
            fail("allocation state contains an invalid lifecycle status")
        seen_ids.add(project_id)
    return data


def assert_workspace_registry_consistent(root, allocations):
    expected = {"run-" + run_id for run_id in allocations}
    for run_id, entry in allocations.items():
        canonical_workspace = root / ("run-" + run_id)
        if not isinstance(entry, dict) or entry.get("workspace") != str(canonical_workspace):
            fail("allocation registry workspace does not match its canonical run path")
    for child in root.iterdir():
        if child.name not in expected:
            fail("workspace root contains an untracked entry; refusing quota allocation or cleanup")
        info = child.lstat()
        if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode):
            fail("registered workspace path is not a real directory")

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


def extract_hard_limit(output, project_id):
    rows = []
    for line in output.splitlines():
        fields = line.split()
        if not fields:
            continue
        reported_id = fields[0].lstrip("#")
        if reported_id == str(project_id):
            rows.append(fields)
    if len(rows) != 1 or len(rows[0]) < 4 or not rows[0][3].isdigit():
        fail("cannot uniquely read back numeric project hard limit")
    return int(rows[0][3])


def verify_quota(root, project_id, bytes_limit, inode_limit):
    # `report` emits project ID, used, soft, hard; block reports use 1K units.
    block_output = run(["xfs_quota", "-x", "-c", "report -p -b -n -N", str(root)])
    inode_output = run(["xfs_quota", "-x", "-c", "report -p -i -n -N", str(root)])
    expected_blocks = (bytes_limit + 1023) // 1024
    if extract_hard_limit(block_output, project_id) != expected_blocks:
        fail("XFS block hard limit read-back did not match request")
    if extract_hard_limit(inode_output, project_id) != inode_limit:
        fail("XFS inode hard limit read-back did not match request")

def create(root, state_root, request):
    run_id = validate_run_id(request["runId"])
    byte_limit = request["hardQuotaBytes"]
    inode_limit = request["hardQuotaInodes"]
    if type(byte_limit) is not int or byte_limit < 1024 * 1024 or type(inode_limit) is not int or inode_limit != INODE_LIMIT:
        fail("requested quota limits are outside host policy")
    allocations = load_allocations(state_root)
    assert_workspace_registry_consistent(root, allocations)
    if run_id in allocations:
        fail("runId already has an allocation")
    used = {entry.get("project_id") for entry in allocations.values() if isinstance(entry, dict)}
    # Never assume the private registry is the only source of project IDs.
    report = run(["xfs_quota", "-x", "-c", "report -p -n", str(root)])
    for line in report.splitlines():
        fields = line.split()
        if fields and fields[0].lstrip("#").isdigit():
            existing_id = int(fields[0].lstrip("#"))
            if PROJECT_ID_MIN <= existing_id <= PROJECT_ID_MAX and existing_id not in used:
                fail("reserved project ID range contains an untracked allocation")
    project_id = next((candidate for candidate in range(PROJECT_ID_MIN, PROJECT_ID_MAX + 1) if candidate not in used), None)
    if project_id is None:
        fail("project ID allocation range exhausted")
    workspace = root / ("run-" + run_id)
    # Refuse pre-existing paths before recording ownership. The workspace root
    # is root-only, so no untrusted principal can race mkdir after this check.
    try:
        workspace.lstat()
    except FileNotFoundError:
        pass
    else:
        fail("workspace path already exists; refusing to adopt or delete it")
    # Persist the reservation before any filesystem side effect. A crash at
    # any later point is therefore recoverable by the adapter's abort call.
    allocation = {"project_id": project_id, "workspace": str(workspace), "bytes": byte_limit, "inodes": inode_limit, "status": "allocating"}
    allocations[run_id] = allocation
    save_allocations(state_root, allocations)
    try:
        workspace.mkdir(mode=0o700)
        run(["xfs_quota", "-x", "-c", "project -s -p " + str(workspace) + " " + str(project_id), str(root)])
        run(["xfs_quota", "-x", "-c", "limit -p bhard=" + str(byte_limit) + " ihard=" + str(inode_limit) + " " + str(project_id), str(root)])
        verify_quota(root, project_id, byte_limit, inode_limit)
        allocation["status"] = "active"
        save_allocations(state_root, allocations)
    except Exception:
        allocation["status"] = "needs_recovery"
        save_allocations(state_root, allocations)
        raise
    return {"ok": True, "runId": run_id, "workspacePath": str(workspace), "quotaBytes": byte_limit, "quotaInodes": inode_limit}

def dispose(root, state_root, request, abort=False):
    run_id = validate_run_id(request["runId"])
    allocations = load_allocations(state_root)
    assert_workspace_registry_consistent(root, allocations)
    entry = allocations.get(run_id)
    if entry is None:
        return {"ok": True, "runId": run_id}
    if not isinstance(entry, dict) or set(entry) - {"project_id", "workspace", "bytes", "inodes", "status"}:
        fail("allocation record is malformed")
    workspace = root / ("run-" + run_id)
    if entry.get("workspace") != str(workspace) or type(entry.get("project_id")) is not int:
        fail("allocation record does not match canonical workspace")
    if not abort and request.get("workspacePath") != str(workspace):
        fail("dispose workspace path does not match run identity")
    try:
        info = workspace.lstat()
    except FileNotFoundError:
        info = None
    if info is not None:
        if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode):
            fail("workspace is not a real directory")
        run(["xfs_quota", "-x", "-c", "project -C -p " + str(workspace) + " " + str(entry["project_id"]), str(root)])
        shutil.rmtree(workspace)
    # Reset limits before returning the project ID, even after interrupted removal.
    # A failed reset preserves the registry entry.
    run(["xfs_quota", "-x", "-c", "limit -p bhard=0 ihard=0 " + str(entry["project_id"]), str(root)])
    allocations.pop(run_id, None)
    save_allocations(state_root, allocations)
    return {"ok": True, "runId": run_id}


def main():
    if len(sys.argv) != 2 or sys.argv[1] != "--stdio-json":
        fail("only --stdio-json is supported")
    raw = sys.stdin.buffer.read(MAX_INPUT + 1)
    if len(raw) > MAX_INPUT:
        fail("request exceeds size limit")
    request = strict_json_loads(raw.decode("utf-8"))
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
        sys.stdout.write(json.dumps(reply, separators=(",", ":")) + "\n")
    finally:
        os.close(lock_fd)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        sys.stderr.write("sofia-xfs-quota-helper: " + str(error)[:500] + "\n")
        sys.exit(1)
