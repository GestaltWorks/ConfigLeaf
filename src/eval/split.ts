// The eval's development and held-out sets, as eval/PROTOCOL.md "Split" states them: a seeded shuffle of
// the labelled items, seed = the sha256 of eval/labels.json, the first 40% the development set and the
// rest the held-out set.
//
// Contract. The seed is the sha256 hex of labels.json as committed: the text with CRLF line endings read as
// LF, so a Windows checkout under core.autocrlf and a Linux checkout give one seed. The shuffle is
// Fisher-Yates from the last position down; the draw for position i is a 32-bit big-endian word of a
// sha256 counter stream (block k = sha256("<seed>:<k>"), eight words per block, taken in order) modulo
// i + 1. The development set is the first floor(40% of n) items of the shuffled order, kept in that order;
// the held-out set is the rest. Pure: the same file gives the same sets on every machine.
//
// Measured 24 Oct 2026 on the committed labels.json (38 labelled items): 15 development, 23 held out
// (test/eval.test.ts pins both lists).

import { createHash } from "node:crypto";

export const DEV_FRACTION = 0.4;

/** sha256 hex of the labels file as committed (CRLF read as LF). */
export function labelsSeed(text: string): string {
  return createHash("sha256").update(text.replace(/\r\n/g, "\n"), "utf8").digest("hex");
}

/** A deterministic stream of 32-bit words from the seed: sha256("<seed>:<k>") for k = 0, 1, 2, ..., eight words each. */
export function wordStream(seedHex: string): () => number {
  let block = 0;
  let words: number[] = [];
  return () => {
    if (words.length === 0) {
      const d = createHash("sha256").update(`${seedHex}:${block++}`, "utf8").digest();
      words = Array.from({ length: 8 }, (_, i) => d.readUInt32BE(i * 4));
    }
    return words.shift()!;
  };
}

/** Fisher-Yates over a copy, from the last position down, each draw a word of the seed's stream modulo i + 1. */
export function seededShuffle<T>(xs: readonly T[], seedHex: string): T[] {
  const out = [...xs];
  const next = wordStream(seedHex);
  for (let i = out.length - 1; i > 0; i--) {
    const j = next() % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export interface Split {
  seed: string;
  /** Every labelled id in shuffled order. */
  order: string[];
  dev: string[];
  heldout: string[];
}

/** The protocol's split of the labelled ids (in the labels file's order) under the seed. */
export function splitItems(ids: readonly string[], seedHex: string, fraction = DEV_FRACTION): Split {
  const order = seededShuffle(ids, seedHex);
  const n = Math.floor(order.length * fraction);
  return { seed: seedHex, order, dev: order.slice(0, n), heldout: order.slice(n) };
}
