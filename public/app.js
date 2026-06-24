// ── État ─────────────────────────────────────────────────────────────────────
let selectedFile = null;
let isGithubDeploy = false;
let currentBotId = null;
let botsData = {};
let ws;

// ── WebSocket ─────────────────────────────────────────────────────────────────
function connectWS() {
  const protocol = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${protocol}://${location.host}`);

  ws.onmessage = ({ data }) => {
    const msg = JSON.parse(data);

    if (msg.event === "log") {
      appendLog(msg.botId, msg.line, msg.type, msg.time);
    }

    if (msg.event === "status") {
      if (botsData[msg.botId]) botsData[msg.botId].status = msg.status;
      updateBotItem(msg.botId);
      if (currentBotId === msg.botId) renderPanelStatus(msg.status);
    }

    if (msg.event === "deployed") {
      fetchBots();
      toast(`✅ Bot "${msg.name}" déployé !`, "success");
    }

    if (msg.event === "deleted") {
      delete botsData[msg.botId];
      renderBotList();
      if (currentBotId === msg.botId) {
        currentBotId = null;
        showPlaceholder();
      }
    }
  };

  ws.onclose = () => setTimeout(connectWS, 2000);
}

// ── Fetch & render bots ───────────────────────────────────────────────────────
async function fetchBots() {
  const res = await fetch("/api/bots");
  const list = await res.json();
  botsData = {};
  list.forEach((b) => (botsData[b.id] = b));
  renderBotList();
}

function renderBotList() {
  const el = document.getElementById("botList");
  const ids = Object.keys(botsData);
  if (ids.length === 0) {
    el.innerHTML = '<p class="empty-list">Aucun bot déployé</p>';
    return;
  }
  el.innerHTML = ids
    .map((id) => {
      const b = botsData[id];
      return `
      <div class="bot-item ${currentBotId === id ? "active" : ""}" onclick="selectBot('${id}')">
        <div class="status-dot ${b.status}"></div>
        <div>
          <div class="bot-item-name">${b.name}</div>
          <div class="bot-item-id">${b.id}</div>
        </div>
      </div>`;
    })
    .join("");
}

function updateBotItem(botId) {
  renderBotList();
}

// ── Sélection d'un bot ────────────────────────────────────────────────────────
async function selectBot(botId) {
  currentBotId = botId;
  const bot = botsData[botId];

  document.getElementById("placeholder").classList.add("hidden");
  document.getElementById("botPanel").classList.remove("hidden");

  document.getElementById("panelName").textContent = bot.name;
  renderPanelStatus(bot.status);
  renderBotList();

  // Charger les logs
  const logRes = await fetch(`/api/bots/${botId}/logs`);
  const logs = await logRes.json();
  const container = document.getElementById("logContainer");
  container.innerHTML = "";
  logs.forEach((l) => appendLog(botId, l.line, l.type, l.time, false));
  container.scrollTop = container.scrollHeight;

  // Charger la config
  document.getElementById("cfgEntry").value = bot.entry || "";
  document.getElementById("cfgToken").value = bot.env?.DISCORD_TOKEN || "";
  document.getElementById("cfgAutoRestart").checked = bot.autoRestart || false;
  const envCopy = { ...(bot.env || {}) };
  delete envCopy.DISCORD_TOKEN;
  document.getElementById("cfgEnv").value =
    Object.keys(envCopy).length ? JSON.stringify(envCopy, null, 2) : "";
}

function showPlaceholder() {
  document.getElementById("placeholder").classList.remove("hidden");
  document.getElementById("botPanel").classList.add("hidden");
}

function renderPanelStatus(status) {
  const dot = document.getElementById("panelDot");
  const badge = document.getElementById("panelBadge");
  const labels = {
    running: "En ligne",
    stopped: "Arrêté",
    starting: "Démarrage...",
    crashed: "Crash",
    deployed: "Déployé",
    error: "Erreur",
  };
  dot.className = `status-dot ${status}`;
  badge.className = `badge ${status}`;
  badge.textContent = labels[status] || status;

  const running = status === "running" || status === "starting";
  document.getElementById("btnStart").disabled = running;
  document.getElementById("btnStop").disabled = !running;
  document.getElementById("btnRestart").disabled = !running;
}

// ── Logs ──────────────────────────────────────────────────────────────────────
function appendLog(botId, line, type, time, scroll = true) {
  if (currentBotId !== botId) return;
  const container = document.getElementById("logContainer");
  const div = document.createElement("div");
  div.className = `log-line ${type}`;
  const t = new Date(time).toLocaleTimeString("fr-FR");
  div.innerHTML = `<span class="log-time">${t}</span><span class="log-text">${escHtml(line)}</span>`;
  container.appendChild(div);

  // Limite 500 lignes dans le DOM
  while (container.children.length > 500) container.removeChild(container.firstChild);

  if (scroll && document.getElementById("autoScroll").checked) {
    container.scrollTop = container.scrollHeight;
  }
}

function clearLogs() {
  document.getElementById("logContainer").innerHTML = "";
}

// ── Actions bot ───────────────────────────────────────────────────────────────
async function actionBot(action) {
  if (!currentBotId) return;
  await fetch(`/api/bots/${currentBotId}/${action}`, { method: "POST" });
}

