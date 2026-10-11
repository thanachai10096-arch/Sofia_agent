import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const license = await readFile(path.join(root, "LICENSE"), "utf8");

const errors = [];
if (pkg.license !== "Apache-2.0") {
  errors.push(`package.json license must be "Apache-2.0" (found: ${String(pkg.license)})`);
}
if (!license.includes("Apache License") || !license.includes("Version 2.0, January 2004")) {
  errors.push("LICENSE does not appear to contain the Apache License 2.0 text");
}
if (errors.length) {
  for (const error of errors) console.error(`LICENSE CHECK FAILED: ${error}`);
  process.exitCode = 1;
} else {
  console.log("License check passed: package.json declares Apache-2.0 and LICENSE contains Apache 2.0 text.");
}
