// The console's page shell: the one design's tokens, type scale, header bar, cards and tiles (src/design/theme.ts,
// the owner's report's and the executive report's too) with the console's own rules on top, the executive report's
// (src/document/executive.ts EXECUTIVE_CSS) among them; one stylesheet and one script, each served from its own
// same-origin path that names its content's hash (ASSETS: /assets/console.<hash>.css and .js, cached for a year,
// src/console/server.ts), so a page carries no inline style or script and the CSP needs no 'unsafe-inline'; and the
// layout every page shares: a 240 px navigation with the leaf mark, the tenant switcher and the pages, a sticky summary
// bar (the work queue's strip, with Run a pass) and content up to 1200 px, a table page (work queue, Settings, an
// object) up to 1480 px. One accent (the focus blue) for the primary button, the current page and the sort mark; the
// status chips keep their own colours and always their words. No external script, style or font; light and dark by
// prefers-color-scheme; in print the light tokens and the page alone, the navigation, the bar and the toasts left out;
// at phone width the navigation folds above the bar, tables become one block per row, type goes to 16 px and the
// gutter is 16 px.
//
// The script does these things and nothing else: the drawer (open from a row by click, Enter or Space; close on
// Escape, the scrim or Close; focus kept inside while it is open and returned to the row after), the Settings filters,
// search and column sort, the action forms (one fetch POST; on success the toast is kept in sessionStorage and the
// page reloads, on refusal the toast shows and the form stays; a row's Approve, Unlock and Lock are native popovers
// that carry their own confirmation, so without the script they post the same form and the server answers with the
// toast; the exception form keeps its on-page confirmation, which needs the script), the trace viewer's agent filter,
// the tenant switcher (a change submits its form; without the script its Switch button does), Export PDF
// (window.print) and, for printing, every fold opened and closed again after. Every page reads in full without it;
// the drawer, the sort and the exception form need it.

import { createHash } from "node:crypto";
import { EXECUTIVE_CSS } from "../document/executive.ts";
import { escapeHtml } from "../document/report.ts";
import { BASE_CSS, MARK, PRINT_TOKENS, ROOT_CSS } from "../design/theme.ts";

export { escapeHtml };

