import { ModelRouter } from "./router.js";
import { SofiaModelGateway } from "./gateway.js";
import { loadModelConfigFromEnv } from "./config.js";
import type { AgentDependencies } from "../agent/types.js";
import { Reviewer } from "../review/reviewer.js";
import { createNodeWorkspaceRuntime } from "../platform/local-runtime.js";
import { createToolRegistry } from "../tools/registry.js";
import { loadExecutionPolicyFromEnv } from "../security/policy.js";
import { createBuiltinTools } from "../tools/builtin.js";
export function createSofiaAgentDependencies(workspace=process.cwd()):AgentDependencies{
 const config=loadModelConfigFromEnv();
 return {router:new ModelRouter(config.routes),provider:new SofiaModelGateway(config.providers),reviewer:new Reviewer(),runtime:createNodeWorkspaceRuntime(workspace),tools:createToolRegistry(createBuiltinTools()),policy:loadExecutionPolicyFromEnv()};
}