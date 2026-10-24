// SAMPLE_MODE entry point: the real pass (src/pipeline.ts) over sample/bundle.json through
// DataLayer(SqlJsEngine), with no model. The DQ gate, the hero query and every precondition run as
// SQL over the bundle's rows and the World Model confirms FOUND-BUT-DIFFERENT from what it recorded;
// nothing here maps an input to a stored answer. Prints one JSON finding per line, then one summary.
import { config } from "../src/config.ts";
import { DataLayer } from "../src/data/layer.ts";
import { SqlJsEngine } from "../src/data/engines/sqljs.ts";
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
tracer.emit({ agent: "collector", action: "observe", status: "ok", output_summary: `sample/bundle.json loaded into sql.js: ${Object.entries(counts).map(([t, n]) => `${t} ${n}`).join(", ")}`, detail: "model: none (bundled, redacted rows; shapes real, values authored)" });

const pass = await runPass(new DataLayer(engine), { tracer, world: new DriftWorld("sample") });

for (const f of pass.findings) console.log(JSON.stringify(f));
const described = pass.findings.map((f) => {
  const fails = f.checks.filter((c) => !c.holds).map((c) => c.template);
  return `${f.finding.class} ${f.finding.host} ${f.finding.object_id} ${f.finding.setting_path} -> ${f.verb} (${f.checks.length - fails.length}/${f.checks.length} preconditions hold${fails.length ? `, fails: ${fails.join(", ")}` : ""})`;
});
console.log(`SAMPLE: ${pass.runs} collection runs, ${pass.gatedOut.length} failed the DQ gate (${pass.gatedOut.join(", ") || "none"}), ${pass.observed} observations in the World Model, ${pass.findings.length} finding(s): ${described.join("; ") || "none"}; judge skipped (model: none)`);
