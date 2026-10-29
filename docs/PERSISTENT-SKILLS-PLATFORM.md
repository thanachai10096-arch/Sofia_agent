# Persistent skills platform

Sofia keeps the existing InMemorySkillsPlatform unchanged. FileSkillsPlatform is an optional implementation of the same SkillsPlatform interface for applications that need skill metadata to survive process restarts.

## Use

    import { FileSkillsPlatform } from "sofia-agent";

    const skills = new FileSkillsPlatform("/var/lib/sofia/skills.json");

The path must be absolute. The store writes a versioned JSON document using a same-directory temporary file and atomic rename, and requests restrictive file permissions on POSIX systems. Returned packages are defensive copies.

## Boundaries

- This is a local, single-process registry, not a multi-host distributed store. Do not share one file across concurrent processes.
- The store persists metadata and skill procedures; it does not install, evaluate, or execute skills.
- External or learned skill content remains untrusted. Promotion, execution, permissions, and approval must remain controlled by Sofia's existing skill and tool policy paths.
- Back up the file before manual edits. Unsupported or malformed data fails closed rather than being silently overwritten.


## Verified workflow memory

When Brain has a project memory store and a project context, it records a compact advisory workflow pattern only after at least one acceptance criterion has passed with verification evidence. The record includes the task objective, task type, tool names, step objectives, and evidence IDs. It intentionally excludes tool arguments and tool outputs, which may contain user data or secrets.

Workflow memory is stored as a project decision entry and can be retrieved by the existing project-memory search for future planning context. It is not an executable skill and does not grant tool permissions. Saving is best-effort: a memory-store failure must not turn a verified completed task into a failed task. Learned skill promotion remains governed separately by the versioned skill lifecycle and its approval policy.
