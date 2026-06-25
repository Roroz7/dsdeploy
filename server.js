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
const crypto = require("crypto");
const cron = require("node-cron");

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin";
const AUTH_TOKEN = crypto.createHash("sha256").update(ADMIN_PASSWORD + "deployer_salt").digest("hex");
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || null;

async function sendWebhook(title, description, color) {
  if (!DISCORD_WEBHOOK_URL) return;
  try {
    await fetch(DISCORD_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ embeds: [{ title, description, color }] })
    });
  } catch (err) {
    console.error("Webhook failed:", err);
  }
}

const app = express();
const server = http.createServer(app);

// ── Fichiers (Web IDE) ────────────────────────────────────────────────────────

function walkDir(dir, baseDir = dir) {
  let results = [];
  const list = fs.readdirSync(dir);
  list.forEach((file) => {
    if (file === "node_modules" || file === "venv" || file === ".git" || file === "__pycache__") return;
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);
    if (stat && stat.isDirectory()) {
      results = results.concat(walkDir(fullPath, baseDir));
    } else {
      results.push(path.relative(baseDir, fullPath).replace(/\\/g, "/"));
    }
  });
  return results;
}

app.get("/api/bots/:id/files", authMiddleware, (req, res) => {
  const botDir = path.join(BOTS_DIR, req.params.id);
  if (!fs.existsSync(botDir)) return res.status(404).json({ error: "Dossier introuvable" });
  try {
    const files = walkDir(botDir);
    res.json(files);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/bots/:id/files/read", authMiddleware, (req, res) => {
  const filePath = req.query.path;
  if (!filePath || filePath.includes("..")) return res.status(400).json({ error: "Chemin invalide" });
  const fullPath = path.join(BOTS_DIR, req.params.id, filePath);
  if (!fs.existsSync(fullPath)) return res.status(404).json({ error: "Fichier introuvable" });
  try {
    res.send(fs.readFileSync(fullPath, "utf8"));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put("/api/bots/:id/files/write", authMiddleware, (req, res) => {
  const filePath = req.body.path;
  const content = req.body.content;
  if (!filePath || filePath.includes("..")) return res.status(400).json({ error: "Chemin invalide" });
  const fullPath = path.join(BOTS_DIR, req.params.id, filePath);
  try {
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, "utf8");
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const wss = new ws.WebSocketServer({ server });

app.use(express.json());
app.use(express.static("public"));

function authMiddleware(req, res, next) {
  if (req.headers.authorization !== AUTH_TOKEN) {
    return res.status(401).json({ error: "Non autorisé" });
  }
  next();
}

app.post("/api/login", (req, res) => {
  if (req.body.password === ADMIN_PASSWORD) {
    res.json({ token: AUTH_TOKEN });
  } else {
    res.status(401).json({ error: "Mot de passe incorrect" });
  }
});

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

  if (language === "node") {
    if (fs.existsSync(pkgPath)) {
      botLog(botId, "📦 Installation des dépendances (npm)...", "info");
      const install = spawn("npm", ["install", "--silent"], { cwd: botDir, shell: true });
      install.stdout.on("data", (d) => d.toString().split("\n").filter(Boolean).forEach((l) => botLog(botId, l, "log")));
      install.stderr.on("data", (d) => d.toString().split("\n").filter(Boolean).forEach((l) => botLog(botId, l, "error")));
      install.on("close", (code) => {
        if (code !== 0) {
          botLog(botId, "❌ npm install a échoué", "error");
          botStatus(botId, "error");
          return;
        }
        botLog(botId, "✅ Dépendances installées", "info");
        _spawnBot(botId, language, entry);
      });
    } else {
      botLog(botId, "📦 Génération automatique de package.json et installation de discord.js...", "info");
      const install = spawn("npm", ["init", "-y", "&&", "npm", "install", "discord.js", "dotenv", "--silent"], { cwd: botDir, shell: true });
      install.stdout.on("data", (d) => d.toString().split("\n").filter(Boolean).forEach((l) => botLog(botId, l, "log")));
      install.stderr.on("data", (d) => d.toString().split("\n").filter(Boolean).forEach((l) => botLog(botId, l, "error")));
      install.on("close", (code) => {
        _spawnBot(botId, language, entry);
      });
    }
  } else if (language === "python") {
    _setupPythonVenvAndSpawn(botId, botDir, language, entry);
  } else {
    _spawnBot(botId, language, entry);
  }
}

function _setupPythonVenvAndSpawn(botId, botDir, language, entry) {
  const venvDir = path.join(botDir, "venv");
  const sysPython = process.env.PYTHON_CMD || (process.platform === "win32" ? "python" : "python3");
  
  if (!fs.existsSync(venvDir)) {
    botLog(botId, "📦 Création de l'environnement virtuel (venv)...", "info");
    const venv = spawn(sysPython, ["-m", "venv", "venv"], { cwd: botDir, shell: true });
    venv.stdout.on("data", (d) => d.toString().split("\n").filter(Boolean).forEach((l) => botLog(botId, l, "log")));
    venv.stderr.on("data", (d) => d.toString().split("\n").filter(Boolean).forEach((l) => botLog(botId, l, "error")));
    venv.on("close", (code) => {
      if (code !== 0) {
        botLog(botId, "❌ Erreur lors de la création du venv", "error");
        botStatus(botId, "error");
        return;
      }
      _checkReqsAndInstall(botId, botDir, language, entry);
    });
  } else {
    _checkReqsAndInstall(botId, botDir, language, entry);
  }
}

function _checkReqsAndInstall(botId, botDir, language, entry) {
  const reqPath = path.join(botDir, "requirements.txt");
  const isWin = process.platform === "win32";
  const venvPython = isWin ? path.join(botDir, "venv", "Scripts", "python") : path.join(botDir, "venv", "bin", "python");

  if (!fs.existsSync(reqPath)) {
    botLog(botId, "🔍 Génération automatique des dépendances...", "info");
    const reqs = spawn(`${venvPython} -m pip install pipreqs && ${venvPython} -m pipreqs.pipreqs . --force`, [], { cwd: botDir, shell: true });
    reqs.on("close", () => {
       _installPythonDepsAndSpawn(botId, botDir, language, entry, venvPython);
    });
  } else {
     _installPythonDepsAndSpawn(botId, botDir, language, entry, venvPython);
  }
}

function _installPythonDepsAndSpawn(botId, botDir, language, entry, venvPython) {
  const reqPath = path.join(botDir, "requirements.txt");
  if (!fs.existsSync(reqPath)) {
    _spawnBot(botId, language, entry, venvPython);
    return;
  }
  
  botLog(botId, "📦 Installation des dépendances (pip)...", "info");
  const install = spawn(venvPython, ["-m", "pip", "install", "-r", "requirements.txt"], { cwd: botDir, shell: true });
  install.on("close", (code) => {
    if (code !== 0) {
      botLog(botId, "❌ pip install a échoué", "error");
      botStatus(botId, "error");
      return;
    }
    botLog(botId, "✅ Dépendances installées", "info");
    _spawnBot(botId, language, entry, venvPython);
  });
}

function _spawnBot(botId, language, entry, venvPython = null) {
  const bot = bots[botId];
  const botDir = path.join(BOTS_DIR, botId);

  const env = {
    ...process.env,
    ...(bot.config.env || {}),
    NODE_ENV: "production",
  };

  const command = language === "python" ? (venvPython || "python") : "node";
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
    if (crashed) {
      const lastLogs = bot.logs.filter(l => l.type === 'error').slice(-5).map(l => l.line).join("\\n");
      sendWebhook(`❌ Crash: ${bot.config.name || botId}`, `Le processus s'est arrêté avec une erreur.\n\`\`\`\n${lastLogs.substring(0, 1000)}\n\`\`\``, 0xda373c);
      
      if (bot.config.autoRestart) {
        botLog(botId, "🔄 Redémarrage automatique dans 3s...", "info");
        setTimeout(() => startBot(botId), 3000);
      }
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
app.get("/api/bots", authMiddleware, (_, res) => {
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
app.get("/api/bots/:id/logs", authMiddleware, (req, res) => {
  const bot = bots[req.params.id];
  if (!bot) return res.status(404).json({ error: "Bot introuvable" });
  res.json(bot.logs);
});

// STDIN
app.post("/api/bots/:id/stdin", authMiddleware, (req, res) => {
  const bot = bots[req.params.id];
  if (bot?.process) {
    bot.process.stdin.write(req.body.input + "\n");
    res.json({ ok: true });
  } else res.status(400).json({ error: "Bot non actif" });
});

// Déployer un bot (upload ZIP)
app.post("/api/deploy", authMiddleware, upload.single("archive"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Aucun fichier" });

  const rawName = req.body.name || path.basename(req.file.originalname, ".zip");
  const botId = rawName.replace(/[^a-zA-Z0-9_-]/g, "_").toLowerCase();
  const botDir = path.join(BOTS_DIR, botId);
  const tmpDir = path.join(BOTS_DIR, `${botId}_tmp`);

  try {
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.mkdirSync(tmpDir, { recursive: true });
    await extract(req.file.path, { dir: tmpDir });
    fs.unlinkSync(req.file.path);

    const contents = fs.readdirSync(tmpDir);
    if (contents.length === 1 && fs.statSync(path.join(tmpDir, contents[0])).isDirectory()) {
      const sub = path.join(tmpDir, contents[0]);
      fs.readdirSync(sub).forEach((f) => fs.renameSync(path.join(sub, f), path.join(tmpDir, f)));
      fs.rmdirSync(sub);
    }

    const cfgPath = path.join(tmpDir, "deployer.json");
    const config = fs.existsSync(cfgPath)
      ? JSON.parse(fs.readFileSync(cfgPath, "utf8"))
      : { name: rawName, entry: null, autoRestart: false, env: {} };
    config.projectType = req.body.projectType || config.projectType || 'bot';

    if (req.body.token) config.env = { ...config.env, DISCORD_TOKEN: req.body.token };
    if (req.body.env) {
      try { Object.assign(config.env, JSON.parse(req.body.env)); } catch {}
    }
    fs.writeFileSync(cfgPath, JSON.stringify(config, null, 2));

    // Zero Downtime Swap
    if (bots[botId]?.process) stopBot(botId);
    await new Promise((r) => setTimeout(r, 500));
    
    if (fs.existsSync(botDir)) fs.rmSync(botDir, { recursive: true, force: true });
    fs.renameSync(tmpDir, botDir);

    bots[botId] = { process: null, status: "deployed", logs: [], config };
    broadcast({ event: "deployed", botId, name: config.name });

    res.json({ success: true, botId, name: config.name });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Déployer un bot (depuis GitHub)
app.post("/api/deploy/github", authMiddleware, async (req, res) => {
  const { repoUrl, name, token, env } = req.body;
  if (!repoUrl) return res.status(400).json({ error: "URL GitHub manquante" });

  const rawName = name || repoUrl.split("/").pop().replace(".git", "");
  const botId = rawName.replace(/[^a-zA-Z0-9_-]/g, "_").toLowerCase();
  const botDir = path.join(BOTS_DIR, botId);
  const tmpDir = path.join(BOTS_DIR, `${botId}_tmp`);

  try {
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });

    const clone = spawn("git", ["clone", repoUrl, tmpDir], { shell: true });
    clone.on("close", async (code) => {
      if (code !== 0) {
        return res.status(500).json({ error: "Erreur lors du git clone. Vérifiez l'URL du dépôt." });
      }

      const cfgPath = path.join(tmpDir, "deployer.json");
      const config = { name: rawName, entry: "", autoRestart: false, env: {}, repoUrl, projectType: req.body.projectType || 'bot' };

      if (token) config.env.DISCORD_TOKEN = token;
      if (env) {
        try { Object.assign(config.env, JSON.parse(env)); } catch {}
      }

      fs.writeFileSync(cfgPath, JSON.stringify(config, null, 2));

      // Zero Downtime Swap
      if (bots[botId]?.process) stopBot(botId);
      await new Promise((r) => setTimeout(r, 500));
      
      if (fs.existsSync(botDir)) fs.rmSync(botDir, { recursive: true, force: true });
      fs.renameSync(tmpDir, botDir);

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
app.post("/api/bots/:id/start", authMiddleware, (req, res) => {
  if (!bots[req.params.id]) return res.status(404).json({ error: "Bot introuvable" });
  startBot(req.params.id);
  res.json({ ok: true });
});

// Arrêter
app.post("/api/bots/:id/stop", authMiddleware, (req, res) => {
  if (!bots[req.params.id]) return res.status(404).json({ error: "Bot introuvable" });
  stopBot(req.params.id);
  res.json({ ok: true });
});

// Redémarrer
app.post("/api/bots/:id/restart", authMiddleware, async (req, res) => {
  if (!bots[req.params.id]) return res.status(404).json({ error: "Bot introuvable" });
  stopBot(req.params.id);
  await new Promise((r) => setTimeout(r, 1000));
  startBot(req.params.id);
  res.json({ ok: true });
});

// Supprimer
app.delete("/api/bots/:id", authMiddleware, (req, res) => {
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

// Mettre à jour la Config
app.patch("/api/bots/:id/config", authMiddleware, (req, res) => {
  const bot = bots[req.params.id];
  if (!bot) return res.status(404).json({ error: "Bot introuvable" });

  if (req.body.entry !== undefined) bot.config.entry = req.body.entry;
  if (req.body.autoRestart !== undefined) bot.config.autoRestart = req.body.autoRestart;
  if (req.body.env !== undefined) bot.config.env = req.body.env;
  if (req.body.projectType !== undefined) bot.config.projectType = req.body.projectType;
  if (req.body.cron !== undefined) {
    bot.config.cron = req.body.cron;
    scheduleCron(req.params.id);
  }

  saveBots();
  res.json({ ok: true });
});

// ── Démarrage ─────────────────────────────────────────────────────────────────
loadExistingBots();
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🚀 Discord Deployer lancé sur http://localhost:${PORT}\n`);
});
