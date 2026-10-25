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
- `npm test` checks each of the 14 files under `vendor/world-model/` against its git blob id at the upstream commit
  (`vendor/UPSTREAM.json`, `test/vendor.test.ts`); `gh api repos/Meterless/Meterless/git/trees/1742dec56a66e58eef9dda2d2b865823758ca8cd?recursive=1`
  lists the same ids.

## Vendored: Meterless H-MEM reference implementation

| | |
|---|---|
| Path | `vendor/hmem/` |
| Upstream | https://github.com/Meterless/Meterless, `engines/hmem/reference` and `engines/hmem/conformance` |
| Upstream commit | `1742dec56a66e58eef9dda2d2b865823758ca8cd` (the same clone and commit as the World Model entry) |
| Licence | Apache-2.0, copyright 2026 Meterless. Full text in `vendor/hmem/LICENSE` (byte-identical to `vendor/world-model/LICENSE`) |
| NOTICE | Upstream ships no NOTICE file at that commit, neither at the repository root nor under `engines/hmem`, so there is none to carry |

What we changed, per Apache-2.0 section 4(b):

- Copied `reference/src` (ten files), `reference/test/smoke.test.ts`, `reference/package.json`, `reference/tsconfig.json`,
  `reference/README.md`, flattened into `vendor/hmem/` the way `vendor/world-model/` is.
- Copied `conformance/runner.ts`, `conformance/README.md` and `conformance/vectors/vectors.json` into
  `vendor/hmem/conformance/`, unmodified. The runner loads the implementation named by `HMEM_IMPL`; ours is
  `src/engine/memory.ts` (`npm run conformance:hmem`, 13 checks).
- Copied the engine contract `engines/hmem/AGENTS.md` as `vendor/hmem/CONTRACT.md` (renamed so coding agents working in
  this repo do not read it as instructions for this repo). Content unmodified.
- Did not copy `engines/hmem/CLAUDE.md` (two lines pointing at AGENTS.md, written to be auto-loaded as instructions),
  `reference/package-lock.json`, `HOW_TO_USE_H-MEM.md`, `docs/`, `examples/`, `workshops/`, `content/`, `demos/`, `evals/`
  or `images/`. Not needed by the runner or by our module.
- No source file under `vendor/hmem/src` is modified. Our code wraps it from `src/engine/memory.ts`.
- `npm test` checks each of the 19 files under `vendor/hmem/` against its git blob id at the upstream commit
  (`vendor/UPSTREAM.json`, `test/vendor.test.ts`); `gh api repos/Meterless/Meterless/git/trees/1742dec56a66e58eef9dda2d2b865823758ca8cd?recursive=1`
  lists the same ids.

## Libraries

Runtime and dev dependencies are installed from npm and listed in `package.json`. None are copied into the repo.

## Not used

The author's earlier research repo (`config-drift`) contributed design notes only. No code from it was opened,
copied or translated into this repository.
