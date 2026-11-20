#!/usr/bin/env node
import { createHash } from "node:crypto";
import { promises as fs, constants as fsConstants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const STORE_NAMES = ["runs", "jobs", "checkpoints", "memory", "sessions", "api-runs", "chat-dedupe", "api", "skills", "evolution", "security", "user-memory"];

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative));
}

async function collectFiles(source, relative = "") {
  const current = path.join(source, relative);
  const entries = await fs.readdir(current, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const childRelative = path.join(relative, entry.name);
    const full = path.join(source, childRelative);
    const stat = await fs.lstat(full);
    if (stat.isSymbolicLink()) throw new Error("Refusing to migrate symbolic link: " + full);
    if (stat.isDirectory()) files.push(...await collectFiles(source, childRelative));
    else if (stat.isFile()) files.push({ source: full, relative: childRelative, size: stat.size, mode: stat.mode & 0o777 });
    else throw new Error("Refusing to migrate special filesystem entry: " + full);
  }
  return files;
}

export function buildMigrationPlan({ workspace, stateDir, tempDir = os.tmpdir(), homeDir = os.homedir(), platform = process.platform, env = process.env }) {
  if (!path.isAbsolute(workspace) || !path.isAbsolute(stateDir)) throw new Error("Workspace and SOFIA_STATE_DIR must be absolute paths.");
  const destinationRoot = path.resolve(stateDir);
  const workspaceRoot = path.resolve(workspace);
  const sources = [];
  const add = (source, target, label) => {
    if (source && path.isAbsolute(source)) sources.push({ source: path.resolve(source), target: path.resolve(target), label });
  };

  for (const name of ["runs", "jobs", "checkpoints", "memory", "sessions", "api-runs", "chat-dedupe"]) {
    add(path.join(tempDir, "sofia-agents-" + name), path.join(destinationRoot, "sofia-agents-" + name), "legacy OS temporary store: " + name);
  }

  if (env.SOFIA_LEGACY_STATE_DIR && path.isAbsolute(env.SOFIA_LEGACY_STATE_DIR)) {
    const legacyRoot = path.resolve(env.SOFIA_LEGACY_STATE_DIR);
    for (const name of STORE_NAMES) {
      add(path.join(legacyRoot, "sofia-agents-" + name), path.join(destinationRoot, "sofia-agents-" + name), "previous configured state root: " + name);
    }
  }

  add(path.join(workspaceRoot, ".sofia", "api-runs"), path.join(destinationRoot, "sofia-agents-api-runs"), "legacy workspace API run records");
  add(path.join(workspaceRoot, ".sofia", "chat-dedupe"), path.join(destinationRoot, "sofia-agents-chat-dedupe"), "legacy workspace chat deduplication");
  add(path.join(workspaceRoot, ".sofia", "api-usage.json"), path.join(destinationRoot, "sofia-agents-api", "usage.json"), "legacy API usage file");
  add(path.join(workspaceRoot, ".sofia", "skill-lifecycle.json"), path.join(destinationRoot, "sofia-agents-skills", "skill-lifecycle.json"), "legacy skill lifecycle file");
  add(path.join(workspaceRoot, ".sofia", "evolution.json"), path.join(destinationRoot, "sofia-agents-evolution", "evolution.json"), "legacy evolution file");
  add(path.join(workspaceRoot, ".sofia", "security-audit.log"), path.join(destinationRoot, "sofia-agents-security", "security-audit.log"), "legacy security audit file");

  const userMemory = platform === "win32"
    ? path.join(env.APPDATA || path.join(homeDir, "AppData", "Roaming"), "Sofia Agents", "user-memory")
    : platform === "darwin"
      ? path.join(homeDir, "Library", "Application Support", "Sofia Agents", "user-memory")
      : path.join(env.XDG_DATA_HOME && path.isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : path.join(homeDir, ".local", "share"), "sofia-agents", "user-memory");
  add(userMemory, path.join(destinationRoot, "sofia-agents-user-memory"), "legacy user memory");

  if (env.SOFIA_RUN_STORE_DIR) add(path.resolve(env.SOFIA_RUN_STORE_DIR), path.join(destinationRoot, "sofia-agents-api-runs"), "explicit legacy SOFIA_RUN_STORE_DIR");
  if (env.SOFIA_CHAT_DEDUPE_DIR) add(path.resolve(env.SOFIA_CHAT_DEDUPE_DIR), path.join(destinationRoot, "sofia-agents-chat-dedupe"), "explicit legacy SOFIA_CHAT_DEDUPE_DIR");

  return sources.filter(item => !isWithin(destinationRoot, item.source) && !isWithin(item.source, destinationRoot));
}

