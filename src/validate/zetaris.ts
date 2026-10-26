// The zetaris-json validator: whether a vault copy of one Zetaris control-plane object (src/zetaris/control.ts) can be
// restored as the collector wrote it, offline. The copy is one <raw id>.json file of a commit of the tenant's zetaris
// repository; the context is the other objects of the same commit (the same zetaris.control run) and the hash the
// vault_copy row recorded. Pure: no network, no store, no git.
//
// Contract:
//   - Hash: the bytes hash (sha256:<hex>) to the copy's recorded blob_sha256; a copy recorded with another hash fails.
//     With no recorded hash (no store) the check is skipped and the output says so.
//   - JSON: the bytes parse as one JSON object and are its canonical form (control.ts canonical: keys sorted at every
//     depth, two-space indent, a trailing newline); anything else fails.
//   - Shape per id, as controlObjects writes it (anything else fails):
//       usl/<usl>             name (the id's <usl>), namespace (an array of strings, or null), tables (strings, sorted)
//       usl/<usl>/<entity>    an object with name (the id's <entity>) and columnSpecs (an array), without the
//                             table-level dqAnnotations or ifNotExit control.ts leaves out
//       dq/<rule>             exactly name (the id's <rule>), table, type and expression, all strings;
//       dq/<table>.<rule>     the same, table and name from the id
//       grants                exactly principals: "<type> <name>" strings, sorted
//       grant/<principal>     exactly principal (the id's <principal>), type and privileges: objects of exactly
//                             identifier, privilege, grant_option and grant_by, all strings
//       datasources           exactly names: strings, sorted
//       datasource/<name>     exactly kind (jdbc or lightning), name (the id's <name>), description and id, all strings
//       server/version        an object of strings holding version
//   - Dependencies of a well-shaped index: every principal of grants has its grant/<name> in the commit, every name of
//     datasources its datasource/<name>, every table of usl/<usl> its usl/<usl>/<table>; one missing is named as a
//     dependency (the raw id; the caller redacts).
//   - result: ok when every check holds and no dependency is named; ok_with_gaps when the checks hold and a dependency
//     is named; fail when the hash, the JSON or the shape fails. output is one sentence per issue, "" when none.

import { createHash } from "node:crypto";
import type { ValidationResult } from "../data/rows.ts";
import { canonical } from "../zetaris/control.ts";

export interface ControlCopyValidation {
  result: ValidationResult;
  missing_dependencies: string[];
  output: string;
}

export interface ControlContext {
  /** Every object id of the same commit (the raw ids, the file paths without .json). */
  ids: ReadonlySet<string>;
  /** The copy's recorded blob_sha256; null when the copy is unknown (no store). */
  recorded: string | null;
}

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");
const sorted = (xs: readonly string[]): boolean => xs.every((x, i) => i === 0 || xs[i - 1] <= x);
/** The object's keys are exactly `keys`. */
const exactly = (v: Json, keys: readonly string[]): boolean => {
  const have = Object.keys(v).sort();
  return have.length === keys.length && [...keys].sort().every((k, i) => have[i] === k);
};
const strings = (v: Json, keys: readonly string[]): boolean => exactly(v, keys) && keys.every((k) => typeof v[k] === "string");

export const sha256 = (b: Uint8Array): string => `sha256:${createHash("sha256").update(b).digest("hex")}`;

