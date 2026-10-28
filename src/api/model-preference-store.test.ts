import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { FileModelPreferenceStore } from "./model-preference-store.js";

test("file model preferences persist valid profiles and remain scoped by API key identity", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "sofia-model-preferences-"));
  try {
    const first = "a".repeat(32);
    const second = "b".repeat(32);
    const store = new FileModelPreferenceStore(directory);
    assert.equal(store.get(first), undefined);
    store.set(first, "reasoning");
    assert.equal(store.get(first), "reasoning");
    assert.equal(store.get(second), undefined);

    const reopened = new FileModelPreferenceStore(directory);
    assert.equal(reopened.get(first), "reasoning");
    reopened.set(first, "auto");
    assert.equal(store.get(first), "auto");
    assert.throws(() => store.set("../invalid", "fast"), /Invalid model preference owner/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