export const CSS = `${ROOT_CSS}
:root{--accent:var(--focus);--bar-h:45px}
${BASE_CSS}
[hidden]{display:none!important}
button,input,select,textarea{font:inherit;color:inherit}
:focus-visible{outline:2px solid var(--focus);outline-offset:2px;border-radius:3px}
.skip{position:absolute;left:-999px;top:8px;z-index:50;background:var(--card);padding:6px 10px;border:1px solid var(--line);border-radius:6px}
.skip:focus{left:8px}
h2{margin:26px 0 8px;font-size:17px}
h2 .cnt{font-weight:500;color:var(--muted);font-size:14px;margin-left:6px}
h3{margin:0 0 4px}
.shell{display:grid;grid-template-columns:240px minmax(0,1fr);min-height:100vh}
.side{position:sticky;top:0;height:100vh;overflow:auto;background:var(--card);border-right:1px solid var(--line);padding:18px 12px;display:flex;flex-direction:column;gap:14px}
.brand{padding:0 8px;display:flex;gap:10px;align-items:flex-start}
.brand b{display:block;font-size:16px}
.brand span{display:block;font-size:12.5px;color:var(--muted);margin-top:2px}
.brand .mark{margin-top:1px}
.tenant{margin:0 2px;padding:8px 10px;border:1px solid var(--line);border-radius:8px;font-size:12.5px;color:var(--muted)}
.tenant b{display:block;font-size:14px;color:var(--fg)}
.tenant .mode{display:block;margin-top:4px}
.tsw{margin:0}
.tsw label{display:block;font-size:12px;color:var(--muted);margin:0 0 3px}
.tsw-row{display:flex;gap:6px}
.tsw select{flex:1;min-width:0;padding:5px 8px;border:1px solid var(--line);border-radius:7px;background:var(--card);font-size:14px;font-weight:600;color:var(--fg)}
.tsw .btn{padding:4px 10px;font-size:13px}
.js .tsw .btn{display:none}
.tsw-err{display:block;margin-top:6px;font-size:12px;line-height:1.35;color:var(--need)}
.nav{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px}
.nav a{display:flex;justify-content:space-between;align-items:baseline;gap:8px;padding:7px 10px;border-radius:7px;text-decoration:none}
.nav a:hover{background:var(--hover)}
.nav a[aria-current="page"]{background:var(--soft);font-weight:620;box-shadow:inset 3px 0 0 var(--accent)}
.nav .cnt{font-size:12px;color:var(--muted);font-variant-numeric:tabular-nums}
.nav .cnt.need{color:var(--need);font-weight:650}
.side form{margin:0 2px}
.side .tsw{margin:0}
.side-foot{margin-top:auto;padding:0 8px;font-size:12px;color:var(--muted)}
.content{min-width:0;display:flex;flex-direction:column}
.bar-in{justify-content:space-between;align-items:baseline;gap:2px 20px}
.sum .adopted{color:var(--adopted)}
.sum .locked{color:var(--locked)}
.sum .window{color:var(--window)}
.sum .zero{color:var(--muted)}
.sum .dot{color:var(--muted);font-weight:400}
main{flex:1;min-width:0}
.wrap{max-width:1200px;margin:0 auto;padding:20px 24px 56px}
.shell.wide{--page:1480px}
.shell.wide .wrap{max-width:1480px}
.shell:has(table.set) .bar{position:static}
.head{display:flex;flex-wrap:wrap;gap:8px 16px;align-items:flex-end;justify-content:space-between;margin:0 0 8px}
.lede{color:var(--muted);max-width:86ch;font-size:14px;margin:2px 0 0}
details.more{margin:4px 0 0;font-size:13.5px}
details.more>summary{font-size:12.5px;color:var(--muted);margin:2px 0}
.more-body{max-width:86ch;color:var(--muted);padding:2px 0 4px}
.more-body p{margin:4px 0}
.more-body .facts{margin:2px 0}
.facts{display:flex;flex-wrap:wrap;gap:4px 18px;margin:8px 0 12px;font-size:13.5px;color:var(--muted)}
.facts b{color:var(--fg);font-weight:600}
.alert{margin:10px 0;padding:8px 12px}
.note{border:1px solid var(--line);border-radius:var(--radius);padding:8px 12px;margin:10px 0;background:var(--card);font-size:14px}
.b{display:inline-flex;align-items:center;gap:5px;font-size:12.5px;line-height:1.35;padding:1px 8px;border-radius:999px;border:1px solid var(--line);white-space:nowrap;font-weight:560}
.b::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor;flex:none}
.b.need{color:var(--need);background:var(--need-bg);border-color:transparent}
.b.drifted{color:var(--fg);border-color:var(--fg)}
.b.held{color:var(--hold);background:var(--hold-bg);border-color:transparent}
.b.adopted{color:var(--adopted);background:var(--soft);border-color:transparent}
.b.ok{color:var(--muted)}
.b.locked{color:var(--locked);background:var(--locked-bg);border-color:transparent}
.b.open{color:var(--muted);border-style:dashed}
.b.window{color:var(--window);background:var(--window-bg);border-color:var(--window);border-style:dashed}
.verb{display:inline-block;vertical-align:1px;font-size:11px;font-weight:700;letter-spacing:.04em;line-height:1.6;padding:0 6px;border-radius:4px;margin-right:8px;background:var(--soft)}
.verb.v-ESCALATE,.verb.v-FIX{color:var(--need);background:var(--need-bg)}
.verb.v-ADOPT{color:var(--adopted)}
.verb.v-HOLD.w{color:var(--window);background:var(--window-bg)}
.tbl{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);overflow:hidden}
table{border-collapse:collapse;width:100%;font-size:14px}
th,td{text-align:left;vertical-align:top;padding:7px 10px;border-bottom:1px solid var(--line)}
th{font-size:12.5px;font-weight:600;color:var(--muted);background:var(--soft);white-space:nowrap}
tbody tr:last-child td{border-bottom:0}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
.tbl.flush{overflow:visible}
.tbl.flush table{border-collapse:separate;border-spacing:0}
.tbl.flush thead th:first-child{border-top-left-radius:calc(var(--radius) - 1px)}
.tbl.flush thead th:last-child{border-top-right-radius:calc(var(--radius) - 1px)}
.tbl.flush tbody tr:last-child td:first-child{border-bottom-left-radius:calc(var(--radius) - 1px)}
.tbl.flush tbody tr:last-child td:last-child{border-bottom-right-radius:calc(var(--radius) - 1px)}
.tbl.flush tbody tr:last-child td{border-bottom:0}
table.set,table.wq{table-layout:fixed}
table.set th,table.set td,table.wq th,table.wq td{font-size:var(--t-s);padding:5px 10px}
table.set thead th{position:sticky;top:0;z-index:5;box-shadow:0 1px 0 var(--line)}
table.set td{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:20px;vertical-align:middle;padding-top:5px;padding-bottom:5px}
table.set td .b{vertical-align:middle}
table.set .w-obj{width:16%}
table.set .w-live{width:9%}
table.set .w-appr{width:7%}
table.set .w-lock{width:12%}
table.set .w-tpl{width:10%}
table.set .w-last{width:11%}
table.set .w-st{width:10%}
table.set .w-act{width:25%}
table.set td.acts-c{overflow:visible;text-overflow:clip;white-space:normal}
table.set .acts{flex-wrap:nowrap}
table.set tbody tr:not(.grp):hover{background:var(--hover)}
table.set .btn.sm{border-color:var(--line)}
table.set .btn.sm:hover{border-color:var(--fg)}
table.set .btn.sm[disabled]{border-color:transparent;background:transparent}
table.wq td{vertical-align:top;line-height:1.4;padding-top:8px;padding-bottom:8px}
table.wq th:nth-child(1){width:16%}
table.wq th:nth-child(2){width:12%}
table.wq th:nth-child(3){width:8%}
table.wq th:nth-child(4){width:24%}
table.wq th:nth-child(5){width:10%}
table.wq th:nth-child(6){width:11%}
table.wq th:nth-child(7){width:19%}
table.wq.lean th:nth-child(1){width:30%}
table.wq.lean th:nth-child(2){width:38%}
table.wq.lean th:nth-child(3){width:13%}
table.wq.lean th:nth-child(4){width:12%}
table.wq.lean th:nth-child(5){width:7%}
table.wq td code{font-size:12.5px;overflow-wrap:anywhere}
table.wq td.st{display:table-cell}
table.wq td.st .b{margin:0 4px 3px 0}
table.wq tbody tr:hover{background:var(--hover)}
code.chg{color:var(--need);font-weight:600}
.cls{font-weight:600}
.rs{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;line-clamp:2;overflow:hidden;color:var(--muted);font-size:12.5px;line-height:1.4;margin-top:1px}
.q.late{color:var(--need)}
th[data-sort]{user-select:none}
.sortbtn{all:unset;cursor:pointer;display:inline-flex;gap:5px;align-items:center;font-weight:600;color:var(--muted);font-size:12.5px}
.sortbtn:hover{color:var(--fg)}
.sortbtn:focus-visible{outline:2px solid var(--focus);outline-offset:2px;border-radius:3px}
.sortbtn::after{content:"\\2195";font-size:11px;opacity:.55}
th[aria-sort="ascending"] .sortbtn,th[aria-sort="descending"] .sortbtn{color:var(--fg)}
th[aria-sort="ascending"] .sortbtn::after{content:"\\25B2";color:var(--accent);opacity:1}
th[aria-sort="descending"] .sortbtn::after{content:"\\25BC";color:var(--accent);opacity:1}
td .on{font-family:var(--mono);font-size:13px}
td .oh{color:var(--muted);font-size:12.5px;margin-left:4px}
tr[data-open]{cursor:pointer}
tr[data-open]:hover{background:var(--hover)}
tr[data-open]:focus-visible{outline:2px solid var(--focus);outline-offset:-2px}
tr.grp td{background:var(--bg);font-size:12.5px;color:var(--muted);font-weight:600;padding:6px 10px;white-space:normal}
td .p{font-family:var(--mono);font-size:13.5px;display:block}
td .q{display:block;color:var(--muted);font-size:12.5px}
.filters{display:flex;flex-wrap:wrap;gap:10px;align-items:end;margin:14px 0 10px}
.filters label{display:flex;flex-direction:column;font-size:12.5px;color:var(--muted);gap:3px}
.filters select,.filters input{min-width:150px;padding:5px 8px;border:1px solid var(--line);border-radius:7px;background:var(--card);font-size:14px}
.filters .count{margin-left:auto;font-size:13px;color:var(--muted)}
.btn{display:inline-block;border:1px solid var(--line);background:var(--card);border-radius:7px;padding:6px 12px;cursor:pointer;font-size:14px;line-height:1.3;white-space:nowrap;text-decoration:none}
.btn:hover{background:var(--hover)}
.btn.primary{background:var(--accent);color:var(--bg);border-color:var(--accent);font-weight:600}
.btn.primary:hover{filter:brightness(1.08)}
.btn.approve{color:var(--accent);border-color:var(--accent)}
.btn.lock{color:var(--locked);border-color:var(--locked)}
.btn.window{color:var(--window);border-color:var(--window)}
.btn.full{width:100%;text-align:center}
.btn.sm{padding:2px 8px;font-size:12.5px;line-height:1.5}
.btn[disabled]{opacity:.55;cursor:progress}
.acts .btn[disabled]{opacity:.5;cursor:not-allowed}
.acts .btn[disabled]:hover{background:var(--card)}
.acts{display:flex;flex-wrap:wrap;gap:5px;align-items:center}
.busy{font-size:12.5px;color:var(--muted)}
.item{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:6px 18px;align-items:start;padding:12px 0;border-bottom:1px solid var(--line)}
.item:last-child{border-bottom:0}
.item .what{font-weight:600}
.item .where,.item .meta{color:var(--muted);font-size:13.5px}
.item .why{margin-top:2px}
.item .cause{margin-top:2px}
.list{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:0 14px}
.calm{color:var(--ok);font-weight:600}
details>summary{cursor:pointer}
details.fold>summary{color:var(--muted);margin:6px 0}
details.exc>summary{list-style:none}
details.exc>summary::-webkit-details-marker{display:none}
details.exc[open]>summary{margin-bottom:8px}
.exc form{width:min(360px,80vw)}
.scrim{position:fixed;inset:0;background:var(--scrim);z-index:20}
.drawer{position:fixed;top:0;right:0;height:100vh;height:100dvh;width:min(640px,100vw);background:var(--card);border-left:1px solid var(--line);box-shadow:var(--shadow);z-index:21;display:flex;flex-direction:column}
.dr{display:flex;flex-direction:column;min-height:0;flex:1}
.dr-head{padding:16px 20px 12px;border-bottom:1px solid var(--line);display:flex;gap:12px;align-items:flex-start}
.dr-head h2{margin:0;font-size:15px;font-family:var(--mono);font-weight:600}
.dr-tools{margin-left:auto;flex:none;display:flex;gap:6px}
.kicker{font-size:12.5px;color:var(--muted);margin:0 0 4px}
.badges{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0 0}
.dr-body{overflow:auto;padding:4px 20px 28px;flex:1}
.dr-body h3,.detail h3{font-size:12px;letter-spacing:.05em;text-transform:uppercase;color:var(--muted);margin:20px 0 6px;font-weight:650}
.dr-body table,.detail table{font-size:14px}
.kv{display:grid;grid-template-columns:9em minmax(0,1fr);gap:4px 14px;margin:6px 0;font-size:14px}
.kv dt{color:var(--muted)}
.kv dd{margin:0}
.kv.glance{grid-template-columns:11em minmax(0,1fr);gap:6px 14px;padding:10px 14px;border:1px solid var(--line);border-radius:10px;background:var(--card);margin:10px 0}
.kv .rc{display:block;font-size:12.5px;color:var(--muted)}
.crumb{margin:0 0 6px;font-size:13px;color:var(--muted)}
.oname{font-family:var(--mono);font-size:20px;overflow-wrap:anywhere}
.detail{max-width:980px}
.obj-head .acts{align-self:flex-start}
.pop{position:fixed;inset:0;margin:auto;width:min(400px,calc(100vw - 32px));height:fit-content;max-height:calc(100vh - 32px);overflow:auto;padding:16px 18px;border:1px solid var(--line);border-radius:var(--radius);background:var(--card);color:var(--fg);box-shadow:var(--shadow);white-space:normal;text-align:left;text-overflow:clip;font-size:14px;line-height:1.45;font-weight:400}
.pop::backdrop{background:var(--scrim)}
.pop form{display:grid;grid-template-columns:4.5em minmax(0,1fr);gap:8px 10px;align-items:center;margin:0}
.pop h3{grid-column:1 / -1;font-size:16px;margin:0}
.pop-o{grid-column:1 / -1;margin:0;font-family:var(--mono);font-size:12.5px;color:var(--muted);overflow-wrap:anywhere}
.pop-i{grid-column:1 / -1;margin:0 0 4px;font-size:13.5px}
.pop label{font-size:13px;color:var(--muted)}
.pop input{padding:6px 8px;border:1px solid var(--line);border-radius:7px;background:var(--bg);min-width:0;width:100%}
.pop .act{grid-column:1 / -1;display:flex;flex-wrap:wrap;gap:8px;margin-top:6px}
.strip-in{display:flex;flex-wrap:wrap;align-items:center;gap:8px 22px}
.strip-id{display:flex;flex-direction:column;gap:1px;font-size:12.5px;line-height:1.3;color:var(--muted);min-width:0}
.strip-id b{font-size:16px;color:var(--fg)}
.stats{display:flex;flex-wrap:wrap;gap:8px;margin-right:auto}
.stat{display:inline-flex;align-items:baseline;gap:6px;padding:3px 12px;border:1px solid var(--line);border-radius:999px;background:var(--card);text-decoration:none;font-size:var(--t-s);color:var(--fg)}
.stat:hover{border-color:var(--fg);text-decoration:none}
.stat b{font-size:19px;line-height:1.15;font-variant-numeric:tabular-nums}
.stat.need{color:var(--need);background:var(--need-bg);border-color:transparent}
.stat.held{color:var(--hold)}
.stat.locked{color:var(--locked)}
.stat.adopted{color:var(--adopted)}
.stat.zero{color:var(--muted)}
.stat.drifted{color:var(--fg);border-color:var(--fg)}
.stat.window{color:var(--window);background:var(--window-bg);border-color:var(--window);border-style:dashed}
.strip-pass{margin:0}
.strip-pass .busy{margin:0}
.strip~main section{scroll-margin-top:84px}
@supports not selector(:popover-open){
.pop,[popovertarget]{display:none}
.obj-head .pop{display:block;position:static;width:auto;max-width:400px;margin:8px 0 0;box-shadow:none}
}
pre{white-space:pre-wrap;overflow-wrap:anywhere;font:12.5px/1.5 var(--mono);background:var(--soft);padding:10px 12px;border-radius:8px;margin:6px 0}
pre.diff{white-space:pre;overflow-x:auto;overflow-wrap:normal}
pre .del{color:var(--need)}
pre .add{color:var(--locked)}
pre .hunk{color:var(--muted)}
.hist{list-style:none;margin:6px 0;padding:0;font-size:14px}
.hist li{padding:6px 0;border-bottom:1px solid var(--line)}
.hist li:last-child{border-bottom:0}
.hist .rc{display:block;font-size:12.5px;color:var(--muted)}
.wf{border:1px solid var(--line);border-radius:10px;padding:10px 14px 12px;margin:14px 0 4px;background:var(--bg)}
.wf h3{margin:0 0 8px}
.exc input,.exc textarea{padding:6px 8px;border:1px solid var(--line);border-radius:7px;background:var(--card);min-width:0;width:100%}
.exc .act{grid-column:1 / -1;display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.list.needs{border-left:4px solid var(--need)}
.exc form{display:grid;gap:6px}
.exc label{font-size:13px;color:var(--muted)}
.confirm{grid-column:1 / -1;border:1px solid var(--fg);border-radius:8px;padding:8px 10px;background:var(--card);font-size:14px}
.confirm p{margin:0 0 8px}
.report{display:block;width:100%;height:calc(100vh - 170px);min-height:520px;border:1px solid var(--line);border-radius:10px;background:var(--bg)}
.toasts{position:fixed;right:16px;bottom:16px;z-index:30;display:flex;flex-direction:column;gap:8px;width:min(560px,calc(100vw - 32px));pointer-events:none}
.toast{position:relative;pointer-events:auto;background:var(--card);border:1px solid var(--line);border-left:4px solid var(--ok);border-radius:8px;box-shadow:var(--shadow);padding:10px 34px 10px 12px;font-size:14px}
.toast.err{border-left-color:var(--need)}
.toast pre{margin:6px 0 0;max-height:40vh;overflow:auto}
.toast .tx{position:absolute;top:6px;right:6px;border:0;background:none;cursor:pointer;font-size:18px;line-height:1;padding:2px 6px;color:var(--muted)}
.pill{display:inline-block;font-size:11px;padding:0 6px;border-radius:4px;background:var(--soft);color:var(--muted)}
@media (prefers-reduced-motion:no-preference){.drawer.in{animation:slide .18s ease-out}@keyframes slide{from{transform:translateX(32px)}to{transform:none}}}
@media (max-width:1360px){
table.set .hide-m,table.set col.hide-m{display:none}
}
@media (max-width:1080px){
table.set,table.set thead,table.set tbody,table.set tr,table.set td,table.wq,table.wq thead,table.wq tbody,table.wq tr,table.wq td{display:block;width:100%;min-width:0}
table.set colgroup,table.set thead,table.wq thead{display:none}
table.set tr[data-open],table.wq tbody tr{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:2px 14px;border-bottom:1px solid var(--line);padding:8px 12px}
table.set td,table.wq td{border:0;padding:2px 0;white-space:normal;line-height:1.4}
table.set td::before,table.wq td::before{content:attr(data-label);display:block;font-size:12.5px;color:var(--muted)}
table.set td[data-label="Object"],table.set td[data-label="Actions"],table.wq td[data-label="Object"],table.wq td[data-label="Why"],table.wq td[data-label="Actions"]{grid-column:1 / -1}
table.set tr.grp td::before,table.wq td[data-label="Actions"]::before{display:none}
table.set td.acts-c{padding-top:4px}
table.set .acts{flex-wrap:wrap}
.tbl.flush tbody tr:last-child td{border-bottom:0}
.kv.glance{grid-template-columns:1fr;gap:0}
}
@media (max-width:860px){
table.set tr[data-open],table.wq tbody tr{grid-template-columns:repeat(2,minmax(0,1fr))}
.strip{position:static}
.strip-in{gap:8px 12px}
.strip-pass,.strip-pass .btn{width:100%}
.stats{margin-right:0}
.oname{font-size:17px}
body{font-size:16px}
table{font-size:16px}
.shell{grid-template-columns:1fr}
.side{position:static;height:auto;border-right:0;border-bottom:1px solid var(--line);padding:12px 16px;gap:10px}
.brand,.tenant{padding:0;margin:0;border:0}
.nav{flex-direction:row;flex-wrap:wrap;gap:4px}
.nav a{border:1px solid var(--line);padding:5px 10px}
.side-foot{display:none}
.bar-in,.wrap{padding-left:16px;padding-right:16px}
.sum{font-size:16px}
table.rt,table.rt thead,table.rt tbody,table.rt tr,table.rt td{display:block;width:100%}
table.rt thead{display:none}
table.rt tr{border-bottom:1px solid var(--line);padding:8px 12px}
table.rt tbody tr:last-child{border-bottom:0}
table.rt td{border:0;padding:2px 0}
table.rt td::before{content:attr(data-label);display:block;font-size:12.5px;color:var(--muted)}
table.rt tr.grp td::before{display:none}
.filters label{flex:1 1 140px}
.filters select,.filters input{min-width:0;width:100%}
.filters .count{margin-left:0;width:100%}
.item{grid-template-columns:1fr}
.kv{grid-template-columns:1fr;gap:0}
.kv dt{margin-top:6px}
.report{height:calc(100vh - 230px)}
.ex-tools{flex-wrap:wrap}
}
${EXECUTIVE_CSS}
.ex-tools{display:flex;align-items:center;justify-content:space-between;gap:8px 16px;margin:0 0 14px;padding:0 0 10px;border-bottom:1px solid var(--line)}
.ex-act{display:inline-flex;gap:8px}
.seg{display:inline-flex;border:1px solid var(--line);border-radius:8px;overflow:hidden;background:var(--card)}
.seg a{padding:6px 12px;text-decoration:none;font-size:14px;border-left:1px solid var(--line)}
.seg a:first-child{border-left:0}
.seg a:hover{background:var(--hover)}
.seg a[aria-current="page"]{background:var(--fg);color:var(--bg);font-weight:600}
.tpls{display:flex;flex-direction:column;gap:10px;margin:14px 0 0}
.tpl{padding:0}
.tpl>summary{list-style:none;display:flex;flex-wrap:wrap;align-items:center;gap:6px 12px;padding:12px 16px}
.tpl>summary::-webkit-details-marker{display:none}
.tpl>summary::before{content:"\\25B8";color:var(--muted)}
.tpl[open]>summary::before{content:"\\25BE"}
.tpl-name{font-family:var(--mono);font-weight:600;font-size:14px}
.tpl-n{margin-left:auto;color:var(--muted);font-size:13.5px}
.tpl-n .need{color:var(--need);font-weight:600}
.tpl-rule{margin:0;padding:0 16px 10px;font-size:13.5px}
.tpl .tbl{border-width:1px 0 0;border-radius:0 0 var(--radius) var(--radius)}
.tpl-t td .verb{margin-right:4px}
@media print{
:root{${PRINT_TOKENS}}
body{font-size:10pt}
.side,.bar,.skip,.toasts,.drawer,.scrim,.ex-tools{display:none!important}
.pop,.acts{display:none!important}
.shell{display:block}
.wrap{max-width:none;padding:0}
a{text-decoration:none}
}`;

