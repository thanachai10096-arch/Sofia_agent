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
