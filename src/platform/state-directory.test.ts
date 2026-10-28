import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { sofiaStateDirectory } from "./state-directory.js";

test("state directory defaults to persistent storage under ~/.sofia", () => {
  const previous = process.env.SOFIA_STATE_DIR;
  delete process.env.SOFIA_STATE_DIR;
  try {
    assert.equal(sofiaStateDirectory("jobs"), path.join(os.homedir(), ".sofia", "sofia-agents-jobs"));
  } finally {
    if (previous === undefined) delete process.env.SOFIA_STATE_DIR;
    else process.env.SOFIA_STATE_DIR = previous;
  }
});

test("state directory uses an explicitly configured absolute persistent root", () => {
  const previous = process.env.SOFIA_STATE_DIR;
  process.env.SOFIA_STATE_DIR = path.join(os.tmpdir(), "sofia-persistent-root-test");
  try {
    assert.equal(
      sofiaStateDirectory("runs"),
      path.join(os.tmpdir(), "sofia-persistent-root-test", "sofia-agents-runs"),
    );
  } finally {
    if (previous === undefined) delete process.env.SOFIA_STATE_DIR;
    else process.env.SOFIA_STATE_DIR = previous;
  }
});

test("state directory rejects relative roots and unsafe store names", () => {
  const previous = process.env.SOFIA_STATE_DIR;
  try {
    process.env.SOFIA_STATE_DIR = "relative/path";
    assert.throws(() => sofiaStateDirectory("jobs"), /absolute path/i);
    process.env.SOFIA_STATE_DIR = "";
    assert.throws(() => sofiaStateDirectory("../jobs"), /store names/i);
  } finally {
    if (previous === undefined) delete process.env.SOFIA_STATE_DIR;
    else process.env.SOFIA_STATE_DIR = previous;
  }
});
