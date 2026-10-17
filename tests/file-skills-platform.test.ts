import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { FileSkillsPlatform } from "../src/skills/file-platform.js";
import type { SkillPackage } from "../src/skills/platform.js";

function fixture(id = "test-skill"): SkillPackage {
  return {
    source: "custom",
    version: "1.0.0",
    publisher: "tests",
    skill: {
      id,
      name: "Test skill",
      description: "A fixture skill",
      triggers: ["test"],
      categories: ["runtime_error"],
      strategy: "inspect-evidence",
      procedure: ["inspect evidence", "verify outcome"],
      verification: ["test"],
    },
  };
}
function withTempDir(run: (directory: string) => void): void {
  const directory = mkdtempSync(path.join(os.tmpdir(), "sofia-skills-"));
  try { run(directory); } finally { rmSync(directory, { recursive: true, force: true }); }
}

test("FileSkillsPlatform persists and reloads registered skills", () => {
  withTempDir((directory) => {
    const file = path.join(directory, "state", "skills.json");
    const first = new FileSkillsPlatform(file);
    first.register(fixture());
    const second = new FileSkillsPlatform(file);
    assert.equal(second.get("test-skill")?.skill.name, "Test skill");
    assert.equal(second.list("custom").length, 1);
  });
});

test("FileSkillsPlatform returns defensive copies", () => {
  withTempDir((directory) => {
    const store = new FileSkillsPlatform(path.join(directory, "skills.json"));
    store.register(fixture());
    const returned = store.get("test-skill")!;
    (returned.skill.procedure as string[]).push("mutated");
    assert.deepEqual(store.get("test-skill")?.skill.procedure, ["inspect evidence", "verify outcome"]);
  });
});

test("FileSkillsPlatform removes a skill durably", () => {
  withTempDir((directory) => {
    const file = path.join(directory, "skills.json");
    const store = new FileSkillsPlatform(file);
    store.register(fixture());
    assert.equal(store.remove("test-skill"), true);
    assert.equal(new FileSkillsPlatform(file).get("test-skill"), undefined);
    assert.equal(store.remove("missing"), false);
  });
});

test("FileSkillsPlatform fails closed on corrupt or unsupported data", () => {
  withTempDir((directory) => {
    const file = path.join(directory, "skills.json");
    writeFileSync(file, JSON.stringify({ schemaVersion: 999, skills: [] }));
    assert.throws(() => new FileSkillsPlatform(file), /corrupt skills store format/);
  });
});

test("FileSkillsPlatform does not overwrite an invalid registration", () => {
  withTempDir((directory) => {
    const file = path.join(directory, "skills.json");
    const store = new FileSkillsPlatform(file);
    store.register(fixture());
    const before = readFileSync(file, "utf8");
    assert.throws(() => store.register({ ...fixture(), version: "" }), /Invalid skill version/);
    assert.equal(readFileSync(file, "utf8"), before);
  });
});
