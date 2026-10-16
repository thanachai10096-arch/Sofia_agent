import { readdir } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ignored = new Set(["node_modules", ".git", "dist", "coverage"]);
const files = [];

async function visit(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!ignored.has(entry.name)) await visit(path.join(directory, entry.name));
    } else if (entry.isFile() && entry.name.endsWith(".test.ts")) {
      files.push(path.relative(root, path.join(directory, entry.name)));
    }
  }
}

await visit(path.join(root, "src"));
await visit(path.join(root, "tests"));
files.sort();
if (files.length === 0) {
  console.error("No TypeScript test files were found under src/ or tests/.");
  process.exit(1);
}

// Use Node's TAP reporter so trusted project.verify calls can consume an explicit,
 // machine-readable test summary rather than infer success from prose.
const result = spawnSync(process.execPath, ["--import", "tsx", "--test", "--test-reporter=tap", ...files], {
  cwd: root,
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
});
if (result.error) throw result.error;
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
process.exit(result.status ?? 1);
