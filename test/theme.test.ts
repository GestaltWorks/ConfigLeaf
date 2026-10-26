// The one design (src/design/theme.ts) on its own, before any page wears it: the token sets agree light and dark, every
// variable a shared rule reads is defined, the text and state colours read on their backgrounds at WCAG AA in both
// schemes, the root rules put dark under prefers-color-scheme, print forces the light tokens on white, the type
// scale is the stated one, and the mark is a drawing with no words that a screen reader skips. The pages' own tests
// (report, executive, console, site) hold the pages to it after; this holds the primitives.
import { describe, expect, it } from "vitest";
import { BASE_CSS, DARK, LIGHT, MARK, PRINT_TOKENS, ROOT_CSS, SCALE, TOKENS } from "../src/design/theme.ts";

/** A token list "--a:x;--b:y" as a map, failing on a name given twice or an entry that is not a custom property. */
function tokens(list: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const entry of list.split(";")) {
    const m = /^(--[a-z][a-z0-9-]*):(.+)$/.exec(entry);
    expect(m, `not a custom property: ${entry}`).not.toBeNull();
    expect(out.has(m![1]), `${m![1]} twice`).toBe(false);
    out.set(m![1], m![2]);
  }
  return out;
}

/** WCAG 2 contrast of two #rrggbb colours. */
function contrast(a: string, b: string): number {
  const lum = (hex: string): number => {
    const [r, g, bl] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const light = tokens(LIGHT);
const dark = tokens(DARK);
const scale = tokens(SCALE);

describe("the one design's tokens", () => {
  it("one table holds each colour's light and dark value side by side: LIGHT and DARK are read off it, the same names in the same order, none twice", () => {
    expect([...light]).toEqual(TOKENS.map(([n, l]) => [n, l]));
    expect([...dark]).toEqual(TOKENS.map(([n, , d]) => [n, d]));
    expect(new Set(TOKENS.map(([n]) => n)).size).toBe(TOKENS.length);
    expect([...light.keys()].filter((k) => scale.has(k))).toEqual([]);
    // the owner's report's colours and the console's additions, in one list
    expect(TOKENS.map(([n]) => n)).toEqual(["--bg", "--fg", "--muted", "--line", "--card", "--soft", "--need", "--need-bg", "--hold", "--hold-bg", "--adopted", "--ok", "--ok-bg", "--locked", "--locked-bg", "--window", "--window-bg", "--hover", "--focus", "--scrim", "--shadow"]);
  });

  it("every colour token is a #rrggbb colour, an rgba() scrim or a shadow", () => {
    for (const [scheme, set] of [["light", light], ["dark", dark]] as const) {
      for (const [k, v] of set) expect(/^#[0-9a-f]{6}$/.test(v) || (k === "--scrim" && /^rgba\(/.test(v)) || (k === "--shadow" && /^0 \d+px \d+px rgba\(/.test(v)), `${scheme} ${k}: ${v}`).toBe(true);
    }
  });

  it("text and every state colour read on their backgrounds at WCAG AA (4.5:1) in both schemes", () => {
    const pairs: [string, string][] = [["--fg", "--bg"], ["--fg", "--card"], ["--muted", "--bg"], ["--muted", "--card"], ["--need", "--need-bg"], ["--hold", "--hold-bg"], ["--ok", "--ok-bg"], ["--locked", "--locked-bg"], ["--window", "--window-bg"], ["--need", "--card"], ["--ok", "--card"]];
    for (const [scheme, set] of [["light", light], ["dark", dark]] as const) {
      for (const [fg, bg] of pairs) expect(contrast(set.get(fg)!, set.get(bg)!), `${scheme} ${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("the type scale is 12, 13.5, 15, 17 and 22 px with 28 px for a tile's number, one radius, one sans and one mono stack", () => {
    expect([...scale].filter(([k]) => k.startsWith("--t-"))).toEqual([["--t-xs", "12px"], ["--t-s", "13.5px"], ["--t-m", "15px"], ["--t-l", "17px"], ["--t-xl", "22px"], ["--t-num", "28px"]]);
    expect(scale.get("--radius")).toBe("10px");
    expect(scale.get("--sans")).toMatch(/^system-ui,.*sans-serif$/);
    expect(scale.get("--mono")).toMatch(/^ui-monospace,.*monospace$/);
  });
});

describe("the one design's rules", () => {
  it("the root rules: light tokens and the scale on :root, the dark ones on a screen that prefers dark (never in print), each with its color-scheme", () => {
    expect(ROOT_CSS).toBe(`:root{${LIGHT};${SCALE};color-scheme:light}\n@media screen and (prefers-color-scheme:dark){:root{${DARK};color-scheme:dark}}`);
  });

  it("print sets the white page and cards once and copies no light token: the light ones already hold, the dark ones are for a screen", () => {
    expect(PRINT_TOKENS).toBe("color-scheme:light;--bg:#fff;--card:#fff;--soft:#f3f3f3");
    for (const [n] of TOKENS.filter(([n]) => !["--bg", "--card", "--soft"].includes(n))) expect(PRINT_TOKENS, n).not.toContain(`${n}:`);
    // the light text and states still read on the white page
    for (const n of ["--fg", "--muted", "--need", "--ok"]) expect(contrast(light.get(n)!, "#ffffff"), n).toBeGreaterThanOrEqual(4.5);
  });

  it("every variable the shared rules read is a token of the design, or carries its own fallback", () => {
    const defined = new Set([...light.keys(), ...scale.keys()]);
    const used = [...BASE_CSS.matchAll(/var\((--[a-z0-9-]+)(,[^)]*)?\)/g)].map((m) => ({ name: m[1], fallback: m[2] !== undefined }));
    expect(used.length).toBeGreaterThan(20);
    expect(used.filter((u) => !defined.has(u.name) && !u.fallback).map((u) => u.name)).toEqual([]);
    // the two a page sets itself, each with a fallback: the page width and the gutter
    expect([...new Set(used.filter((u) => !defined.has(u.name)).map((u) => u.name))].sort()).toEqual(["--gutter", "--page"]);
  });

  it("no colour is written into the shared rules: every colour is a token", () => {
    expect(BASE_CSS).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
    // the header bar, the cards, the tiles and the mark are there
    for (const sel of [".bar{", ".bar-in{", ".card{", ".tile{", ".tile .v{", ".mark{", ".mark .vein{", ".alert{", ".sum{"]) expect(BASE_CSS, sel).toContain(sel);
  });

  it("the mark is a drawing with no words: hidden from a screen reader, not focusable, outline in the ok colour and veins in the text colour", () => {
    expect(MARK.startsWith('<span class="mark" aria-hidden="true"><svg viewBox="0 0 100 100"')).toBe(true);
    expect(MARK).toContain('focusable="false"');
    expect(MARK).toContain('stroke="currentColor"');
    expect(MARK).toContain('class="vein"');
    expect(MARK.replace(/<[^>]+>/g, "")).toBe("");
    expect(MARK).not.toMatch(/<text|<title|href|url\(|<image/);
    expect(BASE_CSS).toContain(".mark{display:inline-flex;flex:none;width:22px;height:22px;color:var(--ok)}");
    expect(BASE_CSS).toContain(".mark .vein{stroke:var(--fg)}");
  });
});
