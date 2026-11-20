# Vendored Agent-Reach

- Upstream project: https://github.com/Panniantong/Agent-Reach
- Upstream source version: 1.6.1
- License: MIT; see [LICENSE](./LICENSE).
- Python package source is kept under `agent_reach/`.
- Sofia's direct integration entry point is `sofia_bridge.py`; Sofia imports and dispatches the upstream channel classes in-process through the Python interpreter. It does not call the separately installed `agent-reach` CLI.
- Runtime dependencies are listed in [requirements.txt](./requirements.txt).
- Local bridge changes are intentionally isolated from the upstream package files to make future upstream updates reviewable.

When updating this vendored snapshot, preserve the upstream MIT notice, review upstream changes for new network and browser behaviors, update the source version here, and run Sofia's bridge tests before enabling it in Staging.
