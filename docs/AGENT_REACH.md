# Sofia Internet Reach (vendored Agent-Reach)

Sofia includes the upstream Agent-Reach Python package in `vendor/agent-reach/agent_reach` under its MIT license. Upstream: https://github.com/Panniantong/Agent-Reach (version 1.6.1 source snapshot).

## Integrated execution

- Sofia calls the vendored Python modules through `vendor/agent-reach/sofia_bridge.py`; it does **not** invoke or require a separately installed `agent-reach` executable.
- Tools are registered in Sofia's normal Tool Registry and executed by the existing WorkspaceRuntime and Tool Gateway.
- The worker image needs Python 3.10+ and the pinned/minimum dependencies in `vendor/agent-reach/requirements.txt`. Provision them as part of the Sofia image/build, not by running an interactive setup at service startup.
- The bridge exposes channel discovery, URL reading and channel actions. Mutating social actions are blocked.
- Search/read results are untrusted reference data. Sofia's Brain must not treat page text as system instructions.
- Network access remains subject to Sofia's execution policy and host egress controls. URL validation in the TypeScript adapter is a first check, not a substitute for DNS-aware egress/SSRF protection.

## Included upstream channels

GitHub, web search/read, YouTube, Reddit, Bilibili, V2EX, Xueqiu, Xiaohongshu, Xiaoyuzhou, LinkedIn, Boss, Twitter/X, Facebook and Instagram. Availability varies by backend, login state, upstream changes and optional system tools. Some channels require additional browser/tool prerequisites or user-managed sessions; these are not silently installed by Sofia.

## Validation

- Verify Python import and bridge protocol in CI.
- Verify public web read and GitHub repository read in staging.
- Verify channel failures return normalized errors without leaking credentials.
- Keep Production unchanged until Staging acceptance passes.