async function deleteBot() {
  if (!currentBotId) return;
  if (!confirm(`Supprimer le bot "${botsData[currentBotId]?.name}" ?`)) return;
  await fetch(`/api/bots/${currentBotId}`, { method: "DELETE" });
}

// ── Config ────────────────────────────────────────────────────────────────────
async function saveConfig() {
  if (!currentBotId) return;
  const entry = document.getElementById("cfgEntry").value || "";
  const token = document.getElementById("cfgToken").value;
  const autoRestart = document.getElementById("cfgAutoRestart").checked;
  let env = {};
  try {
    env = JSON.parse(document.getElementById("cfgEnv").value || "{}");
  } catch {
    toast("JSON des variables d'env invalide", "error");
    return;
  }
  if (token) env.DISCORD_TOKEN = token;

  await fetch(`/api/bots/${currentBotId}/config`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ entry, autoRestart, env }),
  });

  botsData[currentBotId].entry = entry;
  botsData[currentBotId].autoRestart = autoRestart;
  botsData[currentBotId].env = env;
  toast("✅ Config sauvegardée !", "success");
}

// ── Deploy ────────────────────────────────────────────────────────────────────
function showGithubForm() {
  isGithubDeploy = true;
  document.getElementById("formTitle").textContent = "Déployer depuis GitHub";
  document.getElementById("githubUrlContainer").classList.remove("hidden");
  document.getElementById("botName").value = "";
  document.getElementById("deployZone").classList.add("hidden");
  document.getElementById("uploadForm").classList.remove("hidden");
}

function cancelDeploy() {
  selectedFile = null;
  isGithubDeploy = false;
  document.getElementById("fileInput").value = "";
  document.getElementById("repoUrl").value = "";
  document.getElementById("uploadForm").classList.add("hidden");
  document.getElementById("deployZone").classList.remove("hidden");
}

async function deployBot() {
  const name = document.getElementById("botName").value.trim();
  const token = document.getElementById("botToken").value;
  const envRaw = document.getElementById("botEnv").value;

  document.querySelector("#uploadForm .btn-primary").textContent = "Déploiement...";

  let res, data;

  if (isGithubDeploy) {
    const repoUrl = document.getElementById("repoUrl").value.trim();
    if (!repoUrl) {
      toast("L'URL du dépôt est requise", "error");
      document.querySelector("#uploadForm .btn-primary").textContent = "🚀 Déployer";
      return;
    }
    
    res = await fetch("/api/deploy/github", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repoUrl, name, token, env: envRaw })
    });
  } else {
    if (!selectedFile) return;
    const finalName = name || selectedFile.name.replace(".zip", "");
    const fd = new FormData();
    fd.append("archive", selectedFile);
    fd.append("name", finalName);
    if (token) fd.append("token", token);
    if (envRaw) fd.append("env", envRaw);

    res = await fetch("/api/deploy", { method: "POST", body: fd });
  }

  data = await res.json();

  if (data.error) {
    toast(`❌ ${data.error}`, "error");
  } else {
    cancelDeploy();
    await fetchBots();
    selectBot(data.botId);
  }
  document.querySelector("#uploadForm .btn-primary").textContent = "🚀 Déployer";
}

// ── Drag & Drop ───────────────────────────────────────────────────────────────
function initDragDrop() {
  const zone = document.getElementById("deployZone");

  zone.addEventListener("dragover", (e) => {
    e.preventDefault();
    zone.classList.add("drag-over");
  });
  zone.addEventListener("dragleave", () => zone.classList.remove("drag-over"));
  zone.addEventListener("drop", (e) => {
    e.preventDefault();
    zone.classList.remove("drag-over");
    const file = e.dataTransfer.files[0];
    if (file?.name.endsWith(".zip")) handleFile(file);
    else toast("Seuls les fichiers ZIP sont acceptés", "error");
  });
  zone.addEventListener("click", (e) => {
    if (e.target.tagName !== "BUTTON") document.getElementById("fileInput").click();
  });

  document.getElementById("fileInput").addEventListener("change", (e) => {
    if (e.target.files[0]) handleFile(e.target.files[0]);
  });
}

function handleFile(file) {
  isGithubDeploy = false;
  selectedFile = file;
  document.getElementById("formTitle").textContent = "Déployer un bot (ZIP)";
  document.getElementById("githubUrlContainer").classList.add("hidden");
  document.getElementById("botName").value = file.name.replace(".zip", "");
  document.getElementById("deployZone").classList.add("hidden");
  document.getElementById("uploadForm").classList.remove("hidden");
}

// ── Tabs ──────────────────────────────────────────────────────────────────────
function setTab(tab, btn) {
  document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
  btn.classList.add("active");
  document.getElementById("tabLogs").classList.toggle("hidden", tab !== "logs");
  document.getElementById("tabConfig").classList.toggle("hidden", tab !== "config");
}

// ── Toast ─────────────────────────────────────────────────────────────────────
function toast(msg, type = "info") {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.className = `toast ${type}`;
  el.classList.remove("hidden");
  setTimeout(() => el.classList.add("hidden"), 3000);
}

// ── Utils ─────────────────────────────────────────────────────────────────────
function escHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ── Init ──────────────────────────────────────────────────────────────────────
initDragDrop();
connectWS();
fetchBots();
