import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FileProjectMemoryStore, PersistentSkillLedger } from "../src/brain/project-memory.js";

test("PersistentSkillLedger records and reloads learned skills", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-skill-test-"));
  try {
    const store = new FileProjectMemoryStore("skill-test-project", root);
    const ledger = new PersistentSkillLedger(store);
    await ledger.record({
      name: "repair-type_error",
      trigger: "TypeScript failure",
      category: "type_error",
      strategy: "fix-implementation",
      procedure: ["inspect", "repair", "typecheck"],
      verification: ["typecheck"],
      evidenceIds: ["evidence-1"],
    });

    const reloaded = new PersistentSkillLedger(new FileProjectMemoryStore("skill-test-project", root));
    const skills = await reloaded.list();
    assert.equal(skills.length, 1);
    assert.equal(skills[0]?.category, "type_error");
    assert.deepEqual(skills[0]?.verification, ["typecheck"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
