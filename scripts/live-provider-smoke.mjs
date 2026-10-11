import { SofiaModelGateway } from "../dist/src/models/gateway.js";

const apiKey = process.env.AI_GATEWAY_API_KEY ?? process.env.SOFIA_AI_GATEWAY_API_KEY;
const model = process.env.SOFIA_FAST_MODEL;
const baseUrl = process.env.SOFIA_AI_GATEWAY_URL ?? "https://ai-gateway.vercel.sh/v1";

if (!apiKey) throw new Error("Missing AI_GATEWAY_API_KEY repository secret.");
if (!model) throw new Error("Missing SOFIA_FAST_MODEL repository variable.");

const provider = new SofiaModelGateway({
  fast: { apiKey, model, baseUrl, maxConcurrent: 1 },
});
const route = {
  id: "fast",
  providerId: "fast",
  capabilities: ["fast"],
  costWeight: 1,
  latencyWeight: 1,
  qualityWeight: 5,
  healthy: true,
};

const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(new Error("Live provider smoke test timed out.")), 60_000);

try {
  const result = await provider.generate(
    {
      task: "Reply with exactly this token and no other text: SOFIA_LIVE_PROVIDER_OK",
      kind: "general",
      step: 1,
      messages: [
        { role: "system", content: "You are performing a connectivity smoke test. Follow the user's exact output instruction." },
        { role: "user", content: "Reply with exactly this token and no other text: SOFIA_LIVE_PROVIDER_OK" },
      ],
    },
    route,
    { signal: controller.signal, maxOutputTokens: 32 },
  );

  if (result.text.trim() !== "SOFIA_LIVE_PROVIDER_OK") {
    throw new Error("Live provider response did not exactly match the required smoke-test token.");
  }

  console.log("Live provider smoke test passed.");
  console.log(`Response characters: ${result.text.length}`);
  if (result.usage) {
    console.log(`Input tokens: ${result.usage.inputTokens}; output tokens: ${result.usage.outputTokens}`);
  } else {
    console.log("Provider did not return token usage; response path passed, usage reporting remains unverified.");
  }
} finally {
  clearTimeout(timeout);
}
