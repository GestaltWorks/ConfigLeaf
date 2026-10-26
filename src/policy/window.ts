// Change windows: a technician's declared intent to change one object for a while (the console's Unlock), kept in the
// agent's own store as change_window rows (sql/schema.sql). The Decider holds a drift on the object while one is open
// (src/policy/decide.ts, step 3); Approve and Lock close it early. One interface, two backings, as the ledger has:
// PgWindows writes through the Store into the app Postgres the live pass reads through Zetaris, MemoryWindows into the
// sql.js engine of the console in sample mode and of the tests.
//
// Contract:
//   - newWindow builds one row from what the form gives: who and why trimmed, 1 to 200 and 1 to 500 characters with
//     no control character (a newline, a tab or an escape is refused, not stored), both through the redactor the
//     caller passes; hours a whole number from 1 to 72; the surface one of WINDOW_SURFACES (the CHECK sql/schema.sql
//     holds); opened_at the given instant and until that instant plus the hours, both the millisecond form;
//     setting_path "*", every setting of the object; window_id rows.ts windowId. A value out of range throws
//     WindowError naming the field. freeText is the same rule for any other free-text field of a form.
//   - open writes the row (idempotent on window_id), close sets closed_at on a row still open and returns the rows
//     changed: 1, or 0 for a window that is unknown or closed already.

import type { SqlJsEngine } from "../data/engines/sqljs.ts";
import { windowId, type ChangeWindow } from "../data/rows.ts";
import type { Store } from "../data/store.ts";

export const WINDOW_MIN_HOURS = 1;
export const WINDOW_MAX_HOURS = 72;
/** The surfaces a window can be declared on: the objects the console lists (sql/schema.sql change_window_surface). */
export const WINDOW_SURFACES: readonly string[] = ["linux.nginx", "linux.etc", "cloudflare.dns"];

export class WindowError extends Error {}

/** C0 controls, DEL and the C1 range: none belongs in a name or a sentence a page shows on one line. */
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/** One free-text form field, trimmed: 1 to max characters (0 to max when optional), no control character; throws WindowError naming the field. */
export function freeText(field: string, value: string, max: number, what: string, optional = false): string {
  const v = value.trim();
  if ((!v && !optional) || v.length > max) throw new WindowError(`${field}: ${optional ? 0 : 1} to ${max} characters, ${what}`);
  if (CONTROL.test(v)) throw new WindowError(`${field}: one line of text with no control character, ${what}`);
  return v;
}

export interface WindowStore {
  open(row: ChangeWindow): Promise<number>;
  close(windowId: string, closedAt: string): Promise<number>;
}

/** The app Postgres, through the Store (ON CONFLICT (window_id) DO NOTHING; the UPDATE only while closed_at is null). */
export class PgWindows implements WindowStore {
  constructor(private readonly store: Pick<Store, "insertChangeWindows" | "closeChangeWindow">) {}
  open(row: ChangeWindow): Promise<number> { return this.store.insertChangeWindows([row]); }
  close(id: string, closedAt: string): Promise<number> { return this.store.closeChangeWindow(id, closedAt); }
}

/** The sql.js engine (SqlJsEngine.insertRows, closeChangeWindow). */
export class MemoryWindows implements WindowStore {
  constructor(private readonly engine: SqlJsEngine) {}
  async open(row: ChangeWindow): Promise<number> { return this.engine.insertRows("change_window", [row]); }
  async close(id: string, closedAt: string): Promise<number> { return this.engine.closeChangeWindow(id, closedAt); }
}

export interface WindowInput {
  tenant: string;
  surface: string;
  host: string | null;
  object_id: string;
  who: string;
  why: string;
  hours: number;
  now: Date;
  /** The redactor free text passes before it is stored. */
  redact: (s: string) => string;
}

/** One change_window row from the Unlock form (see the header). */
export function newWindow(i: WindowInput): ChangeWindow {
  const who = freeText("who", i.who, 200, "the person or role opening the window");
  const why = freeText("why", i.why, 500, "the change the window is for");
  if (!Number.isInteger(i.hours) || i.hours < WINDOW_MIN_HOURS || i.hours > WINDOW_MAX_HOURS) throw new WindowError(`until: a whole number of hours from ${WINDOW_MIN_HOURS} to ${WINDOW_MAX_HOURS}`);
  if (!WINDOW_SURFACES.includes(i.surface)) throw new WindowError(`surface: a window is declared on ${WINDOW_SURFACES.join(", ")}, got ${i.surface}`);
  const opened = i.now.toISOString();
  const until = new Date(i.now.getTime() + i.hours * 3_600_000).toISOString();
  return {
    window_id: windowId(i.tenant, i.surface, i.host, i.object_id, "*", opened), tenant_id: i.tenant, surface: i.surface, host: i.host, object_id: i.object_id,
    setting_path: "*", opened_by: i.redact(who), opened_at: opened, until, reason: i.redact(why), closed_at: null,
  };
}
