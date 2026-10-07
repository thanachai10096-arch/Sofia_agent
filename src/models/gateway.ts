import type { ChatMessage, ModelProvider, ModelRequest, ModelResponse, ModelRoute, ToolDefinition } from "./types.js";
export interface GatewayProviderConfig { baseUrl:string; apiKey:string; model:string; headers?:Record<string,string>; }
interface ChatResponse { choices?:Array<{message?:{content?:string|null;tool_calls?:Array<{id?:string;function?:{name?:string;arguments?:string}}>}}>; }
export class SofiaModelGateway implements ModelProvider {
 constructor(private readonly providers:Record<string,GatewayProviderConfig>){}
 async generate(request:ModelRequest,route:ModelRoute):Promise<ModelResponse>{
  const config=this.providers[route.providerId??route.id]; if(!config) throw new Error(`No provider configuration for route ${route.id}`);
  const messages:ChatMessage[]=request.messages?.length?request.messages:[
   {role:"system",content:"You are Sofia, a general-purpose software agent. Use available tools when they help accomplish the task. Never reveal internal model routing."},
   {role:"user",content:request.task},
   ...(request.context?[{role:"user",content:`Workspace context:\n${request.context}`}]:[])
  ];
  const tools=request.tools?.length?request.tools:undefined;
  const response=await fetch(`${config.baseUrl.replace(/\/$/,"")}/chat/completions`,{
   method:"POST",headers:{authorization:`Bearer ${config.apiKey}`,"content-type":"application/json",...config.headers},
   body:JSON.stringify({model:config.model,messages,...(tools?{tools,tool_choice:"auto"}:{})})
  });
  if(!response.ok){const detail=await response.text();throw new Error(`Model gateway request failed (${response.status}): ${detail.slice(0,500)}`);}
  const data=await response.json() as ChatResponse; const message=data.choices?.[0]?.message;
  if(!message) throw new Error("Model gateway returned no message.");
  const calls=(message.tool_calls??[]).map((call,i)=>({id:call.id??`call-${request.step}-${i}`,name:call.function?.name??"",input:JSON.parse(call.function?.arguments??"{}") as Record<string,unknown>}));
  const text=message.content?.trim()??"";
  if(!text&&!calls.length) throw new Error("Model gateway returned an empty response.");
  return {text,toolCalls:calls.length?calls:undefined,assistantMessage:{role:"assistant",content:text,toolCalls:calls.map(c=>({id:c.id,name:c.name,arguments:JSON.stringify(c.input)}))}};
 }
}