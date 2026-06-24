const express = require("express");
const multer = require("multer");
const ws = require("ws");
const http = require("http");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const extract = require("extract-zip");
const treeKill = require("tree-kill");
const chokidar = require("chokidar");

const app = express();
const server = http.createServer(app);
const wss = new ws.WebSocketServer({ server });

app.use(express.json());
app.use(express.static("public"));

// ── Dossiers ────────────────────────────────────────────────────────────────
const BOTS_DIR = path.join(__dirname, "bots");
const UPLOADS_DIR = path.join(__dirname, "uploads");
[BOTS_DIR, UPLOADS_DIR].forEach((d) => fs.mkdirSync(d, { recursive: true }));

// ── État en mémoire ──────────────────────────────────────────────────────────
const bots = {}; // { [botId]: { process, status, logs, config, watcher } }

// ── Upload ───────────────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: UPLOADS_DIR,
  filename: (_, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
});
const upload = multer({ storage, limits: { fileSize: 100 * 1024 * 1024 } });

// ── WebSocket broadcast ──────────────────────────────────────────────────────
function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach((c) => {
    if (c.readyState === ws.WebSocket.OPEN) c.send(msg);
  });
}

function botLog(botId, line, type = "log") {
  if (bots[botId]) {
    bots[botId].logs.push({ time: new Date().toISOString(), type, line });
    if (bots[botId].logs.length > 500) bots[botId].logs.shift();
  }
  broadcast({ event: "log", botId, line, type, time: new Date().toISOString() });
}

function botStatus(botId, status) {
  if (bots[botId]) bots[botId].status = status;
  broadcast({ event: "status", botId, status });
}

// ── Lancer un bot ────────────────────────────────────────────────────────────
function startBot(botId) {
  const bot = bots[botId];
  if (!bot) return;
  if (bot.process) return;

  const botDir = path.join(BOTS_DIR, botId);

  const isGitRepo = fs.existsSync(path.join(botDir, ".git"));
  if (isGitRepo) {
    botStatus(botId, "starting");
    botLog(botId, "🔄 Mise à jour depuis GitHub (git pull)...", "info");
    const pull = spawn("git", ["pull"], { cwd: botDir, shell: true });
    pull.on("close", (code) => {
      if (code !== 0) {
        botLog(botId, "⚠️ git pull a échoué", "warning");
      } else {
        botLog(botId, "✅ git pull réussi", "info");
      }
      _continueStartBot(botId, botDir);
    });
  } else {
    _continueStartBot(botId, botDir);
  }
}

function _continueStartBot(botId, botDir) {
  const bot = bots[botId];
  if (!bot) return;

  // Détection du langage
  let language = "node";
  if (fs.existsSync(path.join(botDir, "requirements.txt")) || fs.existsSync(path.join(botDir, "main.py")) || fs.existsSync(path.join(botDir, "bot.py"))) {
    language = "python";
  }

  // Détection du point d'entrée
  let entry = bot.config.entry;
  if (!entry || entry === "index.js" || entry === "") {
    if (language === "python") {
      const pyEntries = ["main.py", "bot.py", "index.py", "app.py"];
      for (const e of pyEntries) {
        if (fs.existsSync(path.join(botDir, e))) {
          entry = e;
          break;
        }
      }
      if (!entry || entry === "index.js") entry = "main.py";
    } else {
      const jsEntries = ["index.js", "main.js", "bot.js", "app.js"];
      for (const e of jsEntries) {
        if (fs.existsSync(path.join(botDir, e))) {
          entry = e;
          break;
        }
      }
      if (!entry || entry === "") entry = "index.js";
    }
  }

  const entryPath = path.join(botDir, entry);

  if (!fs.existsSync(entryPath)) {
    botLog(botId, `❌ Fichier d'entrée introuvable : ${entry}`, "error");
    botStatus(botId, "error");
    return;
  }

  botStatus(botId, "starting");
  botLog(botId, `🚀 Démarrage du bot (${language} : ${entry})...`, "info");

  const pkgPath = path.join(botDir, "package.json");
  const reqPath = path.join(botDir, "requirements.txt");

  if (language === "node" && fs.existsSync(pkgPath)) {
    botLog(botId, "📦 Installation des dépendances (npm)...", "info");
    const install = spawn("npm", ["install", "--silent"], { cwd: botDir, shell: true });
    install.on("close", (code) => {
      if (code !== 0) {
        botLog(botId, "❌ npm install a échoué", "error");
        botStatus(botId, "error");
        return;
      }
      botLog(botId, "✅ Dépendances installées", "info");
      _spawnBot(botId, language, entry);
    });
  } else if (language === "python" && fs.existsSync(reqPath)) {
    botLog(botId, "📦 Installation des dépendances (pip)...", "info");
    const install = spawn("python", ["-m", "pip", "install", "-r", "requirements.txt"], { cwd: botDir, shell: true });
    install.on("close", (code) => {
      if (code !== 0) {
        botLog(botId, "❌ pip install a échoué", "error");
        botStatus(botId, "error");
        return;
      }
      botLog(botId, "✅ Dépendances installées", "info");
      _spawnBot(botId, language, entry);
    });
  } else {
    _spawnBot(botId, language, entry);
  }
}

