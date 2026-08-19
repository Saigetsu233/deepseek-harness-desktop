'use strict';

/**
 * DSH Desktop — DeepSeek Harness Web UI 的桌面壳（Electron）。
 *
 * 职责：
 *  1. 检测 http://127.0.0.1:<port> 是否已有 DSH Web 服务在运行（例如你已手动
 *     启动过 `dsh web`）。有则直接复用，不重复启动、退出时也不去停它。
 *  2. 没有则自动启动 `dsh web --port <port>`（配置的工作目录作为 workspace 根），
 *     等端口就绪后打开窗口；关闭应用时自动把启动的 dsh 进程连同其子进程一起停掉。
 *  3. 打开一个原生窗口承载该地址（无地址栏、外链走系统浏览器、记住窗口位置）。
 *
 * 配置（按优先级从高到低）：
 *  环境变量  DSH_DESKTOP_PORT / DSH_DESKTOP_WORKSPACE / DSH_DESKTOP_COMMAND
 *  配置文件  %APPDATA%\DSH Desktop\config.json  （{"port":3080,"workspace":"...","dshCommand":"dsh"}）
 *  默认值    port=3080, workspace=用户主目录, dshCommand=dsh
 */

const { app, BrowserWindow, dialog, nativeImage, screen, shell } = require('electron');
const { spawn, execFileSync } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const DEFAULT_PORT = 3080;
const READY_TIMEOUT_MS = 90 * 1000; // 等待 dsh 启动就绪的最长时间
const PROBE_TIMEOUT_MS = 1500;      // 每次探测端口的超时

// ── 日志（同时写文件，方便排查）──────────────────────────────────────────────
let logStream = null;
function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}`;
  console.log(line);
  if (logStream) {
    try { logStream.write(line + '\n'); } catch { /* 忽略写日志失败 */ }
  }
}

// ── 配置 ────────────────────────────────────────────────────────────────────
function loadConfig() {
  const userData = app.getPath('userData');
  const file = path.join(userData, 'config.json');
  let cfg = {};
  if (fs.existsSync(file)) {
    try {
      cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
      log(`已读取配置 ${file}`);
    } catch (e) {
      log('config.json 解析失败，使用默认配置:', e.message);
    }
  }
  const port = Number(process.env.DSH_DESKTOP_PORT ?? cfg.port ?? DEFAULT_PORT);
  const workspace = process.env.DSH_DESKTOP_WORKSPACE ?? cfg.workspace ?? os.homedir();
  const dshCommand = process.env.DSH_DESKTOP_COMMAND ?? cfg.dshCommand ?? 'dsh';
  return { port, workspace, dshCommand, configFile: file };
}

// ── 端口探测：确认是「DeepSeek Harness」本尊而不是别的服务 ─────────────────
function probe(port, timeoutMs = PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: timeoutMs }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size < 128 * 1024) chunks.push(c); else req.destroy();
      });
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        resolve(res.statusCode >= 200 && res.statusCode < 500 && /DeepSeek Harness/i.test(body));
      });
      res.on('error', () => resolve(false));
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function tail(lines, n = 20) {
  return lines.slice(-n).join('\n');
}

// ── dsh 服务生命周期 ────────────────────────────────────────────────────────
let serverChild = null; // 只有「我们自己启动的」dsh 进程才非空
let ownsServer = false;
let quitting = false;

function killServerTree() {
  if (!serverChild) return;
  const pid = serverChild.pid;
  log(`正在停止自启的 dsh 服务 (pid ${pid}) ...`);
  try { serverChild.kill(); } catch { /* 忽略 */ }
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } catch { /* 进程可能已退出 */ }
  }
  serverChild = null;
  ownsServer = false;
}

async function ensureServer(cfg) {
  if (!fs.existsSync(cfg.workspace)) {
    throw new Error(`工作目录不存在：${cfg.workspace}\n请在配置中修改 workspace（见 ${cfg.configFile}）。`);
  }
  if (!Number.isInteger(cfg.port) || cfg.port < 1 || cfg.port > 65535) {
    throw new Error(`无效端口：${cfg.port}（应为 1-65535 的整数）`);
  }

  // 1) 已有实例则复用
  if (await probe(cfg.port)) {
    log(`http://127.0.0.1:${cfg.port} 已有 DSH Web 服务，直接复用（退出时不会停止它）`);
    return `http://127.0.0.1:${cfg.port}`;
  }

  // 2) 启动自己的 dsh web
  log(`启动 dsh web（端口 ${cfg.port}，workspace "${cfg.workspace}"，命令 "${cfg.dshCommand}"）`);
  let spawnFailed = false;
  serverChild = spawn(cfg.dshCommand, ['web', '--port', String(cfg.port)], {
    cwd: cfg.workspace,
    shell: true,
    windowsHide: true,
  });
  ownsServer = true;

  const out = [];
  serverChild.stdout?.on('data', (d) => {
    const s = d.toString();
    out.push(s);
    log('[dsh]', s.trimEnd());
  });
  serverChild.stderr?.on('data', (d) => {
    const s = d.toString();
    out.push(s);
    log('[dsh]', s.trimEnd());
  });
  serverChild.on('error', (err) => {
    spawnFailed = true;
    log('无法启动 dsh 进程:', err.message);
  });
  serverChild.on('exit', (code) => {
    log(`dsh 进程退出，code=${code}`);
    if (ownsServer && !quitting && code !== 0) {
      showFatal(`dsh web 启动失败（退出码 ${code}）。\n\n` +
        `请先在命令行手动执行 "${cfg.dshCommand} web" 确认可用。\n` +
        `最近输出：\n${tail(out)}`);
    }
    if (ownsServer) { serverChild = null; ownsServer = false; }
  });

  // 3) 等待端口就绪
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await probe(cfg.port)) {
      log(`DSH Web 服务就绪：http://127.0.0.1:${cfg.port}`);
      return `http://127.0.0.1:${cfg.port}`;
    }
    if (spawnFailed) {
      throw new Error(`无法启动 "${cfg.dshCommand}"。请确认 dsh 已安装且在 PATH 中（命令行执行 ${cfg.dshCommand} 测试）。`);
    }
    if (serverChild.exitCode !== null) {
      throw new Error(`dsh web 提前退出（code ${serverChild.exitCode}）。\n最近输出：\n${tail(out)}`);
    }
    await sleep(500);
  }
  throw new Error(`等待 DSH Web 服务超时（${READY_TIMEOUT_MS / 1000}s）。\n最近输出：\n${tail(out)}`);
}

