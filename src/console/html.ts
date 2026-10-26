// The console's page shell: the report's colour tokens (src/document/report.ts LIGHT and DARK) with the console's own
// four on top (locked, an open window, the hover and the focus ring), one stylesheet and one script, both inline, and
// the layout every page shares: a 240 px navigation, a sticky summary bar and content up to 1200 px. No external script,
// style or font; light and dark by prefers-color-scheme; at phone width the navigation folds above the bar, tables
// become one block per row, type goes to 16 px and the gutter is 16 px.
//
// The script does four things and nothing else: the drawer (open from a row by click, Enter or Space; close on
// Escape, the scrim or Close; focus kept inside while it is open and returned to the row after), the Settings filters
// and search, the action forms (an on-page confirmation, then one fetch POST; on success the toast is kept in
// sessionStorage and the page reloads, on refusal the toast shows and the form stays), and the trace viewer's agent
// filter. Every page reads in full without it; an action needs it.

import { DARK, LIGHT, escapeHtml } from "../document/report.ts";

export { escapeHtml };

export const CONSOLE_LIGHT = `${LIGHT};--locked:#2b5c8a;--locked-bg:#e7eef6;--window:#835700;--window-bg:#f8ecd2;--hover:#f3f1ec;--focus:#2b5c8a;--scrim:rgba(20,20,22,.36);--shadow:0 10px 40px rgba(0,0,0,.14)`;
export const CONSOLE_DARK = `${DARK};--locked:#8db8e6;--locked-bg:#1b2733;--window:#f0c46e;--window-bg:#382c13;--hover:#202226;--focus:#8db8e6;--scrim:rgba(0,0,0,.55);--shadow:0 10px 40px rgba(0,0,0,.5)`;

