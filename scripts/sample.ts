// SAMPLE_MODE entry point. Today it proves the no-credential path exists and exercises the real
// FOUND-BUT-DIFFERENT logic on bundled observations; the agent loop grows into it. It must never
// replay a stored answer for a stored input.
import { DriftWorld } from "../src/engine/world.ts";
import { Tracer } from "../src/trace.ts";
import sample from "../sample/observations.json" with { type: "json" };

if (process.env.SAMPLE_MODE !== "true") {
  console.error("sample.ts runs with SAMPLE_MODE=true only");
  process.exit(2);
}

const tracer = new Tracer(`sample_${Date.now().toString(36)}`);
const world = new DriftWorld("sample");
for (const o of sample.observations) await world.observe(o as any);
tracer.emit({ agent: "collector", action: "observe", status: "ok", output_summary: `${sample.observations.length} recorded observations loaded (model: none)` });

let findings = 0;
for (const probe of sample.probes) {
  const sid = world.settingId(probe);
  const r = world.foundButDifferent(sid, probe.before, probe.after);
  tracer.emit({ agent: "detector", action: "detect", status: "ok", input_summary: `${probe.surface} ${probe.objectId} ${probe.settingPath}`, output_summary: r.changed ? `FOUND-BUT-DIFFERENT: ${r.before} -> ${r.after}` : "reference stable", detail: "model: none (sample deterministic)" });
  if (r.changed) findings++;
}
console.log(`SAMPLE: ${sample.observations.length} observations, ${sample.probes.length} probes, ${findings} found-but-different finding(s)`);
