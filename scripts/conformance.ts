// Run the official Meterless World Model conformance suite against OUR module (src/engine/world.ts).
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const impl = path.resolve(here, "..", "src", "engine", "world.ts");
const runner = path.resolve(here, "..", "vendor", "world-model", "conformance", "runner.ts");

const r = spawnSync(process.platform === "win32" ? "npx.cmd" : "npx", ["tsx", runner], {
  stdio: "inherit",
  env: { ...process.env, WORLD_MODEL_IMPL: impl.replace(/\\/g, "/") },
  shell: process.platform === "win32",
});
process.exit(r.status ?? 1);