/** The one script (see the header). No template literal and no ${ inside, so it sits in this file as a plain string. */
export const SCRIPT = `(function(){"use strict";
var $=function(s,el){return (el||document).querySelector(s)};
var $$=function(s,el){return Array.prototype.slice.call((el||document).querySelectorAll(s))};
var keep={get:function(k){try{return sessionStorage.getItem(k)}catch(e){return null}},set:function(k,v){try{sessionStorage.setItem(k,v)}catch(e){}},del:function(k){try{sessionStorage.removeItem(k)}catch(e){}}};
document.documentElement.classList.add("js");
var toasts=$("#toasts");
function toast(t){if(!toasts)return;var d=document.createElement("div");d.className="toast"+(t.ok?"":" err");d.setAttribute("role",t.ok?"status":"alert");var h=document.createElement("b");h.textContent=t.title||"";d.appendChild(h);if(t.lines&&t.lines.length){var p=document.createElement("pre");p.textContent=t.lines.join("\\n");d.appendChild(p)}var x=document.createElement("button");x.type="button";x.className="tx";x.setAttribute("aria-label","Dismiss");x.textContent="\\u00d7";x.onclick=function(){d.remove()};d.appendChild(x);toasts.appendChild(d);if(t.ok)setTimeout(function(){d.remove()},15000)}
document.addEventListener("click",function(e){var x=e.target.closest(".toast .tx");if(x)x.parentNode.remove()});
var pending=keep.get("console.toast");if(pending){keep.del("console.toast");try{toast(JSON.parse(pending))}catch(e){}}
var drawer=$("#drawer"),scrim=$("#scrim"),back=null;
function openDrawer(row){var tpl=document.getElementById("t-"+row.dataset.open);if(!tpl||!drawer)return;var box=$("#dr",drawer);box.replaceChildren(tpl.content.cloneNode(true));drawer.hidden=false;scrim.hidden=false;drawer.classList.remove("in");void drawer.offsetWidth;drawer.classList.add("in");back=row;document.body.style.overflow="hidden";var c=$("[data-close]",drawer);if(c)c.focus();keep.set("console.open",row.dataset.key||"")}
function closeDrawer(){if(!drawer||drawer.hidden)return;drawer.hidden=true;scrim.hidden=true;document.body.style.overflow="";keep.del("console.open");if(back&&back.focus)back.focus()}
document.addEventListener("click",function(e){if(e.target.closest("[data-close]")){closeDrawer();return}var r=e.target.closest("tr[data-open]");if(r&&!e.target.closest("a,button,input,select,textarea,summary,.pop"))openDrawer(r)});
if(scrim)scrim.addEventListener("click",closeDrawer);
function popOpen(){try{return !!document.querySelector(".pop:popover-open")}catch(e){return false}}
document.addEventListener("keydown",function(e){if(e.key==="Escape"){if(!popOpen())closeDrawer();return}var t=e.target;if((e.key==="Enter"||e.key===" ")&&t.matches&&t.matches("tr[data-open]")){e.preventDefault();openDrawer(t);return}if(e.key==="Tab"&&drawer&&!drawer.hidden){var f=$$("a[href],button:not([disabled]),input,select,textarea,[tabindex]:not([tabindex='-1'])",drawer).filter(function(x){return x.offsetParent!==null});if(!f.length)return;var a=f[0],z=f[f.length-1];if(e.shiftKey&&document.activeElement===a){e.preventDefault();z.focus()}else if(!e.shiftKey&&document.activeElement===z){e.preventDefault();a.focus()}}});
var rows=$$("tr[data-open]"),fs=$$("[data-filter]"),q=$("#q"),count=$("#count");
function apply(){var v={};fs.forEach(function(f){v[f.dataset.filter]=f.value});var term=q?q.value.trim().toLowerCase():"";var n=0;rows.forEach(function(r){var ok=true;for(var k in v){if(v[k]&&r.dataset[k]!==v[k])ok=false}if(term&&(r.dataset.text||"").indexOf(term)<0)ok=false;r.hidden=!ok;if(ok)n++});$$("tr.grp").forEach(function(g){g.hidden=!rows.some(function(r){return r.dataset.tier===g.dataset.tier&&!r.hidden})});if(count)count.textContent=n+" of "+rows.length+" objects"}
fs.concat(q?[q]:[]).forEach(function(f){f.addEventListener("input",apply);f.addEventListener("change",apply)});if(rows.length)apply();
function sortBy(th){var table=th.closest("table"),body=table.tBodies[0],col=th.cellIndex,dir=th.getAttribute("aria-sort")==="ascending"?-1:1;$$("th[data-sort]",table).forEach(function(h){h.setAttribute("aria-sort","none")});th.setAttribute("aria-sort",dir===1?"ascending":"descending");var segs=[],cur=null;Array.prototype.forEach.call(body.rows,function(r,i){if(r.dataset.i===undefined)r.dataset.i=i;if(r.classList.contains("grp")){cur={head:r,rows:[]};segs.push(cur)}else{if(!cur){cur={head:null,rows:[]};segs.push(cur)}cur.rows.push(r)}});segs.forEach(function(s){s.rows.sort(function(a,b){var x=a.cells[col].textContent.trim().toLowerCase(),y=b.cells[col].textContent.trim().toLowerCase();return dir*x.localeCompare(y,undefined,{numeric:true})||a.dataset.i-b.dataset.i});if(s.head)body.appendChild(s.head);s.rows.forEach(function(r){body.appendChild(r)})})}
$$("th[data-sort]").forEach(function(th){var b=document.createElement("button");b.type="button";b.className="sortbtn";b.textContent=th.textContent;th.textContent="";th.appendChild(b);th.setAttribute("aria-sort","none");b.addEventListener("click",function(){sortBy(th)})});
var want=document.body.dataset.open||keep.get("console.open");if(want){var row=rows.filter(function(r){return r.dataset.key===want})[0];if(row)openDrawer(row);else keep.del("console.open")}
function send(form){var btns=$$("button",form);btns.forEach(function(b){b.disabled=true});var busy=$("[data-busy]",form);var t0=Date.now(),tick=null;if(busy){busy.hidden=false;tick=setInterval(function(){busy.textContent=busy.dataset.busy+" "+Math.round((Date.now()-t0)/1000)+" s"},1000)}var body=new URLSearchParams(new FormData(form));body.set("confirm","yes");function done(){btns.forEach(function(b){b.disabled=false});if(tick)clearInterval(tick);if(busy)busy.hidden=true}fetch(form.action,{method:"POST",body:body,headers:{"Accept":"application/json"},credentials:"same-origin"}).then(function(r){return r.json().catch(function(){return{ok:false,title:"The console answered "+r.status,lines:[]}})}).then(function(t){if(t.ok){keep.set("console.toast",JSON.stringify(t));location.reload()}else{done();toast(t)}}).catch(function(err){done();toast({ok:false,title:"The console did not answer",lines:[String(err)]})})}
document.addEventListener("submit",function(e){var form=e.target;if(!form.matches||!form.matches("form[data-action]"))return;e.preventDefault();var conf=$(".confirm",form);if(conf&&conf.hidden){if(!form.reportValidity())return;var s=$("[data-summary]",conf);if(s&&form.dataset.summary)s.textContent=summary(form);conf.hidden=false;var yes=$("[data-yes]",conf);if(yes)yes.focus();return}send(form)});
function summary(form){var h=form.elements.hours;var text=form.dataset.summary;if(h){var until=new Date(Date.now()+Number(h.value||0)*3600000);text=text.replace("{until}",until.toISOString().slice(0,16).replace("T"," ")+" UTC")}return text}
document.addEventListener("click",function(e){var no=e.target.closest("[data-no]");if(no){var c=no.closest(".confirm");if(c)c.hidden=true}});
document.addEventListener("change",function(e){var s=e.target;if(s.matches&&s.matches("select[data-autosubmit]")&&s.form)s.form.submit()});
$$("[data-print]").forEach(function(b){b.hidden=false;b.addEventListener("click",function(){window.print()})});
addEventListener("beforeprint",function(){$$("details:not([open])").forEach(function(d){d.open=true;d.dataset.printed="1"})});
addEventListener("afterprint",function(){$$("details[data-printed]").forEach(function(d){d.open=false;delete d.dataset.printed})});
var af=$("#agent");if(af){var trs=$$("tbody tr[data-agent]"),tc=$("#tcount");af.addEventListener("change",function(){var n=0;trs.forEach(function(r){r.hidden=af.value!==""&&r.dataset.agent!==af.value;if(!r.hidden)n++});if(tc)tc.textContent=n+" of "+trs.length+" events"})}
})();`;

