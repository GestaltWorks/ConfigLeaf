// The executive report's charts (src/document/executive.ts): inline SVG rendered on the server, no script, no
// external resource. Each chart is a <figure> with its title, an SVG with both axes labelled, a legend, and its data
// beneath it as a table, so a reader without the colours, or without the picture, reads the same numbers.
//
//   barChart   one bar per UTC day, stacked by series. A series is told apart three ways: its fill (a token of the one
//              design, src/design/theme.ts, so light, dark and print follow the page), its pattern (solid, stripes,
//              dots, bars, cross-hatch, columns, drawn in the card colour over the fill) and its name in the legend and
//              the table; each bar's total stands above it.
//   lineChart  one point per UTC day joined by a line, each point a circle, the first and the last value written
//              beside their point.
//
// Every label passes `t` (the page's redactor, then the HTML escape). Ids are the chart's own (`<id>-t`, `<id>-p1`),
// so several charts sit on one page. Sizes are in the SVG's own units (680 by 240); CSS scales it to the column.

import { thousands } from "../loop/present.ts";

export interface Series {
  key: string;
  /** The name the legend and the table give it. */
  label: string;
  /** The fill: need, hold, ok, adopted, locked, muted, fg (the .f-<fill> classes of CHART_CSS). */
  fill: Fill;
}
export type Fill = "need" | "hold" | "ok" | "adopted" | "locked" | "muted" | "fg";

export interface BarChart {
  id: string;
  title: string;
  /** One sentence under the title: what is counted. */
  caption: string;
  /** The y axis: what one unit is ("findings"). */
  y: string;
  days: readonly string[];
  series: readonly Series[];
  /** values[day][series]. */
  values: readonly (readonly number[])[];
  /** The table's column for a day's total, and any column after the series (e.g. the names probed that day). */
  extra?: { label: string; values: readonly number[] };
  /** The series' name as a column head ("Kind and status"): the table lists one row per day and series when there are more than WIDE series. */
  seriesHead?: string;
}

/** Series a table shows as columns; with more, one row per day and series. */
const WIDE = 4;

export interface LineChart {
  id: string;
  title: string;
  caption: string;
  y: string;
  days: readonly string[];
  /** The value at the end of each day. */
  values: readonly number[];
  /** What happened on each day, the table's middle column. */
  daily: { label: string; values: readonly number[] };
  /** The table's last column: what the line shows. */
  label: string;
  /** What a quiet day records none of, for the line under the table ("approval"). */
  none: string;
}

const W = 680;
const H = 240;
const L = 52;
const R = 14;
const T = 18;
const B = 50;
const PW = W - L - R;
const PH = H - T - B;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** 2026-10-25 as the axis writes it: 25 Oct. */
export const dayLabel = (day: string): string => `${Number(day.slice(8, 10))} ${MONTHS[Number(day.slice(5, 7)) - 1] ?? ""}`;
/** 2026-10-25 as the table writes it: 25 Oct 2026. */
export const dayLong = (day: string): string => `${dayLabel(day)} ${day.slice(0, 4)}`;
const num = (x: number): string => (Number.isInteger(x) ? String(x) : x.toFixed(1));
const capital = (s: string): string => s.replace(/^./, (c) => c.toUpperCase());

/** The axis's top and its step: a round step (1, 2 or 5 times a power of ten) giving at most five intervals. */
export function niceScale(max: number): { top: number; step: number } {
  if (max <= 0) return { top: 1, step: 1 };
  const raw = max / 5;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= raw && s >= 1) ?? Math.max(1, pow * 10);
  return { top: Math.ceil(max / step) * step, step };
}

