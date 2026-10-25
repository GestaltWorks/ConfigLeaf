// The diff of a cause (src/explain/): the approved copy of a file against its live bytes as a unified diff, or an
// approved value against the observed one, every line through a redaction function, at most DIFF_MAX_LINES lines.
// Pure: no file, no git, no clock; the vault reads happen in explain.ts and hand the bytes in.
//
// Contract:
//   - unifiedDiff(a, b) is null when the two texts are equal line for line. Lines split on "\n" with a trailing "\r"
//     dropped, a final newline ending the last line rather than starting an empty one. The edit script is a longest
//     common subsequence of lines after the common head and tail are set aside; when the middle is larger than
//     LCS_CELLS cells it is every old line removed, then every new line added. Hunks carry CONTEXT lines either side,
//     two hunks at most twice that apart are one, and each header is "@@ -<start>,<len> +<start>,<len> @@" as diff -u
//     writes it (a zero-length side starts at the line before).
//   - The first two lines are "--- <from>" and "+++ <to>". Past DIFF_MAX_LINES, the first DIFF_MAX_LINES - 1 lines are
//     kept and the last says how many were left out.
//   - valueDiff(setting, approved, observed) is the same two header lines and one "-" and one "+" line; an absent
//     side reads "(absent)".

/** The most lines a cause's diff holds. */
export const DIFF_MAX_LINES = 40;
/** Lines of context around each change. */
export const CONTEXT = 3;
/** The largest middle (old lines times new lines) the subsequence table is built for. */
export const LCS_CELLS = 4_000_000;

type Op = { t: " " | "-" | "+"; s: string };

/** A text's lines: "\n" splits, a trailing "\r" goes, and a final newline ends the last line. */
export function linesOf(text: string): string[] {
  if (text === "") return [];
  const ls = text.split("\n").map((l) => l.replace(/\r$/, ""));
  if (ls.at(-1) === "") ls.pop();
  return ls;
}

/** The edit script turning `a` into `b`, line by line. */
export function editScript(a: readonly string[], b: readonly string[]): Op[] {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const A = a.slice(head, a.length - tail);
  const B = b.slice(head, b.length - tail);
  const mid: Op[] = [];
  if (A.length * B.length > LCS_CELLS) {
    mid.push(...A.map((s): Op => ({ t: "-", s })), ...B.map((s): Op => ({ t: "+", s })));
  } else {
    // lcs[i][j]: the longest common subsequence of A[i..] and B[j..]
    const w = B.length + 1;
    const lcs = new Uint32Array((A.length + 1) * w);
    for (let i = A.length - 1; i >= 0; i--) {
      for (let j = B.length - 1; j >= 0; j--) {
        lcs[i * w + j] = A[i] === B[j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < A.length && j < B.length) {
      if (A[i] === B[j]) { mid.push({ t: " ", s: A[i] }); i++; j++; }
      else if (lcs[(i + 1) * w + j] >= lcs[i * w + j + 1]) mid.push({ t: "-", s: A[i++] });
      else mid.push({ t: "+", s: B[j++] });
    }
    while (i < A.length) mid.push({ t: "-", s: A[i++] });
    while (j < B.length) mid.push({ t: "+", s: B[j++] });
  }
  return [...a.slice(0, head).map((s): Op => ({ t: " ", s })), ...mid, ...a.slice(a.length - tail).map((s): Op => ({ t: " ", s }))];
}

/** At most `max` lines: past it, the first max - 1 and a line saying how many were left out. */
export function capLines(lines: readonly string[], max = DIFF_MAX_LINES): string[] {
  if (lines.length <= max) return [...lines];
  return [...lines.slice(0, max - 1), `… ${lines.length - (max - 1)} more lines of the diff left out`];
}

export interface DiffOptions {
  /** The "---" and "+++" labels. */
  from: string;
  to: string;
  /** Every line of the diff passes this; the identity when absent. */
  line?: (s: string) => string;
  max?: number;
}

/** The unified diff of two texts, or null when they are equal line for line (see the header). */
export function unifiedDiff(a: string, b: string, o: DiffOptions): string | null {
  const ops = editScript(linesOf(a), linesOf(b));
  const changed = ops.flatMap((op, k) => (op.t === " " ? [] : [k]));
  if (!changed.length) return null;
  // positions in a and b before each op
  const ai: number[] = [];
  const bi: number[] = [];
  let x = 0;
  let y = 0;
  for (const op of ops) {
    ai.push(x);
    bi.push(y);
    if (op.t !== "+") x++;
    if (op.t !== "-") y++;
  }
  ai.push(x);
  bi.push(y);
  const ranges: [number, number][] = [];
  for (const k of changed) {
    const lo = Math.max(0, k - CONTEXT);
    const hi = Math.min(ops.length, k + CONTEXT + 1);
    const last = ranges.at(-1);
    if (last && lo <= last[1]) last[1] = Math.max(last[1], hi);
    else ranges.push([lo, hi]);
  }
  const out = [`--- ${o.from}`, `+++ ${o.to}`];
  for (const [lo, hi] of ranges) {
    const aLen = ai[hi] - ai[lo];
    const bLen = bi[hi] - bi[lo];
    out.push(`@@ -${aLen ? ai[lo] + 1 : ai[lo]},${aLen} +${bLen ? bi[lo] + 1 : bi[lo]},${bLen} @@`);
    for (const op of ops.slice(lo, hi)) out.push(`${op.t}${op.s}`);
  }
  const line = o.line ?? ((s: string) => s);
  return capLines(out, o.max).map(line).join("\n");
}

/** An approved value against the observed one, as two diff lines under the same headers. */
export function valueDiff(setting: string, approved: string | null, observed: string | null, o: Omit<DiffOptions, "max">): string | null {
  if (approved === observed) return null;
  const line = o.line ?? ((s: string) => s);
  return [`--- ${o.from}`, `+++ ${o.to}`, `-${setting} ${approved ?? "(absent)"}`, `+${setting} ${observed ?? "(absent)"}`].map(line).join("\n");
}
