# Pre-existing and third-party code

Everything in this repository was written during the GenAI Works Open Agent Hackathon 2026 build window
(from 22 Oct 2026 00:00 UTC), with one exception, declared here.

## Vendored: Meterless World Model reference implementation

| | |
|---|---|
| Path | `vendor/world-model/` |
| Upstream | https://github.com/Meterless/Meterless, `engines/world-model/reference` and `engines/world-model/conformance` |
| Upstream commit | `1742dec56a66e58eef9dda2d2b865823758ca8cd` |
| Licence | Apache-2.0, copyright 2026 Meterless. Full text in `vendor/world-model/LICENSE` |
| NOTICE | Upstream ships no NOTICE file at that commit, so there is none to carry |

What we changed, per Apache-2.0 section 4(b):

- Copied `reference/src`, `reference/test`, `reference/package.json`, `reference/tsconfig.json`, `reference/README.md`.
- Copied `conformance/runner.ts` and `conformance/README.md` into `vendor/world-model/conformance/`, unmodified.
- Copied the engine contract `engines/world-model/AGENTS.md` as `vendor/world-model/CONTRACT.md` (renamed so coding agents
  working in this repo do not read it as instructions for this repo). Content unmodified.
- Did not copy `reference/scripts/` (browser bundle build, live app) or `reference/package-lock.json`. Not needed.
- No source file under `vendor/world-model/src` is modified. Our code wraps it from `src/engine/world.ts`.

## Libraries

Runtime and dev dependencies are installed from npm and listed in `package.json`. None are copied into the repo.

## Not used

The author's earlier research repo (`config-drift`) contributed design notes only. No code from it was opened,
copied or translated into this repository.
