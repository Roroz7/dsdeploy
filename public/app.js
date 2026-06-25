// ── État ─────────────────────────────────────────────────────────────────────
let selectedFile = null;
let isGithubDeploy = false;
let currentBotId = null;
let botsData = {};
let ws;
let currentViewType = "bot";
let authToken = localStorage.getItem("deployer_token") || null;
let codeEditorInstance = null;
let currentOpenedFile = null;
let userRole = localStorage.getItem("deployer_role") || "USER";
let chartInstance = null;
let metricsData = { cpu: [], ram: [], labels: [] };

// ── Auth & Fetch ──────────────────────────────────────────────────────────────
async function login() {
  const username = document.getElementById("loginUsername").value;
  const password = document.getElementById("loginPassword").value;
  if (!username || !password) return;
  const res = await fetch("/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (res.ok) {
    const data = await res.json();
    authToken = data.token;
    userRole = data.role;
    localStorage.setItem("deployer_token", authToken);
    localStorage.setItem("deployer_role", userRole);
    document.getElementById("loginOverlay").style.display = "none";
    initUI();
    initWs();
    fetchBots();
  } else {
    document.getElementById("loginError").classList.remove("hidden");
  }
}

function initUI() {
  if (userRole === "ADMIN") {
    document.getElementById("adminTabBtn").classList.remove("hidden");
  }
}

function logout() {
  localStorage.removeItem("deployer_token");
  localStorage.removeItem("deployer_role");
  location.reload();
}

async function authFetch(url, options = {}) {
  if (!options.headers) options.headers = {};
  if (!(options.body instanceof FormData) && !options.headers["Content-Type"]) {
    options.headers["Content-Type"] = "application/json";
  }
  if (authToken) options.headers["Authorization"] = authToken;
  
  const res = await fetch(url, options);
  if (res.status === 401) {
    document.getElementById("loginOverlay").classList.remove("hidden");
    throw new Error("Non autorisé");
  }
  return res;
}

// ── WebSocket ─────────────────────────────────────────────────────────────────
function initWs() {
  if (!authToken) return;
  const loc = window.location;
  const wsUri = (loc.protocol === "https:" ? "wss://" : "ws://") + loc.host + "?token=" + authToken;
  ws = new WebSocket(wsUri);
  
  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);
    if (data.event === "log" && data.botId === currentBotId) {
      appendLog(data);
    } else if (data.event === "status") {
      if (botsData[data.botId]) botsData[data.botId].status = data.status;
      renderBotList();
      if (data.botId === currentBotId) renderPanelStatus(data.status);
    } else if (data.event === "deployed") {
      fetchBots();
    } else if (data.event === "deleted") {
      delete botsData[data.botId];
      renderBotList();
      if (currentBotId === data.botId) {
        currentBotId = null;
        showPlaceholder();
      }
    } else if (data.event === "metrics") {
      if (currentBotId && data.stats[currentBotId]) {
        updateMetrics(data.stats[currentBotId]);
      }
    }
  };
  ws.onclose = () => setTimeout(initWs, 2000);
}

// ── Fetch & render bots ───────────────────────────────────────────────────────
async function fetchBots() {
  const res = await authFetch("/api/bots");
  const list = await res.json();
  botsData = {};
  list.forEach((b) => (botsData[b.id] = b));
  renderBotList();
}