export async function inspectMigration(plan) {
  const report = [];
  for (const item of plan) {
    let stat;
    try { stat = await fs.lstat(item.source); }
    catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error("Refusing to migrate symbolic link: " + item.source);
    if (!stat.isDirectory() && !stat.isFile()) throw new Error("Unsupported migration source: " + item.source);
    const files = stat.isDirectory()
      ? await collectFiles(item.source)
      : [{ source: item.source, relative: path.basename(item.source), size: stat.size, mode: stat.mode & 0o777 }];
    let bytes = 0;
    for (const file of files) bytes += file.size;
    report.push({ ...item, kind: stat.isDirectory() ? "directory" : "file", files: files.length, bytes, entries: files });
  }
  return report;
}

export async function applyMigration(report) {
  const results = [];
  const conflicts = [];
  for (const item of report) {
    for (const file of item.entries) {
      const destination = item.kind === "file" ? item.target : path.join(item.target, file.relative);
      await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      let sourceData;
      let sourceHandle;
      try {
        sourceHandle = await fs.open(file.source, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
        const sourceStat = await sourceHandle.stat();
        if (!sourceStat.isFile()) throw new Error("Source is no longer a regular file: " + file.source);
        sourceData = await sourceHandle.readFile();
      } catch (error) {
        throw new Error("Could not safely read migration source " + file.source + ": " + error.message);
      } finally {
        await sourceHandle?.close();
      }
      const digest = sha256(sourceData);
      try {
        const destinationStat = await fs.lstat(destination);
        if (!destinationStat.isFile() || destinationStat.isSymbolicLink()) {
          conflicts.push({ source: file.source, destination, status: "conflict" });
          continue;
        }
        const existing = await fs.readFile(destination);
        if (sha256(existing) === digest) {
          results.push({ source: file.source, destination, status: "identical" });
          continue;
        }
        conflicts.push({ source: file.source, destination, status: "conflict" });
        continue;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }

      const temporary = destination + ".sofia-migrate-" + process.pid + "-" + digest.slice(0, 12) + ".tmp";
      try {
        await fs.writeFile(temporary, sourceData, { flag: "wx", mode: file.mode & 0o600 ? file.mode & 0o600 : 0o600 });
        await fs.link(temporary, destination);
        await fs.chmod(destination, file.mode & 0o600 ? file.mode & 0o600 : 0o600).catch(() => undefined);
        results.push({ source: file.source, destination, status: "copied", sha256: digest, bytes: sourceData.length });
      } catch (error) {
        if (error.code === "EEXIST") {
          const existing = await fs.readFile(destination);
          if (sha256(existing) === digest) results.push({ source: file.source, destination, status: "identical" });
          else conflicts.push({ source: file.source, destination, status: "conflict" });
        } else throw error;
      } finally {
        await fs.rm(temporary, { force: true });
      }
    }
  }
  return { results, conflicts };
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const workspaceArg = args.find(value => value.startsWith("--workspace="))?.slice(12);
  const stateArg = args.find(value => value.startsWith("--state-dir="))?.slice(12);
  const workspace = path.resolve(workspaceArg || process.env.SOFIA_WORKSPACE || process.cwd());
  const configuredState = stateArg || process.env.SOFIA_STATE_DIR;
  if (!configuredState) {
    console.error("SOFIA_STATE_DIR is required. Example: SOFIA_STATE_DIR=/data/state node scripts/sofia-migrate-state.mjs");
    process.exitCode = 2;
    return;
  }
  if (!path.isAbsolute(configuredState)) {
    console.error("SOFIA_STATE_DIR must be an absolute path.");
    process.exitCode = 2;
    return;
  }

  const plan = buildMigrationPlan({ workspace, stateDir: configuredState });
  const report = await inspectMigration(plan);
  const summary = report.map(item => ({ source: item.source, target: item.target, label: item.label, files: item.files, bytes: item.bytes }));
  console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", workspace, stateDir: path.resolve(configuredState), sources: summary }, null, 2));
  if (!apply) {
    console.log("Dry run only. Review the inventory, back up both locations, then rerun with --apply.");
    return;
  }
  const result = await applyMigration(report);
  console.log(JSON.stringify({ copied: result.results.filter(x => x.status === "copied").length, identical: result.results.filter(x => x.status === "identical").length, conflicts: result.conflicts }, null, 2));
  if (result.conflicts.length) {
    console.error("Migration stopped with conflicts. Existing destination files were not overwritten; resolve them manually and rerun.");
    process.exitCode = 1;
    return;
  }
  console.log("Migration verified by SHA-256. Legacy source files were retained; no source data was deleted.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
