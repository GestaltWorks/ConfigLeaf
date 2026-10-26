// The one design (src/design/theme.ts) on its own, before any page wears it: the token sets agree light and dark, every
// variable a shared rule reads is defined, the text and state colours read on their backgrounds at WCAG AA in both
// schemes, the root rules put dark under prefers-color-scheme, print forces the light tokens on white, the type
// scale is the stated one, and the mark is a drawing with no words that a screen reader skips. The pages' own tests
// (report, executive, console, site) hold the pages to it after; this holds the primitives.
import { describe, expect, it } from "vitest";
import { BASE_CSS, DARK, DARK_MORE, LIGHT, LIGHT_MORE, MARK, PRINT_TOKENS, ROOT_CSS, SCALE } from "../src/design/theme.ts";

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

const light = new Map([...tokens(LIGHT), ...tokens(LIGHT_MORE)]);
const dark = new Map([...tokens(DARK), ...tokens(DARK_MORE)]);
const scale = tokens(SCALE);

describe("the one design's tokens", () => {
  it("light and dark define the same names, the base set and the console's additions apart, none twice", () => {
    expect([...tokens(DARK).keys()]).toEqual([...tokens(LIGHT).keys()]);
    expect([...tokens(DARK_MORE).keys()]).toEqual([...tokens(LIGHT_MORE).keys()]);
    expect([...tokens(LIGHT).keys()].filter((k) => tokens(LIGHT_MORE).has(k))).toEqual([]);
    expect([...light.keys()].filter((k) => scale.has(k))).toEqual([]);
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
  it("the root rules: light tokens and the scale on :root, the dark ones under prefers-color-scheme: dark, each with its color-scheme", () => {
    expect(ROOT_CSS).toBe(`:root{${LIGHT};${LIGHT_MORE};${SCALE};color-scheme:light}\n@media (prefers-color-scheme:dark){:root{${DARK};${DARK_MORE};color-scheme:dark}}`);
  });

  it("print: the light tokens, then a white page and white cards over them, the light color-scheme", () => {
    expect(PRINT_TOKENS).toBe(`color-scheme:light;${LIGHT};${LIGHT_MORE};--bg:#fff;--card:#fff;--soft:#f3f3f3`);
    // the later declaration wins, as in a CSS block
    const print = new Map(PRINT_TOKENS.split(";").slice(1).map((e) => e.split(/:(.*)/s).slice(0, 2) as [string, string]));
    expect([print.get("--bg"), print.get("--card"), print.get("--fg"), print.get("--need")]).toEqual(["#fff", "#fff", light.get("--fg"), light.get("--need")]);
    expect(contrast(print.get("--muted")!, "#ffffff")).toBeGreaterThanOrEqual(4.5);
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
