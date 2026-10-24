// SAMPLE_MODE entry point: the real pass (src/pipeline.ts) over sample/bundle.json through
// DataLayer(SqlJsEngine), with no model. The DQ gate, the hero query and every precondition run as
// SQL over the bundle's rows and the World Model confirms FOUND-BUT-DIFFERENT from what it recorded;
// nothing here maps an input to a stored answer. Prints one JSON finding per line, then one summary.
//
// The Decider consults the technician's memory (src/engine/memory.ts, the vendored H-MEM reference under
// .world/memory, gitignored): a lesson recorded with `npm run answer` changes the verb of the finding it
// scopes on the next run of this script, until it expires. With no lesson recorded the pass is exactly
// the one the README's numbers describe.
import { config } from "../src/config.ts";
import { DataLayer } from "../src/data/layer.ts";
import { SqlJsEngine } from "../src/data/engines/sqljs.ts";
import { TechnicianMemory } from "../src/engine/memory.ts";
import { DriftWorld } from "../src/engine/world.ts";
import { runPass } from "../src/pipeline.ts";
import { Tracer } from "../src/trace.ts";
import bundle from "../sample/bundle.json" with { type: "json" };

if (!config.sampleMode) {
  console.error("sample.ts runs with SAMPLE_MODE=true only");
  process.exit(2);
}

// model: "none" stamps model_requested on every trace line of this pass, the query lines included.
const tracer = new Tracer(`sample_${Date.now().toString(36)}`, { model: "none" });
const engine = await SqlJsEngine.create();
const counts = engine.loadBundle(bundle);
tracer.emit({ agent: "collector", action: "observe", status: "ok", output_summary: `sample/bundle.json loaded into sql.js: ${Object.entries(counts).map(([t, n]) => `${t} ${n}`).join(", ")}`, detail: "model: none (recorded, redacted rows exported from the app Postgres; see sample/bundle.json _note)" });

const memory = new TechnicianMemory({ storage: "local" });
const pass = await runPass(new DataLayer(engine), { tracer, world: new DriftWorld("sample"), memory });

for (const f of pass.findings) console.log(JSON.stringify(f));
const described = pass.findings.map((f) => {
  const fails = f.checks.filter((c) => !c.holds).map((c) => c.template);
  const exception = f.exception ? ` [exception ${f.exception.lesson} ${f.exception.status === "applied" ? `until ${f.exception.expires_at}` : `lapsed ${f.exception.expires_at}`}]` : "";
  return `${f.id} ${f.finding.class} ${f.finding.host ?? f.finding.surface} ${f.finding.object_id} ${f.finding.setting_path} -> ${f.verb} (${f.checks.length - fails.length}/${f.checks.length} preconditions hold${fails.length ? `, fails: ${fails.join(", ")}` : ""})${exception}`;
});
const mem = pass.memory ? `; memory: ${pass.memory.lessons} lesson(s), ${pass.memory.applied} exception(s) applied, ${pass.memory.lapsed} lapsed` : "";
console.log(`SAMPLE: ${pass.runs} collection runs, ${pass.gatedOut.length} failed the DQ gate (${pass.gatedOut.join(", ") || "none"}), ${pass.observed} observations in the World Model, ${pass.findings.length} finding(s): ${described.join("; ") || "none"}; judge skipped (model: none)${mem}`);
