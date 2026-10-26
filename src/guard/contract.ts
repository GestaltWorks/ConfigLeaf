// The execution contract: Meterless Scout Intent's "only thing downstream engines accept"
// (engines/scout-intent/docs/execution-contract.md) for ConfigLeaf's two write paths. A ROLLBACK or a FIX under --apply
// runs only against a contract the plan step issued for that action: it names the action, the object, the exact set of
// capabilities the action may use, a five-minute lifetime and an Ed25519 signature.
//
// Contract:
//   - Shape (ExecutionContract): kind "execution_contract", contract_id ("ctr-" and 16 hex of the sha256 of the other
//     fields), tenant_id, action (the Actor's kind: rollback_file, revert_record, investigate), action_id and
//     disposition_id (src/data/rows.ts), object (the redacted target the action rows carry, src/actions/plan.ts
//     targetOf), capabilities (CAPABILITIES[action], sorted), issued_at, expires_at (issued_at plus CONTRACT_TTL_MS),
//     signed_by "scout" and policy (the guard's version).
//   - Signature: the envelope is the Nightshift receipt's ({ body: { receipt }, pubkey_b64, sig_b64 }), so the code that
//     signs and verifies receipts serves it unchanged: Ed25519 over canonicalReceiptBody(body), checked by verifyReceipt
//     (src/adapters/nightshift.ts). The spec names HMAC and calls the signer pluggable; this is the swap.
//   - Key: ContractKey.loadOrCreate generates an Ed25519 key on first use and keeps it under .scout/ at the repository
//     root (gitignored, the directory created mode 0700, the file mode 0600). The key is never printed, logged or put in
//     a trace line. A contract verifies only
//     under the public key of the deployment that holds the private one, so a contract signed by another key is refused
//     as such even when its signature is valid for its own key.
//   - Checks, in the spec's order, each a refusal with a plain sentence: unsigned (no signature or no envelope),
//     bad-signature (a key this deployment does not hold, or bytes that differ from the signed ones), malformed, expired
//     (expires_at is not after the check's instant), not-yet-valid, ttl-too-long (a lifetime past CONTRACT_TTL_MS: the
//     goalposts do not move), scope-mismatch (tenant, action, action id, disposition, object, or a capability set that
//     is not exactly CAPABILITIES[action]).
//   - The Actor (src/actions/act.ts) issues the contract when an action's plan is made, which is just before it runs,
//     and verifies it before any write, model call or host session. A refusal is an action row (status refused) and a
//     trace line (agent actor, action guard).

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalReceiptBody, verifyReceipt, type SignedReceipt } from "../adapters/nightshift.ts";
import type { ActionKind } from "../data/rows.ts";
import { GUARD_VERSION } from "./scout.ts";

/** Five minutes: a decision is bound to the context it was made in. */
export const CONTRACT_TTL_MS = 5 * 60_000;
export const CONTRACT_KIND = "execution_contract" as const;

/** The actions that need a contract: the ones that write or call a model. The fix row only records a refusal and takes none. */
export type GatedKind = Exclude<ActionKind, "fix">;

/** The exact set of capabilities a contract for each kind of action grants, sorted. */
export const CAPABILITIES: Readonly<Record<GatedKind, readonly string[]>> = {
  rollback_file: ["host:write", "nginx:reload", "probe:run", "vault:read"],
  revert_record: ["dns:write", "probe:run", "vault:read"],
  investigate: ["data:read", "model:call", "probe:read"],
};

export type ExecutionContract = {
  kind: typeof CONTRACT_KIND;
  contract_id: string;
  tenant_id: string;
  action: GatedKind;
  action_id: string;
  disposition_id: string;
  object: string;
  capabilities: string[];
  issued_at: string;
  expires_at: string;
  signed_by: "scout";
  policy: string;
};

/** What a contract is for; the Actor states it from the action about to run. */
export type ContractScope = Pick<ExecutionContract, "tenant_id" | "action" | "action_id" | "disposition_id" | "object">;

/** The Nightshift receipt's envelope (src/adapters/nightshift.ts SignedReceipt) around a contract. */
export type SignedContract = { body: { receipt: ExecutionContract }; pubkey_b64: string; sig_b64: string };

export type ContractRefusal = "unsigned" | "bad-signature" | "malformed" | "expired" | "not-yet-valid" | "ttl-too-long" | "scope-mismatch";
export type ContractCheck = { ok: true; contract: ExecutionContract } | { ok: false; refusal: ContractRefusal; reason: string };

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
/** Where the local key lives: gitignored (.scout/). */
export const DEFAULT_KEY_FILE = path.join(ROOT, ".scout", "contract-key.pem");

/** An Ed25519 key pair: signs a body the way the runtime's receipts are signed. */
export class ContractKey {
  readonly publicB64: string;
  private constructor(private readonly privateKey: KeyObject) {
    this.publicB64 = createPublicKey(privateKey).export({ format: "der", type: "spki" }).subarray(-32).toString("base64");
  }

  static generate(): ContractKey {
    return new ContractKey(generateKeyPairSync("ed25519").privateKey);
  }