function renderBotList() {
  const el = document.getElementById("botList");
  const ids = Object.keys(botsData).filter(id => (botsData[id].projectType || 'bot') === currentViewType);
  if (ids.length === 0) {
    el.innerHTML = `<p class="empty-list">Aucun ${currentViewType === 'bot' ? 'bot déployé' : 'script déployé'}</p>`;
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

  fetchLogs(botId);

  // Charger la config
  document.getElementById("cfgEntry").value = bot.entry || "";
  document.getElementById("cfgToken").value = bot.env?.DISCORD_TOKEN || "";
  document.getElementById("cfgAutoRestart").checked = bot.autoRestart || false;
  document.getElementById("cfgCron").value = bot.cron || "";
  const envCopy = { ...(bot.env || {}) };
  delete envCopy.DISCORD_TOKEN;
  document.getElementById("cfgEnv").value =
    Object.keys(envCopy).length ? JSON.stringify(envCopy, null, 2) : "";

  // Reset Metrics & Chart
  metricsData = { cpu: [], ram: [], labels: [] };
  document.getElementById("metricCpu").textContent = "CPU: 0%";
  document.getElementById("metricRam").textContent = "RAM: 0 MB";
  initChart();

  // Reset IDE
  if (codeEditorInstance) codeEditorInstance.setValue("");
  currentOpenedFile = null;
  document.getElementById("currentFileName").textContent = "Aucun fichier sélectionné";
  document.getElementById("fileList").innerHTML = "";
}

async function fetchLogs(botId) {
  const logRes = await authFetch(`/api/bots/${botId}/logs`);
  const logs = await logRes.json();
  const container = document.getElementById("logContainer");
  container.innerHTML = "";
  logs.forEach((l) => appendLog(l));
  container.scrollTop = container.scrollHeight;
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
function appendLog(log) {
  if (document.getElementById("logSearch").value) return;
  const container = document.getElementById("logContainer");
  const div = document.createElement("div");
  div.className = `log-line ${log.type}`;
  const t = new Date(log.time).toLocaleTimeString("fr-FR");
  div.innerHTML = `<span class="log-time">${t}</span><span class="log-text">${escHtml(log.line)}</span>`;
  container.appendChild(div);

  while (container.children.length > 500) container.removeChild(container.firstChild);

  if (document.getElementById("autoScroll").checked) {
    container.scrollTop = container.scrollHeight;
  }
}

async function searchLogs() {
  const q = document.getElementById("logSearch").value;
  if (!q) {
    await fetchLogs(currentBotId);
    return;
  }
  const res = await authFetch(`/api/bots/${currentBotId}/logs/search?q=${encodeURIComponent(q)}`);
  const logs = await res.json();
  const container = document.getElementById("logContainer");
  container.innerHTML = "";
  logs.forEach(l => appendLog(l));
}

function downloadLogs() {
  if (!currentBotId) return;
  window.open(`/api/bots/${currentBotId}/logs/download?token=${authToken}`, "_blank");
}

function clearLogs() {
  document.getElementById("logContainer").innerHTML = "";
}

// ── Stdin ─────────────────────────────────────────────────────────────────────
async function handleStdin(e) {
  if (e.key === "Enter") {
    const input = e.target.value;
    if (!input || !currentBotId) return;
    e.target.value = "";
    await authFetch(`/api/bots/${currentBotId}/stdin`, {
      method: "POST",
      body: JSON.stringify({ input })
    });
  }
}

// ── Actions bot ───────────────────────────────────────────────────────────────
async function actionBot(action) {
  if (!currentBotId) return;
  await authFetch(`/api/bots/${currentBotId}/${action}`, { method: "POST" });
}

async function deleteBot() {
  if (!currentBotId) return;
  if (!confirm(`Supprimer le projet "${botsData[currentBotId]?.name}" ?`)) return;
  await authFetch(`/api/bots/${currentBotId}`, { method: "DELETE" });
}

// ── Config ────────────────────────────────────────────────────────────────────
async function saveConfig() {
  if (!currentBotId) return;
  const entry = document.getElementById("cfgEntry").value || "";
  const token = document.getElementById("cfgToken").value;
  const cronExpr = document.getElementById("cfgCron").value;
  const autoRestart = document.getElementById("cfgAutoRestart").checked;
  let env = {};
  try {
    env = JSON.parse(document.getElementById("cfgEnv").value || "{}");
  } catch {
    toast("JSON des variables d'env invalide", "error");
    return;
  }
  if (token) env.DISCORD_TOKEN = token;

  await authFetch(`/api/bots/${currentBotId}/config`, {
    method: "PATCH",
    body: JSON.stringify({ entry, autoRestart, cron: cronExpr, env }),
  });

  botsData[currentBotId].entry = entry;
  botsData[currentBotId].autoRestart = autoRestart;
  botsData[currentBotId].cron = cronExpr;
  botsData[currentBotId].env = env;
  toast("✅ Config sauvegardée !", "success");
}

// ── Deploy ────────────────────────────────────────────────────────────────────
function showGithubForm() {
  isGithubDeploy = true;
  document.getElementById("formTitle").textContent = currentViewType === 'bot' ? "Déployer depuis GitHub" : "Déployer un script (GitHub)";
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
    
    res = await authFetch("/api/deploy/github", {
      method: "POST",
      body: JSON.stringify({ repoUrl, name, token, env: envRaw, projectType: currentViewType })
    });
  } else {
    if (!selectedFile) return;
    const finalName = name || selectedFile.name.replace(".zip", "");
    const fd = new FormData();
    fd.append("archive", selectedFile);
    fd.append("name", finalName);
    if (token) fd.append("token", token);
    if (envRaw) fd.append("env", envRaw);

    fd.append("projectType", currentViewType);

    res = await authFetch("/api/deploy", { method: "POST", body: fd });
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
  document.getElementById("formTitle").textContent = currentViewType === 'bot' ? "Déployer un bot (ZIP)" : "Déployer un script (ZIP)";
  document.getElementById("githubUrlContainer").classList.add("hidden");
  document.getElementById("botName").value = file.name.replace(".zip", "");
  document.getElementById("deployZone").classList.add("hidden");
  document.getElementById("uploadForm").classList.remove("hidden");
}

// ── Sidebar Switch ────────────────────────────────────────────────────────────
function switchSidebarTab(type) {
  currentViewType = type;
  document.querySelectorAll(".s-tab").forEach(t => t.classList.remove("active"));
  event.currentTarget.classList.add("active");
  
  document.getElementById("deployZone").classList.toggle("hidden", type === "admin");
  document.getElementById("botList").classList.toggle("hidden", type === "admin");
  document.getElementById("adminForm").classList.toggle("hidden", type !== "admin");
  
  document.getElementById("lblBotName").textContent = type === "bot" ? "Nom du bot" : "Nom du script";
  document.getElementById("tokenContainer").classList.toggle("hidden", type !== "bot");
  document.getElementById("cfgTokenContainer").classList.toggle("hidden", type !== "bot");
  
  cancelDeploy();
  renderBotList();
  showPlaceholder();
}

async function createUser() {
  const username = document.getElementById("newUsername").value;
  const password = document.getElementById("newPassword").value;
  if (!username || !password) return toast("Remplissez les champs", "error");
  const res = await authFetch("/api/users", {
    method: "POST",
    body: JSON.stringify({ username, password })
  });
  if (res.ok) {
    toast("✅ Utilisateur créé !", "success");
    document.getElementById("newUsername").value = "";
    document.getElementById("newPassword").value = "";
  } else {
    toast("❌ Erreur lors de la création", "error");
  }
}

// ── Web IDE ───────────────────────────────────────────────────────────────────
async function loadFiles() {
  if (!currentBotId) return;
  const res = await authFetch(`/api/bots/${currentBotId}/files`);
  const files = await res.json();
  const el = document.getElementById("fileList");
  if (files.error) {
    el.innerHTML = '<p class="empty-list">Erreur de chargement</p>';
    return;
  }
  el.innerHTML = files.map(f => `<div class="file-item" onclick="openFile('${f}')">${f}</div>`).join("");
}

async function openFile(path) {
  if (!currentBotId) return;
  const res = await authFetch(`/api/bots/${currentBotId}/files/read?path=${encodeURIComponent(path)}`);
  const content = await res.text();
  
  currentOpenedFile = path;
  document.getElementById("currentFileName").textContent = path;
  
  if (!codeEditorInstance) {
    codeEditorInstance = CodeMirror.fromTextArea(document.getElementById("codeEditor"), {
      lineNumbers: true,
      theme: "dracula",
      mode: path.endsWith('.py') ? "python" : "javascript"
    });
  }
  
  codeEditorInstance.setOption("mode", path.endsWith('.py') ? "python" : "javascript");
  codeEditorInstance.setValue(content);
  
  document.querySelectorAll(".file-item").forEach(el => el.classList.remove("active"));
  event.target.classList.add("active");
}

async function saveFile() {
  if (!currentBotId || !currentOpenedFile || !codeEditorInstance) return;
  const content = codeEditorInstance.getValue();
  const res = await authFetch(`/api/bots/${currentBotId}/files/write`, {
    method: "PUT",
    body: JSON.stringify({ path: currentOpenedFile, content })
  });
  if (res.ok) toast("✅ Fichier sauvegardé !", "success");
  else toast("❌ Erreur de sauvegarde", "error");
}

// ── Tabs ──────────────────────────────────────────────────────────────────────
function setTab(tab, btn) {
  document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
  btn.classList.add("active");
  document.getElementById("tabLogs").classList.toggle("hidden", tab !== "logs");
  document.getElementById("tabConfig").classList.toggle("hidden", tab !== "config");
  document.getElementById("tabFiles").classList.toggle("hidden", tab !== "files");
  
  if (tab === "files") {
    loadFiles();
    if (codeEditorInstance) setTimeout(() => codeEditorInstance.refresh(), 50);
  }
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

// ── Metrics Chart ─────────────────────────────────────────────────────────────
function initChart() {
  const ctx = document.getElementById('metricsChart').getContext('2d');
  if (chartInstance) chartInstance.destroy();
  chartInstance = new Chart(ctx, {
    type: 'line',
    data: {
      labels: metricsData.labels,
      datasets: [
        { label: 'CPU (%)', data: metricsData.cpu, borderColor: '#5865F2', borderWidth: 2, pointRadius: 0, tension: 0.3 },
        { label: 'RAM (MB)', data: metricsData.ram, borderColor: '#57F287', borderWidth: 2, pointRadius: 0, tension: 0.3 }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { display: false },
        y: { display: false, min: 0 }
      },
      animation: false
    }
  });
}

function updateMetrics(stats) {
  const memMB = (stats.memory / 1024 / 1024).toFixed(1);
  const cpuPct = stats.cpu.toFixed(1);
  
  document.getElementById("metricCpu").textContent = `CPU: ${cpuPct}%`;
  document.getElementById("metricRam").textContent = `RAM: ${memMB} MB`;
  
  metricsData.labels.push("");
  metricsData.cpu.push(stats.cpu);
  metricsData.ram.push(stats.memory / 1024 / 1024);
  
  if (metricsData.labels.length > 30) {
    metricsData.labels.shift();
    metricsData.cpu.shift();
    metricsData.ram.shift();
  }
  
  if (chartInstance) chartInstance.update();
}

// ── Init ──────────────────────────────────────────────────────────────────────
function initApp() {
  if (!authToken) {
    document.getElementById("loginOverlay").classList.remove("hidden");
    return;
  }
  document.getElementById("loginOverlay").style.display = "none";
  initUI();
  initDragDrop();
  initWs();
  fetchBots();
}

initApp();
