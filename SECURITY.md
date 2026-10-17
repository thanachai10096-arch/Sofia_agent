# Security Policy

Sofia Agent is an agent runtime that can interact with files, tools, networks, and external services. Security reports are especially important.

## Reporting a vulnerability

Please do not publish exploitable details in a public issue before maintainers have had a reasonable chance to investigate.

Use GitHub's **Private vulnerability reporting** feature for this repository if it is enabled. If it is unavailable, contact the repository owner through a private channel listed on the owner's GitHub profile and include **Sofia Agent security report** in the subject. Do not include live credentials or unrelated personal data.

Include, where safe:
- affected commit, release, platform, and configuration;
- impact and prerequisites;
- minimal reproduction steps or a proof of concept;
- logs with secrets and personal data removed;
- a suggested mitigation, if known.

## Scope and priorities

Examples of in-scope issues:
- authentication, authorization, run ownership, or scope bypass;
- workspace escape, unsafe path/symlink handling, or unintended file access;
- shell, browser, network, sandbox, or approval-policy bypass;
- secret leakage, unsafe logging, or cross-user data exposure;
- job recovery or replay bugs that violate access control or integrity.

Do not test against systems, accounts, or data you do not own or have permission to assess.

## Response expectations

Maintainers will make a best effort to acknowledge reports, reproduce the issue, assess severity, and coordinate a fix and disclosure. No response-time SLA is promised until a maintained security response process is established.

## Safe defaults

- Keep privileged API keys on trusted servers.
- Treat prompts, files, tool output, browser content, and provider events as untrusted input.
- Use explicit least-privilege permissions and approval gates.
- Never assume a feature is sandboxed or secure merely because documentation describes it as such; verify the implementation and tests.
