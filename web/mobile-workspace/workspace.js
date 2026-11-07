(() => {
  "use strict";
  // The UI talks to a same-origin authenticated BFF. The BFF must inject the
  // Sofia API key server-side; this browser code never handles master keys.
  const API_ROOT = (window.SOFIA_WORKSPACE_API_ROOT || "/api/sofia").replace(/\/$/, "");
  const $ = (id) => document.getElementById(id);
  const state = { sessionId: null, refreshTimer: null, clockTimer: null, runTimer: null, approvalTimer: null, approvalBusy: false, startedAt: 0, expiresAt: 0, sessionTimeoutMs: 900000, screenshotBusy: false, lastUrl: "", busy: false, touchStart: null };
  const els = {
    statusDot:$("statusDot"),statusText:$("statusText"),url:$("urlInput"),pageTitle:$("pageTitle"),
    welcome:$("welcomeScreen"),screenWrap:$("screenWrap"),screenshot:$("browserScreenshot"),
    stage:$("browserStage"),loading:$("loadingOverlay"),loadingText:$("loadingText"),
    browserState:$("browserState"),sessionTimer:$("sessionTimer"),close:$("closeSessionButton"),
    messages:$("copilotMessages"),chat:$("chatInput"),send:$("sendButton"),approval:$("approvalInbox"),approvalList:$("approvalList"),approvalText:$("approvalText"),
    modal:$("infoModal"),modalTitle:$("modalTitle"),modalBody:$("modalBody"),toast:$("toast")
  };

  function toast(message) {
    els.toast.textContent = message;
    els.toast.classList.add("show");
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => els.toast.classList.remove("show"), 3000);
  }
  function setStatus(connected, label) {
    els.statusDot.style.background = connected ? "var(--mint2)" : "#7c879e";
    els.statusDot.style.boxShadow = connected ? "0 0 12px #4ed8a477" : "none";
    els.statusText.textContent = label;
    els.browserState.textContent = connected ? "Cloud browser connected" : "Waiting for connection";
  }
  function loading(on, label) {
    els.loadingText.textContent = label || "Working…";
    els.loading.classList.toggle("hidden", !on);
  }
  function showModal(title, message) {
    els.modalTitle.textContent = title;
    els.modalBody.textContent = message;
    els.modal.showModal();
  }
  function csrfToken() {
    const cookie = document.cookie.split("; ").find(item => item.startsWith("sofia_csrf="));
    return cookie ? decodeURIComponent(cookie.slice("sofia_csrf=".length)) : "";
  }
  async function api(path, options = {}) {
    const csrf = csrfToken();
    const response = await fetch(API_ROOT + path, {
      method: options.method || "GET",
      credentials: "same-origin",
      headers: { "accept": "application/json", ...(csrf ? { "x-csrf-token": csrf } : {}), ...(options.body ? { "content-type": "application/json" } : {}) },
      ...(options.body ? { body: JSON.stringify(options.body) } : {})
    });
    let payload = {};
    try { payload = await response.json(); } catch { /* non-JSON error response */ }
    if (!response.ok) {
      const error = new Error(payload.error || (response.status === 401 ? "Sign in to your Sofia account to connect this workspace." : "The workspace request could not be completed."));
      error.status = response.status;
      throw error;
    }
    return payload;
  }
  function showConnected(session) {
    state.sessionId = session.id;
    state.startedAt = session.createdAt || Date.now();
    state.sessionTimeoutMs = session.expiresInMs || 900000;
    state.expiresAt = state.startedAt + state.sessionTimeoutMs;
    els.welcome.classList.add("hidden");
    els.screenWrap.classList.remove("hidden");
    els.close.classList.remove("hidden");
    setStatus(true, "Connected");
    els.url.value = session.url || "";
    els.pageTitle.textContent = session.title || "New tab";
    clearInterval(state.refreshTimer);
    clearInterval(state.clockTimer);
    state.refreshTimer = setInterval(refreshScreenshot, 1800);
    state.clockTimer = setInterval(updateClock, 1000);
    updateClock();
    refreshScreenshot();
  }
  async function startSession() {
    if (state.busy) return;
    state.busy = true; loading(true, "Starting your private browser…");
    try {
      const result = await api("/v1/browser/cloud/sessions", { method:"POST" });
      showConnected(result.session);
      toast("Your private browser is ready.");
    } catch (error) {
      setStatus(false, "Connection required");
      showModal(error.status === 401 ? "Sign in to Sofia" : "Could not start browser",
        error.message + " This workspace requires your Sofia account to be signed in through the secure application gateway. No API key is requested or stored in this page.");
    } finally { loading(false); state.busy = false; }
  }
  async function refreshScreenshot() {
    if (!state.sessionId || state.screenshotBusy) return;
    state.screenshotBusy = true;
    try {
      const result = await api("/v1/browser/cloud/sessions/" + encodeURIComponent(state.sessionId) + "/screenshot");
      if (!state.sessionId) return;
      const source = "data:" + (result.mimeType || "image/png") + ";base64," + result.imageBase64;
      if (els.screenshot.src !== source) els.screenshot.src = source;
      if (result.width && result.height) {
        els.screenshot.dataset.viewportWidth = String(result.width);
        els.screenshot.dataset.viewportHeight = String(result.height);
      }
      els.screenWrap.classList.remove("hidden");
    } catch (error) {
      if (error.status === 404 || error.status === 401) stopSession(false);
      if (error.status !== 404) toast(error.message);
    } finally { state.screenshotBusy = false; }
  }
  async function navigate() {
    if (!state.sessionId) { toast("Start your cloud browser first."); return; }
    let value = els.url.value.trim();
    if (!value) return;
    if (!/^https?:\/\//i.test(value)) value = "https://" + value;
    loading(true, "Opening " + value.replace(/^https?:\/\//, "").slice(0, 48) + "…");
    try {
      const result = await api("/v1/browser/cloud/sessions/" + state.sessionId + "/navigate", { method:"POST", body:{url:value} });
      els.url.value = result.url;
      els.pageTitle.textContent = result.title || result.url;
      state.lastUrl = result.url;
      await refreshScreenshot();
    } catch (error) { toast(error.message); }
    finally { loading(false); }
  }
  async function action(payload, quiet = false) {
    if (!state.sessionId) { toast("Start your cloud browser first."); return; }
    try {
      await api("/v1/browser/cloud/sessions/" + state.sessionId + "/action", { method:"POST", body:payload });
      if (!quiet) setTimeout(refreshScreenshot, 250);
    } catch (error) { toast(error.message); }
  }
  function stopSession(notify = true) {
    clearInterval(state.refreshTimer); clearInterval(state.clockTimer);
    state.sessionId = null; state.expiresAt = 0; state.startedAt = 0;
    els.screenshot.removeAttribute("src");
    els.screenWrap.classList.add("hidden"); els.welcome.classList.remove("hidden"); $("remoteKeyboard").classList.add("hidden");
    els.close.classList.add("hidden"); els.url.value = ""; els.pageTitle.textContent = "Your browser is ready";
    els.sessionTimer.textContent = "SESSION · —"; setStatus(false, "Not connected");
    if (notify) toast("Browser session closed.");
  }
  async function closeSession() {
    if (!state.sessionId) return;
    const id = state.sessionId;
    try { await api("/v1/browser/cloud/sessions/" + id, { method:"DELETE" }); }
    catch (error) { toast(error.message); }
    stopSession();
  }
  function updateClock() {
    if (!state.sessionId) return;
    const remaining = Math.max(0, state.expiresAt - Date.now());
    const minutes = Math.floor(remaining / 60000), seconds = Math.floor(remaining % 60000 / 1000);
    els.sessionTimer.textContent = "SESSION · " + String(minutes).padStart(2,"0") + ":" + String(seconds).padStart(2,"0");
    if (!remaining) { stopSession(false); toast("Your browser session expired. Start a new one to continue."); }
  }
  function appendMessage(text, who) {
    const row = document.createElement("div");
    row.className = "message " + (who === "user" ? "user-message" : "sofia-message");
    if (who !== "user") {
      const avatar = document.createElement("div"); avatar.className = "message-avatar"; avatar.textContent = "S"; row.append(avatar);
    }
    const content = document.createElement("div"); content.className = "message-content";
    const p = document.createElement("p"); p.textContent = text; content.append(p);
    const time = document.createElement("span"); time.className = "message-time"; time.textContent = who === "user" ? "You · now" : "Sofia · now"; content.append(time);
    row.append(content); els.messages.append(row); els.messages.scrollTop = els.messages.scrollHeight;
    return row;
  }
  function approvalNode(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  async function loadApprovals() {
    if (state.approvalBusy) return;
    state.approvalBusy = true;
    try {
      const result = await api("/v1/approvals");
      const items = Array.isArray(result.approvals) ? result.approvals : [];
      els.approval.classList.toggle("hidden", items.length === 0);
      els.approvalText.textContent = items.length ? items.length + " action" + (items.length === 1 ? "" : "s") + " waiting for your decision." : "No pending actions.";
      els.approvalList.replaceChildren();
      if (!items.length) return;
      for (const item of items) {
        const card = approvalNode("article", "approval-item");
        const top = approvalNode("div", "approval-item-top");
        top.append(approvalNode("strong", "approval-tool", item.toolName || "Sofia action"));
        top.append(approvalNode("span", "approval-risk", String(item.risk || "unknown") + " risk"));
        card.append(top);
        card.append(approvalNode("div", "approval-meta", "Run " + String(item.runId || "").slice(0, 8) + " · Expires " + new Date(item.expiresAt).toLocaleTimeString()));
        const input = approvalNode("pre", "approval-input");
        try { input.textContent = JSON.stringify(item.input ?? {}, null, 2); }
        catch { input.textContent = "[Action details unavailable]"; }
        card.append(input);
        const actions = approvalNode("div", "approval-actions");
        const deny = approvalNode("button", "approval-deny", "Deny");
        const approve = approvalNode("button", "approval-allow", "Approve action");
        deny.type = approve.type = "button";
        deny.addEventListener("click", () => decideApproval(item, "deny", deny, approve));
        approve.addEventListener("click", () => decideApproval(item, "approve", deny, approve));
        actions.append(deny, approve);
        card.append(actions);
        els.approvalList.append(card);
      }
    } catch (error) {
      if (error.status === 401) {
        els.approval.classList.add("hidden");
      } else if (error.status === 403) {
        els.approval.classList.remove("hidden");
        els.approvalText.textContent = "This API key needs approval:read and approval:decide scopes.";
        els.approvalList.replaceChildren(approvalNode("p", "approval-empty", "Ask the workspace administrator to grant the approval scopes."));
      } else if (error.status !== 404) {
        els.approval.classList.remove("hidden");
        els.approvalText.textContent = "Approval inbox temporarily unavailable.";
      }
    } finally {
      state.approvalBusy = false;
    }
  }
  async function decideApproval(item, decision, denyButton, approveButton) {
    if (!item?.id || !item?.actionHash) return;
    denyButton.disabled = approveButton.disabled = true;
    try {
      await api("/v1/approvals/" + encodeURIComponent(item.id) + "/decision", {
        method: "POST",
        body: { decision, actionHash: item.actionHash }
      });
      toast(decision === "approve" ? "Action approved. Sofia may continue." : "Action denied. Sofia will not execute it.");
      await loadApprovals();
    } catch (error) {
      toast(error.status === 409 ? "This approval expired or was already decided." : error.message);
      await loadApprovals();
    } finally {
      denyButton.disabled = approveButton.disabled = false;
    }
  }
  async function sendMessage(text) {
    const task = text.trim(); if (!task || state.busy) return;
    appendMessage(task, "user"); els.chat.value = ""; resizeChat();
    state.busy = true; els.send.disabled = true;
    const progress = document.createElement("div"); progress.className = "assistant-run"; progress.textContent = "Sofia is understanding your request…"; els.messages.append(progress);
    try {
      const started = await api("/v1/agent/runs", { method:"POST", body:{ task, async:true } });
      if (!started.id) throw new Error("Sofia did not return a run ID.");
      progress.textContent = "Sofia is working · run " + started.id.slice(0,8);
      await pollRun(started.id, progress);
    } catch (error) {
      progress.textContent = error.message;
      progress.style.color = "#ffabb5";
    } finally { state.busy = false; els.send.disabled = false; }
  }
  async function pollRun(id, progress) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < 10 * 60 * 1000) {
      await new Promise(resolve => setTimeout(resolve, 1800));
      const result = await api("/v1/agent/runs/" + encodeURIComponent(id));
      if (result.status === "completed") {
        const summary = result.result?.summary || result.result?.response || "Task completed.";
        progress.textContent = "✓ " + String(summary);
        progress.style.color = "var(--mint)";
        return;
      }
      if (result.status === "failed" || result.status === "cancelled") {
        progress.textContent = result.error || "Sofia could not complete this task.";
        progress.style.color = "#ffabb5";
        return;
      }
      progress.textContent = "Sofia is working · " + result.status + "…";
    }
    progress.textContent = "This task is still running. You can check its status in Activity.";
  }
  function resizeChat() { els.chat.style.height = "auto"; els.chat.style.height = Math.min(els.chat.scrollHeight, 100) + "px"; }
  function openKeyboard() { els.chat.focus(); toast("Type a message to Sofia, or tap a field in the browser to enter text."); }
  function clickScreen(event) {
    if (!state.sessionId || !els.screenshot.naturalWidth) return;
    const rect = els.screenshot.getBoundingClientRect();
    const x = Math.max(0, Math.min(els.screenshot.naturalWidth, (event.clientX - rect.left) * els.screenshot.naturalWidth / rect.width));
    const y = Math.max(0, Math.min(els.screenshot.naturalHeight, (event.clientY - rect.top) * els.screenshot.naturalHeight / rect.height));
    action({kind:"clickAt",x:Math.round(x),y:Math.round(y)});
  }
  els.stage.addEventListener("click", event => { if (event.target === els.screenshot && event.detail > 0) clickScreen(event); });
  els.screenshot.addEventListener("touchstart", event => {
    const touch = event.touches[0]; if (touch) state.touchStart = {x:touch.clientX,y:touch.clientY};
  }, {passive:true});
  els.screenshot.addEventListener("touchend", event => {
    if (!state.touchStart) return;
    const touch = event.changedTouches[0]; const start = state.touchStart; state.touchStart = null; if (!touch) return;
    const dx = touch.clientX - start.x, dy = touch.clientY - start.y;
    if (Math.abs(dx) > 18 || Math.abs(dy) > 18) { event.preventDefault(); action({kind:"scroll",x:Math.round(-dx),y:Math.round(-dy)}); }
    else { event.preventDefault(); const rect = els.screenshot.getBoundingClientRect(); const x = Math.max(0, Math.min(els.screenshot.naturalWidth, (touch.clientX - rect.left) * els.screenshot.naturalWidth / rect.width)); const y = Math.max(0, Math.min(els.screenshot.naturalHeight, (touch.clientY - rect.top) * els.screenshot.naturalHeight / rect.height)); action({kind:"clickAt",x:Math.round(x),y:Math.round(y)}); }
  }, {passive:false});
  $("startButton").addEventListener("click", startSession);
  $("goButton").addEventListener("click", navigate);
  els.url.addEventListener("keydown", event => { if (event.key === "Enter") navigate(); });
  $("refreshButton").addEventListener("click", () => action({kind:"reload"}));
  $("backButton").addEventListener("click", () => action({kind:"back"}));
  $("forwardButton").addEventListener("click", () => action({kind:"forward"}));
  els.close.addEventListener("click", closeSession);
  $("keyboardButton").addEventListener("click", () => {
    if (!state.sessionId) { toast("Start your cloud browser first."); return; }
    $("remoteKeyboard").classList.remove("hidden");
    $("remoteTyping").focus();
  });
  $("keyboardClose").addEventListener("click", () => $("remoteKeyboard").classList.add("hidden"));
  $("remoteTypeSend").addEventListener("click", async () => {
    const text = $("remoteTyping").value; if (!text) return;
    await action({kind:"typeFocused",text}); $("remoteTyping").value = ""; $("remoteKeyboard").classList.add("hidden");
  });
  $("remoteTyping").addEventListener("keydown", event => {
    if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); $("remoteTypeSend").click(); }
  });
  document.querySelectorAll("[data-remote-key]").forEach(button => button.addEventListener("click", () => {
    action({kind:"pressFocused",key:button.dataset.remoteKey});
    $("remoteTyping").focus();
  }));
  els.screenshot.addEventListener("wheel", event => {
    event.preventDefault();
    action({kind:"scroll",x:Math.round(event.deltaX),y:Math.round(event.deltaY)});
  }, {passive:false});
  $("fullScreenButton").addEventListener("click", () => els.stage.requestFullscreen?.().catch(() => undefined));
  $("newTabHint").addEventListener("click", () => { els.url.focus(); els.url.value = ""; toast("Enter a website address above."); });
  $("signInHint").addEventListener("click", () => showModal("Sign in safely", "Open the website in the browser and enter your password or verification code directly in that page. Sofia does not ask for, read, or store your passwords or one-time codes."));
  $("privacyHint").addEventListener("click", () => showModal("Private by design", "Your cloud browser session is isolated to your account, expires after inactivity, and is closed when you end it. This initial version does not preserve cookies after a server restart."));
  $("helpButton").addEventListener("click", () => showModal("Your Sofia workspace", "Start a cloud browser to browse from your phone. Tap the page to click, use the address bar to navigate, and ask Sofia to research or complete tasks. Some sensitive actions may require a separate confirmation."));
  $("copilotInfo").addEventListener("click", () => showModal("Sofia AI companion", "Sofia can work on your request through the agent API. Browser interaction and AI task execution share your authenticated Sofia account but use separate session controls."));
  $("modalClose").addEventListener("click", () => els.modal.close());
  $("modalOk").addEventListener("click", () => els.modal.close());
  els.modal.addEventListener("click", event => { if (event.target === els.modal) els.modal.close(); });
  $("chatForm").addEventListener("submit", event => { event.preventDefault(); sendMessage(els.chat.value); });
  els.chat.addEventListener("input", resizeChat);
  els.chat.addEventListener("keydown", event => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); sendMessage(els.chat.value); } });
  document.querySelectorAll("[data-prompt]").forEach(button => button.addEventListener("click", () => { els.chat.value = button.dataset.prompt; els.chat.focus(); resizeChat(); }));
  $("mobileSofiaButton").addEventListener("click", () => { els.chat.scrollIntoView({behavior:"smooth",block:"center"}); setTimeout(() => els.chat.focus(),250); });
  $("mobileMoreButton").addEventListener("click", () => showModal("Workspace options", "Your mobile workspace is designed to work without a desktop computer. Use the Browser tab to control your cloud browser, or ask Sofia for help."));
  $("activityNav").addEventListener("click", () => showModal("Activity", "Run history and reconnectable task activity are available through the Sofia API. A dedicated activity screen will be added in a later UI slice."));
  $("approvalRefresh").addEventListener("click", loadApprovals);
  loadApprovals();
  state.approvalTimer = setInterval(loadApprovals, 2500);
  $("chatInput").addEventListener("focus", () => { if (window.matchMedia("(max-width:600px)").matches) setTimeout(() => els.chat.scrollIntoView({behavior:"smooth",block:"center"}),150); });
  window.addEventListener("beforeunload", () => { clearInterval(state.refreshTimer); clearInterval(state.clockTimer); clearInterval(state.approvalTimer); });
  if ("serviceWorker" in navigator && location.protocol === "https:") {
    navigator.serviceWorker.register("./service-worker.js").catch(() => { /* Offline shell is an enhancement, not a blocker. */ });
  }
  setStatus(false, "Not connected");
})();