/** Why a value is not what controlObjects writes under `id`; null when it is. */
export function shapeIssue(id: string, v: Json): string | null {
  const parts = id.split("/");
  const [kind] = parts;
  if (kind === "usl" && parts.length === 2) {
    const ok = exactly(v, ["name", "namespace", "tables"]) && v.name === parts[1] && (v.namespace === null || isStrings(v.namespace)) && isStrings(v.tables) && sorted(v.tables);
    return ok ? null : `${id} must hold exactly name ${parts[1]}, namespace and the sorted table names`;
  }
  if (kind === "usl" && parts.length === 3) {
    const ok = v.name === parts[2] && Array.isArray(v.columnSpecs) && !("dqAnnotations" in v) && !("ifNotExit" in v);
    return ok ? null : `${id} must be the entity ${parts[2]} as LOAD USL reports it, with columnSpecs and without its table-level dqAnnotations or ifNotExit`;
  }
  if (kind === "dq" && parts.length === 2) {
    const dot = parts[1].lastIndexOf(".");
    const name = dot < 0 ? parts[1] : parts[1].slice(dot + 1);
    const ok = strings(v, ["expression", "name", "table", "type"]) && v.name === name && (dot < 0 || v.table === parts[1].slice(0, dot));
    return ok ? null : `${id} must hold exactly the strings name ${name}, table, type and expression`;
  }
  if (id === "grants") {
    const ok = exactly(v, ["principals"]) && isStrings(v.principals) && v.principals.every((p) => / ./.test(p)) && sorted(v.principals);
    return ok ? null : `grants must hold exactly principals, sorted "<type> <name>" strings`;
  }
  if (kind === "grant" && parts.length >= 2) {
    const principal = parts.slice(1).join("/");
    const privileges = v.privileges;
    const ok = exactly(v, ["principal", "privileges", "type"]) && v.principal === principal && typeof v.type === "string"
      && Array.isArray(privileges) && privileges.every((p) => isObject(p) && strings(p, ["grant_by", "grant_option", "identifier", "privilege"]));
    return ok ? null : `${id} must hold exactly principal ${principal}, type and privileges of identifier, privilege, grant_option and grant_by`;
  }
  if (id === "datasources") {
    const ok = exactly(v, ["names"]) && isStrings(v.names) && sorted(v.names);
    return ok ? null : "datasources must hold exactly names, sorted strings";
  }
  if (kind === "datasource" && parts.length === 2) {
    const ok = strings(v, ["description", "id", "kind", "name"]) && (v.kind === "jdbc" || v.kind === "lightning") && v.name === parts[1];
    return ok ? null : `${id} must hold exactly the strings kind (jdbc or lightning), name ${parts[1]}, description and id`;
  }
  if (id === "server/version") {
    const ok = typeof v.version === "string" && Object.values(v).every((x) => typeof x === "string");
    return ok ? null : "server/version must be an object of strings holding version";
  }
  return `${id} is an object id the zetaris.control collector does not write`;
}

/** The objects a well-shaped index names, as raw ids. */
function dependencies(id: string, v: Json): string[] {
  if (id === "grants") return (v.principals as string[]).map((p) => `grant/${p.slice(p.indexOf(" ") + 1)}`);
  if (id === "datasources") return (v.names as string[]).map((n) => `datasource/${n}`);
  const parts = id.split("/");
  if (parts[0] === "usl" && parts.length === 2) return (v.tables as string[]).map((t) => `usl/${parts[1]}/${t}`);
  return [];
}

/** Validate one object copy; see the module header for the contract. */
export function validateControlCopy(id: string, bytes: Uint8Array, ctx: ControlContext): ControlCopyValidation {
  const fail = (output: string): ControlCopyValidation => ({ result: "fail", missing_dependencies: [], output });
  const hash = sha256(bytes);
  if (ctx.recorded !== null && ctx.recorded !== hash) return fail(`the copy's bytes hash to ${hash.slice(0, 19)}; its vault_copy row records ${ctx.recorded.slice(0, 19)}`);
  const text = Buffer.from(bytes).toString("utf8");
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return fail(`${id} fails to parse as JSON`);
  }
  if (!isObject(v)) return fail(`${id} is JSON of another kind than an object`);
  if (canonical(v) !== text) return fail(`${id} is not in the collector's canonical form (keys sorted at every depth, two-space indent, a trailing newline)`);
  const shape = shapeIssue(id, v);
  if (shape) return fail(shape);
  const gaps = dependencies(id, v).filter((d) => !ctx.ids.has(d)).sort();
  const notes = gaps.map((d) => `${id} names ${d}, which the commit does not hold`);
  if (ctx.recorded === null) notes.push("no vault_copy row was read (no store), so the recorded hash was not checked");
  return { result: gaps.length ? "ok_with_gaps" : "ok", missing_dependencies: gaps, output: notes.join("\n") };
}