/** The patterns a series index draws over its fill: none for the first, then stripes, dots, bars, cross-hatch, columns. */
function patterns(id: string): string {
  const p = (n: number, body: string, rotate = ""): string =>
    `<pattern id="${id}-p${n}" width="6" height="6" patternUnits="userSpaceOnUse"${rotate ? ` patternTransform="${rotate}"` : ""}>${body}</pattern>`;
  return `<defs>${[
    p(1, `<path class="pl" d="M0 0V6"/>`, "rotate(45)"),
    p(2, `<circle class="pd" cx="3" cy="3" r="1.3"/>`),
    p(3, `<path class="pl" d="M0 3H6"/>`),
    p(4, `<path class="pl" d="M0 0V6M0 3H6"/>`, "rotate(45)"),
    p(5, `<path class="pl" d="M3 0V6"/>`),
  ].join("")}</defs>`;
}
const PATTERNS = 5;
/** A rectangle in a series' fill, with its pattern over it. */
const rect = (id: string, i: number, fill: Fill, x: number, y: number, w: number, h: number, cls = "seg"): string =>
  `<rect class="${cls} f-${fill}" x="${num(x)}" y="${num(y)}" width="${num(w)}" height="${num(h)}"/>${i % (PATTERNS + 1) ? `<rect class="ov" x="${num(x)}" y="${num(y)}" width="${num(w)}" height="${num(h)}" fill="url(#${id}-p${i % (PATTERNS + 1)})"/>` : ""}`;

/** The legend: a swatch drawn as the bars draw the series, then its name. */
function legend(c: { id: string; series: readonly Series[] }, t: (s: string) => string): string {
  return `<ul class="legend">${c.series.map((s, i) => `<li><svg class="sw" viewBox="0 0 14 14" aria-hidden="true" focusable="false">${rect(c.id, i, s.fill, 0, 0, 14, 14, "sws")}</svg>${t(s.label)}</li>`).join("")}</ul>`;
}

/** The axes: the grid at each step, the y ticks, the day labels (every k-th when they would crowd), both axis names. */
function axes(days: readonly string[], top: number, step: number, y: string, t: (s: string) => string): string {
  const out: string[] = [];
  for (let v = 0; v <= top + 1e-9; v += step) {
    const yy = T + PH - (v / top) * PH;
    out.push(`<line class="grid" x1="${L}" x2="${W - R}" y1="${num(yy)}" y2="${num(yy)}"/><text class="tick" x="${L - 8}" y="${num(yy + 4)}" text-anchor="end">${thousands(v)}</text>`);
  }
  const slot = PW / Math.max(1, days.length);
  const every = Math.max(1, Math.ceil(days.length / 10));
  days.forEach((d, i) => {
    // every k-th day, and the last when it sits at least half a step past the one before
    if (i % every !== 0 && !(i === days.length - 1 && i % every >= Math.ceil(every / 2))) return;
    out.push(`<text class="tick" x="${num(L + i * slot + slot / 2)}" y="${T + PH + 18}" text-anchor="middle">${t(dayLabel(d))}</text>`);
  });
  out.push(`<line class="axis" x1="${L}" x2="${W - R}" y1="${T + PH}" y2="${T + PH}"/><line class="axis" x1="${L}" x2="${L}" y1="${T}" y2="${T + PH}"/>`);
  out.push(`<text class="axl" x="${L + PW / 2}" y="${H - 8}" text-anchor="middle">Day (UTC)</text>`);
  out.push(`<text class="axl" transform="translate(14 ${T + PH / 2}) rotate(-90)" text-anchor="middle">${t(y)}</text>`);
  return out.join("");
}

const svgOpen = (id: string, title: string, caption: string, t: (s: string) => string): string =>
  `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="${id}-st ${id}-sd" focusable="false"><title id="${id}-st">${t(title)}</title><desc id="${id}-sd">${t(caption)} The table under the chart holds every number.</desc>`;

/** The table beneath a chart: the days with a count, the others named in one line. */
function dataTable(head: readonly string[], rows: readonly (readonly string[])[], rest: string, t: (s: string) => string, text: readonly number[] = []): string {
  const cls = (i: number): string => (text.includes(i) ? "" : ' class="num"');
  const table = rows.length
    ? `<table class="data"><thead><tr>${head.map((h, i) => `<th scope="col"${i ? cls(i) : ""}>${t(h)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c, i) => (i ? `<td${cls(i)} data-label="${t(head[i])}">${c}</td>` : `<th scope="row" data-label="${t(head[0])}">${c}</th>`)).join("")}</tr>`).join("")}</tbody></table>`
    : "";
  return `${table}${rest ? `<p class="rest">${t(rest)}</p>` : ""}`;
}