export const CSS = `:root{${CONSOLE_LIGHT};--mono:ui-monospace,SFMono-Regular,"Cascadia Mono",Consolas,"Liberation Mono",Menlo,monospace;color-scheme:light}
@media (prefers-color-scheme:dark){:root{${CONSOLE_DARK};color-scheme:dark}}
*{box-sizing:border-box}
[hidden]{display:none!important}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;overflow-wrap:anywhere}
a{color:inherit;text-decoration-thickness:1px;text-underline-offset:2px}
a:hover{text-decoration-thickness:2px}
button,input,select,textarea{font:inherit;color:inherit}
:focus-visible{outline:2px solid var(--focus);outline-offset:2px;border-radius:3px}
.skip{position:absolute;left:-999px;top:8px;z-index:50;background:var(--card);padding:6px 10px;border:1px solid var(--line);border-radius:6px}
.skip:focus{left:8px}
code,.mono{font-family:var(--mono);font-size:.87em}
.muted{color:var(--muted)}
.nw{white-space:nowrap}
h1{font-size:22px;line-height:1.25;margin:0 0 4px;letter-spacing:-.005em}
h2{font-size:17px;line-height:1.3;margin:28px 0 8px}
h2 .cnt{font-weight:500;color:var(--muted);font-size:14px;margin-left:6px}
h3{font-size:15px;line-height:1.35;margin:0 0 4px}
p{margin:4px 0}
ul{margin:4px 0;padding-left:20px}
.shell{display:grid;grid-template-columns:240px minmax(0,1fr);min-height:100vh}
.side{position:sticky;top:0;height:100vh;overflow:auto;background:var(--card);border-right:1px solid var(--line);padding:18px 12px;display:flex;flex-direction:column;gap:14px}
.brand{padding:0 8px}
.brand b{display:block;font-size:16px}
.brand span{display:block;font-size:12.5px;color:var(--muted);margin-top:2px}
.tenant{margin:0 2px;padding:8px 10px;border:1px solid var(--line);border-radius:8px;font-size:12.5px;color:var(--muted)}
.tenant b{display:block;font-size:14px;color:var(--fg)}
.nav{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px}
.nav a{display:flex;justify-content:space-between;align-items:baseline;gap:8px;padding:7px 10px;border-radius:7px;text-decoration:none}
.nav a:hover{background:var(--hover)}
.nav a[aria-current="page"]{background:var(--soft);font-weight:620}
.nav .cnt{font-size:12px;color:var(--muted);font-variant-numeric:tabular-nums}
.nav .cnt.need{color:var(--need);font-weight:650}
.side form{margin:0 2px}
.side-foot{margin-top:auto;padding:0 8px;font-size:12px;color:var(--muted)}
.content{min-width:0;display:flex;flex-direction:column}
.bar{position:sticky;top:0;z-index:10;background:var(--bg);border-bottom:1px solid var(--line)}
.bar-in{max-width:1200px;margin:0 auto;padding:10px 24px;display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:2px 20px}
.sum{font-size:17px;font-weight:600;line-height:1.3}
.sum a{text-decoration:none;white-space:nowrap}
.sum a:hover{text-decoration:underline}
.sum b{font-variant-numeric:tabular-nums}
.sum .need{color:var(--need)}
.sum .adopted{color:var(--adopted)}
.sum .locked{color:var(--locked)}
.sum .window{color:var(--window)}
.sum .dot{color:var(--muted);font-weight:400}
.who{display:flex;flex-wrap:wrap;gap:0 12px;font-size:12.5px;color:var(--muted)}
.who b{color:var(--fg);font-weight:600}
main{flex:1;min-width:0}
.wrap{max-width:1200px;margin:0 auto;padding:20px 24px 56px}
.head{display:flex;flex-wrap:wrap;gap:8px 16px;align-items:flex-end;justify-content:space-between;margin:0 0 6px}
.lede{color:var(--muted);max-width:86ch}
.facts{display:flex;flex-wrap:wrap;gap:4px 18px;margin:8px 0 12px;font-size:13.5px;color:var(--muted)}
.facts b{color:var(--fg);font-weight:600}
.alert{border:1px solid var(--need);border-radius:8px;padding:8px 12px;margin:10px 0;color:var(--need);background:var(--need-bg)}
.note{border:1px solid var(--line);border-radius:8px;padding:8px 12px;margin:10px 0;background:var(--card);font-size:14px}
.b{display:inline-flex;align-items:center;gap:5px;font-size:12.5px;line-height:1.35;padding:1px 8px;border-radius:999px;border:1px solid var(--line);white-space:nowrap;font-weight:560}
.b::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor;flex:none}
.b.need{color:var(--need);background:var(--need-bg);border-color:transparent}
.b.drifted{color:var(--fg);border-color:var(--fg)}
.b.held{color:var(--fg)}
.b.adopted{color:var(--adopted);background:var(--soft);border-color:transparent}
.b.ok{color:var(--muted)}
.b.locked{color:var(--locked);background:var(--locked-bg);border-color:transparent}
.b.open{color:var(--muted);border-style:dashed}
.b.window{color:var(--window);background:var(--window-bg);border-color:var(--window);border-style:dashed}
.verb{display:inline-block;vertical-align:1px;font-size:11px;font-weight:700;letter-spacing:.04em;line-height:1.6;padding:0 6px;border-radius:4px;margin-right:8px;background:var(--soft)}
.verb.v-ESCALATE,.verb.v-FIX{color:var(--need);background:var(--need-bg)}
.verb.v-ADOPT{color:var(--adopted)}
.verb.v-HOLD.w{color:var(--window);background:var(--window-bg)}
.tbl{background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden}
table{border-collapse:collapse;width:100%;font-size:15px}
th,td{text-align:left;vertical-align:top;padding:7px 10px;border-bottom:1px solid var(--line)}
th{font-size:12.5px;font-weight:600;color:var(--muted);background:var(--soft);white-space:nowrap}
tbody tr:last-child td{border-bottom:0}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
table.set{table-layout:fixed}
tr[data-open]{cursor:pointer}
tr[data-open]:hover{background:var(--hover)}
tr[data-open]:focus-visible{outline:2px solid var(--focus);outline-offset:-2px}
tr.grp td{background:var(--bg);font-size:12.5px;color:var(--muted);font-weight:600;padding:6px 10px}
td .p{font-family:var(--mono);font-size:13.5px;display:block}
td .q{display:block;color:var(--muted);font-size:12.5px}
.filters{display:flex;flex-wrap:wrap;gap:10px;align-items:end;margin:14px 0 10px}
.filters label{display:flex;flex-direction:column;font-size:12.5px;color:var(--muted);gap:3px}
.filters select,.filters input{min-width:150px;padding:6px 8px;border:1px solid var(--line);border-radius:7px;background:var(--card);font-size:14px}
.filters .count{margin-left:auto;font-size:13px;color:var(--muted)}
.btn{display:inline-block;border:1px solid var(--line);background:var(--card);border-radius:7px;padding:6px 12px;cursor:pointer;font-size:14px;line-height:1.3;white-space:nowrap;text-decoration:none}
.btn:hover{background:var(--hover)}
.btn.primary{background:var(--fg);color:var(--bg);border-color:var(--fg)}
.btn.lock{color:var(--locked);border-color:var(--locked)}
.btn.window{color:var(--window);border-color:var(--window)}
.btn.full{width:100%;text-align:center}
.btn[disabled]{opacity:.55;cursor:progress}
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
.dr-head .x{margin-left:auto;flex:none}
.kicker{font-size:12.5px;color:var(--muted);margin:0 0 4px}
.badges{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0 0}
.dr-body{overflow:auto;padding:4px 20px 28px;flex:1}
.dr-body h3{font-size:12px;letter-spacing:.05em;text-transform:uppercase;color:var(--muted);margin:20px 0 6px;font-weight:650}
.dr-body table{font-size:14px}
.kv{display:grid;grid-template-columns:9em minmax(0,1fr);gap:4px 14px;margin:6px 0;font-size:14px}
.kv dt{color:var(--muted)}
.kv dd{margin:0}
pre{white-space:pre-wrap;overflow-wrap:anywhere;font:12.5px/1.5 var(--mono);background:var(--soft);padding:10px 12px;border-radius:8px;margin:6px 0}
pre.diff{white-space:pre;overflow-x:auto;overflow-wrap:normal}
pre .del{color:var(--need)}
pre .add{color:var(--locked)}
pre .hunk{color:var(--muted)}
.hist{list-style:none;margin:6px 0;padding:0;font-size:14px}
.hist li{padding:6px 0;border-bottom:1px solid var(--line)}
.hist li:last-child{border-bottom:0}
.hist .rc{display:block;font-size:12.5px;color:var(--muted)}
.wf{border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin:18px 0 4px;background:var(--bg)}
.wf h3{margin-top:0}
.wf form{display:grid;grid-template-columns:7.5em minmax(0,1fr);gap:8px 10px;align-items:center;margin:10px 0 0;padding:10px 0 0;border-top:1px solid var(--line)}
.wf form:first-of-type{border-top:0;padding-top:0}
.wf label{font-size:13.5px;color:var(--muted)}
.wf input,.wf textarea,.exc input,.exc textarea{padding:6px 8px;border:1px solid var(--line);border-radius:7px;background:var(--card);min-width:0;width:100%}
.wf .act,.exc .act{grid-column:1 / -1;display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.wf .hint{grid-column:2;font-size:12.5px;color:var(--muted);margin:-4px 0 0}
.wf .fh{grid-column:1 / -1;font-weight:600;margin:0}
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
@media (max-width:1080px){
table.set,table.set thead,table.set tbody,table.set tr,table.set td{display:block;width:100%}
table.set colgroup,table.set thead{display:none}
table.set tr[data-open]{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:2px 14px;border-bottom:1px solid var(--line);padding:8px 12px}
table.set td{border:0;padding:2px 0}
table.set td::before{content:attr(data-label);display:block;font-size:12.5px;color:var(--muted)}
table.set td[data-label="Object"],table.set td[data-label="Last change"]{grid-column:1 / -1}
table.set tr.grp td::before{display:none}
}
@media (max-width:860px){
table.set tr[data-open]{grid-template-columns:repeat(2,minmax(0,1fr))}
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
.wf form{grid-template-columns:1fr}
.wf .hint{grid-column:1}
.report{height:calc(100vh - 230px)}
}`;

