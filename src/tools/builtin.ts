import type { SofiaTool } from "./types.js";
import { applyEditPatch, createEditPatch } from "../brain/edit-engine.js";

const str = (description: string) => ({ type: "string", description });

const editOperationSchema = {
  type: "object",
  properties: {
    path: str("Workspace-relative file path"),
    expectedContent: str("Exact file content observed when the edit was planned"),
    expectedHash: str("SHA-256 hash of the file content observed when the edit was planned"),
    content: str("Complete replacement file contents"),
  },
  required: ["path", "content"],
  additionalProperties: false,
};

export function createBuiltinTools(): SofiaTool[] {
  return [
    {
      name: "web.search",
      description: "Search the public web and return source-grounded excerpts for research. Requires BRAVE_SEARCH_API_KEY and network access explicitly enabled by the operator.",
      effects: ["network", "read"],
      inputSchema: {
        type: "object",
        properties: {
          query: str("Search query, maximum 600 characters and 75 words"),
          country: str("Two-letter country code for results, for example TH"),
          searchLanguage: str("Search language code, for example th or en"),
          freshness: { type: "string", enum: ["pd", "pw", "pm", "py"] },
          maxResults: { type: "integer" },
        },
        required: ["query"],
        additionalProperties: false,
      },
      async execute(input, { signal }) {
        const apiKey = process.env.BRAVE_SEARCH_API_KEY?.trim();
        if (!apiKey) throw new Error("Web search is not configured: set BRAVE_SEARCH_API_KEY.");
        const query = typeof input.query === "string" ? input.query.trim() : "";
        if (!query || query.length > 600 || query.split(/\s+/).length > 75) {
          throw new Error("Web search query must contain 1–600 characters and at most 75 words.");
        }
        const country = typeof input.country === "string" ? input.country.toUpperCase() : "TH";
        if (!/^[A-Z]{2}$/.test(country)) throw new Error("Search country must be a two-letter country code.");
        const searchLanguage = typeof input.searchLanguage === "string" ? input.searchLanguage : "th";
        if (!/^[a-zA-Z]{2,8}(?:-[a-zA-Z0-9]{2,8})?$/.test(searchLanguage)) {
          throw new Error("Search language must be a valid short language code.");
        }
        const freshness = input.freshness;
        if (freshness !== undefined && !["pd", "pw", "pm", "py"].includes(String(freshness))) {
          throw new Error("Unsupported search freshness filter.");
        }
        const maxResults = input.maxResults === undefined ? 6 : Number(input.maxResults);
        if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 10) {
          throw new Error("maxResults must be an integer from 1 to 10.");
        }

        const url = new URL("https://api.search.brave.com/res/v1/llm/context");
        url.searchParams.set("q", query);
        url.searchParams.set("country", country);
        url.searchParams.set("search_lang", searchLanguage);
        url.searchParams.set("count", String(maxResults));
        url.searchParams.set("maximum_number_of_urls", String(maxResults));
        url.searchParams.set("maximum_number_of_tokens", "4096");
        url.searchParams.set("context_threshold_mode", "balanced");
        url.searchParams.set("safesearch", "moderate");
        url.searchParams.set("enable_source_metadata", "true");
        if (freshness) url.searchParams.set("freshness", String(freshness));

        const response = await fetch(url, {
          method: "GET",
          headers: { accept: "application/json", "x-subscription-token": apiKey },
          signal,
        });
        if (!response.ok) {
          if (response.status === 401 || response.status === 403) {
            throw new Error("Web search authentication failed. Check BRAVE_SEARCH_API_KEY.");
          }
          if (response.status === 429) throw new Error("Web search rate limit reached. Retry later.");
          throw new Error("Web search provider returned HTTP " + response.status + ".");
        }
        const payload: unknown = await response.json();
        const root = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
        const grounding = root.grounding && typeof root.grounding === "object"
          ? root.grounding as Record<string, unknown>
          : {};
        const generic = Array.isArray(grounding.generic) ? grounding.generic : [];
        const results = generic.slice(0, maxResults).flatMap((entry) => {
          if (!entry || typeof entry !== "object") return [];
          const item = entry as Record<string, unknown>;
          const sourceUrl = typeof item.url === "string" ? item.url : "";
          if (!sourceUrl.startsWith("https://") && !sourceUrl.startsWith("http://")) return [];
          const snippets = Array.isArray(item.snippets)
            ? item.snippets.filter((value): value is string => typeof value === "string").slice(0, 4)
            : [];
          return [{
            title: typeof item.title === "string" ? item.title.slice(0, 300) : sourceUrl,
            url: sourceUrl,
            snippets: snippets.map((value) => value.slice(0, 1800)),
          }];
        });
        return { provider: "Brave Search", query, results, resultCount: results.length };
      },
    },
    {
      name: "web.search_news",
      description: "Search current news articles and return titles, publishers, dates, descriptions, and source URLs. Requires BRAVE_SEARCH_API_KEY and network access explicitly enabled by the operator.",
      effects: ["network", "read"],
      inputSchema: {
        type: "object",
        properties: {
          query: str("News search query, maximum 400 characters and 50 words"),
          country: str("Two-letter country code or ALL for worldwide results"),
          searchLanguage: str("Search language code, for example th or en"),
          freshness: { type: "string", enum: ["pd", "pw", "pm", "py"] },
          maxResults: { type: "integer" },
        },
        required: ["query"],
        additionalProperties: false,
      },
      async execute(input, { signal }) {
        const apiKey = process.env.BRAVE_SEARCH_API_KEY?.trim();
        if (!apiKey) throw new Error("News search is not configured: set BRAVE_SEARCH_API_KEY.");
        const query = typeof input.query === "string" ? input.query.trim() : "";
        if (!query || query.length > 400 || query.split(/\s+/).length > 50) {
          throw new Error("News query must contain 1–400 characters and at most 50 words.");
        }
        const country = typeof input.country === "string" ? input.country.toUpperCase() : "TH";
        if (country !== "ALL" && !/^[A-Z]{2}$/.test(country)) throw new Error("News country must be a two-letter code or ALL.");
        const searchLanguage = typeof input.searchLanguage === "string" ? input.searchLanguage : "th";
        if (!/^[a-zA-Z]{2,8}(?:-[a-zA-Z0-9]{2,8})?$/.test(searchLanguage)) {
          throw new Error("News search language must be a valid short language code.");
        }
        const freshness = input.freshness;
        if (freshness !== undefined && !["pd", "pw", "pm", "py"].includes(String(freshness))) {
          throw new Error("Unsupported news freshness filter.");
        }
        const maxResults = input.maxResults === undefined ? 6 : Number(input.maxResults);
        if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 10) {
          throw new Error("maxResults must be an integer from 1 to 10.");
        }
        const url = new URL("https://api.search.brave.com/res/v1/news/search");
        url.searchParams.set("q", query);
        url.searchParams.set("country", country);
        url.searchParams.set("search_lang", searchLanguage);
        url.searchParams.set("count", String(maxResults));
        url.searchParams.set("safesearch", "strict");
        url.searchParams.set("extra_snippets", "true");
        if (freshness) url.searchParams.set("freshness", String(freshness));
        const response = await fetch(url, {
          method: "GET",
          headers: { accept: "application/json", "x-subscription-token": apiKey },
          signal,
        });
        if (!response.ok) {
          if (response.status === 401 || response.status === 403) throw new Error("News search authentication failed. Check BRAVE_SEARCH_API_KEY.");
          if (response.status === 429) throw new Error("News search rate limit reached. Retry later.");
          throw new Error("News search provider returned HTTP " + response.status + ".");
        }
        const payload: unknown = await response.json();
        const root = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
        const rawResults = Array.isArray(root.results) ? root.results : [];
        const results = rawResults.slice(0, maxResults).flatMap((entry) => {
          if (!entry || typeof entry !== "object") return [];
          const item = entry as Record<string, unknown>;
          const sourceUrl = typeof item.url === "string" ? item.url : "";
          if (!sourceUrl.startsWith("https://") && !sourceUrl.startsWith("http://")) return [];
          const profile = item.profile && typeof item.profile === "object"
            ? item.profile as Record<string, unknown>
            : {};
          const extra = Array.isArray(item.extra_snippets)
            ? item.extra_snippets.filter((value): value is string => typeof value === "string").slice(0, 3)
            : [];
          return [{
            title: typeof item.title === "string" ? item.title.slice(0, 300) : sourceUrl,
            url: sourceUrl,
            description: typeof item.description === "string" ? item.description.slice(0, 1600) : "",
            publisher: typeof profile.name === "string" ? profile.name.slice(0, 160) : undefined,
            age: typeof item.age === "string" ? item.age.slice(0, 80) : undefined,
            pageAge: typeof item.page_age === "string" ? item.page_age.slice(0, 80) : undefined,
            breaking: item.breaking === true,
            extraSnippets: extra.map((value) => value.slice(0, 1200)),
          }];
        });
        return { provider: "Brave News Search", query, results, resultCount: results.length };
      },
    },
    {
      name: "workspace.read_file",
      description: "Read a UTF-8 text file inside the current workspace.",
      inputSchema: {
        type: "object",
        properties: { path: str("Workspace-relative file path") },
        required: ["path"],
        additionalProperties: false,
      },
      async execute(input, { runtime }) {
        const path = String(input.path);
        return { path, content: await runtime.readFile(path) };
      },
    },
    {
      name: "workspace.apply_patch",
      description:
        "Apply one or more conflict-checked file edits. Every edit must include the expected file content or its SHA-256 hash, so stale edits are rejected instead of overwriting newer changes.",
      inputSchema: {
        type: "object",
        properties: {
          operations: {
            type: "array",
            items: editOperationSchema,
            minItems: 1,
          },
        },
        required: ["operations"],
        additionalProperties: false,
      },
      async execute(input, { runtime }) {
        if (!Array.isArray(input.operations)) {
          throw new Error("Patch operations must be an array");
        }

        const operations = input.operations.map((value) => {
          if (!value || typeof value !== "object") {
            throw new Error("Invalid patch operation");
          }

          const item = value as Record<string, unknown>;
          if (typeof item.path !== "string" || typeof item.content !== "string") {
            throw new Error("Patch operation requires path and content");
          }

          return {
            path: item.path,
            content: item.content,
            ...(typeof item.expectedContent === "string"
              ? { expectedContent: item.expectedContent }
              : {}),
            ...(typeof item.expectedHash === "string"
              ? { expectedHash: item.expectedHash }
              : {}),
          };
        });

        const patch = createEditPatch(operations);
        const results = await applyEditPatch(runtime, patch);

        return {
          patchId: patch.id,
          results,
          changedFiles: results.filter((result) => result.changed).map((result) => result.path),
        };
      },
    },
    {
      name: "workspace.write_file",
      description: "Create or replace a UTF-8 text file inside the current workspace.",
      inputSchema: {
        type: "object",
        properties: {
          path: str("Workspace-relative file path"),
          content: str("Complete file contents"),
        },
        required: ["path", "content"],
        additionalProperties: false,
      },
      async execute(input, { runtime }) {
        const path = String(input.path);
        await runtime.writeFile(path, String(input.content));
        return { ok: true, path };
      },
    },
    {
      name: "workspace.search",
      description: "Search workspace files for a text query.",
      inputSchema: {
        type: "object",
        properties: { query: str("Text to search for"), path: str("Optional workspace-relative path") },
        required: ["query"],
        additionalProperties: false,
      },
      async execute(input, { runtime }) {
        return runtime.search(String(input.query), typeof input.path === "string" ? input.path : undefined);
      },
    },
    {
      name: "workspace.list_files",
      description: "List entries in a workspace directory.",
      inputSchema: {
        type: "object",
        properties: { path: str("Workspace-relative directory path") },
        additionalProperties: false,
      },
      async execute(input, { runtime }) {
        const path = String(input.path ?? ".");
        return { path, entries: await runtime.listFiles(path) };
      },
    },
    {
      name: "project.verify",
      description: "Run a bounded project verification command such as typecheck, test, or build.",
      inputSchema: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["typecheck", "test", "build"] },
        },
        required: ["kind"],
        additionalProperties: false,
      },
      async execute(input, { runtime }) {
        const kind = String(input.kind);
        const commands: Record<string, [string, string[]]> = {
          typecheck: ["npm", ["run", "typecheck"]],
          test: ["npm", ["test"]],
          build: ["npm", ["run", "build"]],
        };
        const command = commands[kind];
        if (!command) throw new Error("Unsupported verification kind: " + kind);
        const [executable, args] = command;
        const result = await runtime.run(executable, args);
        return { kind, command: executable, args, ...result, passed: result.code === 0 };
      },
    },
    {
      name: "git.diff",
      description: "Inspect the current git diff without changing the workspace.",
      inputSchema: {
        type: "object",
        properties: { args: { type: "array", items: { type: "string" } } },
        additionalProperties: false,
      },
      async execute(input, { runtime }) {
        const args = Array.isArray(input.args) ? input.args.map(String) : [];
        return runtime.git(["diff", ...args]);
      },
    },
    {
      name: "git.run",
      description: "Run a git command in the workspace.",
      inputSchema: {
        type: "object",
        properties: { args: { type: "array", items: { type: "string" } } },
        required: ["args"],
        additionalProperties: false,
      },
      async execute(input, { runtime }) {
        const args = Array.isArray(input.args) ? input.args.map(String) : [];
        return runtime.git(args);
      },
    },
    {
      name: "terminal.run",
      description:
        "Run an executable with arguments in the workspace. Only available when shell execution is explicitly enabled.",
      inputSchema: {
        type: "object",
        properties: {
          command: str("Executable name"),
          args: { type: "array", items: { type: "string" } },
        },
        required: ["command"],
        additionalProperties: false,
      },
      async execute(input, { runtime }) {
        const command = String(input.command);
        const args = Array.isArray(input.args) ? input.args.map(String) : [];
        return runtime.run(command, args);
      },
    },
  ];
}
