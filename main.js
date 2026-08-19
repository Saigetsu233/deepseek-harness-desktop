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
 *            以及 DSH_DESKTOP_ICON / DSH_DESKTOP_BACKGROUND / DSH_DESKTOP_BACKGROUND_DIM
 *            / DSH_DESKTOP_CUSTOM_CSS / DSH_DESKTOP_WINDOW_BACKGROUND
 *  配置文件  %APPDATA%\DSH Desktop\config.json
 *  默认值    port=3080, workspace=用户主目录, dshCommand=dsh
 *
 * 自定义（都在 config.json 里）：
 *  icon            窗口/任务栏图标（png 或 ico 路径），默认用内置图标
 *  backgroundImage 背景图片路径，铺满窗口，UI 各面板自动变半透明露出背景
 *  backgroundDim   背景变暗程度 0-1（默认 0.45，保证文字可读）
 *  customCss       自定义 CSS 文件路径，页面加载后注入（高级玩法）
 *  windowBackground  窗口底色（加载期间/无背景图时可见），默认 #0b1220
 */

const { app, BrowserWindow, dialog, nativeImage, screen, shell } = require('electron');
const { spawn, execFileSync } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');

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
  const icon = process.env.DSH_DESKTOP_ICON ?? cfg.icon ?? '';
  const backgroundImage = process.env.DSH_DESKTOP_BACKGROUND ?? cfg.backgroundImage ?? '';
  const backgroundDim = Number(process.env.DSH_DESKTOP_BACKGROUND_DIM ?? cfg.backgroundDim ?? 0.45);
  const customCss = process.env.DSH_DESKTOP_CUSTOM_CSS ?? cfg.customCss ?? '';
  const windowBackground = process.env.DSH_DESKTOP_WINDOW_BACKGROUND ?? cfg.windowBackground ?? '#0b1220';
  return { port, workspace, dshCommand, icon, backgroundImage, backgroundDim, customCss, windowBackground, configFile: file };
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

/**
 * 应用界面自定义：背景图 + 面板半透明 + 自定义 CSS。
 * DSH Web UI 的背景色全部由 body 上的设计变量控制
 * （--dsw-alias-bg-base / --dsw-alias-bg-layer-* / --dsw-specific-*），
 * 所以把变量覆盖成半透明即可让背景图透出来，且明暗主题都能用。
 */
async function applyCustomizations(win, cfg) {
  const parts = [];

  if (cfg.backgroundImage && fs.existsSync(cfg.backgroundImage)) {
    const url = pathToFileURL(path.resolve(cfg.backgroundImage)).href;
    const dim = Math.min(0.9, Math.max(0, Number(cfg.backgroundDim) || 0.45));
    // 探测当前主题，选对应的面板底色（深色/浅色）
    const dark = await win.webContents
      .executeJavaScript(`document.body ? document.body.hasAttribute('data-ds-dark-theme') : true`)
      .catch(() => true);
    const layer = dark ? '13,17,23' : '249,250,251'; // 面板/侧栏底色
    const bubble = dark ? '22,27,34' : '255,255,255'; // 聊天气泡底色
    const panelA = (1 - dim * 0.6).toFixed(3);        // 面板不透明度
    const surfaceA = (1 - dim * 0.75).toFixed(3);     // 侧栏/输入区不透明度
    parts.push(`
      html {
        background:
          linear-gradient(rgba(0,0,0,${dim.toFixed(3)}), rgba(0,0,0,${dim.toFixed(3)})),
          url("${url}") center/cover no-repeat fixed !important;
        background-color: ${cfg.windowBackground} !important;
      }
      body { background: transparent !important; }
      body, body[data-ds-dark-theme] {
        --dsw-alias-bg-base: rgba(0,0,0,0) !important;
        --dsw-alias-bg-layer-1: rgba(${layer},${panelA}) !important;
        --dsw-alias-bg-layer-2: rgba(${layer},${panelA}) !important;
        --dsw-alias-bg-layer-3: rgba(${layer},${panelA}) !important;
        --dsw-specific-sidebar-fill: rgba(${layer},${surfaceA}) !important;
        --dsw-specific-bubble: rgba(${bubble},${surfaceA}) !important;
        --dsw-specific-input-major: rgba(${layer},${surfaceA}) !important;
      }
    `);
    log(`已启用背景图：${cfg.backgroundImage}（变暗 ${dim.toFixed(2)}，主题 ${dark ? 'dark' : 'light'}）`);
  }

  if (cfg.customCss && fs.existsSync(cfg.customCss)) {
    try {
      parts.push(fs.readFileSync(cfg.customCss, 'utf8'));
      log(`已加载自定义 CSS：${cfg.customCss}`);
    } catch (e) {
      log('读取自定义 CSS 失败:', e.message);
    }
  }

  if (parts.length) {
    try {
      await win.webContents.insertCSS(parts.join('\n'));
      log('自定义样式注入完成');
    } catch (e) {
      log('注入自定义样式失败:', e.message);
    }
  }
}

function createWindow(url, cfg) {
  const saved = loadWindowState();
  const bounds = clampBounds(saved);
  const builtinIcon = path.join(__dirname, 'build', 'icon.png');
  const iconPath = cfg.icon && fs.existsSync(cfg.icon) ? cfg.icon : builtinIcon;
  const icon = nativeImage.createFromPath(iconPath);

  const win = new BrowserWindow({
    ...bounds,
    minWidth: 960,
    minHeight: 600,
    autoHideMenuBar: true,
    backgroundColor: cfg.windowBackground || '#0b1220',
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

  // 页面加载过程日志（排障用，平时也能看到）
  win.webContents.on('did-finish-load', () => log(`页面加载完成：${url}`));
  win.webContents.on('did-fail-load', (_e, code, desc, failedUrl) => {
    log(`页面加载失败 (${code}) ${desc}：${failedUrl}`);
  });
  win.webContents.on('render-process-gone', (_e, details) => {
    log(`渲染进程异常退出：${details.reason} (exitCode=${details.exitCode})`);
  });

  win.loadURL(url).then(() => applyCustomizations(win, cfg)).catch((e) => {
    log('页面加载异常:', e.message);
  });

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

    mainWindow = createWindow(url, cfg);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow(url, cfg);
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
