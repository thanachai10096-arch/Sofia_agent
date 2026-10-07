import { ModelRouter } from "./router.js";
import { SofiaModelGateway } from "./gateway.js";
import { loadModelConfigFromEnv } from "./config.js";
import type { AgentDependencies } from "../agent/types.js";
import { Reviewer } from "../review/reviewer.js";
export function createSofiaAgentDependencies(): AgentDependencies {
  const config=loadModelConfigFromEnv();
  return {router:new ModelRouter(config.routes),provider:new SofiaModelGateway(config.providers),reviewer:new Reviewer()};
}
