# Sofia Agent: Open-Source and Commercial Model

## Current license

The repository currently declares the **MIT License** in `LICENSE` and `package.json`. MIT permits use, modification, redistribution, and commercial use subject to its notice and warranty terms. This is the current repository license, not a legal opinion about every file, dependency, asset, trademark, or future hosted service.

Before making a public release, maintainers should verify the provenance and license of all included character artwork, fonts, icons, documentation, vendored files, and dependencies. The root MIT license must not be presented as automatically relicensing third-party material.

## Product principle

Keep the core agent runtime open and useful on its own. Commercial offerings should add operational value rather than artificially disable core functionality or create an incompatible second agent.

### Open-source repository (community)

Intended to include:
- agent runtime and shared execution lifecycle;
- documented API/SDK contracts and local development workflows;
- tool permission and approval primitives;
- local runtime integrations and reproducible tests;
- core adapters and contribution/security documentation;
- self-hosting guidance and example configurations.

Exact availability is determined by code actually present and supported in this repository. Roadmap items are not current capabilities.

### Potential paid services (not implied to exist today)

- managed hosted Sofia, with operations, upgrades, monitoring, and backups;
- organization/team controls, SSO, centralized policy, and audit retention;
- enterprise deployment support, SLAs, compliance assistance, and private networking;
- managed durable queues, multi-region availability, and usage analytics;
- paid cloud execution capacity, storage, and model-provider usage;
- marketplace distribution, premium integrations, and support plans.

These are product hypotheses and require implementation, security review, cost modelling, and clear terms before being advertised or sold.

## Shared-core rule

Web, desktop, mobile, chat channels, and third-party SDKs should call the same versioned Sofia API and core runtime. Adapters may handle transport-specific authentication, formatting, reconnects, and identity mapping; they must not bypass core authorization, approvals, or tool policy.

## Cost and provider boundaries

- Model/API usage may incur third-party charges even when Sofia itself is free.
- Self-hosted users control their own infrastructure and provider credentials.
- Hosted Sofia must enforce per-user/org quotas, rate limits, spending caps, and transparent usage records.
- Never bundle a privileged provider key in a public client or distribute one shared master key to end users.

## Before introducing a separate commercial license

If maintainers later consider a source-available or enterprise-only license for any component, they should first document exactly which files and versions are affected, obtain legal review, explain the change publicly, and preserve clear license notices for existing releases. Do not describe a non-open-source restriction as “open source.”

## Release checklist

- [ ] Verify license and provenance of every included asset and third-party component.
- [ ] Generate and review an SBOM and dependency license report.
- [ ] Add release notes, versioning, support policy, and security contact.
- [ ] Validate installation from a clean checkout and a published package.
- [ ] Distinguish implemented capabilities from roadmap items.
- [ ] Document hosted-service pricing, data retention, privacy, and cancellation before accepting payment.
