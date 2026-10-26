// One design for every page ConfigLeaf renders: the technician's console (src/console/html.ts), the owner's report
// (src/document/report.ts), the executive report (src/document/executive.ts), the replay page and the landing page
// (scripts/build-site.ts, scripts/site/landing.html). Each page states its own layout; the colours, the type scale, the
// header bar, the cards and the tiles come from here, so the pages read as one product.
//
//   tokens    one table (TOKENS), each colour's light and dark value side by side: the owner's report's colours and
//             the ones the console added (ok's background, the lock, an open window, the hover, the focus ring, the
//             scrim, the shadow). LIGHT and DARK are read off it, so the two schemes cannot drift apart. The light
//             ones are the page's; the dark ones apply on a screen that prefers dark, never in print, so print needs
//             no second copy of the light tokens: PRINT_TOKENS sets only the white page and cards.
//   scale     one type scale (12, 13.5, 15, 17 and 22 px, 28 px for a tile's number), one monospace and one sans stack,
//             one corner radius.
//   bar       the sticky header bar: the leaf mark, the summary line in the bar's 17 px, the who line in 12.5 px muted.
//   cards     .card and .tile: the card colour on the page colour, a 1 px rule, the radius.
//
// No colour is the only signal anywhere: a verb or a state carries its word, and a chart's series carry a pattern and
// a label as well as a fill (src/document/charts.ts).

/** Every colour token with its light and its dark value. */
export const TOKENS: readonly (readonly [name: string, light: string, dark: string])[] = [
  ["--bg", "#fbfaf7", "#141517"],
  ["--fg", "#1d1e20", "#e8e6e1"],
  ["--muted", "#62666d", "#a3a19b"],
  ["--line", "#dedad2", "#33353a"],
  ["--card", "#ffffff", "#1b1c1f"],
  ["--soft", "#f2f0eb", "#222428"],
  ["--need", "#b3361d", "#ff8e74"],
  ["--need-bg", "#fbebe6", "#3a201a"],
  ["--hold", "#835700", "#f0c46e"],
  ["--hold-bg", "#f8ecd2", "#382c13"],
  ["--adopted", "#6c7178", "#9a9da3"],
  ["--ok", "#2f6b45", "#8fd1a6"],
  ["--ok-bg", "#e3f0e7", "#1b3124"],
  ["--locked", "#2b5c8a", "#8db8e6"],
  ["--locked-bg", "#e7eef6", "#1b2733"],
  ["--window", "#835700", "#f0c46e"],
  ["--window-bg", "#f8ecd2", "#382c13"],
  ["--hover", "#f3f1ec", "#202226"],
  ["--focus", "#2b5c8a", "#8db8e6"],
  ["--scrim", "rgba(20,20,22,.36)", "rgba(0,0,0,.55)"],
  ["--shadow", "0 10px 40px rgba(0,0,0,.14)", "0 10px 40px rgba(0,0,0,.5)"],
];
/** The light tokens, as one declaration list. */
export const LIGHT = TOKENS.map(([name, light]) => `${name}:${light}`).join(";");
/** The dark tokens, the same names in the same order. */
export const DARK = TOKENS.map(([name, , dark]) => `${name}:${dark}`).join(";");
/** The type scale, the two stacks and the radius, the same in both schemes. */
export const SCALE = `--sans:system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;--mono:ui-monospace,SFMono-Regular,"Cascadia Mono",Consolas,"Liberation Mono",Menlo,monospace;--t-xs:12px;--t-s:13.5px;--t-m:15px;--t-l:17px;--t-xl:22px;--t-num:28px;--radius:10px`;

/** Print: the light tokens already hold (the dark ones are for a screen), on a white page with white cards. */
export const PRINT_TOKENS = "color-scheme:light;--bg:#fff;--card:#fff;--soft:#f3f3f3";

/** The root rules: the tokens light, dark on a screen that prefers it. */
export const ROOT_CSS = `:root{${LIGHT};${SCALE};color-scheme:light}
@media screen and (prefers-color-scheme:dark){:root{${DARK};color-scheme:dark}}`;

/** The rules every page shares: the page, the type scale, links, code, the header bar, cards and tiles. */
export const BASE_CSS = `*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:var(--t-m)/1.45 var(--sans);overflow-wrap:anywhere}
a{color:inherit;text-decoration-thickness:1px;text-underline-offset:2px}
a:hover{text-decoration-thickness:2px}
h1{font-size:var(--t-xl);line-height:1.25;margin:0 0 4px;letter-spacing:-.005em}
h2{font-size:18px;line-height:1.3;margin:0 0 10px;letter-spacing:-.003em}
h3{font-size:var(--t-m);line-height:1.35;margin:0}
p{margin:4px 0}
ul{margin:4px 0;padding-left:20px}
code,.mono{font-family:var(--mono);font-size:.87em}
.muted{color:var(--muted)}
.nw{white-space:nowrap}
.bar{position:sticky;top:0;z-index:10;background:var(--bg);border-bottom:1px solid var(--line)}
.bar-in{max-width:var(--page,1200px);margin:0 auto;padding:10px var(--gutter,24px);display:flex;flex-wrap:wrap;align-items:center;gap:4px 20px}
.bar-in>.sum{flex:1 1 auto}
.mark{display:inline-flex;flex:none;width:22px;height:22px;color:var(--ok)}
.mark svg{width:22px;height:22px}
.mark .vein{stroke:var(--fg)}
.sum{font-size:var(--t-l);font-weight:600;line-height:1.3}
.sum a{text-decoration:none;white-space:nowrap}
.sum a:hover{text-decoration:underline}
.sum b{font-variant-numeric:tabular-nums}
.sum .need{color:var(--need)}
.who{display:flex;flex-wrap:wrap;align-items:baseline;gap:0 12px;font-size:12.5px;color:var(--muted)}
.who h1{font-size:12.5px;font-weight:600;margin:0;color:var(--fg)}
.who b{color:var(--fg);font-weight:600}
.card{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);padding:14px 16px}
.tile{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);padding:18px}
.tile .k{display:block;font-size:12.5px;line-height:1.3;color:var(--muted)}
.tile .v{display:block;font-size:var(--t-num);font-weight:650;line-height:1.15;margin:4px 0 2px;font-variant-numeric:tabular-nums}
.tile .s{margin:0;font-size:12.5px;color:var(--muted)}
.alert{border:1px solid var(--need);border-radius:var(--radius);padding:10px 12px;color:var(--need);background:var(--need-bg)}
.calm{color:var(--ok);font-weight:600}`;

/**
 * The leaf mark at the left of the header bar: a drawing, no words, hidden from a screen reader (the page's heading
 * names what it is). Its outline takes the ok colour and its veins the text colour, through the classes BASE_CSS styles.
 */
export const MARK = `<span class="mark" aria-hidden="true"><svg viewBox="0 0 100 100" fill="none" stroke="currentColor" stroke-width="7" stroke-linecap="round" stroke-linejoin="round" focusable="false"><path d="M50 12C68 26 82 44 80 62C78 78 64 88 50 88C36 88 22 78 20 62C18 44 32 26 50 12Z"/><path class="vein" stroke-width="5" d="M50 30V94M50 54L64 46M50 68L36 60"/></svg></span>`;
