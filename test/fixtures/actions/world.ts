// The Actor's test world, built from test/fixtures/policy-bundle.json: a vault in a temp directory holding the
// fixture's nginx runs (the file rows' bodies are the files, and they hash to their value_hash) and its DNS runs
// (one record JSON per dns_record row), the bundle's vault_copy rows pointed at those real commits, and the pass run
// over it into an in-memory ledger. The vhosts app.conf and blog.conf get their server_name rows (each body names
// its one name), so the names they serve can be probed. The live side starts as the 23 Oct runs recorded it: the
// fake host holds the drifted files and lacks blog.conf, the fake Cloudflare zone holds the drifted record.
// Documentation names and addresses only.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MemoryActionSink, type ActorDeps } from "../../../src/actions/act.ts";
import { dispositionOf } from "../../../src/actions/plan.ts";
import { DISPOSITIONS_SQL, objects } from "../../../src/data/queries.ts";
import type { Probe, ProbeKind } from "../../../src/data/rows.ts";
import { Cloudflare, type CfRecord, type CfZone } from "../../../src/collectors/cloudflare.ts";
import { DataLayer } from "../../../src/data/layer.ts";
import { SqlJsEngine } from "../../../src/data/engines/sqljs.ts";
import { AUTHORITY, obsId, probeId, type Disposition, type Observation } from "../../../src/data/rows.ts";
import { DriftWorld } from "../../../src/engine/world.ts";
import { MemoryLedger } from "../../../src/ledger.ts";
import { runPass, type PassResult } from "../../../src/pipeline.ts";
import { Redactor } from "../../../src/redactor.ts";
import { recordJson } from "../../../src/vault/hook.ts";
import { CLOUDFLARE_REPO, Vault } from "../../../src/vault/vault.ts";
import policyBundle from "../policy-bundle.json" with { type: "json" };
import { MemTracer } from "../mem-tracer.ts";
import { CF_TOKEN, fakeCloudflare, type FakeCloudflare } from "./fake-cloudflare.ts";
import { FakeHost } from "./fake-host.ts";
import { FakeModel } from "./fake-model.ts";

export const TENANT = "client-a";
export const HOST = "host-7f1c";
export const ALIAS = "fixture-host";
export const AT = "2026-10-23T03:00:00.000Z";
export const SALT = "policy-fixture-salt";
export const ZONE = "example.invalid";
export const ZONE_ID = "zone-0001";
export const APP = "/etc/nginx/conf.d/app.conf";
export const SHOP = "/etc/nginx/conf.d/shop.conf";
/** Approved and observed on 20 Oct, absent from the 23 Oct run: the fixture's approved_missing file. */
export const BLOG = "/etc/nginx/conf.d/blog.conf";
export const NGINX_RUNS = ["run-nginx-7f1c-1020", "run-nginx-7f1c-1023"] as const;
export const DNS_RUNS = ["run-dns-1020", "run-dns-1023"] as const;

type B = typeof policyBundle;
type Rec = B["dns_record"][number];
const cfOf = (d: Rec): CfRecord => ({ id: d.record_id, name: d.name, type: d.type, content: d.content, ...(d.ttl === null ? {} : { ttl: d.ttl }), ...(d.proxied === null ? {} : { proxied: d.proxied === 1 }) });

/** The vault and the bundle pointed at it, built once per test file: the Actor only reads the vault. */
export interface Base {
  root: string;
  redactor: Redactor;
  vault: Vault;
  commits: Record<string, string>;
  bundle: B;
  cleanup(): void;
}

export interface World extends Omit<Base, "cleanup"> {
  engine: SqlJsEngine;
  layer: DataLayer;
  pass: PassResult;
  dispositions: Disposition[];
  /** The live side: files of the host as run 1023 recorded them, records of the zone as dns run 1023 did. */
  host: FakeHost;
  cf: FakeCloudflare;
  model: FakeModel;
  probes: { names: string[]; kinds: ProbeKind[] }[];
  /** Names whose probes answer fail. */
  failing: Set<string>;
  tracer: MemTracer;
  deps(over?: Partial<ActorDeps>): ActorDeps;
  cleanup(): void;
}