/** One static part of the shell: its path, which names the hash of its bytes, its type and its bytes. */
export interface Asset { path: string; type: string; body: string; etag: string }

const asset = (name: string, ext: string, type: string, body: string): Asset => {
  const hash = createHash("sha256").update(body).digest("hex").slice(0, 16);
  return { path: `/assets/${name}.${hash}.${ext}`, type, body, etag: `"${hash}"` };
};

/** The stylesheet and the script every page links; a new build names new paths, so a cached copy is never stale. */
export const ASSETS = {
  css: asset("console", "css", "text/css; charset=utf-8", CSS),
  js: asset("console", "js", "text/javascript; charset=utf-8", SCRIPT),
} as const;

export interface NavCounts { settings: number; findings: number; needs: number; actions: number; traces: number; templates: number }
export interface Shell {
  title: string;
  page: "work" | "overview" | "executive" | "settings" | "templates" | "findings" | "actions" | "traces" | "sources" | "policy" | "document";
  tenant: string;
  /** The tenants the switcher lists; with one, the tenant reads as plain text. */
  tenants: readonly string[];
  /** Why the store's tenants were not read (src/console/state.ts readTenants): the switcher says so under the tenant. */
  tenantsError?: string | null;
  /** The page a switch returns to. */
  returnTo: string;
  modeLine: string;
  bar: string | null;
  nav: NavCounts;
  csrf: string;
  passForm: string;
  body: string;
  /** The drawer templates (Settings). */
  extra?: string;
  /** A toast the server renders (a POST without the script). */
  toast?: { ok: boolean; title: string; lines: string[] } | null;
  /** An object key the page opens its drawer on. */
  open?: string | null;
  /** A table page: content up to 1480 px instead of 1200. */
  wide?: boolean;
}

