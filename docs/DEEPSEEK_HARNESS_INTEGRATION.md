# DeepSeek Harness integration in Sofia

Sofia remains the single agent runtime. This integration takes the compositional
ideas from DeepSeek Harness/Cordis and implements a small native host at
`src/integrations/deepseek-harness/plugin-host.ts`; it does not launch a second
agent, a second server, or a child CLI.

## What is integrated now

- In-process plugin identity and duplicate protection.
- A live Tool Registry backed by the plugin host, so plugins installed after startup are visible to subsequent Sofia runs.
- The host is exposed on `AgentDependencies.pluginHost` for trusted host-side plugin installation and unloading.
- Tool and service registration through a plugin-scoped context.
- Reversible registration effects and reverse-order teardown.
- Rollback of partial registrations when plugin installation fails.
- Typed install/uninstall lifecycle events and runtime plugin unloading.
- Versioned plugin manifests with declared capabilities and install-time validation of explicitly declared tool effects.
- Dependency ordering: required plugins must be installed first, and providers cannot be unloaded while installed dependents remain.
- Cleanup continues across failures; teardown reports aggregated cleanup errors.
- Plugin tools enter Sofia's existing Tool Registry and continue through the
  existing Tool Gateway, approval, execution policy, audit, and workspace
  runtime. Plugins do not bypass those controls.

## Deliberate boundary

The upstream DeepSeek Harness is a complete TypeScript monorepo with a separate
Cordis-based application composition, session implementation, model adapters,
and desktop/web products. Copying its whole tree into Sofia would duplicate
agent loops, sessions, model routing, tool execution, and host runtimes. That
would create two competing authorities rather than one unified Sofia.

This first integration therefore ports the plugin lifecycle boundary only.
Sofia's existing Agent, durable jobs, sessions, tenant isolation, Model Router,
Tool Gateway, and approval/security layers remain authoritative. No upstream
web/desktop application, CLI launcher, or independent agent loop is embedded.

## Upstream attribution

The plugin lifecycle and composition design is informed by DeepSeek Harness
and its vendored Cordis framework. DeepSeek Harness is MIT-licensed. Cordis is
MIT-licensed and copyright Shigma (2021-present). This native Sofia host is an
independent implementation of the integration boundary; it is not a verbatim
copy of Cordis source.

- https://github.com/deepseek-ai/deepseek-harness
- https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cordis-primer.md
- https://github.com/deepseek-ai/deepseek-harness/blob/master/vendor/cordis/LICENSE

## Next integration stages

1. Move messaging and MCP adapters behind native plugins so every capability
   uses the same registration lifecycle. Browser and desktop tools are already
   registered in a short-lived host per Brain run.
2. Bridge plugin lifecycle events to Sofia's existing run/step/tool event stream.
3. Add tenant-scoped process plugin instances, principal-bound grants, and scoped service injection. Manifest declarations are metadata/validation, not a replacement for host authorization.
4. Add per-plugin capability manifests and approval metadata.
5. Evaluate selective upstream source vendoring only where it is compatible
   with Sofia's Node >=20 runtime and does not duplicate core authority.
