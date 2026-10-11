import { readdir } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

async function findTests(directory) {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error && error.code === "ENOENT") return []; throw error; }
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await findTests(fullPath));
    else if (entry.isFile() && entry.name.endsWith(".test.ts")) files.push(fullPath);
  }
  return files;
}
const files = (await Promise.all(["tests", "src"].map(findTests))).flat().sort();
if (!files.length) { console.error("No test files found under tests/ or src/"); process.exit(1); }
const result = spawnSync(process.execPath, ["--import", "tsx", "--test", ...files], { stdio: "inherit", shell: false });
if (result.error) { console.error(result.error); process.exit(1); }
process.exit(result.status ?? 1);
