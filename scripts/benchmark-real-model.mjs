import { mkdtemp, mkdir, copyFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { SofiaAgent, createSofiaAgentDependencies } from "../dist/src/index.js";

if (!process.env.AI_GATEWAY_API_KEY) {
  console.error("Set AI_GATEWAY_API_KEY and the required SOFIA_*_MODEL variables before running the real-model benchmark.");
  process.exit(2);
}

const workspace = await mkdtemp(path.join(os.tmpdir(), "sofia-real-model-bench-"));
const files = [
  "README.md",
  "package.json",
  "src/security/policy.ts",
  "src/security/guard.ts",
  "src/api/server.ts",
];
try {
  for (const relative of files) {
    const source = path.resolve(process.cwd(), relative);
    const target = path.join(workspace, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(source, target);
  }

  const agent = new SofiaAgent(createSofiaAgentDependencies(workspace));
  const cases = [
    {
      id: "repo-overview",
      task: "Read README.md and package.json. Summarize the project's purpose and the main validation scripts. Do not edit files or run commands.",
    },
    {
      id: "security-controls",
      task: "Read src/security/policy.ts and src/security/guard.ts. Identify three concrete security controls and cite the source file names. Do not edit files or run commands.",
    },
  ];
  const results = [];
  for (const item of cases) {
    const started = performance.now();
    try {
      const result = await agent.run({
        task: item.task,
        context: "Benchmark mode: read-only task. Do not modify files, run shell commands, or access the network.",
        maxSteps: 6,
      });
      results.push({
        id: item.id,
        success: result.events.some((event) => event.type === "run.completed"),
        elapsedMs: Math.round(performance.now() - started),
        steps: result.steps,
        toolStarts: result.events.filter((event) => event.type === "tool.started").length,
        toolFailures: result.events.filter((event) => event.type === "tool.failed").length,
        outputChars: result.output.length,
      });
    } catch (error) {
      results.push({
        id: item.id,
        success: false,
        elapsedMs: Math.round(performance.now() - started),
        errorClass: error instanceof Error ? error.name : "UnknownError",
      });
    }
  }
  const report = {
    benchmarkVersion: 1,
    createdAt: new Date().toISOString(),
    note: "Real provider calls may incur cost. This report intentionally excludes prompts, model output, credentials, and provider error messages.",
    cases: results,
    summary: {
      total: results.length,
      succeeded: results.filter((result) => result.success).length,
      successRate: results.length ? results.filter((result) => result.success).length / results.length : 0,
      meanElapsedMs: results.length ? Math.round(results.reduce((sum, result) => sum + result.elapsedMs, 0) / results.length) : 0,
    },
  };
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  if (results.some((result) => !result.success)) process.exitCode = 1;
} finally {
  await rm(workspace, { recursive: true, force: true });
}
