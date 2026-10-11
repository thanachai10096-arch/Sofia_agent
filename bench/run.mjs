#!/usr/bin/env node
/**
 * Sofia benchmark harness sanity checks.
 *
 * This file intentionally distinguishes harness validation from an agent score.
 * It does not claim to measure Sofia until a real command/API adapter is run.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const args = process.argv.slice(2);
const valueAfter = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const selftest = args.includes("--selftest");
const mode = valueAfter("--agent", selftest ? "selftest" : "");
const tasks = [
  { id: "sum-first-n", prompt: "Create sum-first-n.mjs exporting sumFirstN(n), validating n as a non-negative integer.", file: "sum-first-n.mjs", test: "import {sumFirstN} from './sum-first-n.mjs'; if(sumFirstN(0)!==0||sumFirstN(5)!==15)process.exit(1);" , solution: "export function sumFirstN(n){if(!Number.isInteger(n)||n<0)throw new TypeError('n');return n*(n+1)/2;}\n" },
  { id: "chunk", prompt: "Create chunk.mjs exporting chunk(array,size); preserve order and reject size <= 0.", file: "chunk.mjs", test: "import {chunk} from './chunk.mjs'; if(JSON.stringify(chunk([1,2,3,4,5],2))!==JSON.stringify([[1,2],[3,4],[5]]))process.exit(1);", solution: "export function chunk(a,n){if(!Number.isInteger(n)||n<=0)throw new RangeError('size');const r=[];for(let i=0;i<a.length;i+=n)r.push(a.slice(i,i+n));return r;}\n" },
  { id: "days-between", prompt: "Create days-between.mjs exporting daysBetween(ISODateA,ISODateB), returning absolute UTC calendar-day difference.", file: "days-between.mjs", test: "import {daysBetween} from './days-between.mjs'; if(daysBetween('2024-01-01','2024-01-31')!==30)process.exit(1);", solution: "export function daysBetween(a,b){const parse=s=>{if(!/^\\d{4}-\\d{2}-\\d{2}$/.test(s))throw new TypeError('date');const d=new Date(s+'T00:00:00Z');if(d.toISOString().slice(0,10)!==s)throw new TypeError('date');return d.getTime();};return Math.abs(parse(a)-parse(b))/86400000;}\n" },
  { id: "csv-parse", prompt: "Create csv-parse.mjs exporting parseCsv(text), supporting commas, quoted fields, escaped double quotes, and newlines in quotes.", file: "csv-parse.mjs", test: "import {parseCsv} from './csv-parse.mjs'; const x=parseCsv(['a,b','1,'+String.fromCharCode(34)+'two, too'+String.fromCharCode(34),''].join(String.fromCharCode(10))); if(x[1][1]!=='two, too')process.exit(1);", solution: "export function parseCsv(s){const rows=[];let row=[],cell='',q=false;for(let i=0;i<s.length;i++){const c=s[i];if(q){if(c==='"'&&s[i+1]==='"'){cell+='"';i++;}else if(c==='"')q=false;else cell+=c;}else if(c==='"'){if(cell)throw new Error('quote');q=true;}else if(c===','){row.push(cell);cell='';}else if(c==='\\n'||c==='\\r'){if(c==='\\r'&&s[i+1]==='\\n')i++;row.push(cell);rows.push(row);row=[];cell='';}else cell+=c;}if(q)throw new Error('quote');if(cell||row.length){row.push(cell);rows.push(row);}return rows;}\n" },
  { id: "slugify", prompt: "Create slugify.mjs exporting slugify(text), lowercasing, trimming, collapsing spaces/hyphens, and preserving Thai letters and digits.", file: "slugify.mjs", test: "import {slugify} from './slugify.mjs'; if(slugify(' Hello   โลก  42 ')!=='hello-โลก-42')process.exit(1);", solution: "export function slugify(s){return String(s).normalize('NFC').toLocaleLowerCase('th').trim().replace(/[\\s-]+/g,'-').replace(/^-|-$/g,'');}\n" },
  { id: "lru-cache", prompt: "Create lru-cache.mjs exporting LRUCache with constructor(capacity), get(key), and set(key,value), evicting least recently used entries.", file: "lru-cache.mjs", test: "import {LRUCache} from './lru-cache.mjs'; const c=new LRUCache(2);c.set('a',1);c.set('b',2);c.get('a');c.set('c',3);if(c.get('b')!==undefined||c.get('a')!==1)process.exit(1);", solution: "export class LRUCache{constructor(n){if(!Number.isInteger(n)||n<1)throw new RangeError('capacity');this.n=n;this.m=new Map();}get(k){if(!this.m.has(k))return undefined;const v=this.m.get(k);this.m.delete(k);this.m.set(k,v);return v;}set(k,v){this.m.delete(k);this.m.set(k,v);if(this.m.size>this.n)this.m.delete(this.m.keys().next().value);return this;}}\n" },
  { id: "safe-join", prompt: "Create safe-join.mjs exporting safeJoin(root, input), rejecting absolute paths and any path that escapes root.", file: "safe-join.mjs", test: "import {safeJoin} from './safe-join.mjs'; import path from 'node:path'; const r=path.resolve('/tmp/root'); if(!safeJoin(r,'a/b').startsWith(r+path.sep))process.exit(1); let ok=false;try{safeJoin(r,'../secret')}catch{ok=true}if(!ok)process.exit(1);", solution: "import path from 'node:path';export function safeJoin(root,input){if(typeof input!=='string'||path.isAbsolute(input))throw new Error('unsafe path');const r=path.resolve(root),p=path.resolve(r,input);if(p!==r&&!p.startsWith(r+path.sep))throw new Error('unsafe path');return p;}\n" },
  { id: "baht-text", prompt: "Create baht-text.mjs exporting bahtText(number), formatting finite non-negative baht amounts as Thai words, including satang.", file: "baht-text.mjs", test: "import {bahtText} from './baht-text.mjs'; if(bahtText(0)!=='ศูนย์บาทถ้วน'||!bahtText(10).includes('สิบบาทถ้วน'))process.exit(1);", solution: "const d=['','หนึ่ง','สอง','สาม','สี่','ห้า','หก','เจ็ด','แปด','เก้า'];function read(n){if(!n)return '';const s=String(n),L=s.length;let o='';for(let i=0;i<L;i++){const x=+s[i],p=L-i-1;if(!x)continue;if(p===0)o+=x===1&&L>1?'เอ็ด':d[x];else if(p===1)o+=x===1?'สิบ':x===2?'ยี่สิบ':d[x]+'สิบ';else if(p===2)o+=d[x]+'ร้อย';else if(p===3)o+=d[x]+'พัน';else if(p===4)o+=d[x]+'หมื่น';else if(p===5)o+=d[x]+'แสน';else o+=read(+s.slice(0,-6))+'ล้าน'+read(+s.slice(-6));}return o;}export function bahtText(v){if(typeof v!=='number'||!Number.isFinite(v)||v<0)throw new TypeError('amount');const n=Math.round(v*100),b=Math.floor(n/100),s=n%100;return (read(b)||'ศูนย์')+'บาท'+(s?read(s)+'สตางค์':'ถ้วน');}\n" },
  { id: "split-vat", prompt: "Create split-vat.mjs exporting splitVat(gross), returning {net, vat, gross} for a VAT-inclusive amount at 7%, rounded to 2 decimals.", file: "split-vat.mjs", test: "import {splitVat} from './split-vat.mjs'; const x=splitVat(107);if(x.net!==100||x.vat!==7||x.gross!==107)process.exit(1);", solution: "export function splitVat(gross){if(typeof gross!=='number'||!Number.isFinite(gross)||gross<0)throw new TypeError('gross');const r=n=>Math.round((n+Number.EPSILON)*100)/100;const net=r(gross/1.07);return {net,vat:r(gross-net),gross:r(gross)};}\n" },
  { id: "thai-date", prompt: "Create thai-date.mjs exporting thaiDate(ISODate), formatting a valid Gregorian ISO date in Thai Buddhist calendar as d เดือน yyyy (พ.ศ.).", file: "thai-date.mjs", test: "import {thaiDate} from './thai-date.mjs'; if(!thaiDate('2024-01-02').includes('2567'))process.exit(1);", solution: "const months=['มกราคม','กุมภาพันธ์','มีนาคม','เมษายน','พฤษภาคม','มิถุนายน','กรกฎาคม','สิงหาคม','กันยายน','ตุลาคม','พฤศจิกายน','ธันวาคม'];export function thaiDate(s){if(!/^\\d{4}-\\d{2}-\\d{2}$/.test(s))throw new TypeError('date');const d=new Date(s+'T00:00:00Z');if(!Number.isFinite(d.getTime())||d.toISOString().slice(0,10)!==s)throw new TypeError('date');return d.getUTCDate()+' '+months[d.getUTCMonth()]+' '+(d.getUTCFullYear()+543);}\n" },
];

async function runNode(cwd, code) {
  const file = path.join(cwd, ".bench-check.mjs");
  await writeFile(file, code, "utf8");
  const child = spawn(process.execPath, [file], { cwd, stdio: "pipe" });
  let stderr = "";
  child.stderr.on("data", (b) => stderr += b);
  child.stdout.resume();
  const codeOut = await new Promise((resolve) => child.on("close", resolve));
  return { ok: codeOut === 0, stderr };
}
async function selfTest() {
  assert.equal(tasks.length, 10);
  const dir = await mkdtemp(path.join(os.tmpdir(), "sofia-bench-selftest-"));
  try {
    for (const task of tasks) {
      await rm(path.join(dir, task.file), { force: true });
      const before = await runNode(dir, task.test);
      assert.equal(before.ok, false, task.id + " must fail before implementation");
      await writeFile(path.join(dir, task.file), task.solution, "utf8");
      const after = await runNode(dir, task.test);
      assert.equal(after.ok, true, task.id + " reference solution failed: " + after.stderr);
    }
    console.log("SELFTEST PASS: 10/10 task fixtures fail before solution and pass after reference solution.");
  } finally { await rm(dir, { recursive: true, force: true }); }
}
async function main() {
  if (selftest || mode === "selftest") return selfTest();
  if (!["noop", "reference", "command", "http"].includes(mode)) {
    console.error("Usage: node bench/run.mjs --selftest | --agent noop|reference|command|http");
    process.exitCode = 2; return;
  }
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-bench-"));
  const report = [];
  try {
    for (const task of tasks) {
      const dir = path.join(root, task.id);
      await mkdir(dir, { recursive: true });
      let error = "";
      if (mode === "reference") await writeFile(path.join(dir, task.file), task.solution, "utf8");
      else if (mode === "command") {
        const command = valueAfter("--command", "");
        if (!command) throw new Error("--command is required for command agent");
        const child = spawn(command, [], { cwd: dir, shell: true, stdio: "inherit", env: { ...process.env, BENCH_PROMPT: task.prompt, BENCH_WORKSPACE: dir, BENCH_TASK_ID: task.id } });
        const code = await new Promise((resolve) => child.on("close", resolve));
        if (code !== 0) error = "command exited " + code;
      } else if (mode === "http") {
        const url = valueAfter("--url", "");
        const apiKey = process.env.SOFIA_API_KEY;
        if (!url || !apiKey) throw new Error("--url and SOFIA_API_KEY are required for http agent");
        const workspace = valueAfter("--shared-workspace", "");
        if (!workspace) throw new Error("--shared-workspace is required; point Sofia at a disposable workspace matching its server configuration");
        const response = await fetch(new URL("/v1/agent/runs", url), { method: "POST", headers: { authorization: "Bearer " + apiKey, "content-type": "application/json" }, body: JSON.stringify({ task: task.prompt + "\nWorkspace: " + workspace, async: false, maxSteps: 12 }) });
        if (!response.ok) error = "HTTP " + response.status + ": " + (await response.text()).slice(0, 300);
      }
      const checked = await runNode(dir, task.test);
      report.push({ id: task.id, passed: checked.ok, error: error || checked.stderr.trim() });
    }
    const passed = report.filter((x) => x.passed).length;
    console.log(JSON.stringify({ agent: mode, passed, total: tasks.length, note: mode === "noop" ? "Expected negative control; not a Sofia score." : mode === "reference" ? "Reference upper bound; not a Sofia score." : "Measured against task checks.", results: report }, null, 2));
    if (mode === "reference" && passed !== tasks.length) process.exitCode = 1;
  } finally { await rm(root, { recursive: true, force: true }); }
}
main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