/** The one script (see the header). No template literal and no ${ inside, so it sits in this file as a plain string. */
export const SCRIPT = `(function(){"use strict";
var $=function(s,el){return (el||document).querySelector(s)};
var $$=function(s,el){return Array.prototype.slice.call((el||document).querySelectorAll(s))};
var keep={get:function(k){try{return sessionStorage.getItem(k)}catch(e){return null}},set:function(k,v){try{sessionStorage.setItem(k,v)}catch(e){}},del:function(k){try{sessionStorage.removeItem(k)}catch(e){}}};
var toasts=$("#toasts");
function toast(t){if(!toasts)return;var d=document.createElement("div");d.className="toast"+(t.ok?"":" err");d.setAttribute("role",t.ok?"status":"alert");var h=document.createElement("b");h.textContent=t.title||"";d.appendChild(h);if(t.lines&&t.lines.length){var p=document.createElement("pre");p.textContent=t.lines.join("\\n");d.appendChild(p)}var x=document.createElement("button");x.type="button";x.className="tx";x.setAttribute("aria-label","Dismiss");x.textContent="\\u00d7";x.onclick=function(){d.remove()};d.appendChild(x);toasts.appendChild(d);if(t.ok)setTimeout(function(){d.remove()},15000)}
document.addEventListener("click",function(e){var x=e.target.closest(".toast .tx");if(x)x.parentNode.remove()});
var pending=keep.get("console.toast");if(pending){keep.del("console.toast");try{toast(JSON.parse(pending))}catch(e){}}
var drawer=$("#drawer"),scrim=$("#scrim"),back=null;
function openDrawer(row){var tpl=document.getElementById("t-"+row.dataset.open);if(!tpl||!drawer)return;var box=$("#dr",drawer);box.replaceChildren(tpl.content.cloneNode(true));drawer.hidden=false;scrim.hidden=false;drawer.classList.remove("in");void drawer.offsetWidth;drawer.classList.add("in");back=row;document.body.style.overflow="hidden";var c=$("[data-close]",drawer);if(c)c.focus();keep.set("console.open",row.dataset.key||"")}
function closeDrawer(){if(!drawer||drawer.hidden)return;drawer.hidden=true;scrim.hidden=true;document.body.style.overflow="";keep.del("console.open");if(back&&back.focus)back.focus()}
document.addEventListener("click",function(e){if(e.target.closest("[data-close]")){closeDrawer();return}var r=e.target.closest("tr[data-open]");if(r&&!e.target.closest("a,button,input,select,textarea,summary"))openDrawer(r)});
if(scrim)scrim.addEventListener("click",closeDrawer);
document.addEventListener("keydown",function(e){if(e.key==="Escape"){closeDrawer();return}var t=e.target;if((e.key==="Enter"||e.key===" ")&&t.matches&&t.matches("tr[data-open]")){e.preventDefault();openDrawer(t);return}if(e.key==="Tab"&&drawer&&!drawer.hidden){var f=$$("a[href],button:not([disabled]),input,select,textarea,[tabindex]:not([tabindex='-1'])",drawer).filter(function(x){return x.offsetParent!==null});if(!f.length)return;var a=f[0],z=f[f.length-1];if(e.shiftKey&&document.activeElement===a){e.preventDefault();z.focus()}else if(!e.shiftKey&&document.activeElement===z){e.preventDefault();a.focus()}}});
var rows=$$("tr[data-open]"),fs=$$("[data-filter]"),q=$("#q"),count=$("#count");
function apply(){var v={};fs.forEach(function(f){v[f.dataset.filter]=f.value});var term=q?q.value.trim().toLowerCase():"";var n=0;rows.forEach(function(r){var ok=true;for(var k in v){if(v[k]&&r.dataset[k]!==v[k])ok=false}if(term&&(r.dataset.text||"").indexOf(term)<0)ok=false;r.hidden=!ok;if(ok)n++});$$("tr.grp").forEach(function(g){g.hidden=!rows.some(function(r){return r.dataset.group===g.dataset.group&&!r.hidden})});if(count)count.textContent=n+" of "+rows.length+" objects"}
fs.concat(q?[q]:[]).forEach(function(f){f.addEventListener("input",apply);f.addEventListener("change",apply)});if(rows.length)apply();
var want=document.body.dataset.open||keep.get("console.open");if(want){var row=rows.filter(function(r){return r.dataset.key===want})[0];if(row)openDrawer(row);else keep.del("console.open")}
function send(form){var btns=$$("button",form);btns.forEach(function(b){b.disabled=true});var busy=$("[data-busy]",form);var t0=Date.now(),tick=null;if(busy){busy.hidden=false;tick=setInterval(function(){busy.textContent=busy.dataset.busy+" "+Math.round((Date.now()-t0)/1000)+" s"},1000)}var body=new URLSearchParams(new FormData(form));body.set("confirm","yes");function done(){btns.forEach(function(b){b.disabled=false});if(tick)clearInterval(tick);if(busy)busy.hidden=true}fetch(form.action,{method:"POST",body:body,headers:{"Accept":"application/json"},credentials:"same-origin"}).then(function(r){return r.json().catch(function(){return{ok:false,title:"The console answered "+r.status,lines:[]}})}).then(function(t){if(t.ok){keep.set("console.toast",JSON.stringify(t));location.reload()}else{done();toast(t)}}).catch(function(err){done();toast({ok:false,title:"The console did not answer",lines:[String(err)]})})}
document.addEventListener("submit",function(e){var form=e.target;if(!form.matches||!form.matches("form[data-action]"))return;e.preventDefault();var conf=$(".confirm",form);if(conf&&conf.hidden){if(!form.reportValidity())return;var s=$("[data-summary]",conf);if(s&&form.dataset.summary)s.textContent=summary(form);conf.hidden=false;var yes=$("[data-yes]",conf);if(yes)yes.focus();return}send(form)});
function summary(form){var h=form.elements.hours;var text=form.dataset.summary;if(h){var until=new Date(Date.now()+Number(h.value||0)*3600000);text=text.replace("{until}",until.toISOString().slice(0,16).replace("T"," ")+" UTC")}return text}
document.addEventListener("click",function(e){var no=e.target.closest("[data-no]");if(no){var c=no.closest(".confirm");if(c)c.hidden=true}});
var af=$("#agent");if(af){var trs=$$("tbody tr[data-agent]"),tc=$("#tcount");af.addEventListener("change",function(){var n=0;trs.forEach(function(r){r.hidden=af.value!==""&&r.dataset.agent!==af.value;if(!r.hidden)n++});if(tc)tc.textContent=n+" of "+trs.length+" events"})}
})();`;

