const MODEL_VALUES = new Set(["auto", "fast", "coding", "reasoning", "vision"]);
const $ = (id) => document.getElementById(id);
const state = { sessionId: crypto.randomUUID(), history: [], busy: false, panel: "chat" };
const historyKey = "sofia-chat-history-v1";
const sessionKey = "sofia-chat-session-v1";
const toast = (message, bad = false) => {
  const el = $("toast"); el.textContent = message; el.classList.remove("hidden", "bad"); if (bad) el.classList.add("bad");
  window.clearTimeout(toast.timer); toast.timer = window.setTimeout(() => el.classList.add("hidden"), 3600);
};
async function api(path, options = {}) {
  const response = await fetch("/bridge" + path, { ...options, headers: { "content-type": "application/json", ...(options.headers || {}) } });
  let data = {}; try { data = await response.json(); } catch {}
  if (!response.ok) throw new Error(data.message || data.error || ("Request failed (" + response.status + ")"));
  return data;
}
function saveHistory() {
  try { localStorage.setItem(historyKey, JSON.stringify(state.history.slice(-80))); localStorage.setItem(sessionKey, state.sessionId); } catch {}
}
function renderHistory() {
  const root = $("messages"); root.replaceChildren();
  if (!state.history.length) {
    const welcome = document.createElement("div"); welcome.className = "welcome";
    const icon = document.createElement("div"); icon.className = "welcome-icon"; icon.textContent = "✳";
    const eyebrow = document.createElement("p"); eyebrow.className = "eyebrow"; eyebrow.textContent = "YOUR AGENT, NOT JUST A CHATBOT";
    const heading = document.createElement("h2"); heading.textContent = "What are we working on?";
    const desc = document.createElement("p"); desc.textContent = "Talk naturally. Sofia can plan, use its tools, verify work, and remember details you explicitly save.";
    const suggestions = document.createElement("div"); suggestions.className = "suggestions";
    for (const prompt of ["Review my project and tell me the highest-priority gaps.", "Help me plan and implement the next step.", "Explain what you can do in this workspace."]) {
      const button = document.createElement("button"); button.textContent = prompt.length > 34 ? prompt.slice(0, 31) + "…" : prompt; button.title = prompt;
      button.addEventListener("click", () => { $("prompt").value = prompt; $("prompt").focus(); }); suggestions.append(button);
    }
    welcome.append(icon, eyebrow, heading, desc, suggestions); root.append(welcome); return;
  }
  for (const item of state.history) {
    const bubble = document.createElement("article"); bubble.className = "bubble " + (item.role === "user" ? "user" : "assistant") + (item.error ? " error" : "");
    const content = document.createElement("div"); content.textContent = item.content; bubble.append(content);
    if (item.meta) { const meta = document.createElement("div"); meta.className = "meta"; meta.textContent = item.meta; bubble.append(meta); }
    root.append(bubble);
  }
  root.scrollTop = root.scrollHeight;
}
function setBusy(value) { state.busy = value; $("send").disabled = value; $("send").querySelector("span").textContent = value ? "Working…" : "Send"; }
async function loadPreference() {
  try { const result = await api("/model"); $("model-select").value = result.modelSelection; $("model-source").textContent = result.source === "saved" ? "Saved for this API key" : "Sofia default"; }
  catch (error) { $("model-source").textContent = "Preference unavailable"; toast("Model setting: " + error.message, true); }
}
$("model-select").addEventListener("change", async () => {
  const selection = $("model-select").value;
  if (!MODEL_VALUES.has(selection)) return;
  try { const result = await api("/model", { method: "PUT", body: JSON.stringify({ modelSelection: selection }) }); $("model-source").textContent = result.source === "saved" ? "Saved for this API key" : "Sofia default"; toast("Default model saved: " + selection); }
  catch (error) { toast("Could not save model: " + error.message, true); await loadPreference(); }
});
function explicitMemoryRequest(task) {
  const patterns = [
    { regex: /^จำไว้ว่าฉันชอบ\s*(.+)$/u, kind: "preference" },
    { regex: /^เป้าหมายของฉันคือ\s*(.+)$/u, kind: "goal" },
    { regex: /^จำไว้ว่า\s*(.+)$/u, kind: "fact" },
    { regex: /^remember\s+(?:that\s+)?I\s+prefer\s+(.+)$/i, kind: "preference" },
    { regex: /^remember\s+(?:that\s+)?my\s+goal\s+is\s+(.+)$/i, kind: "goal" },
    { regex: /^remember\s+(?:that\s+)?(.+)$/i, kind: "fact" },
  ];
  for (const pattern of patterns) {
    const match = task.match(pattern.regex);
    const value = match?.[1]?.trim().replace(/[.!。\s]+$/u, "");
    if (value && value.length >= 3 && value.length <= 1200) return { kind: pattern.kind, content: value };
  }
  return undefined;
}
async function submitMessage(text) {
  const task = text.trim(); if (!task || state.busy) return;
  state.history.push({ role: "user", content: task }); saveHistory(); renderHistory(); $("prompt").value = ""; setBusy(true);
  const placeholder = { role: "assistant", content: "Sofia is working on it…", meta: "Starting run" }; state.history.push(placeholder); renderHistory();
  try {
    const memoryRequest = explicitMemoryRequest(task);
    if (memoryRequest) {
      await api("/memory", { method: "POST", body: JSON.stringify(memoryRequest) });
      placeholder.content = "จำไว้แล้ว — Sofia จะใช้ข้อมูลนี้เป็นความทรงจำอ้างอิงเมื่อเกี่ยวข้อง";
      placeholder.meta = "Saved to your Sofia memory";
      saveHistory(); renderHistory(); return;
    }
    const prior = state.history.slice(-10, -2).map((m) => (m.role === "user" ? "User: " : "Sofia: ") + m.content).join("\n");
    const started = await api("/runs", { method: "POST", body: JSON.stringify({ task, async: true, sessionId: state.sessionId, modelSelection: $("model-select").value, ...(prior ? { context: "Recent conversation (reference only):\n" + prior.slice(-6000) } : {}) }) });
    if (!started.id) throw new Error("Sofia did not return a run ID.");
    let result = started;
    for (let attempt = 0; attempt < 240; attempt++) {
      if (result.status === "completed" || result.status === "failed" || result.status === "cancelled") break;
      await new Promise((resolve) => setTimeout(resolve, Math.min(1000 + attempt * 25, 2500)));
      result = await api("/runs/" + encodeURIComponent(started.id));
    }
    if (result.status === "completed") { placeholder.content = result.result?.output || "Sofia completed the task."; placeholder.meta = "Completed · " + (result.result?.steps ?? 0) + " steps"; }
    else { placeholder.content = result.error || "The run did not complete."; placeholder.meta = "Status: " + result.status; placeholder.error = true; }
  } catch (error) { placeholder.content = "I couldn’t complete that request: " + error.message; placeholder.meta = "Connection or run error"; placeholder.error = true; }
  finally { setBusy(false); saveHistory(); renderHistory(); }
}
$("chat-form").addEventListener("submit", (event) => { event.preventDefault(); void submitMessage($("prompt").value); });
$("prompt").addEventListener("keydown", (event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); $("chat-form").requestSubmit(); } });
$("new-chat").addEventListener("click", () => { if (state.busy) return toast("Wait for the current run to finish.", true); state.sessionId = crypto.randomUUID(); state.history = []; saveHistory(); renderHistory(); showPanel("chat"); });
function showPanel(panel) {
  state.panel = panel; $("chat-panel").classList.toggle("hidden", panel !== "chat"); $("memory-panel").classList.toggle("hidden", panel !== "memory");
  $("page-title").textContent = panel === "chat" ? "Chat with Sofia" : "Memory"; document.querySelectorAll(".nav").forEach((n) => n.classList.toggle("active", n.dataset.panel === panel));
  if (panel === "memory") void loadMemories("");
}
document.querySelectorAll(".nav").forEach((n) => n.addEventListener("click", () => showPanel(n.dataset.panel)));
function renderMemories(entries) {
  const root = $("memory-results"); root.replaceChildren();
  if (!entries.length) { const p = document.createElement("p"); p.className = "muted"; p.textContent = "No saved memories found."; root.append(p); return; }
  for (const entry of entries) {
    const card = document.createElement("article"); card.className = "memory-card"; const body = document.createElement("div");
    const kind = document.createElement("small"); kind.textContent = entry.kind + " · " + new Date(entry.updatedAt).toLocaleString();
    const content = document.createElement("p"); content.textContent = entry.content; body.append(kind, content);
    const remove = document.createElement("button"); remove.textContent = "Delete"; remove.addEventListener("click", async () => { try { await api("/memory/" + encodeURIComponent(entry.id), { method: "DELETE" }); await loadMemories($("memory-query").value); toast("Memory deleted."); } catch (error) { toast(error.message, true); } });
    card.append(body, remove); root.append(card);
  }
}
async function loadMemories(query) { try { const result = await api("/memory" + (query.trim() ? "?q=" + encodeURIComponent(query.trim()) : "")); renderMemories(result.memories || []); } catch (error) { $("memory-results").textContent = "Memory unavailable: " + error.message + ". Check that the server key has memory:read scope."; } }
$("memory-form").addEventListener("submit", async (event) => { event.preventDefault(); const content = $("memory-content").value.trim(); if (!content) return; try { await api("/memory", { method: "POST", body: JSON.stringify({ kind: $("memory-kind").value, content }) }); $("memory-content").value = ""; toast("Memory saved."); await loadMemories($("memory-query").value); } catch (error) { toast("Could not save memory: " + error.message, true); } });
$("memory-search-form").addEventListener("submit", (event) => { event.preventDefault(); void loadMemories($("memory-query").value); });
$("memory-refresh").addEventListener("click", () => { $("memory-query").value = ""; void loadMemories(""); });
try { state.sessionId = localStorage.getItem(sessionKey) || state.sessionId; const history = JSON.parse(localStorage.getItem(historyKey) || "[]"); if (Array.isArray(history)) state.history = history.filter((x) => x && ["user", "assistant"].includes(x.role) && typeof x.content === "string").slice(-80); } catch {}
renderHistory(); void loadPreference(); void api("/health").then(() => { $("connection-label").textContent = "Sofia API connected"; }).catch(() => { $("connection-label").textContent = "API connection needs attention"; });
