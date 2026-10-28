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


/**
 * Conservative single-pass routing for ordinary conversation. This path is only
 * selected for general-language requests without action/tool intent; callers can
 * force Brain with useBrain=true. Coding, research, analysis, vision and requests
 * that imply external effects stay on the full Brain path.
 */
export function shouldUseSinglePassConversation(task: string): boolean {
  const value = task.trim().toLowerCase();
  if (!value || value.length > 1_200) return false;
  if (classifyTask(value) !== "general") return false;
  const actionIntent = /\\b(create|build|make|write|edit|change|fix|debug|run|execute|install|deploy|delete|remove|search|research|investigate|browse|open|read file|modify|implement|refactor|test|check repo|inspect|compare|analy[sz]e|plan|schedule|send|post|upload|download|commit|push|pull request|book|buy)\\b/i;
  const thaiActionIntent = /(ทำให้|ทำมา|สร้าง|แก้ไข|แก้โค้ด|เขียนโค้ด|รัน|ติดตั้ง|ดีพลอย|ค้นหา|ตรวจสอบ|วิเคราะห์|เปรียบเทียบ|วางแผน|ส่งข้อความ|ลบไฟล์|แก้ระบบ|พัฒนา|ต่อยอด|เปิดไฟล์|อ่านไฟล์)/;
  return !actionIntent.test(value) && !thaiActionIntent.test(value);
}