const NAV: readonly [Shell["page"], string, string][] = [
  ["work", "/work", "Work queue"], ["overview", "/overview", "Overview"], ["executive", "/executive", "Executive"], ["settings", "/settings", "Settings"], ["templates", "/templates", "Templates"],
  ["findings", "/findings", "Findings"], ["actions", "/actions", "Actions and tickets"], ["traces", "/traces", "Traces"], ["sources", "/sources", "Sources"],
];

const navCount = (s: Shell, page: Shell["page"]): string => {
  const n = s.nav;
  if (page === "work") return n.needs ? `<span class="cnt need">${n.needs}</span>` : "";
  if (page === "settings") return `<span class="cnt">${n.settings}</span>`;
  if (page === "findings") return n.needs ? `<span class="cnt need">${n.needs} need you</span>` : `<span class="cnt">${n.findings}</span>`;
  if (page === "actions") return `<span class="cnt">${n.actions}</span>`;
  if (page === "traces") return `<span class="cnt">${n.traces}</span>`;
  if (page === "templates") return `<span class="cnt">${n.templates}</span>`;
  return "";
};

export function toastHtml(t: { ok: boolean; title: string; lines: string[] }): string {
  return `<div class="toast${t.ok ? "" : " err"}" role="${t.ok ? "status" : "alert"}"><b>${escapeHtml(t.title)}</b>${t.lines.length ? `<pre>${escapeHtml(t.lines.join("\n"))}</pre>` : ""}<button type="button" class="tx" aria-label="Dismiss">×</button></div>`;
}

