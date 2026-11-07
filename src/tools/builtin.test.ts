import assert from "node:assert/strict";
import test from "node:test";
import { createBuiltinTools } from "./builtin.js";

const tools = createBuiltinTools();
const searchTool = tools.find((tool) => tool.name === "web.search")!;
const newsTool = tools.find((tool) => tool.name === "web.search_news")!;

test("web search calls the fixed Brave LLM context endpoint and returns bounded source excerpts", async () => {
  const oldKey = process.env.BRAVE_SEARCH_API_KEY;
  const oldFetch = globalThis.fetch;
  process.env.BRAVE_SEARCH_API_KEY = "brave-test-key";
  let requestedUrl: URL | undefined;
  let requestedHeaders: HeadersInit | undefined;
  globalThis.fetch = async (input, init) => {
    requestedUrl = new URL(String(input));
    requestedHeaders = init?.headers;
    return new Response(JSON.stringify({
      grounding: {
        generic: [
          { title: "Source title", url: "https://example.com/article", snippets: ["First excerpt", "Second excerpt"] },
          { title: "Invalid source", url: "javascript:alert(1)", snippets: ["must be dropped"] },
          { title: "Plaintext source", url: "http://insecure.example/article", snippets: ["must be dropped"] },
          { title: "Credential URL", url: "https://user:pass@example.com/article", snippets: ["must be dropped"] },
        ],
      },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  try {
    const result = await searchTool.execute({
      query: "ข่าว AI ล่าสุด",
      country: "TH",
      searchLanguage: "th",
      freshness: "pw",
      maxResults: 4,
    }, { runtime: {} as never, signal: new AbortController().signal }) as {
      provider: string; query: string; resultCount: number;
      results: Array<{ title: string; url: string; snippets: string[] }>;
    };
    assert.equal(requestedUrl?.origin, "https://api.search.brave.com");
    assert.equal(requestedUrl?.pathname, "/res/v1/llm/context");
    assert.equal(requestedUrl?.searchParams.get("q"), "ข่าว AI ล่าสุด");
    assert.equal(requestedUrl?.searchParams.get("country"), "TH");
    assert.equal(requestedUrl?.searchParams.get("search_lang"), "th");
    assert.equal(requestedUrl?.searchParams.get("freshness"), "pw");
    assert.equal(new Headers(requestedHeaders).get("x-subscription-token"), "brave-test-key");
    assert.equal(result.provider, "Brave Search");
    assert.equal(result.resultCount, 1);
    assert.equal(result.results[0]?.url, "https://example.com/article");
    assert.deepEqual(result.results[0]?.snippets, ["First excerpt", "Second excerpt"]);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldKey === undefined) delete process.env.BRAVE_SEARCH_API_KEY;
    else process.env.BRAVE_SEARCH_API_KEY = oldKey;
  }
});

test("web search fails clearly when credentials are missing", async () => {
  const oldKey = process.env.BRAVE_SEARCH_API_KEY;
  delete process.env.BRAVE_SEARCH_API_KEY;
  try {
    await assert.rejects(
      searchTool.execute({ query: "hello" }, { runtime: {} as never }),
      /set BRAVE_SEARCH_API_KEY/,
    );
  } finally {
    if (oldKey === undefined) delete process.env.BRAVE_SEARCH_API_KEY;
    else process.env.BRAVE_SEARCH_API_KEY = oldKey;
  }
});

test("web search validates query limits and does not call the provider for invalid input", async () => {
  const oldKey = process.env.BRAVE_SEARCH_API_KEY;
  const oldFetch = globalThis.fetch;
  process.env.BRAVE_SEARCH_API_KEY = "brave-test-key";
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response("{}", { status: 200 });
  };
  try {
    await assert.rejects(
      searchTool.execute({ query: "x".repeat(601) }, { runtime: {} as never }),
      /600 characters/,
    );
    await assert.rejects(
      searchTool.execute({ query: "valid", maxResults: 11 }, { runtime: {} as never }),
      /1 to 10/,
    );
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldKey === undefined) delete process.env.BRAVE_SEARCH_API_KEY;
    else process.env.BRAVE_SEARCH_API_KEY = oldKey;
  }
});

test("news search uses the dedicated Brave news endpoint and normalizes publisher metadata", async () => {
  const oldKey = process.env.BRAVE_SEARCH_API_KEY;
  const oldFetch = globalThis.fetch;
  process.env.BRAVE_SEARCH_API_KEY = "brave-test-key";
  let requestedUrl: URL | undefined;
  globalThis.fetch = async (input) => {
    requestedUrl = new URL(String(input));
    return new Response(JSON.stringify({
      results: [
        { title: "News title", url: "https://news.example/story", description: "News summary", age: "2 hours ago", breaking: true, profile: { name: "Example News" }, extra_snippets: ["More context"] },
        { title: "Invalid", url: "file:///etc/passwd" },
      ],
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const result = await newsTool.execute({
      query: "ข่าวเทคโนโลยี",
      country: "TH",
      searchLanguage: "th",
      freshness: "pd",
      maxResults: 3,
    }, { runtime: {} as never, signal: new AbortController().signal }) as {
      resultCount: number; results: Array<{ publisher?: string; breaking: boolean; url: string }>;
    };
    assert.equal(requestedUrl?.pathname, "/res/v1/news/search");
    assert.equal(requestedUrl?.searchParams.get("freshness"), "pd");
    assert.equal(requestedUrl?.searchParams.get("safesearch"), "strict");
    assert.equal(result.resultCount, 1);
    assert.equal(result.results[0]?.publisher, "Example News");
    assert.equal(result.results[0]?.breaking, true);
    assert.equal(result.results[0]?.url, "https://news.example/story");
  } finally {
    globalThis.fetch = oldFetch;
    if (oldKey === undefined) delete process.env.BRAVE_SEARCH_API_KEY;
    else process.env.BRAVE_SEARCH_API_KEY = oldKey;
  }
});
