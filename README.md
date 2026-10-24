# drift-agent

Config-drift assurance for MSP technicians. Three questions, asked of real servers and real DNS:

1. What changed since the last backup?
2. Would a restore regress anything?
3. Where does this system drift from golden, including FOUND-BUT-DIFFERENT: a reference that is byte-identical
   while the thing it points at has changed.

Each finding ends in one verb: ADOPT, HOLD (with an expiry) or ESCALATE. The agent is read-only. It never enforces.

Entry for the GenAI Works Open Agent Hackathon 2026, Track 1 (Solving Fragmented Intelligence).

## Status

Spikes only. `npm run smoke` proves the three sponsor paths:

| Spike | Proves |
|---|---|
| A, Zetaris | Lightning SQL over REST, two differently sourced tables joined in one statement |
| B, Nightshift | Nemotron Lightning and Ultra by explicit id, signed receipts verified, job event stream read |
| C, World Model | Vendored Meterless World Model passes the official conformance suite through our wrapper; the FOUND-BUT-DIFFERENT primitive works on bitemporal snapshots |

## Run

```bash
npm install
cp .env.example .env   # fill in ZETARIS_API_KEY; the Nightshift token is read from its local file
npm run smoke
```

`SAMPLE_MODE=true` runs the real logic against bundled sample data with no credentials.

Every model call is appended to `logs/trace.jsonl`.

## Decisions

Appended as spikes settle. Newest last.

- 2026-10-23: TypeScript on Node 22+ ESM, run with tsx, tested with vitest. The dev machine runs Node 26; `engines` says `>=22`.
- 2026-10-23: `.env` loads through `process.loadEnvFile` (built into Node), so no dotenv dependency.
- 2026-10-23: Nightshift measured live. Explicit `nvidia/*` ids are honoured and named in the receipt; `meterless/fast|deep|judge` all route to the race lane first, so the app requests models by id. Lightning on the free tier returns `empty_response` (502) on about 1 in 4 raw calls (2 of 8 measured); one retry recovered every case, so the adapter retries once and the agent falls back deterministically after that. Ultra answers in 2 to 4 s and puts its reasoning in `content` terminated by `</think>`, with the JSON after it; `extractJson` strips through the last `</think>` first. All 30 runtime receipts verified offline (Ed25519 over the compact key-sorted body). `GET /v1/jobs/{id}/events` is a live SSE stream; failed turns appear there with `ok:false` and no receipt.
- 2026-10-23: World Model reference writes `assertFact` values onto `entity.attrs` only in live state; snapshots replay facts but not attrs. Our `fingerprintAt` therefore reads the latest `fingerprint` fact at or before the time, not attrs. Vendor untouched; conformance 8/8 through `src/engine/world.ts`.
- 2026-10-23: Zetaris REST shape is `{headers, data, total, timeUsed}`, every value a string. The normaliser is written to that. Nemotron is also served through Nightshift via OpenRouter: measured 12/12 at 1 to 2 s median against NVIDIA's free endpoint at 4/6 and 7.5 s, so the primary routes are `openrouter/nvidia/nemotron-*` and the adapter walks a failover ladder (cloud paid, cloud free, local) with every hop receipted and traced as `fallback`.
- 2026-10-23: Zetaris access is denied by default per object. The first API key authenticated for org 1 and ran `SELECT 1` but saw zero Lightning databases over both the direct REST and UI-proxy routes, so the agent's key needs either an administrator's key or a General-role user with explicit SELECT grants on the registered sources. Spike A is blocked on that grant, not on the client.
