// npm run console -- [--tenant <id>] [--port <n>] [--bundle <file>] [--write] [--help]
//
// The technician's console (src/console/): a local HTTP server on 127.0.0.1, port --port, else CONSOLE_PORT, else 8090.
//
//   SAMPLE_MODE=true   sql.js over the bundle (--bundle, default sample/bundle.json), the lessons of DRIFT_MEMORY_DIR
//                      (examples/memory when blank) read only, the tenant --tenant, else CONSOLE_TENANT, else the first
//                      tenant of the bundle's runs. The sample's own pass runs first, at the bundle's decision instant,
//                      as npm run sample decides. Unlock, Approve, Lock and Run a pass write into the sql.js engine and
//                      live for this process; Record exception writes the lesson store only with --write.
//   live               the app Postgres on DATABASE_URL (sql/schema.sql applied first, CREATE TABLE IF NOT EXISTS, then
//                      the Store's migrations, so change_window and disposition.window_id exist), every read through
//                      Zetaris, the tenant --tenant or CONSOLE_TENANT. At start it checks that Zetaris lists
//                      change_window and reads disposition.window_id, and prints one line naming npm run zetaris:setup
//                      when either is missing. A dry pass starts in the background; Run a pass runs another. The
//                      console never runs act.
//
// Prints one line when it listens (and, live, one more when Zetaris lacks what the windows need) and one per action;
// stops on SIGINT or SIGTERM.
// Exit 2 on a usage error or when live mode lacks REDACT_SALT, DATABASE_URL or ZETARIS_API_KEY; 1 when it cannot start.

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { config, redact } from "../src/config.ts";
import { DEFAULT_PORT, startConsole } from "../src/console/server.ts";
import { liveBackend, liveRefusal, sampleBackend, zetarisGaps, type Backend } from "../src/console/state.ts";
import { TENANT_ID, TENANT_ID_SHAPE } from "../src/policy/schema.ts";
import { exitOnConfigError } from "../src/cli.ts";

exitOnConfigError();

const USAGE = "usage: npm run console -- [--tenant <id>] [--port <n>] [--bundle <file>] [--write] [--help]";

function usage(msg: string): never {
  console.error(`console: ${msg}\n${USAGE}`);
  process.exit(2);
}

let args: { tenant?: string; port?: string; bundle?: string; write?: boolean; help?: boolean };
try {
  args = parseArgs({ options: { tenant: { type: "string" }, port: { type: "string" }, bundle: { type: "string" }, write: { type: "boolean" }, help: { type: "boolean" } } }).values;
} catch (e) {
  usage((e as Error).message);
}
if (args.help) {
  console.log(USAGE);
  console.log("Serves the technician's console on 127.0.0.1: the owner's report, every setting with its lock and approval, the findings, the actions and tickets, the traces and the sources; Unlock, Approve, Lock, Record exception and Run a pass. SAMPLE_MODE=true reads the recorded bundle on sql.js.");
  process.exit(0);
}
const portText = args.port ?? process.env.CONSOLE_PORT ?? String(DEFAULT_PORT);
const port = Number(portText);
if (!/^\d{1,5}$/.test(portText) || port < 1 || port > 65535) usage(`the port is 1 to 65535, got ${portText}`);
const tenantGiven = args.tenant ?? process.env.CONSOLE_TENANT;
if (tenantGiven !== undefined && !TENANT_ID.test(tenantGiven)) usage(`the tenant must be ${TENANT_ID_SHAPE}, got ${tenantGiven}`);
if (!config.sampleMode && args.bundle) usage("--bundle is for sample mode (SAMPLE_MODE=true); live mode reads the app Postgres through Zetaris");
if (!config.sampleMode && args.write) usage("--write is for sample mode; live mode records exceptions into DRIFT_MEMORY_DIR");

let backend: Backend;
try {
  if (config.sampleMode) {
    const bundlePath = args.bundle ?? "sample/bundle.json";
    const bundle = JSON.parse(readFileSync(bundlePath, "utf8")) as Record<string, unknown>;
    const runs = (bundle.collection_run ?? []) as { tenant_id: string }[];
    const tenant = tenantGiven ?? [...new Set(runs.map((r) => r.tenant_id))].sort()[0];
    if (!tenant) usage(`${bundlePath} holds no collection run, so no tenant`);
    if (!runs.some((r) => r.tenant_id === tenant)) usage(`${bundlePath} holds no run of tenant ${tenant}`);
    backend = await sampleBackend({ tenant, bundle, bundlePath, memoryDir: config.memoryDir, write: args.write === true });
  } else {
    if (!tenantGiven) usage("live mode needs a tenant: --tenant <id> or CONSOLE_TENANT");
    const refused = liveRefusal();
    if (refused) usage(refused);
    backend = await liveBackend({ tenant: tenantGiven });
  }
} catch (e) {
  console.error(`console: ${redact((e as Error).message ?? String(e))}`);
  process.exit(1);
}

const t0 = Date.now();
let server: Awaited<ReturnType<typeof startConsole>>;
try {
  server = await startConsole({ backend, port, firstPass: backend.mode === "sample" ? "sync" : "background" });
} catch (e) {
  const err = e as NodeJS.ErrnoException;
  console.error(err.code === "EADDRINUSE" ? `console: port ${port} on 127.0.0.1 is in use; --port or CONSOLE_PORT names another` : `console: ${redact(err.message ?? String(e))}`);
  await backend.close().catch(() => undefined);
  process.exit(1);
}
console.log(`console: ${backend.mode === "sample" ? "sample mode" : "live"}, tenant ${backend.tenant}, ${backend.source}${backend.mode === "sample" ? `, the sample's pass decided at ${backend.sampleInstant}` : ", the first dry pass running"}; ${((Date.now() - t0) / 1000).toFixed(1)} s`);
console.log(`console: ${server.url}/  (Ctrl+C stops it)`);
if (backend.mode === "live") {
  const gaps = await zetarisGaps(backend).catch(() => [] as string[]);
  if (gaps.length) console.log(`console: Zetaris does not read ${gaps.join(" or ")}; npm run zetaris:setup registers the table and refreshes the columns, and until it runs Unlock is refused`);
}

const stop = async (): Promise<void> => {
  console.log("console: stopping");
  await server.close().catch(() => undefined);
  process.exit(0);
};
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
