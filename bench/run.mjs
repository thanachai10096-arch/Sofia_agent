#!/usr/bin/env node
/**
 * Sofia benchmark harness sanity checks.
 *
 * This file intentionally distinguishes harness validation from an agent score.
 * It does not claim to measure Sofia until a real command/API adapter is run.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, realpath, rm, stat, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const args = process.argv.slice(2);
const valueAfter = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const timeoutMs = Number(valueAfter("--timeout-ms", "120000"));
if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3_600_000) {
  console.error("--timeout-ms must be an integer between 1 and 3600000");
  process.exit(2);
}
const selftest = args.includes("--selftest");
const mode = valueAfter("--agent", selftest ? "selftest" : "");
const tasks = [
  { id: "sum-first-n", prompt: "Create sum-first-n.mjs exporting sumFirstN(n), validating n as a non-negative integer.", file: "sum-first-n.mjs", test: "import {sumFirstN} from './sum-first-n.mjs'; if(sumFirstN(0)!==0||sumFirstN(5)!==15)process.exit(1);" , solution: "export function sumFirstN(n){if(!Number.isInteger(n)||n<0)throw new TypeError('n');return n*(n+1)/2;}\n" },
  { id: "chunk", prompt: "Create chunk.mjs exporting chunk(array,size); preserve order and reject size <= 0.", file: "chunk.mjs", test: "import {chunk} from './chunk.mjs'; if(JSON.stringify(chunk([1,2,3,4,5],2))!==JSON.stringify([[1,2],[3,4],[5]]))process.exit(1);", solution: "export function chunk(a,n){if(!Number.isInteger(n)||n<=0)throw new RangeError('size');const r=[];for(let i=0;i<a.length;i+=n)r.push(a.slice(i,i+n));return r;}\n" },
  { id: "days-between", prompt: "Create days-between.mjs exporting daysBetween(ISODateA,ISODateB), returning absolute UTC calendar-day difference.", file: "days-between.mjs", test: "import {daysBetween} from './days-between.mjs'; if(daysBetween('2024-01-01','2024-01-31')!==30)process.exit(1);", solution: "export function daysBetween(a,b){const parse=s=>{if(!/^\\d{4}-\\d{2}-\\d{2}$/.test(s))throw new TypeError('date');const d=new Date(s+'T00:00:00Z');if(d.toISOString().slice(0,10)!==s)throw new TypeError('date');return d.getTime();};return Math.abs(parse(a)-parse(b))/86400000;}\n" },
  { id: "csv-parse", prompt: "Create csv-parse.mjs exporting parseCsv(text), supporting commas, quoted fields, escaped double quotes, and newlines in quotes.", file: "csv-parse.mjs", test: "import {parseCsv} from './csv-parse.mjs'; const q=String.fromCharCode(34); const x=parseCsv(['a,b','1,'+q+'two, too'+q,''].join(String.fromCharCode(10))); if(x[1][1]!=='two, too')process.exit(1);", solution: "export function parseCsv(s){const rows=[];let row=[],cell='',q=false;const quote=String.fromCharCode(34);for(let i=0;i<s.length;i++){const c=s[i];if(q){if(c===quote&&s[i+1]===quote){cell+=quote;i++;}else if(c===quote)q=false;else cell+=c;}else if(c===quote){if(cell)throw new Error('quote');q=true;}else if(c===','){row.push(cell);cell='';}else if(c==='\\n'||c==='\\r'){if(c==='\\r'&&s[i+1]==='\\n')i++;row.push(cell);rows.push(row);row=[];cell='';}else cell+=c;}if(q)throw new Error('quote');if(cell||row.length){row.push(cell);rows.push(row);}return rows;}" },
  { id: "slugify", prompt: "Create slugify.mjs exporting slugify(text), lowercasing, trimming, collapsing spaces/hyphens, and preserving Thai letters and digits.", file: "slugify.mjs", test: "import {slugify} from './slugify.mjs'; if(slugify(' Hello   โลก  42 ')!=='hello-โลก-42')process.exit(1);", solution: "export function slugify(s){return String(s).normalize('NFC').toLocaleLowerCase('th').trim().replace(/[\\s-]+/g,'-').replace(/^-|-$/g,'');}\n" },
  { id: "lru-cache", prompt: "Create lru-cache.mjs exporting LRUCache with constructor(capacity), get(key), and set(key,value), evicting least recently used entries.", file: "lru-cache.mjs", test: "import {LRUCache} from './lru-cache.mjs'; const c=new LRUCache(2);c.set('a',1);c.set('b',2);c.get('a');c.set('c',3);if(c.get('b')!==undefined||c.get('a')!==1)process.exit(1);", solution: "export class LRUCache{constructor(n){if(!Number.isInteger(n)||n<1)throw new RangeError('capacity');this.n=n;this.m=new Map();}get(k){if(!this.m.has(k))return undefined;const v=this.m.get(k);this.m.delete(k);this.m.set(k,v);return v;}set(k,v){this.m.delete(k);this.m.set(k,v);if(this.m.size>this.n)this.m.delete(this.m.keys().next().value);return this;}}\n" },
  { id: "safe-join", prompt: "Create safe-join.mjs exporting safeJoin(root, input), rejecting absolute paths and any path that escapes root.", file: "safe-join.mjs", test: "import {safeJoin} from './safe-join.mjs'; import path from 'node:path'; const r=path.resolve('/tmp/root'); if(!safeJoin(r,'a/b').startsWith(r+path.sep))process.exit(1); let ok=false;try{safeJoin(r,'../secret')}catch{ok=true}if(!ok)process.exit(1);", solution: "import path from 'node:path';export function safeJoin(root,input){if(typeof input!=='string'||path.isAbsolute(input))throw new Error('unsafe path');const r=path.resolve(root),p=path.resolve(r,input);if(p!==r&&!p.startsWith(r+path.sep))throw new Error('unsafe path');return p;}\n" },
  { id: "baht-text", prompt: "Create baht-text.mjs exporting bahtText(number), formatting finite non-negative baht amounts as Thai words, including satang.", file: "baht-text.mjs", test: "import {bahtText} from './baht-text.mjs'; if(bahtText(0)!=='ศูนย์บาทถ้วน'||!bahtText(10).includes('สิบบาทถ้วน'))process.exit(1);", solution: "const d=['','หนึ่ง','สอง','สาม','สี่','ห้า','หก','เจ็ด','แปด','เก้า'];function read(n){if(!n)return '';const s=String(n),L=s.length;let o='';for(let i=0;i<L;i++){const x=+s[i],p=L-i-1;if(!x)continue;if(p===0)o+=x===1&&L>1?'เอ็ด':d[x];else if(p===1)o+=x===1?'สิบ':x===2?'ยี่สิบ':d[x]+'สิบ';else if(p===2)o+=d[x]+'ร้อย';else if(p===3)o+=d[x]+'พัน';else if(p===4)o+=d[x]+'หมื่น';else if(p===5)o+=d[x]+'แสน';else o+=read(+s.slice(0,-6))+'ล้าน'+read(+s.slice(-6));}return o;}export function bahtText(v){if(typeof v!=='number'||!Number.isFinite(v)||v<0)throw new TypeError('amount');const n=Math.round(v*100),b=Math.floor(n/100),s=n%100;return (read(b)||'ศูนย์')+'บาท'+(s?read(s)+'สตางค์':'ถ้วน');}\n" },
  { id: "split-vat", prompt: "Create split-vat.mjs exporting splitVat(gross), returning {net, vat, gross} for a VAT-inclusive amount at 7%, rounded to 2 decimals.", file: "split-vat.mjs", test: "import {splitVat} from './split-vat.mjs'; const x=splitVat(107);if(x.net!==100||x.vat!==7||x.gross!==107)process.exit(1);", solution: "export function splitVat(gross){if(typeof gross!=='number'||!Number.isFinite(gross)||gross<0)throw new TypeError('gross');const r=n=>Math.round((n+Number.EPSILON)*100)/100;const net=r(gross/1.07);return {net,vat:r(gross-net),gross:r(gross)};}\n" },
  { id: "thai-date", prompt: "Create thai-date.mjs exporting thaiDate(ISODate), formatting a valid Gregorian ISO date in Thai Buddhist calendar as d เดือน yyyy (พ.ศ.).", file: "thai-date.mjs", test: "import {thaiDate} from './thai-date.mjs'; if(!thaiDate('2024-01-02').includes('2567'))process.exit(1);", solution: "const months=['มกราคม','กุมภาพันธ์','มีนาคม','เมษายน','พฤษภาคม','มิถุนายน','กรกฎาคม','สิงหาคม','กันยายน','ตุลาคม','พฤศจิกายน','ธันวาคม'];export function thaiDate(s){if(!/^\\d{4}-\\d{2}-\\d{2}$/.test(s))throw new TypeError('date');const d=new Date(s+'T00:00:00Z');if(!Number.isFinite(d.getTime())||d.toISOString().slice(0,10)!==s)throw new TypeError('date');return d.getUTCDate()+' '+months[d.getUTCMonth()]+' '+(d.getUTCFullYear()+543);}\n" },
  { id: "readme-docs", category: "documentation", prompt: "Create README.md for a fictional JavaScript package named @sofia/demo. Include the exact headings # Demo, ## Installation, ## Usage, and ## License. Include the install command npm install @sofia/demo, an import/use example for createDemo, and identify the license as MIT.", file: "README.md", test: "import {readFile} from 'node:fs/promises';const s=await readFile(new URL('./README.md',import.meta.url),'utf8');for(const x of ['# Demo','## Installation','npm install @sofia/demo','## Usage','createDemo','## License','MIT'])if(!s.includes(x))process.exit(1);", solution: "# Demo\\n\\n## Installation\\n\\nnpm install @sofia/demo\\n\\n## Usage\\n\\nimport { createDemo } from '@sofia/demo';\\ncreateDemo();\\n\\n## License\\n\\nMIT\\n" },
  { id: "source-grounded-research", category: "research", prompt: "Create research.md as a concise source-grounded security note. Use ONLY these supplied notes: Source S1 (https://example.com/csp-guide) says Content Security Policy can reduce some injection risks but does not replace context-aware output encoding. Source S2 (https://example.com/cookie-guide) says HttpOnly prevents JavaScript from reading a cookie and Secure restricts cookie transmission to HTTPS. State those facts accurately, distinguish the two controls, and include a Sources section with both URLs. Do not add unsupported claims.", file: "research.md", test: "import {readFile} from 'node:fs/promises';const s=await readFile(new URL('./research.md',import.meta.url),'utf8');for(const x of ['Content Security Policy','output encoding','HttpOnly','JavaScript','Secure','HTTPS','https://example.com/csp-guide','https://example.com/cookie-guide','Sources'])if(!s.includes(x))process.exit(1);", solution: "# Security Controls: Brief Research Note\\n\\nContent Security Policy (CSP) can reduce some injection risks, but it does not replace context-aware output encoding. These controls address related but different layers and should not be treated as interchangeable.\\n\\nThe HttpOnly cookie attribute prevents JavaScript from reading a cookie. The Secure attribute restricts cookie transmission to HTTPS. They protect cookie access and transport, respectively.\\n\\n## Sources\\n- https://example.com/csp-guide — CSP can reduce some injection risks but does not replace context-aware output encoding.\\n- https://example.com/cookie-guide — HttpOnly prevents JavaScript access to cookies; Secure restricts transmission to HTTPS.\\n" },
  { id: "batch-automation", category: "automation", prompt: "Create automation.mjs exporting async runBatch(items, action). Process items sequentially in input order. Return one result per item with its index; capture each failure as {index, ok:false, error} and continue processing later items. Do not run actions concurrently.", file: "automation.mjs", test: "import {runBatch} from './automation.mjs';const seen=[];const r=await runBatch([1,2,3],async(x)=>{seen.push(x);if(x===2)throw new Error('bad item');return x*2;});if(JSON.stringify(seen)!=='[1,2,3]'||r.length!==3||r[0].value!==2||r[1].ok!==false||r[1].index!==1||r[2].value!==6)process.exit(1);", solution: "export async function runBatch(items, action) {\\n  const results = [];\\n  for (let index = 0; index < items.length; index += 1) {\\n    try { results.push({ index, ok: true, value: await action(items[index], index) }); }\\n    catch (error) { results.push({ index, ok: false, error: error instanceof Error ? error.message : String(error) }); }\\n  }\\n  return results;\\n}\\n" }
];

const categoryById = Object.fromEntries(tasks.map((task) => [
  task.id,
  task.category ?? (
    ["sum-first-n", "chunk", "lru-cache"].includes(task.id) ? "coding" :
    ["days-between", "csv-parse", "split-vat"].includes(task.id) ? "data" :
    ["slugify", "baht-text", "thai-date"].includes(task.id) ? "localization" :
    task.id === "safe-join" ? "security" : "coding"
  ),
]));


async function runNode(cwd, code) {
  const file = path.join(cwd, ".bench-check.mjs");
  await writeFile(file, code, "utf8");
  const child = spawn(process.execPath, [file], { cwd, stdio: "pipe" });
  let stderr = "";
  let settled = false;
  child.stderr.on("data", (b) => { stderr += b; });
  child.stdout.resume();
  const codeOut = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    child.once("error", (error) => { if (!settled) { settled = true; clearTimeout(timer); reject(error); } });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (!settled) { settled = true; resolve({ code, signal }); }
    });
  });
  return { ok: codeOut.code === 0, stderr: stderr.trim() || (codeOut.signal ? `checker terminated by ${codeOut.signal}` : "") };
}
async function selfTest() {
  assert.equal(tasks.length, 13);
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
    console.log("SELFTEST PASS: 13/13 task fixtures fail before solution and pass after reference solution.");
  } finally { await rm(dir, { recursive: true, force: true }); }
}
async function main() {
  if (selftest || mode === "selftest") return selfTest();
  if (!["noop", "reference", "command", "http"].includes(mode)) {
    console.error("Usage: node bench/run.mjs --selftest | --agent noop|reference|command|http");
    process.exitCode = 2; return;
  }
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "sofia-bench-"));
  let root = tempRoot;
  try {
    if (mode === "http") {
      const workspaceArg = valueAfter("--shared-workspace", "");
      if (!workspaceArg) throw new Error("--shared-workspace is required; use a dedicated disposable workspace configured as Sofia's actual workspace");
      root = await realpath(workspaceArg);
      const info = await stat(root);
      if (!info.isDirectory() || root === path.parse(root).root || root === os.homedir()) {
        throw new Error("--shared-workspace must be an existing dedicated directory, not a filesystem root or home directory");
      }
      const entries = await readdir(root);
      if (entries.length > 0) {
        throw new Error("--shared-workspace must be empty before the benchmark starts; use a new disposable directory to avoid deleting or contaminating project files");
      }
    }
  } catch (error) {
    await rm(tempRoot, { recursive: true, force: true });
    throw error;
  }
  const report = [];
  try {
    for (const task of tasks) {
      const dir = mode === "http" ? root : path.join(root, task.id);
      if (mode !== "http") await mkdir(dir, { recursive: true });
      const startedAt = Date.now();
      const targetFile = path.join(dir, task.file);
      const checkFile = path.join(dir, ".bench-check.mjs");
      if (mode === "http") {
        await rm(targetFile, { force: true });
        await rm(checkFile, { force: true });
      }
      let error = "";
      let usageMetrics = null;
      if (mode === "reference") await writeFile(path.join(dir, task.file), task.solution, "utf8");
      else if (mode === "command") {
        const command = valueAfter("--command", "");
        if (!command) throw new Error("--command is required for command agent");
        const child = spawn(command, [], { cwd: dir, shell: true, stdio: "inherit", env: { ...process.env, BENCH_PROMPT: task.prompt, BENCH_WORKSPACE: dir, BENCH_TASK_ID: task.id } });
        const code = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            child.kill("SIGTERM");
            const forceTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
            forceTimer.unref();
          }, Math.max(1, Number(valueAfter("--timeout-ms", "120000"))));
          child.once("error", (cause) => { clearTimeout(timer); reject(cause); });
          child.once("close", (exitCode, signal) => { clearTimeout(timer); resolve({ exitCode, signal }); });
        });
        if (code.exitCode !== 0) error = code.signal ? "command terminated by " + code.signal : "command exited " + code.exitCode;
      } else if (mode === "http") {
        const url = valueAfter("--url", "");
        const apiKey = process.env.SOFIA_API_KEY;
        if (!url || !apiKey) throw new Error("--url and SOFIA_API_KEY are required for http agent");
        const workspace = valueAfter("--shared-workspace", "");
        if (!workspace) throw new Error("--shared-workspace is required; point Sofia at a disposable workspace matching its server configuration");
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), Number(valueAfter("--timeout-ms", "120000")));
        try {
          const response = await fetch(new URL("/v1/agent/runs", url), { method: "POST", headers: { authorization: "Bearer " + apiKey, "content-type": "application/json" }, body: JSON.stringify({ task: task.prompt + "\nWorkspace: " + workspace, async: false, maxSteps: 12 }), signal: controller.signal });
          const raw = await response.text();
          let payload;
          try { payload = JSON.parse(raw); } catch { throw new Error("API returned non-JSON response"); }
          if (!response.ok) error = "HTTP " + response.status + ": " + raw.slice(0, 300);
          else if (payload?.status !== "completed" || !payload?.result) error = "API run did not complete successfully (status=" + String(payload?.status ?? "missing") + ")";
          else {
            const usage = payload?.result?.brainReport?.usage;
            if (usage && typeof usage === "object") {
              usageMetrics = {
                modelCalls: Number.isFinite(usage.modelCalls) ? usage.modelCalls : null,
                toolCalls: Number.isFinite(usage.toolCalls) ? usage.toolCalls : null,
                tokens: Number.isFinite(usage.reservedOrUsedTokens) ? usage.reservedOrUsedTokens : null,
                providerCostUsd: null,
              };
            }
          }
        } catch (cause) {
          error = cause instanceof Error ? cause.message : String(cause);
        } finally { clearTimeout(timer); }
      }
      const checked = await runNode(dir, task.test);
      report.push({ id: task.id, category: categoryById[task.id], passed: checked.ok && !error, durationMs: Date.now() - startedAt, usage: usageMetrics, error: error || checked.stderr.trim() });
      if (mode === "http") {
        await rm(targetFile, { force: true });
        await rm(checkFile, { force: true });
      }
    }
    const passed = report.filter((x) => x.passed).length;
    const byCategory = Object.fromEntries([...new Set(report.map((x) => x.category))].map((category) => {
      const rows = report.filter((x) => x.category === category);
      return [category, { passed: rows.filter((x) => x.passed).length, total: rows.length }];
    }));
    console.log(JSON.stringify({ agent: mode, passed, total: tasks.length, byCategory, note: mode === "noop" ? "Expected negative control; not a Sofia score." : mode === "reference" ? "Reference upper bound; not a Sofia score." : "Measured against task checks. Provider cost is unavailable unless the API explicitly exposes it; null is not zero.", results: report }, null, 2));
    if (mode === "reference" && passed !== tasks.length) process.exitCode = 1;
  } finally { await rm(tempRoot, { recursive: true, force: true }); }
}
main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