function _spawnBot(botId, language, entry) {
  const bot = bots[botId];
  const botDir = path.join(BOTS_DIR, botId);

  const env = {
    ...process.env,
    ...(bot.config.env || {}),
    NODE_ENV: "production",
  };

  const command = language === "python" ? "python" : "node";
  const proc = spawn(command, [entry], { cwd: botDir, env, shell: true });
  bot.process = proc;

  proc.stdout.on("data", (d) =>
    d.toString().split("\n").filter(Boolean).forEach((l) => botLog(botId, l, "log"))
  );
  proc.stderr.on("data", (d) =>
    d.toString().split("\n").filter(Boolean).forEach((l) => botLog(botId, l, "error"))
  );

  proc.on("spawn", () => botStatus(botId, "running"));
  proc.on("close", (code) => {
    bot.process = null;
    const crashed = code !== 0 && code !== null;
    botLog(botId, `⏹ Processus terminé (code ${code})`, crashed ? "error" : "info");
    botStatus(botId, crashed ? "crashed" : "stopped");

    // Auto-restart si activé
    if (crashed && bot.config.autoRestart) {
      botLog(botId, "🔄 Redémarrage automatique dans 3s...", "info");
      setTimeout(() => startBot(botId), 3000);
    }
  });
}

// ── Arrêter un bot ────────────────────────────────────────────────────────────
function stopBot(botId) {
  const bot = bots[botId];
  if (!bot || !bot.process) return;
  botLog(botId, "🛑 Arrêt du bot...", "info");
  treeKill(bot.process.pid, "SIGTERM");
}

// ── Charger les bots existants au démarrage ───────────────────────────────────
function loadExistingBots() {
  if (!fs.existsSync(BOTS_DIR)) return;
  fs.readdirSync(BOTS_DIR).forEach((name) => {
    const dir = path.join(BOTS_DIR, name);
    if (!fs.statSync(dir).isDirectory()) return;
    const cfgPath = path.join(dir, "deployer.json");
    const config = fs.existsSync(cfgPath)
      ? JSON.parse(fs.readFileSync(cfgPath, "utf8"))
      : { name, entry: "" };
    bots[name] = { process: null, status: "stopped", logs: [], config };
  });
}

// ── Routes API ────────────────────────────────────────────────────────────────

// Lister les bots
app.get("/api/bots", (_, res) => {
  const list = Object.entries(bots).map(([id, b]) => ({
    id,
    name: b.config.name || id,
    status: b.status,
    entry: b.config.entry || "",
    autoRestart: b.config.autoRestart || false,
    env: b.config.env || {},
  }));
  res.json(list);
});

// Logs d'un bot
app.get("/api/bots/:id/logs", (req, res) => {
  const bot = bots[req.params.id];
  if (!bot) return res.status(404).json({ error: "Bot introuvable" });
  res.json(bot.logs);
});