export function buildBase(): Base {
  const root = mkdtempSync(path.join(tmpdir(), "drift-actions-"));
  const redactor = new Redactor(SALT);
  const vault = new Vault(root, redactor);
  const bundle = structuredClone(policyBundle) as B;
  const runOf = (id: string) => bundle.collection_run.find((r) => r.run_id === id)! as Parameters<Vault["commitRun"]>[0]["run"];
  const fileRows = (run: string) => bundle.observation.filter((o) => o.run_id === run && o.setting_path === "file");

  // the server_name each body states, in every run that holds the file
  for (const run of NGINX_RUNS) {
    for (const [object, name] of [[APP, "app.example.invalid"], [BLOG, "blog.example.invalid"]] as const) {
      const file = fileRows(run).find((o) => o.object_id === object);
      if (!file) continue;
      const setting = `server[${name}:443].server_name[${name}]`;
      (bundle.observation as Observation[]).push({
        obs_id: obsId(run, object, setting), run_id: run, tenant_id: TENANT, surface: "linux.nginx", host: HOST, object_id: object, setting_path: setting,
        value_hash: redactor.fingerprint(name), value_redacted: name, refers_to_type: "dns_name", refers_to_id: name, observed_at: file.observed_at, source: "ssh", authority: AUTHORITY.live,
      });
    }
  }

  const commits: Record<string, string> = {};
  for (const run of NGINX_RUNS) {
    const files = fileRows(run).map((o) => ({ path: o.object_id, objectId: o.object_id, bytes: Buffer.from(o.value_redacted!, "utf8") }));
    commits[run] = vault.commitRun({ tenantId: TENANT, repo: ALIAS, run: runOf(run), files }).commit;
  }
  for (const run of DNS_RUNS) {
    const files = bundle.dns_record.filter((d) => d.run_id === run).map((d) => ({ path: `${ZONE}/${d.record_id}.json`, objectId: d.record_id, bytes: Buffer.from(recordJson(cfOf(d)), "utf8") }));
    commits[run] = vault.commitRun({ tenantId: TENANT, repo: CLOUDFLARE_REPO, run: runOf(run), files }).commit;
  }
  for (const c of bundle.vault_copy) c.git_commit = commits[c.run_id];
  return { root, redactor, vault, commits, bundle, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** A fresh ledger, live side and fakes over the shared vault. */
export async function buildWorld(base: Base, opts: { cf?: { failWrites?: boolean; nextId?: string }; drop?: string[] } = {}): Promise<World> {
  const { root, redactor, vault, commits } = base;
  const bundle = structuredClone(base.bundle);
  const fileRows = (run: string) => bundle.observation.filter((o) => o.run_id === run && o.setting_path === "file");
  const engine = await SqlJsEngine.create();
  engine.loadBundle(bundle);
  const layer = new DataLayer(engine);
  const pass = await runPass(layer, { world: new DriftWorld("test_actions"), ledger: new MemoryLedger(engine), at: AT, decidedAt: AT });
  const dispositions = objects(await layer.run(DISPOSITIONS_SQL)).map(dispositionOf);

  const host = new FakeHost();
  for (const o of fileRows("run-nginx-7f1c-1023")) host.files.set(o.object_id, Buffer.from(o.value_redacted!, "utf8"));
  const live = bundle.dns_record.filter((d) => d.run_id === "run-dns-1023" && !(opts.drop ?? []).includes(d.record_id)).map(cfOf);
  const zones: CfZone[] = [{ id: ZONE_ID, name: ZONE }];
  const cf = fakeCloudflare(zones, { [ZONE_ID]: live }, opts.cf);
  const model = new FakeModel();
  const probes: World["probes"] = [];
  const failing = new Set<string>();
  const tracer = new MemTracer("test_actions", {});
  let n = 0;
  const probe = async (names: readonly string[], kinds: readonly ProbeKind[]): Promise<Probe[]> => {
    probes.push({ names: [...names], kinds: [...kinds] });
    const run = `run-verify-${++n}`;
    return names.flatMap((name) => kinds.map((kind): Probe => ({
      probe_id: probeId(run, kind, name), run_id: run, tenant_id: TENANT, kind, target: name, expected: "answers", observed: failing.has(name) ? "status 502" : "status 200",
      status: failing.has(name) ? "fail" : "ok", latency_ms: 5, observed_at: "2026-10-23T03:05:00.000Z",
    })));
  };
  const world: World = {
    root, redactor, vault, commits, bundle, engine, layer, pass, dispositions, host, cf, model, probes, failing, tracer,
    deps: (over = {}) => ({
      layer, sink: new MemoryActionSink(engine), redactor, vault, aliasOf: (h) => (h === HOST ? ALIAS : null), ssh: host.run,
      records: new Cloudflare({ token: CF_TOKEN, fetch: cf.fetch }), probe, model, receipts: model.receipts,
      findingOf: async (d) => pass.findings.find((f) => f.id === d.finding_id) ?? null,
      lightning: ["openrouter/nvidia/nemotron-3.5-lightning"], ultra: ["openrouter/nvidia/nemotron-3-ultra-550b-a55b:free"],
      now: () => new Date("2026-10-23T03:04:00.000Z"), tracer, ...over,
    }),
    cleanup: () => engine.close(),
  };
  return world;
}
