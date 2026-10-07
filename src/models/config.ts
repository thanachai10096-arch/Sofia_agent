import type { ModelRoute } from "./types.js";
export interface SofiaModelConfig { routes: ModelRoute[]; providers: Record<string,{baseUrl:string;apiKey:string;model:string}>; }
function numberEnv(name:string,fallback:number){const value=Number(process.env[name]);return Number.isFinite(value)?value:fallback;}
export function loadModelConfigFromEnv(): SofiaModelConfig {
  const apiKey=process.env.SOFIA_AI_GATEWAY_API_KEY??process.env.AI_GATEWAY_API_KEY??"";
  const baseUrl=process.env.SOFIA_AI_GATEWAY_URL??"https://ai-gateway.vercel.sh/v1";
  if(!apiKey) throw new Error("SOFIA_AI_GATEWAY_API_KEY is required.");
  const definitions=[["fast",["fast"],1,1,5],["coding",["coding","tool-use","reasoning"],2,2,8],["reasoning",["reasoning","long-context"],3,3,9],["vision",["vision","reasoning"],3,3,8]] as const;
  const routes:ModelRoute[]=[]; const providers:SofiaModelConfig["providers"]={};
  for(const [id,capabilities,cost,latency,quality] of definitions){
    const model=process.env[`SOFIA_${id.toUpperCase()}_MODEL`]; if(!model) continue;
    routes.push({id,providerId:id,capabilities,costWeight:numberEnv(`SOFIA_${id.toUpperCase()}_COST`,cost),latencyWeight:numberEnv(`SOFIA_${id.toUpperCase()}_LATENCY`,latency),qualityWeight:numberEnv(`SOFIA_${id.toUpperCase()}_QUALITY`,quality),healthy:true});
    providers[id]={baseUrl,apiKey,model};
  }
  if(!routes.length) throw new Error("Configure at least one SOFIA_*_MODEL environment variable.");
  return {routes,providers};
}
