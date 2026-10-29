# Sofia Agent backup and restore contract

## Status

The versioned integrity-manifest primitives in `src/platform/backup-manifest.ts` are an initial building block, not a complete backup/restore feature. They do not read the filesystem, create archives, encrypt data, or restore state.

## Manifest

- Format identifier: `sofia-agent-backup`
- Current format version: `1`
- Each entry records a normalized relative POSIX path, byte length, and SHA-256 digest.
- Entries are sorted by path for deterministic manifests.
- Manifest parsing rejects unsupported versions, duplicate paths, traversal and absolute paths, malformed digests, excessive entry counts, and excessive declared sizes.
- Verification fails closed when files are missing, unexpected, truncated, changed, or use unsafe paths.

## Required before production restore

1. **Explicit scope:** enumerate supported stores and exclude credentials, environment files, API keys, tokens, and provider secrets by default.
2. **Consistent snapshot:** use store-specific snapshots or quiesce writers; copying a live SQLite database without coordinating WAL/SHM can produce an inconsistent backup.
3. **Private output:** create backup directories/files with restrictive permissions and never log file contents or secrets.
4. **Archive defenses:** if archives are added, reject absolute paths, traversal, symlinks/hardlinks, duplicate normalized paths, and decompression bombs before extraction.
5. **Verify before mutation:** validate the complete manifest and every byte count/checksum before touching destination state.
6. **Safe restore:** restore into a new staging directory, enforce realpath containment, preserve the existing state until validation succeeds, and switch atomically where supported.
7. **Version compatibility:** reject unknown future versions; migrations must be additive and tested on copied fixtures.
8. **Recovery tests:** test truncated/corrupt files, checksum mismatch, duplicate paths, malicious paths, interrupted restore, disk-full errors, SQLite WAL state, and rollback behavior.
9. **Portability:** document OS-specific state paths and keep credentials out of exported bundles. A manifest checksum detects accidental changes but is not a signature and does not prove authenticity.

Do not describe Sofia as having complete automated backups until archive creation, consistent store snapshots, restore staging/rollback, and end-to-end tests exist.