/**
 * The tenant switcher: a form that names the tenant and the page to return to; a change submits it (the script), else
 * its Switch button. When the store's tenants were not read it is degraded and says so: the tenant the console started
 * for, and why the list is that one alone.
 */
export function tenantSwitcher(s: Pick<Shell, "tenant" | "tenants" | "csrf" | "returnTo" | "tenantsError">): string {
  const degraded = s.tenantsError ? `<span class="tsw-err" role="status">The store's tenants were not read: ${escapeHtml(s.tenantsError)}. The switcher lists ${escapeHtml(s.tenant)} alone.</span>` : "";
  if (s.tenants.length < 2) return `<b>${escapeHtml(s.tenant)}</b>${degraded}`;
  const options = s.tenants.map((t) => `<option value="${escapeHtml(t)}"${t === s.tenant ? " selected" : ""}>${escapeHtml(t)}</option>`).join("");
  return `<form method="post" action="/do/tenant" class="tsw"><input type="hidden" name="csrf" value="${escapeHtml(s.csrf)}"><input type="hidden" name="return" value="${escapeHtml(s.returnTo)}"><label for="tenant-pick">Tenant</label><div class="tsw-row"><select id="tenant-pick" name="tenant" data-autosubmit>${options}</select><button type="submit" class="btn">Switch</button></div></form>${degraded}`;
}

