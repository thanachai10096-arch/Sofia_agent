import type { TaskKind } from "../models/types.js";

export function classifyTask(task: string): TaskKind {
  const value = task.toLowerCase();

  if (/\b(fix|bug|error|typescript|javascript|react|code|implement|refactor|github|pull request|test)\b/.test(value)) {
    return /\b(fix|bug|error|debug|failing|broken)\b/.test(value) ? "debugging" : "coding";
  }
  if (/\b(image|screenshot|visual|photo|design review)\b/.test(value)) return "vision";
  if (/\b(research|compare|latest|investigate|sources|market)\b/.test(value)) return "research";
  if (/\b(analy[sz]e|analysis|architecture|evaluate|tradeoff)\b/.test(value)) return "analysis";
  return "general";
}