// Déployer un bot (upload ZIP)
app.post("/api/deploy", upload.single("archive"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Aucun fichier" });

  const rawName = req.body.name || path.basename(req.file.originalname, ".zip");
  const botId = rawName.replace(/[^a-zA-Z0-9_-]/g, "_").toLowerCase();
  const botDir = path.join(BOTS_DIR, botId);

  try {
    // Stopper l'ancienne instance si elle tourne
    if (bots[botId]?.process) stopBot(botId);
    await new Promise((r) => setTimeout(r, 500));

    // Extraire le ZIP
    fs.mkdirSync(botDir, { recursive: true });
    await extract(req.file.path, { dir: botDir });
    fs.unlinkSync(req.file.path);

    // Si le ZIP contient un sous-dossier unique, on remonte d'un niveau
    const contents = fs.readdirSync(botDir);
    if (contents.length === 1) {
      const sub = path.join(botDir, contents[0]);
      if (fs.statSync(sub).isDirectory()) {
        fs.readdirSync(sub).forEach((f) =>
          fs.renameSync(path.join(sub, f), path.join(botDir, f))
        );
        fs.rmdirSync(sub);
      }
    }

    // Lire ou créer deployer.json
    const cfgPath = path.join(botDir, "deployer.json");
    const config = fs.existsSync(cfgPath)
      ? JSON.parse(fs.readFileSync(cfgPath, "utf8"))
      : { name: rawName, entry: "", autoRestart: false, env: {} };

    // Injecter les variables d'env supplémentaires depuis le form
    if (req.body.token) config.env = { ...config.env, DISCORD_TOKEN: req.body.token };
    if (req.body.env) {
      try {
        Object.assign(config.env, JSON.parse(req.body.env));
      } catch {}
    }

    config.name = config.name || rawName;
    fs.writeFileSync(cfgPath, JSON.stringify(config, null, 2));

    bots[botId] = { process: null, status: "deployed", logs: [], config };
    broadcast({ event: "deployed", botId, name: config.name });

    res.json({ success: true, botId, name: config.name });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Déployer un bot (depuis GitHub)
app.post("/api/deploy/github", async (req, res) => {
  const { repoUrl, name, token, env } = req.body;
  if (!repoUrl) return res.status(400).json({ error: "URL GitHub manquante" });

  const rawName = name || repoUrl.split("/").pop().replace(".git", "");
  const botId = rawName.replace(/[^a-zA-Z0-9_-]/g, "_").toLowerCase();
  const botDir = path.join(BOTS_DIR, botId);

  try {
    if (bots[botId]?.process) stopBot(botId);
    await new Promise((r) => setTimeout(r, 500));

    if (fs.existsSync(botDir)) {
      fs.rmSync(botDir, { recursive: true, force: true });
    }

    const clone = spawn("git", ["clone", repoUrl, botDir], { shell: true });
    clone.on("close", (code) => {
      if (code !== 0) {
        return res.status(500).json({ error: "Erreur lors du git clone. Vérifiez l'URL du dépôt." });
      }

      const cfgPath = path.join(botDir, "deployer.json");
      const config = { name: rawName, entry: "", autoRestart: false, env: {}, repoUrl };

      if (token) config.env.DISCORD_TOKEN = token;
      if (env) {
        try {
          Object.assign(config.env, JSON.parse(env));
        } catch {}
      }

      fs.writeFileSync(cfgPath, JSON.stringify(config, null, 2));

      bots[botId] = { process: null, status: "deployed", logs: [], config };
      broadcast({ event: "deployed", botId, name: config.name });

      res.json({ success: true, botId, name: config.name });
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Démarrer
app.post("/api/bots/:id/start", (req, res) => {
  if (!bots[req.params.id]) return res.status(404).json({ error: "Bot introuvable" });
  startBot(req.params.id);
  res.json({ ok: true });
});

// Arrêter
app.post("/api/bots/:id/stop", (req, res) => {
  if (!bots[req.params.id]) return res.status(404).json({ error: "Bot introuvable" });
  stopBot(req.params.id);
  res.json({ ok: true });
});

// Redémarrer
app.post("/api/bots/:id/restart", async (req, res) => {
  if (!bots[req.params.id]) return res.status(404).json({ error: "Bot introuvable" });
  stopBot(req.params.id);
  await new Promise((r) => setTimeout(r, 1000));
  startBot(req.params.id);
  res.json({ ok: true });
});

// Supprimer
app.delete("/api/bots/:id", (req, res) => {
  const botId = req.params.id;
  if (!bots[botId]) return res.status(404).json({ error: "Bot introuvable" });
  stopBot(botId);
  setTimeout(() => {
    const botDir = path.join(BOTS_DIR, botId);
    fs.rmSync(botDir, { recursive: true, force: true });
    delete bots[botId];
    broadcast({ event: "deleted", botId });
  }, 800);
  res.json({ ok: true });
});

// Mettre à jour la config
app.patch("/api/bots/:id/config", (req, res) => {
  const bot = bots[req.params.id];
  if (!bot) return res.status(404).json({ error: "Bot introuvable" });
  Object.assign(bot.config, req.body);
  const cfgPath = path.join(BOTS_DIR, req.params.id, "deployer.json");
  fs.writeFileSync(cfgPath, JSON.stringify(bot.config, null, 2));
  res.json({ ok: true });
});

// ── Démarrage ─────────────────────────────────────────────────────────────────
loadExistingBots();
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🚀 Discord Deployer lancé sur http://localhost:${PORT}\n`);
});