export function barChart(c: BarChart, t: (s: string) => string): string {
  const totals = c.values.map((r) => r.reduce((a, b) => a + b, 0));
  const { top, step } = niceScale(Math.max(0, ...totals));
  const slot = PW / Math.max(1, c.days.length);
  const bw = Math.max(1, Math.min(44, slot * 0.66));
  const bars: string[] = [];
  c.days.forEach((d, i) => {
    let y = T + PH;
    const x = L + i * slot + (slot - bw) / 2;
    c.series.forEach((s, j) => {
      const v = c.values[i]?.[j] ?? 0;
      if (!v) return;
      const h = (v / top) * PH;
      y -= h;
      bars.push(rect(c.id, j, s.fill, x, y, bw, h));
    });
    if (totals[i] && slot >= 13) bars.push(`<text class="val" x="${num(x + bw / 2)}" y="${num(y - 5)}" text-anchor="middle">${thousands(totals[i])}</text>`);
  });
  const shown = c.days.map((d, i) => ({ d, i })).filter(({ i }) => totals[i] > 0 || (c.extra?.values[i] ?? 0) > 0);
  const zero = c.days.length - shown.length;
  const wide = c.series.length <= WIDE;
  const head = wide ? ["Day (UTC)", ...c.series.map((s) => s.label), "Total", ...(c.extra ? [c.extra.label] : [])] : ["Day (UTC)", c.seriesHead ?? "Series", capital(c.y)];
  const rows = wide
    ? shown.map(({ d, i }) => [t(dayLong(d)), ...c.series.map((_, j) => thousands(c.values[i]?.[j] ?? 0)), `<b>${thousands(totals[i])}</b>`, ...(c.extra ? [thousands(c.extra.values[i] ?? 0)] : [])])
    : shown.flatMap(({ d, i }) => [
      ...c.series.flatMap((s, j) => ((c.values[i]?.[j] ?? 0) ? [[t(dayLong(d)), t(s.label), thousands(c.values[i][j])]] : [])),
      [t(dayLong(d)), "<b>Total</b>", `<b>${thousands(totals[i])}</b>`],
    ]);
  const rest = !c.days.length ? "The period holds no day." : !shown.length ? `Every day of the period counts 0 ${c.y.toLowerCase()}.` : zero ? `The other ${zero === 1 ? "day" : `${thousands(zero)} days`} of the period ${zero === 1 ? "counts" : "count"} 0.` : "";
  return `<figure class="ex-chart" id="${c.id}">
<figcaption><h3 id="${c.id}-t">${t(c.title)}</h3><p class="cap">${t(c.caption)}</p></figcaption>
${svgOpen(c.id, c.title, c.caption, t)}${patterns(c.id)}${axes(c.days, top, step, c.y, t)}${bars.join("")}</svg>
${c.series.length ? legend(c, t) : ""}
${dataTable(head, rows, rest, t, wide ? [] : [1])}
</figure>`;
}

