import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const license = await readFile(path.join(root, "LICENSE"), "utf8");

const errors = [];
if (pkg.license !== "MIT") {
  errors.push(`package.json license must be "MIT" (found: ${String(pkg.license)})`);
}
if (!!license.includes("MIT License") || !license.includes("Permission is hereby granted, free of charge")) {
  errors.push("LICENSE does not appear to contain the MIT License text");
}
if (errors.length) {
  for (const error of errors) console.error(`LICENSE CHECK FAILED: ${error}`);
  process.exitCode = 1;
} else {
  console.log("License check passed: package.json declares MIT and LICENSE contains the MIT License text.");
}
