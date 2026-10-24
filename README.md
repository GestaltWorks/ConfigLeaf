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
