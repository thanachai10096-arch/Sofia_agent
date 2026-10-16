import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const lock = JSON.parse(await readFile(path.join(root, "package-lock.json"), "utf8"));
const license = await readFile(path.join(root, "LICENSE"), "utf8");

// Strict allowlist: new or unclassified dependency licenses require an explicit review.
const ALLOWED_DEPENDENCY_LICENSES = new Set(["MIT", "Apache-2.0"]);
const errors = [];
if (pkg.license !== "Apache-2.0") {
  errors.push(`package.json license must be "Apache-2.0" (found: ${String(pkg.license)})`);
}
if (!license.includes("Apache License") || !license.includes("Version 2.0, January 2004")) {
  errors.push("LICENSE does not appear to contain the Apache License 2.0 text");
}
if (!lock || typeof lock !== "object" || !lock.packages || typeof lock.packages !== "object") {
  errors.push("package-lock.json has no package metadata inventory");
} else {
  const packages = Object.entries(lock.packages).filter(([name, metadata]) =>
    name.startsWith("node_modules/") &&
    metadata && typeof metadata === "object" &&
    typeof metadata.version === "string",
  );
  if (packages.length === 0) errors.push("package-lock.json contains no dependency packages");
  for (const [name, metadata] of packages) {
    const declared = typeof metadata.license === "string" ? metadata.license.trim() : "";
    if (!declared) {
      errors.push(`dependency has no single declared license in lockfile: ${name}@${metadata.version}`);
    } else if (!ALLOWED_DEPENDENCY_LICENSES.has(declared)) {
      errors.push(`dependency license requires review: ${name}@${metadata.version} declares ${declared}`);
    }
  }
  if (errors.length === 0) {
    console.log(`Dependency license metadata check passed: ${packages.length} locked packages use MIT or Apache-2.0.`);
  }
}
if (errors.length) {
  for (const error of errors) console.error(`LICENSE CHECK FAILED: ${error}`);
  console.error("This checks declared package metadata only; it does not establish source-code provenance or copyright ownership.");
  process.exitCode = 1;
} else {
  console.log("Project license check passed: package.json declares Apache-2.0 and LICENSE contains Apache 2.0 text.");
  console.log("Note: declared dependency licenses are metadata, not a source-code copyright or provenance verdict.");
}
