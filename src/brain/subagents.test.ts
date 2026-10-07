import { describe, expect, it } from "vitest";
import { createSubagentRuntime, roleForTask } from "./subagents.js";

describe("subagent routing", () => {
  it("routes coding failures to debugger", () => {
    expect(roleForTask("fix the broken TypeScript build", "type_error")).toBe("debugger");
  });

  it("routes security work internally", () => {
    expect(roleForTask("review authentication and token handling")).toBe("security");
  });

  it("routes verification work to tester", () => {
    expect(roleForTask("verify the regression tests")).toBe("tester");
  });
});

describe("subagent runtime", () => {
  it("executes a bounded internal role without exposing model selection", async () => {
    const runtime = createSubagentRuntime({
      async prepare() {
        return {
          inputTokens: 10,
          async invoke() {
            return {
              value: { finding: "inspect package boundaries" },
              usage: { inputTokens: 10, outputTokens: 20 },
            };
          },
        };
      },
    });

    const result = await runtime.run({
      role: "explorer",
      task: "inspect this project",
      signal: new AbortController().signal,
    });

    expect(result.role).toBe("explorer");
    expect(result.output).toEqual({ finding: "inspect package boundaries" });
  });
});