// ── 窗口 ────────────────────────────────────────────────────────────────────
let mainWindow = null;

function loadWindowState() {
  try {
    const f = path.join(app.getPath('userData'), 'window-state.json');
    if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch { /* 忽略 */ }
  return {};
}

function clampBounds(saved) {
  const rect = {
    x: Number.isFinite(saved.x) ? saved.x : 100,
    y: Number.isFinite(saved.y) ? saved.y : 100,
    width: Number.isFinite(saved.width) && saved.width >= 640 ? saved.width : 1360,
    height: Number.isFinite(saved.height) && saved.height >= 480 ? saved.height : 860,
  };
  const area = screen.getDisplayMatching(rect).workArea;
  const width = Math.min(rect.width, area.width);
  const height = Math.min(rect.height, area.height);
  const x = Math.max(area.x, Math.min(rect.x, area.x + area.width - width));
  const y = Math.max(area.y, Math.min(rect.y, area.y + area.height - height));
  return { x, y, width, height };
}

function createWindow(url) {
  const saved = loadWindowState();
  const bounds = clampBounds(saved);
  const icon = nativeImage.createFromPath(path.join(__dirname, 'build', 'icon.png'));

  const win = new BrowserWindow({
    ...bounds,
    minWidth: 960,
    minHeight: 600,
    autoHideMenuBar: true,
    backgroundColor: '#0b1220',
    title: 'DSH Desktop',
    icon: icon.isEmpty() ? undefined : icon,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  if (saved.maximized) win.maximize();

  // 冒烟测试钩子：DSH_DESKTOP_SMOKE_TEST=1 时，页面加载后 8 秒自动退出（仅用于自动化验证）
  if (process.env.DSH_DESKTOP_SMOKE_TEST === '1') {
    win.webContents.once('did-finish-load', () => {
      log('SMOKE TEST: 页面加载完成，8 秒后自动退出');
      setTimeout(() => app.quit(), 8000);
    });
  }

  win.loadURL(url);

  // 同源（本服务内的）弹窗/跳转放行；跨源的一律交给系统默认浏览器
  const isSameOrigin = (target) => {
    try { return new URL(target).origin === new URL(url).origin; } catch { return false; }
  };
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (isSameOrigin(target)) return {}; // 允许
    shell.openExternal(target);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, target) => {
    if (!isSameOrigin(target)) {
      event.preventDefault();
      shell.openExternal(target);
    }
  });

  // 记住窗口位置/大小/最大化状态
  const saveState = () => {
    if (win.isDestroyed()) return;
    try {
      fs.writeFileSync(
        path.join(app.getPath('userData'), 'window-state.json'),
        JSON.stringify({ ...win.getBounds(), maximized: win.isMaximized() })
      );
    } catch { /* 忽略 */ }
  };
  win.on('close', saveState);
  win.on('closed', () => { mainWindow = null; });

  return win;
}

function showFatal(message) {
  log('FATAL:', message);
  dialog.showErrorBox('DSH Desktop', message);
}

// ── 应用生命周期 ────────────────────────────────────────────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    app.setAppUserModelId('com.deepseek.dsh.desktop');
    logStream = fs.createWriteStream(path.join(app.getPath('userData'), 'server.log'), { flags: 'a' });
    log('=== DSH Desktop 启动 ===');

    const cfg = loadConfig();
    let url;
    try {
      url = await ensureServer(cfg);
    } catch (err) {
      killServerTree(); // 兜底：若服务已拉起但校验失败，也要清理
      showFatal(err.message);
      app.exit(1);
      return;
    }

    mainWindow = createWindow(url);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow(url);
    });
  });
}

app.on('window-all-closed', () => {
  app.quit();
});

app.on('before-quit', () => {
  quitting = true;
  killServerTree();
});

process.on('exit', () => {
  try { logStream?.end(); } catch { /* 忽略 */ }
});