export function lineChart(c: LineChart, t: (s: string) => string): string {
  const { top, step } = niceScale(Math.max(0, ...c.values));
  const slot = PW / Math.max(1, c.days.length);
  const pts = c.values.map((v, i) => ({ x: L + i * slot + slot / 2, y: T + PH - (v / top) * PH, v }));
  const line = pts.length > 1 ? `<polyline class="ln" points="${pts.map((p) => `${num(p.x)},${num(p.y)}`).join(" ")}"/>` : "";
  const dots = pts.map((p) => `<circle class="pt" cx="${num(p.x)}" cy="${num(p.y)}" r="3.5"/>`).join("");
  const labelAt = (p: { x: number; y: number; v: number }, anchor: string): string => `<text class="val" x="${num(p.x)}" y="${num(Math.max(T + 10, p.y - 9))}" text-anchor="${anchor}">${thousands(p.v)}</text>`;
  const ends = pts.length ? [labelAt(pts[0], pts.length > 1 ? "start" : "middle"), ...(pts.length > 1 ? [labelAt(pts[pts.length - 1], "end")] : [])].join("") : "";
  const shown = c.days.map((d, i) => ({ d, i })).filter(({ i }) => (c.daily.values[i] ?? 0) > 0 || i === c.days.length - 1);
  const quiet = c.days.length - shown.length;
  const rows = shown.map(({ d, i }) => [t(dayLong(d)), thousands(c.daily.values[i] ?? 0), `<b>${thousands(c.values[i] ?? 0)}</b>`]);
  const rest = quiet ? `The other ${quiet === 1 ? "day" : `${thousands(quiet)} days`} of the period ${quiet === 1 ? "records" : "record"} no ${c.none}; the line holds the day before's value.` : "";
  return `<figure class="ex-chart" id="${c.id}">
<figcaption><h3 id="${c.id}-t">${t(c.title)}</h3><p class="cap">${t(c.caption)}</p></figcaption>
${svgOpen(c.id, c.title, c.caption, t)}${axes(c.days, top, step, c.y, t)}${line}${dots}${ends}</svg>
<ul class="legend"><li><svg class="sw" viewBox="0 0 14 14" aria-hidden="true" focusable="false"><line class="ln" x1="0" x2="14" y1="7" y2="7"/><circle class="pt" cx="7" cy="7" r="3"/></svg>${t(c.label)}</li></ul>
${dataTable(["Day (UTC)", c.daily.label, c.label], rows, rest, t)}
</figure>`;
}

/** The charts' rules: fills from the tokens, the patterns in the card colour, the axes and the labels muted. */
export const CHART_CSS = `.ex-chart{margin:0;min-width:0}
.ex-chart figcaption h3{margin:0}
.ex-chart .cap{color:var(--muted);font-size:var(--t-s);margin:2px 0 6px}
.chart{display:block;width:100%;height:auto;max-height:300px;overflow:visible}
.chart text{font-family:var(--sans);font-size:12px;fill:var(--muted)}
.chart .axl{font-size:12.5px;font-weight:600;fill:var(--fg)}
.chart .val{font-size:12px;font-weight:650;fill:var(--fg)}
.chart .grid{stroke:var(--line);stroke-width:1}
.chart .axis{stroke:var(--muted);stroke-width:1}
.chart .seg,.sw .sws{stroke:var(--card);stroke-width:1}
.chart .pl,.sw .pl{stroke:var(--card);stroke-width:1.7}
.chart .pd{fill:var(--card)}
.chart .ln,.sw .ln{fill:none;stroke:var(--locked);stroke-width:2.5}
.chart .pt,.sw .pt{fill:var(--card);stroke:var(--locked);stroke-width:2}
.f-need{fill:var(--need)}.f-hold{fill:var(--hold)}.f-ok{fill:var(--ok)}.f-adopted{fill:var(--adopted)}.f-locked{fill:var(--locked)}.f-muted{fill:var(--muted)}.f-fg{fill:var(--fg)}
.legend{list-style:none;display:flex;flex-wrap:wrap;gap:4px 16px;margin:6px 0 8px;padding:0;font-size:var(--t-s)}
.legend li{display:inline-flex;align-items:center;gap:6px}
.legend .sw{width:14px;height:14px;flex:none;border-radius:2px}
table.data{border-collapse:collapse;width:100%;font-size:var(--t-s);margin:4px 0;overflow-wrap:normal}
table.data th,table.data td{padding:4px 8px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
table.data thead th{font-size:var(--t-xs);font-weight:600;color:var(--muted);background:var(--soft)}
table.data tbody th{font-weight:500;white-space:nowrap;background:none;color:var(--fg);font-size:inherit}
table.data .num{text-align:right;font-variant-numeric:tabular-nums}
.ex-chart .rest{color:var(--muted);font-size:var(--t-xs);margin:4px 0 0}
@media (max-width:640px){
table.data,table.data tbody,table.data tr,table.data th,table.data td{display:block;width:100%}
table.data thead{display:none}
table.data tr{border-bottom:1px solid var(--line);padding:6px 0}
table.data tbody th,table.data td{border:0;padding:1px 0;white-space:normal}
table.data td{display:flex;justify-content:space-between;gap:12px;text-align:right}
table.data td::before{content:attr(data-label);color:var(--muted);text-align:left}
}`;
