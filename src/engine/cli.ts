// What `npm run why`, `npm run sleep` and `npm run dream` share: the --at flag and the way a store is named on the screen.
import path from "node:path";
import { z } from "zod";

const INSTANT = z.iso.datetime();

/**
 * The instant of --at in milliseconds, or null when it is malformed. --at is strict ISO 8601 UTC: a date, a T, a time and a Z,
 * milliseconds optional ("2026-12-01T00:00:00Z"); an offset, a missing Z, a day the month lacks or a free-form date is
 * malformed. Absent, it is `now`.
 */
export function parseAt(raw: string | undefined, now: number = Date.now()): number | null {
  if (raw === undefined) return now;
  return INSTANT.safeParse(raw).success ? Date.parse(raw) : null;
}

/** The one line a malformed --at prints. */
export const badAt = (raw: string | undefined): string => `--at is an ISO 8601 UTC instant such as 2026-12-01T00:00:00Z, got ${JSON.stringify(raw)}`;

/** A store directory as the screen names it: under the working directory, relative to it with forward slashes; elsewhere, its last segment. */
export function shownStore(dir: string, cwd: string = process.cwd()): string {
  const rel = path.relative(cwd, dir);
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel.replace(/\\/g, "/") : path.basename(dir);
}