export function layout(s: Shell): string {
  const nav = NAV.map(([page, href, label]) => `<li><a href="${href}"${page === s.page ? ' aria-current="page"' : ""}>${label}${navCount(s, page)}</a></li>`).join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(s.title)} · ConfigLeaf console</title>
<link rel="stylesheet" href="${ASSETS.css.path}">
</head>
<body${s.open ? ` data-open="${escapeHtml(s.open)}"` : ""}>
<a class="skip" href="#main">Skip to content</a>
<div class="shell${s.wide ? " wide" : ""}">
<nav class="side" aria-label="Sections">
<div class="brand">${MARK}<div><b>ConfigLeaf console</b><span>configuration assurance, the technician's view</span></div></div>
<div class="tenant">${tenantSwitcher(s)}<span class="mode">${escapeHtml(s.modeLine)}</span></div>
<ul class="nav">
${nav}
</ul>
${s.passForm}
<div class="side-foot">Local to this machine on 127.0.0.1. The console never runs act with <span class="nw">--apply</span>.</div>
</nav>
<div class="content">
${s.bar ?? ""}
<main id="main" tabindex="-1"><div class="wrap">
${s.body}
</div></main>
</div>
</div>
<div class="scrim" id="scrim" hidden></div>
<aside class="drawer" id="drawer" role="dialog" aria-modal="true" aria-labelledby="dr-title" hidden><div class="dr" id="dr"></div></aside>
${s.extra ?? ""}
<div class="toasts" id="toasts" aria-live="polite">${s.toast ? toastHtml(s.toast) : ""}</div>
<script src="${ASSETS.js.path}"></script>
</body>
</html>
`;
}
