// The policy: the glob rule, the zod shapes, the loader and the resolver, over the committed
// policy/hackathon.json and the redacted object ids of the recorded bundle (sample/bundle.json, 24 Oct
// 2026). Every precedence case names a setting the bundle holds, so a re-recorded bundle that drops one
// fails here first. Offline and deterministic.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { config } from "../src/config.ts";
import { ruleId, type PolicyRule } from "../src/data/rows.ts";
import { globMatch, literalLength } from "../src/policy/glob.ts";
import { PolicyError, loadPolicyFile, parsePolicyFile, policyRows } from "../src/policy/load.ts";
import { rankedRules, resolvePolicy, type SettingRef } from "../src/policy/resolve.ts";
import { PolicyFile, PolicyRuleRow } from "../src/policy/schema.ts";
import { Redactor } from "../src/redactor.ts";
import bundle from "../sample/bundle.json" with { type: "json" };
import { QUEST_FILE, T, WWW_RECORD } from "./fixtures/catalogue-params.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const POLICY = path.join(ROOT, "policy", "hackathon.json");
const RAW = JSON.parse(readFileSync(POLICY, "utf8")) as Record<string, unknown> & { rules: Record<string, unknown>[] };
const redactor = new Redactor(config.redactSalt || "policy-test-salt", config.redactWords);
const loaded = loadPolicyFile(POLICY, { tenant: T, redactor });
const RULES = loaded.rows;
const tmp = mkdtempSync(path.join(tmpdir(), "drift-policy-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** The rule of the committed file with these globs. */
const rule = (surface: string, objectGlob: string, settingGlob: string): PolicyRule => {
  const r = RULES.find((x) => x.surface === surface && x.object_glob === objectGlob && x.setting_glob === settingGlob);
  if (!r) throw new Error(`no rule ${surface} ${objectGlob} ${settingGlob}`);
  return r;
};
const CONFD = rule("linux.nginx", "/etc/nginx/conf.d/*.conf", "file");
const SITES = rule("linux.nginx", "/etc/nginx/sites-available/*", "file");
const NGINX_CONF = rule("linux.nginx", "/etc/nginx/nginx.conf", "file");
const DATED = rule("linux.nginx", "/etc/nginx/conf.d/*.conf.*", "**");
const BAK = rule("linux.nginx", "**/*.bak*", "**");
const PRE_SYMLINK = rule("linux.nginx", "**/*.pre-symlink*", "**");
const SITES_BAK = rule("linux.nginx", "/etc/nginx/sites-available/*.bak*", "**");
const SITES_PRE_SYMLINK = rule("linux.nginx", "/etc/nginx/sites-available/*.pre-symlink*", "**");
const SITES_ORIG = rule("linux.nginx", "/etc/nginx/sites-available/*.orig", "**");
const CONFD_BAK = rule("linux.nginx", "/etc/nginx/conf.d/*.bak*", "**");
const REAL_IP = rule("linux.nginx", "**", "server[*].real_ip");
const CONTENT = rule("cloudflare.dns", "*", "content");
const PROXIED = rule("cloudflare.dns", "*", "proxied");
const TTL = rule("cloudflare.dns", "*", "ttl");
const CATCH_ALL = rule("*", "**", "**");

const OBSERVED = new Set(bundle.observation.map((o) => `${o.surface}\u001f${o.object_id}\u001f${o.setting_path}`));
const nginx = (object_id: string, setting_path: string): SettingRef => {
  if (!OBSERVED.has(`linux.nginx\u001f${object_id}\u001f${setting_path}`)) throw new Error(`sample/bundle.json holds no ${object_id} ${setting_path}`);
  return { tenant_id: T, surface: "linux.nginx", object_id, setting_path };
};
const record = (setting_path: string): SettingRef => {
  if (!bundle.dns_record.some((d) => d.record_id === WWW_RECORD)) throw new Error("sample/bundle.json holds no www record");
  return { tenant_id: T, surface: "cloudflare.dns", object_id: WWW_RECORD, setting_path };
};

describe("glob", () => {
  it("* stays within one path segment, ** spans segments, ? is one character other than /", () => {
    expect(globMatch("**", "/etc/nginx/nginx.conf")).toBe(true);
    expect(globMatch("**", "")).toBe(true);
    expect(globMatch("*", WWW_RECORD)).toBe(true);
    expect(globMatch("*", "a/b")).toBe(false);
    expect(globMatch("/etc/nginx/*", "/etc/nginx/conf.d/x.conf")).toBe(false);
    expect(globMatch("/etc/nginx/**", "/etc/nginx/conf.d/x.conf")).toBe(true);
    expect(globMatch("a?c", "abc")).toBe(true);
    expect(globMatch("a?c", "a/c")).toBe(false);
    expect(globMatch("a?c", "ac")).toBe(false);
    expect(globMatch("**/*.bak*", "/etc/nginx/sites-available/host-9ac4f1.com.bak.20260602-150607")).toBe(true);
    expect(globMatch("**/*.bak*", "/etc/nginx/conf.d/host-503b27.ai.conf")).toBe(false);
  });

  it("every other character is itself: dots, brackets, parentheses and plus signs are literal", () => {
    expect(globMatch("a.b", "axb")).toBe(false);
    expect(globMatch("a.b", "a.b")).toBe(true);
    expect(globMatch("server[*].real_ip", "server[host-18efce.ai:443].real_ip")).toBe(true);
    expect(globMatch("server[*].real_ip", "http.real_ip")).toBe(false);
    expect(globMatch("server[*].real_ip", "server[host-18efce.ai:443].server_name[host-18efce.ai]")).toBe(false);
    expect(globMatch("server[*].real_ip", "server[a:443].location[/x].real_ip")).toBe(false);
    expect(globMatch("(x)+", "(x)+")).toBe(true);
    expect(globMatch("(x)+", "xx")).toBe(false);
  });

  it("/etc/nginx/conf.d/*.conf takes the live vhost files of the conf.d host and none of the dated or .bak copies beside them, which *.conf.* takes", () => {
    const confd = [...new Set(bundle.observation.filter((o) => o.object_id.startsWith("/etc/nginx/conf.d/")).map((o) => o.object_id))].sort();
    const live = confd.filter((id) => globMatch("/etc/nginx/conf.d/*.conf", id));
    const copies = confd.filter((id) => globMatch("/etc/nginx/conf.d/*.conf.*", id));
    expect(live).toEqual([
      "/etc/nginx/conf.d/default.conf", "/etc/nginx/conf.d/host-492568.ai.conf", "/etc/nginx/conf.d/host-503b27.ai.conf", "/etc/nginx/conf.d/host-a00d2f.ai.conf",
      "/etc/nginx/conf.d/host-c907ae.ai.conf", "/etc/nginx/conf.d/host-e49c58.cloud.conf", "/etc/nginx/conf.d/word-005ed8-prod.conf", "/etc/nginx/conf.d/word-92cb1d-prod-club.conf",
    ]);
    expect(copies).toEqual([
      "/etc/nginx/conf.d/host-9add22.ai.conf.bak-2026-08-12", "/etc/nginx/conf.d/host-9add22.ai.conf.bak.20260903183931", "/etc/nginx/conf.d/host-9add22.ai.conf.bak.20260924200401",
      "/etc/nginx/conf.d/host-9add22.ai.conf.bak.20261001212949", "/etc/nginx/conf.d/host-dc8e7c.ai.conf.bak.1784942683", "/etc/nginx/conf.d/host-e49c58.cloud.conf.bak",
      "/etc/nginx/conf.d/word-92cb1d-prod-club.conf.bak.1783629242", "/etc/nginx/conf.d/word-e1ed81,host-503b27.ai.conf.bak",
    ]);
    expect(live.filter((id) => copies.includes(id))).toEqual([]);
    expect(confd.filter((id) => !live.includes(id) && !copies.includes(id))).toEqual(["/etc/nginx/conf.d/host-64dc7f.ready", "/etc/nginx/conf.d/host-e07324.ready"]);
  });

  it("literalLength counts the characters that are not wildcards", () => {
    expect(literalLength("/etc/nginx/conf.d/*.conf")).toBe(23);
    expect(literalLength("/etc/nginx/conf.d/*.conf.*")).toBe(24);
    expect(literalLength("/etc/nginx/sites-available/*")).toBe(27);
    expect(literalLength("/etc/nginx/nginx.conf")).toBe(21);
    expect(literalLength("**/*.bak*")).toBe(5);
    expect(literalLength("**/*.pre-symlink*")).toBe(13);
    expect(literalLength("/etc/nginx/sites-available/*.bak*")).toBe(31);
    expect(literalLength("/etc/nginx/sites-available/*.pre-symlink*")).toBe(39);
    expect(literalLength("/etc/nginx/sites-available/*.orig")).toBe(32);
    expect(literalLength("/etc/nginx/conf.d/*.bak*")).toBe(22);
    expect(literalLength("server[*].real_ip")).toBe(16);
    expect(literalLength("**")).toBe(0);
    expect(literalLength("a?c")).toBe(2);
  });
});

describe("schema and loader", () => {
  it("the committed policy/hackathon.json passes the file schema, and each of its 17 rows passes the row schema", () => {
    expect(PolicyFile.safeParse(RAW).success).toBe(true);
    expect(loaded.file).toMatchObject({ version: 2, author: "operator", since: "2026-10-25T00:00:00.000Z", tenant: "*" });
    expect(RULES).toHaveLength(17);
    for (const r of RULES) expect(PolicyRuleRow.safeParse(r).success, r.rule_id).toBe(true);
    expect(RULES.every((r) => r.tenant_id === "*" && r.version === 2 && r.author === "operator" && r.since === "2026-10-25T00:00:00.000Z")).toBe(true);
    // the four rules version 2 adds: the copies under sites-available and conf.d, low and adopted
    for (const r of [SITES_BAK, SITES_PRE_SYMLINK, SITES_ORIG, CONFD_BAK]) {
      expect(r).toMatchObject({ surface: "linux.nginx", setting_glob: "**", criticality: "low", lock: 0, on_drift: "adopt", on_no_copy: "adopt", hold_max_hours: 0, alert: "never", psa_priority: "P4", note: null });
    }
    expect(RULES.filter((r) => r.note !== null).map((r) => r.note)).toEqual([
      "a served vhost file is restored to its approved copy when it drifts", "dated copies beside a live file", "where a name points",
      "the data layer the agent reads through: a changed DQ rule, entity, grant, datasource or server version goes to a technician by ticket, and the agent changes nothing",
      "everything else is held with an expiry",
      "mail DNS is never changed automatically: a record Microsoft 365 requires that the zone lacks or serves with another value goes to a technician by ticket",
    ]);
    // the rule the control plane carries: every object of zetaris.control, ESCALATE on drift, alert always
    expect(RULES.find((r) => r.surface === "zetaris.control")).toMatchObject({ object_glob: "**", setting_glob: "**", criticality: "critical", lock: 1, on_drift: "escalate", on_no_copy: "ticket", hold_max_hours: 0, alert: "always", psa_priority: "P1" });
  });

  it("redaction leaves every glob and note of the committed file unchanged, under the tenant's salt and under a fresh one", () => {
    expect(loaded.redacted).toBe(0);
    const fresh = new Redactor("another-salt-entirely", config.redactWords);
    for (const r of RAW.rules) {
      for (const k of ["object_glob", "setting_glob", "note"]) {
        const v = r[k];
        if (typeof v !== "string") continue;
        expect(redactor.text(v), `${k} ${v}`).toBe(v);
        expect(fresh.text(v), `${k} ${v}`).toBe(v);
      }
    }
    expect(RULES.map((r) => [r.object_glob, r.setting_glob])).toEqual(RAW.rules.map((r) => [r.object_glob, r.setting_glob]));
  });

  it("is deterministic: the same file gives the same rows in file order, and the ids are rows.ts ruleId over the stored globs", () => {
    const again = loadPolicyFile(POLICY, { tenant: T, redactor: new Redactor("another-salt-entirely", config.redactWords) });
    expect(again.rows).toEqual(RULES);
    expect(policyRows(parsePolicyFile(RAW), { tenant: "client-2", redactor }).rows).toEqual(RULES);
    expect(RULES.map((r) => r.rule_id)).toEqual([
      "rule-e186e9d5790a7e6b", "rule-6c41a25a00c404c8", "rule-d0e0d34c8ae191b4", "rule-42827f90778592ff", "rule-44429a425c681bfd", "rule-90f1bcb36548ea39",
      "rule-be0bf7afde964803", "rule-504a8801607b9f1c", "rule-01eb3d1f7585323c", "rule-c6c3c71938210651",
      "rule-66810b66396a3b15", "rule-a3f26f34efab2ebb", "rule-8e75e1d767980665", "rule-a8722e4f568e681e", "rule-8bcb3a03ffcee62e", "rule-b8d9962485c3ced4",
      "rule-6774a8522593a0fc",
    ]);
    for (const r of RULES) expect(r.rule_id).toBe(ruleId(r.tenant_id, r.surface, r.object_glob, r.setting_glob, r.version));
    expect(new Set(RULES.map((r) => r.rule_id)).size).toBe(RULES.length);
  });

  it("refuses unknown verbs and values, negative hours, a lock on an adopting rule, a hold without hours, unknown keys and a bad tenant", () => {
    const base = RAW.rules[0];
    const refused = (patch: Record<string, unknown>, file: Record<string, unknown> = {}) => PolicyFile.safeParse({ ...RAW, ...file, rules: [{ ...base, ...patch }] }).success;
    expect(refused({})).toBe(true);
    expect(refused({ on_drift: "delete" })).toBe(false);
    expect(refused({ on_no_copy: "ignore" })).toBe(false);
    expect(refused({ criticality: "urgent" })).toBe(false);
    expect(refused({ alert: "sometimes" })).toBe(false);
    expect(refused({ psa_priority: "P5" })).toBe(false);
    expect(refused({ surface: "linux.etc" })).toBe(false);
    expect(refused({ hold_max_hours: -1 })).toBe(false);
    expect(refused({ hold_max_hours: 1.5 })).toBe(false);
    expect(refused({ lock: 2 })).toBe(false);
    expect(refused({ lock: 1, on_drift: "adopt" })).toBe(false);
    expect(refused({ lock: 0, on_drift: "adopt", hold_max_hours: 0 })).toBe(true);
    expect(refused({ lock: 0, on_drift: "hold", hold_max_hours: 0 })).toBe(false);
    expect(refused({ on_drift: "rollback", hold_max_hours: 0 })).toBe(false);
    expect(refused({ lock: 1, on_drift: "investigate", hold_max_hours: 0 })).toBe(true);
    expect(refused({ object_glob: "" })).toBe(false);
    expect(refused({ object_glob: "a\nb" })).toBe(false);
    expect(refused({ action: "rollback" })).toBe(false);
    expect(refused({}, { tenant: "client 1" })).toBe(false);
    expect(refused({}, { since: "yesterday" })).toBe(false);
    expect(refused({}, { extra: 1 })).toBe(false);
    expect(PolicyFile.safeParse({ ...RAW, rules: [] }).success).toBe(false);
    expect(() => parsePolicyFile({ ...RAW, rules: [{ ...base, lock: 1, on_drift: "adopt" }] })).toThrow(/rules\.0\.lock: lock 1 acts on a drift/);
    expect(parsePolicyFile({ ...RAW, since: "2026-10-25T00:00:00Z" }).since).toBe("2026-10-25T00:00:00.000Z");
  });

  it("a file for one tenant loads for that tenant only; two rules of one family in one version are refused", () => {
    const own = parsePolicyFile({ ...RAW, tenant: "client-2" });
    expect(policyRows(own, { tenant: "client-2", redactor }).rows.every((r) => r.tenant_id === "client-2")).toBe(true);
    expect(() => policyRows(own, { tenant: T, redactor })).toThrow(/the file is the policy of tenant client-2; the load is for client-1/);
    const twice = parsePolicyFile({ ...RAW, rules: [RAW.rules[0], { ...RAW.rules[0], criticality: "low" }] });
    expect(() => policyRows(twice, { tenant: T, redactor })).toThrow(/rules #1 and #2 name one family/);
  });

  it("a real name typed in a glob is stored as the pseudonym the observations carry, so the rule still matches the redacted object id", () => {
    const typed = "/etc/nginx/conf.d/bluefin-logistics-zz9q.com.conf";
    const file = parsePolicyFile({ ...RAW, rules: [{ ...RAW.rules[0], object_glob: typed, note: "pinned for bluefin-logistics-zz9q.com" }] });
    const { rows, redacted } = policyRows(file, { tenant: T, redactor });
    expect(redacted).toBe(2);
    expect(rows[0].object_glob).toMatch(/^\/etc\/nginx\/conf\.d\/host-[0-9a-f]{6}\.com\.conf$/);
    expect(rows[0].note).toMatch(/^pinned for host-[0-9a-f]{6}\.com$/);
    expect(JSON.stringify(rows)).not.toContain("bluefin");
    const observed = redactor.text(typed);
    expect(observed).toBe(rows[0].object_glob);
    expect(resolvePolicy(rows, { tenant_id: T, surface: "linux.nginx", object_id: observed, setting_path: "file" })?.rule_id).toBe(rows[0].rule_id);
  });

  it("a file of invalid JSON is refused by position, without the text around the fault", () => {
    const bad = path.join(tmp, "bad.json");
    writeFileSync(bad, '{ "version": 1, "author": "bluefin-logistics-zz9q.com" oops }');
    let msg = "";
    try { loadPolicyFile(bad, { tenant: T, redactor }); } catch (e) { expect(e).toBeInstanceOf(PolicyError); msg = (e as Error).message; }
    expect(msg).toMatch(/holds invalid JSON/);
    expect(msg).not.toContain("bluefin");
  });
});

describe("resolvePolicy over the committed policy and the recorded bundle", () => {
  it("a live conf.d vhost file's file setting: the critical, locked rollback rule", () => {
    for (const id of ["/etc/nginx/conf.d/host-503b27.ai.conf", "/etc/nginx/conf.d/word-005ed8-prod.conf", "/etc/nginx/conf.d/default.conf"]) {
      expect(resolvePolicy(RULES, nginx(id, "file")), id).toBe(CONFD);
    }
    expect(CONFD).toMatchObject({ criticality: "critical", lock: 1, on_drift: "rollback", on_no_copy: "investigate_ticket", hold_max_hours: 24, alert: "on_fix", psa_priority: "P1" });
    expect(rankedRules(RULES, nginx("/etc/nginx/conf.d/host-503b27.ai.conf", "file"))).toEqual([CONFD, CATCH_ALL]);
  });

  it("the dated and .bak copies beside a live file: the low adopt rule, over the conf.d .bak rule (24 literal characters against 22), **/*.bak* and the catch-all", () => {
    for (const id of ["/etc/nginx/conf.d/host-9add22.ai.conf.bak-2026-08-12", "/etc/nginx/conf.d/host-e49c58.cloud.conf.bak", "/etc/nginx/conf.d/host-dc8e7c.ai.conf.bak.1784942683"]) {
      expect(resolvePolicy(RULES, nginx(id, "file")), id).toBe(DATED);
    }
    expect(rankedRules(RULES, nginx("/etc/nginx/conf.d/host-9add22.ai.conf.bak-2026-08-12", "file"))).toEqual([DATED, CONFD_BAK, BAK, CATCH_ALL]);
    // the object glob outranks the setting glob: a copy's real_ip stays with the copies' rule
    expect(rankedRules(RULES, nginx("/etc/nginx/conf.d/host-9add22.ai.conf.bak-2026-08-12", "server[host-27618a.ai:443].real_ip"))).toEqual([DATED, CONFD_BAK, BAK, REAL_IP, CATCH_ALL]);
    // a conf.d copy whose name carries no .conf. is the conf.d .bak rule's; one ending in .conf stays live and critical
    const synthetic = (object_id: string): SettingRef => ({ tenant_id: T, surface: "linux.nginx", object_id, setting_path: "file" });
    expect(resolvePolicy(RULES, synthetic("/etc/nginx/conf.d/host-9add22.ai.bak"))).toBe(CONFD_BAK);
    expect(resolvePolicy(RULES, synthetic("/etc/nginx/conf.d/host-9add22.ai.bak.conf"))).toBe(CONFD);
    expect(resolvePolicy(RULES, synthetic("/etc/nginx/sites-available/host-9ac4f1.com.orig"))).toBe(SITES_ORIG);
  });

  it("a block's real_ip: the high hold rule; nginx.conf's file: its own critical rule, its http.real_ip the catch-all", () => {
    expect(resolvePolicy(RULES, nginx("/etc/nginx/conf.d/host-503b27.ai.conf", "server[host-503b27.ai:443].real_ip"))).toBe(REAL_IP);
    expect(resolvePolicy(RULES, nginx(QUEST_FILE, "server[host-4c795e.quest:443].real_ip"))).toBe(REAL_IP);
    expect(REAL_IP).toMatchObject({ criticality: "high", lock: 0, on_drift: "hold", on_no_copy: "ticket", hold_max_hours: 72, psa_priority: "P3" });
    expect(resolvePolicy(RULES, nginx("/etc/nginx/nginx.conf", "file"))).toBe(NGINX_CONF);
    expect(NGINX_CONF.alert).toBe("always");
    expect(resolvePolicy(RULES, nginx("/etc/nginx/nginx.conf", "http.real_ip"))).toBe(CATCH_ALL);
  });

  it("sites-available: a live site's file setting is the critical rule; the .bak and .pre-symlink copies are the low copies' rules (31 and 39 literal characters against 27), every setting of them", () => {
    expect(resolvePolicy(RULES, nginx(QUEST_FILE, "file"))).toBe(SITES);
    expect(rankedRules(RULES, nginx("/etc/nginx/sites-available/host-9ac4f1.com.bak.20260602-150607", "file"))).toEqual([SITES_BAK, SITES, BAK, CATCH_ALL]);
    expect(rankedRules(RULES, nginx("/etc/nginx/sites-available/host-f2a6b6.com.pre-symlink.20260917-235830", "file"))).toEqual([SITES_PRE_SYMLINK, SITES, PRE_SYMLINK, CATCH_ALL]);
    expect(resolvePolicy(RULES, nginx("/etc/nginx/sites-available/host-aeb96b.com.bak-20260921170856", "file"))).toBe(SITES_BAK);
    expect(resolvePolicy(RULES, nginx("/etc/nginx/sites-available/site.bak.20260604203018", "file"))).toBe(SITES_BAK);
    expect(resolvePolicy(RULES, nginx("/etc/nginx/sites-available/host-9ac4f1.com.bak.20260602-150607", "server[host-9ac4f1.com:443].listen"))).toBe(SITES_BAK);
    expect(resolvePolicy(RULES, nginx("/etc/nginx/sites-available/host-f2a6b6.com.pre-symlink.20260917-235830", "server[host-525a57.com:80].listen"))).toBe(SITES_PRE_SYMLINK);
    expect(resolvePolicy(RULES, nginx("/etc/nginx/sites-enabled/default", "file"))).toBe(CATCH_ALL);
    expect(resolvePolicy(RULES, nginx("/etc/nginx/conf.d/host-64dc7f.ready", "file"))).toBe(CATCH_ALL);
    expect(resolvePolicy(RULES, nginx("systemd", "timer[backup-export.timer]"))).toBe(CATCH_ALL);
  });

  it("every file of both hosts in sample/bundle.json: each .bak, .pre-symlink and dated copy resolves to a low adopt rule, each live vhost file and nginx.conf to its critical rule; the tally is pinned", () => {
    // the operator's two hosts, tenant client-1; the lab host's files (tenant lab-1) are the lab's own
    const files = [...new Map(bundle.observation.filter((o) => o.tenant_id === T && o.surface === "linux.nginx" && o.setting_path === "file").map((o) => [`${o.host} ${o.object_id}`, o])).values()];
    const isCopy = (id: string): boolean => /^\/etc\/nginx\/(conf\.d|sites-available)\/[^/]*(\.bak|\.pre-symlink|\.orig$|\.conf\.)/.test(id);
    const isLive = (id: string): boolean => !isCopy(id) && (/^\/etc\/nginx\/conf\.d\/[^/]+\.conf$/.test(id) || /^\/etc\/nginx\/sites-available\/[^/]+$/.test(id));
    const copies = files.filter((o) => isCopy(o.object_id));
    const live = files.filter((o) => isLive(o.object_id));
    for (const o of copies) expect(resolvePolicy(RULES, nginx(o.object_id, "file")), o.object_id).toMatchObject({ criticality: "low", lock: 0, on_drift: "adopt" });
    for (const o of live) {
      const want = o.object_id.startsWith("/etc/nginx/conf.d/") ? CONFD : SITES;
      expect(resolvePolicy(RULES, nginx(o.object_id, "file")), o.object_id).toBe(want);
    }
    for (const host of ["host-aa516a", "host-4b4dc1"]) expect(resolvePolicy(RULES, nginx("/etc/nginx/nginx.conf", "file")), host).toBe(NGINX_CONF);
    const tally = new Map<string, number>();
    for (const o of files) {
      const r = resolvePolicy(RULES, nginx(o.object_id, "file"))!;
      tally.set(`${r.object_glob} ${r.setting_glob}`, (tally.get(`${r.object_glob} ${r.setting_glob}`) ?? 0) + 1);
    }
    expect(Object.fromEntries([...tally].sort())).toEqual({
      "** **": 16,
      "/etc/nginx/conf.d/*.conf file": 8,
      "/etc/nginx/conf.d/*.conf.* **": 8,
      "/etc/nginx/nginx.conf file": 2,
      "/etc/nginx/sites-available/* file": 11,
      "/etc/nginx/sites-available/*.bak* **": 8,
      "/etc/nginx/sites-available/*.pre-symlink* **": 1,
    });
    expect([copies.length, live.length, files.length]).toEqual([17, 19, 54]);
    // the catch-all takes the files outside the vhost directories and the .ready markers: the renewal configs, mime.types, sites-enabled/default
    expect(files.filter((o) => resolvePolicy(RULES, nginx(o.object_id, "file")) === CATCH_ALL).every((o) => !isCopy(o.object_id) && !isLive(o.object_id))).toBe(true);
  });

  it("a Cloudflare record: content and proxied the critical rules, ttl the normal adopt rule, name and type the catch-all", () => {
    expect(resolvePolicy(RULES, record("content"))).toBe(CONTENT);
    expect(resolvePolicy(RULES, record("proxied"))).toBe(PROXIED);
    expect(resolvePolicy(RULES, record("ttl"))).toBe(TTL);
    expect(resolvePolicy(RULES, record("name"))).toBe(CATCH_ALL);
    expect(resolvePolicy(RULES, record("type"))).toBe(CATCH_ALL);
    // an exact surface outranks "*" before literal length is weighed
    expect(rankedRules(RULES, record("content"))).toEqual([CONTENT, CATCH_ALL]);
    expect([CONTENT.lock, CONTENT.hold_max_hours, PROXIED.alert, TTL.on_drift]).toEqual([1, 4, "always", "adopt"]);
  });

  it("precedence: an exact tenant over * before anything else, then the higher version within a family, then the higher version across equal globs, then rule_id", () => {
    const setting = nginx("/etc/nginx/conf.d/host-503b27.ai.conf", "file");
    const mine: PolicyRule = { ...CATCH_ALL, tenant_id: T, surface: "linux.nginx", on_drift: "adopt", hold_max_hours: 0, rule_id: ruleId(T, "linux.nginx", "**", "**", 1) };
    expect(resolvePolicy([...RULES, mine], setting)).toBe(mine);
    expect(resolvePolicy([...RULES, mine], { ...setting, tenant_id: "client-2" })).toBe(CONFD);
    const v3: PolicyRule = { ...CONFD, version: 3, criticality: "high", rule_id: ruleId("*", CONFD.surface, CONFD.object_glob, CONFD.setting_glob, 3) };
    expect(rankedRules([...RULES, v3], setting)).toEqual([v3, CATCH_ALL]);
    // two families with equal literal lengths: the higher version, then the lower rule_id
    const twin: PolicyRule = { ...CONFD, object_glob: "/etc/nginx/conf.d/h*.con*", version: 3, rule_id: ruleId("*", "linux.nginx", "/etc/nginx/conf.d/h*.con*", "file", 3) };
    expect(literalLength(twin.object_glob)).toBe(literalLength(CONFD.object_glob));
    expect(resolvePolicy([...RULES, twin], setting)).toBe(twin);
    const sameVersion = { ...twin, version: CONFD.version, rule_id: ruleId("*", "linux.nginx", "/etc/nginx/conf.d/h*.con*", "file", CONFD.version) };
    expect(resolvePolicy([...RULES, sameVersion], setting)).toBe([CONFD, sameVersion].sort((a, b) => (a.rule_id < b.rule_id ? -1 : 1))[0]);
  });

  it("is deterministic whatever order the rules arrive in, and returns null when no rule matches", () => {
    const settings = [nginx("/etc/nginx/conf.d/host-503b27.ai.conf", "file"), nginx("/etc/nginx/sites-available/host-9ac4f1.com.bak.20260602-150607", "file"), record("ttl")];
    const reversed = [...RULES].reverse();
    const rotated = [...RULES.slice(5), ...RULES.slice(0, 5)];
    for (const s of settings) {
      expect(resolvePolicy(reversed, s)).toBe(resolvePolicy(RULES, s));
      expect(rankedRules(rotated, s)).toEqual(rankedRules(RULES, s));
    }
    expect(resolvePolicy([], settings[0])).toBeNull();
    expect(resolvePolicy(RULES.filter((r) => r !== CATCH_ALL), nginx("/etc/nginx/sites-enabled/default", "file"))).toBeNull();
    expect(resolvePolicy(RULES, { tenant_id: T, surface: "linux.etc", object_id: "/etc/hosts", setting_path: "file" })).toBe(CATCH_ALL);
  });
});
