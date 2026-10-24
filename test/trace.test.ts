// The real Tracer against a temp LOG_DIR: every free-text field (input_summary, output_summary, detail)
// goes through the redactor, the written line equals the returned event, the per-instance model default
// lands on every event that names none, and the agent's own dotted vocabulary survives the pass.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const dir = mkdtempSync(path.join(tmpdir(), "drift-trace-"));
process.env.LOG_DIR = dir;
const { Tracer } = await import("../src/trace.ts");

const H6 = "[0-9a-f]{6}";

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("Tracer", () => {
  it("pseudonymises input_summary, output_summary and detail alike, and writes that same line to LOG_DIR", () => {
    const t = new Tracer("test_trace", { model: "none" });
    const text = "proxy_pass http://app.bluefin-logistics-zz9q.com:8080 from 10.40.12.7 by ops@bluefin-logistics-zz9q.com";
    const e = t.emit({ agent: "t", action: "observe", status: "ok", input_summary: text, output_summary: text, detail: text });
    for (const k of ["input_summary", "output_summary", "detail"] as const) {
      expect(e[k]).toMatch(new RegExp(`^proxy_pass http://host-${H6}\\.com:8080 from ip-${H6} by mail-${H6}@domain-${H6}$`));
    }
    expect(e.model_requested).toBe("none");
    const lines = readFileSync(path.join(dir, "test_trace.jsonl"), "utf8").trim().split("\n");
    expect(JSON.parse(lines.at(-1)!)).toEqual(e);
  });

  it("leaves the agent's own vocabulary alone: surfaces, setting paths, SQL aliases, documentation names", () => {
    const t = new Tracer("test_trace_vocab");
    const kept = [
      "linux.nginx host-7f1c: 2/2 complete",
      "cloudflare.dns: 3/3 complete",
      "server.location./.proxy_pass in /etc/nginx/conf.d/app.conf on host-7f1c is byte-identical since 2026-10-20T02:01:01.000Z",
      "SELECT o.host, o.object_id, d.name, d.content, e2.actor FROM observation o JOIN DRIFT.observation x ON 1 = 1",
      "app.example.invalid resolved to 198.51.100.10 then and to 203.0.113.77 now, an address not in the inventory",
      "sample/bundle.json loaded into sql.js: collection_run 12, observation 12",
    ];
    for (const s of kept) expect(t.emit({ agent: "t", action: "detect", status: "ok", output_summary: s }).output_summary).toBe(s);
  });

  it("a caller-set model_requested wins over the instance default; no default, no field", () => {
    const t = new Tracer("test_trace_model", { model: "none" });
    expect(t.emit({ agent: "t", action: "model_call", status: "ok", model_requested: "x/ultra" }).model_requested).toBe("x/ultra");
    expect(new Tracer("test_trace_nomodel").emit({ agent: "t", action: "spike", status: "ok" }).model_requested).toBeUndefined();
  });
});