export interface NavCounts { settings: number; findings: number; needs: number; actions: number; traces: number }
export interface Shell {
  title: string;
  page: "overview" | "settings" | "findings" | "actions" | "traces" | "sources" | "policy" | "document";
  tenant: string;
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
}

const NAV: readonly [Shell["page"], string, string][] = [
  ["overview", "/overview", "Overview"], ["settings", "/settings", "Settings"], ["findings", "/findings", "Findings"],
  ["actions", "/actions", "Actions and tickets"], ["traces", "/traces", "Traces"], ["sources", "/sources", "Sources"],
];

const navCount = (s: Shell, page: Shell["page"]): string => {
  const n = s.nav;
  if (page === "settings") return `<span class="cnt">${n.settings}</span>`;
  if (page === "findings") return n.needs ? `<span class="cnt need">${n.needs} need you</span>` : `<span class="cnt">${n.findings}</span>`;
  if (page === "actions") return `<span class="cnt">${n.actions}</span>`;
  if (page === "traces") return `<span class="cnt">${n.traces}</span>`;
  return "";
};

export function toastHtml(t: { ok: boolean; title: string; lines: string[] }): string {
  return `<div class="toast${t.ok ? "" : " err"}" role="${t.ok ? "status" : "alert"}"><b>${escapeHtml(t.title)}</b>${t.lines.length ? `<pre>${escapeHtml(t.lines.join("\n"))}</pre>` : ""}<button type="button" class="tx" aria-label="Dismiss">×</button></div>`;
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
<style>
${CSS}
</style>
</head>
<body${s.open ? ` data-open="${escapeHtml(s.open)}"` : ""}>
<a class="skip" href="#main">Skip to content</a>
<div class="shell">
<nav class="side" aria-label="Sections">
<div class="brand"><b>ConfigLeaf console</b><span>configuration assurance, the technician's view</span></div>
<div class="tenant"><b>${escapeHtml(s.tenant)}</b>${escapeHtml(s.modeLine)}</div>
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
<script>${SCRIPT}</script>
</body>
</html>
`;
}
