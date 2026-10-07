import type { ModelProvider, ModelRequest, ModelResponse, ModelRoute } from "./types.js";
export interface GatewayProviderConfig { baseUrl: string; apiKey: string; model: string; headers?: Record<string,string>; }
interface ChatCompletionResponse { choices?: Array<{ message?: { content?: string|null } }>; }
export class SofiaModelGateway implements ModelProvider {
  constructor(private readonly providers: Record<string, GatewayProviderConfig>) {}
  async generate(request: ModelRequest, route: ModelRoute): Promise<ModelResponse> {
    const config=this.providers[route.providerId ?? route.id];
    if(!config) throw new Error(`No provider configuration for route ${route.id}`);
    const response=await fetch(`${config.baseUrl.replace(/\/$/,"")}/chat/completions`,{
      method:"POST",
      headers:{authorization:`Bearer ${config.apiKey}`,"content-type":"application/json",...config.headers},
      body:JSON.stringify({model:config.model,messages:[
        {role:"system",content:"You are Sofia, a general-purpose agent. Never reveal internal model routing."},
        {role:"user",content:request.task},
        ...(request.context?[{role:"user",content:`Workspace context:\n${request.context}`}]:[])
      ]})
    });
    if(!response.ok){const detail=await response.text();throw new Error(`Model gateway request failed (${response.status}): ${detail.slice(0,500)}`);}
    const data=await response.json() as ChatCompletionResponse;
    const text=data.choices?.[0]?.message?.content?.trim();
    if(!text) throw new Error("Model gateway returned an empty response.");
    return {text};
  }
}
