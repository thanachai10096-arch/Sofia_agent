import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".woff", ".woff2",
  ".ttf", ".otf", ".pdf", ".zip", ".gz", ".wasm", ".mp4", ".mov",
]);

function git(args, options = {}) {
  const result = spawnSync("git", args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || "git command failed").trim());
  }
  return result.stdout;
}

function csv(value) {
  const text = String(value ?? "");
  return '"' + text.replaceAll('"', '""') + '"';
}

function parseBlame(output, file) {
  const rows = [];
  let current;
  for (const line of output.split("\n")) {
    const header = /^([0-9a-f]{40}) (\d+) (\d+)(?: (\d+))?$/.exec(line);
    if (header) {
      current = {
        commit: header[1],
        originalLine: Number(header[2]),
        finalLine: Number(header[3]),
        author: "unknown",
        email: "unknown",
        summary: "",
      };
      continue;
    }
    if (!current) continue;
    if (line.startsWith("author ")) current.author = line.slice(7);
    else if (line.startsWith("author-mail ")) current.email = line.slice(12).replace(/^<|>$/g, "");
    else if (line.startsWith("summary ")) current.summary = line.slice(8);
    else if (line.startsWith("\t")) {
      const sourceLine = line.slice(1);
      rows.push({
        file,
        line: current.finalLine,
        commit: current.commit,
        originalLine: current.originalLine,
        author: current.author,
        email: current.email,
        summary: current.summary,
        lineSha256: createHash("sha256").update(sourceLine).digest("hex"),
      });
      current = undefined;
    }
  }
  return rows;
}

const shallow = git(["rev-parse", "--is-shallow-repository"]).trim() === "true";
if (shallow) {
  console.error("PROVENANCE AUDIT INCOMPLETE: this clone is shallow. Run 'git fetch --unshallow' (or clone with full history), then rerun.");
  process.exit(2);
}

const tracked = git(["ls-files", "-z"]).split("\0").filter(Boolean);
const files = tracked.filter((file) => {
  const extension = path.extname(file).toLowerCase();
  return !BINARY_EXTENSIONS.has(extension);
});
if (files.length === 0) {
  console.error("PROVENANCE AUDIT FAILED: no tracked text/source files found.");
  process.exit(1);
}

const allRows = [];
const fileSummary = [];
for (const file of files) {
  const rows = parseBlame(git(["blame", "--line-porcelain", "--", file]), file);
  const authors = [...new Set(rows.map((row) => row.author))].sort();
  fileSummary.push({ file, lines: rows.length, authors });
  allRows.push(...rows);
}

const destination = path.resolve(process.argv[2] || path.join(os.tmpdir(), "sofia-code-provenance-lines.csv"));
await mkdir(path.dirname(destination), { recursive: true });
const header = ["file", "line", "commit", "originalLine", "author", "email", "summary", "lineSha256"];
const csvText = [
  header.map(csv).join(","),
  ...allRows.map((row) => header.map((key) => csv(row[key])).join(",")),
].join("\n") + "\n";
await writeFile(destination, csvText, "utf8");

const authors = [...new Set(allRows.map((row) => row.author))].sort();
console.log("Git blame provenance inventory generated.");
console.log("Tracked text/source files:", files.length);
console.log("Attributed lines:", allRows.length);
console.log("Distinct Git authors:", authors.length);
console.log("CSV report:", destination);
console.log("Files with multiple Git authors:", fileSummary.filter((item) => item.authors.length > 1).length);
console.log("IMPORTANT: Git attribution records repository history only. It does not prove independent authorship, detect copied expression, or establish license compatibility.");