  /** The key at `file`; generated and written there, mode 0600, when the file is absent. */
  static loadOrCreate(file: string = DEFAULT_KEY_FILE): ContractKey {
    try {
      return new ContractKey(createPrivateKey(readFileSync(file)));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    const key = generateKeyPairSync("ed25519").privateKey;
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    try {
      writeFileSync(file, key.export({ type: "pkcs8", format: "pem" }), { flag: "wx", mode: 0o600 });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      return new ContractKey(createPrivateKey(readFileSync(file)));
    }
    return new ContractKey(key);
  }

  /** Base64 Ed25519 signature over canonicalReceiptBody(body). */
  sign(body: unknown): string {
    return sign(null, Buffer.from(canonicalReceiptBody(body), "utf8"), this.privateKey).toString("base64");
  }

  toJSON(): { publicB64: string } {
    return { publicB64: this.publicB64 };
  }
}

/** Issues and verifies contracts. The Actor holds one; a test hands in its own. */
export interface ContractAuthority {
  issue(scope: ContractScope, now: Date): SignedContract;
  verify(presented: unknown, expect: ContractScope, now: Date): ContractCheck;
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const x = [...a].sort();
  const y = [...b].sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
}
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const STRING_FIELDS = ["tenant_id", "action", "action_id", "disposition_id", "object", "issued_at", "expires_at", "contract_id", "signed_by", "policy"] as const;

export class LocalContractAuthority implements ContractAuthority {
  private resolved: ContractKey | null = null;
  /** `key` is read on first use, so building an Actor writes no key file until a contract is issued or checked. */
  constructor(private readonly key: () => ContractKey) {}

  /** The deployment's key: .scout/contract-key.pem, generated on first use. */
  static local(file: string = DEFAULT_KEY_FILE): LocalContractAuthority {
    return new LocalContractAuthority(() => ContractKey.loadOrCreate(file));
  }

  /** A throwaway key that lives as long as the object. */
  static ephemeral(): LocalContractAuthority {
    const key = ContractKey.generate();
    return new LocalContractAuthority(() => key);
  }

  private get k(): ContractKey {
    return (this.resolved ??= this.key());
  }

  issue(scope: ContractScope, now: Date): SignedContract {
    const rest = {
      kind: CONTRACT_KIND, ...scope, capabilities: [...CAPABILITIES[scope.action]],
      issued_at: now.toISOString(), expires_at: new Date(now.getTime() + CONTRACT_TTL_MS).toISOString(), signed_by: "scout" as const, policy: GUARD_VERSION,
    };
    const contract: ExecutionContract = { ...rest, contract_id: `ctr-${createHash("sha256").update(canonicalReceiptBody(rest)).digest("hex").slice(0, 16)}` };
    const body = { receipt: contract };
    return { body, pubkey_b64: this.k.publicB64, sig_b64: this.k.sign(body) };
  }

  verify(presented: unknown, expect: ContractScope, now: Date): ContractCheck {
    const refuse = (refusal: ContractRefusal, reason: string): ContractCheck => ({ ok: false, refusal, reason });
    if (!isObject(presented) || !isObject(presented.body) || !isObject(presented.body.receipt)) return refuse("unsigned", "no signed contract was presented");
    if (typeof presented.sig_b64 !== "string" || !presented.sig_b64 || typeof presented.pubkey_b64 !== "string" || !presented.pubkey_b64) return refuse("unsigned", "the contract carries no signature");
    if (presented.pubkey_b64 !== this.k.publicB64) return refuse("bad-signature", "the contract is signed by a key this deployment does not hold");
    if (!verifyReceipt(presented as unknown as SignedReceipt)) return refuse("bad-signature", "the signature does not match the contract's bytes");
    const c = presented.body.receipt;
    if (c.kind !== CONTRACT_KIND || c.signed_by !== "scout" || STRING_FIELDS.some((f) => typeof c[f] !== "string") || !Array.isArray(c.capabilities) || c.capabilities.some((x) => typeof x !== "string")) {
      return refuse("malformed", "the signed body is not an execution contract");
    }
    const contract = c as unknown as ExecutionContract;
    const issued = Date.parse(contract.issued_at);
    const expires = Date.parse(contract.expires_at);
    if (!Number.isFinite(issued) || !Number.isFinite(expires) || expires <= issued) return refuse("malformed", "the contract's dates are not a lifetime");
    if (now.getTime() >= expires) return refuse("expired", `the contract expired at ${contract.expires_at}; it was checked at ${now.toISOString()}`);
    if (now.getTime() < issued) return refuse("not-yet-valid", `the contract is dated ${contract.issued_at}, after the check at ${now.toISOString()}`);
    if (expires - issued > CONTRACT_TTL_MS) return refuse("ttl-too-long", `the contract lives ${Math.round((expires - issued) / 1000)} s; the limit is ${CONTRACT_TTL_MS / 1000} s`);
    for (const f of ["tenant_id", "action", "action_id", "disposition_id", "object"] as const) {
      if (contract[f] !== expect[f]) return refuse("scope-mismatch", `the contract is for ${f} ${contract[f]}; this action has ${f} ${expect[f]}`);
    }
    const want = CAPABILITIES[expect.action];
    if (!want) return refuse("scope-mismatch", `${expect.action} is not an action a contract grants`);
    if (!sameSet(contract.capabilities, want)) {
      return refuse("scope-mismatch", `the contract grants capabilities ${contract.capabilities.join(", ") || "none"}; ${expect.action} takes exactly ${want.join(", ")}`);
    }
    return { ok: true, contract };
  }
}

/** The sentence an action record carries for a contract that passed. */
export const contractLine = (c: ExecutionContract): string =>
  `execution contract ${c.contract_id} verified: ${c.action} on ${c.object}, capabilities ${c.capabilities.join(", ")}, issued ${c.issued_at}, expires ${c.expires_at}, signed by ${c.signed_by} (Ed25519, ${c.policy})`;
