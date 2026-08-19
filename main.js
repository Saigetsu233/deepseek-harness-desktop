'use strict';

/**
 * DSH Desktop — DeepSeek Harness Web UI 的桌面壳（Electron）。
 *
 * 职责：
 *  1. 检测 http://127.0.0.1:<port> 是否已有 DSH Web 服务在运行（例如你已手动
 *     启动过 `dsh web`）。有则直接复用，不重复启动、退出时也不去停它。
 *  2. dsh 命令自动就绪：检测顺序为 应用自带安装 → 系统 PATH → 都没有则弹出
 *     进度窗口自动 npm 安装（装到应用用户目录，无需管理员权限）。
 *  3. 启动 `dsh web --port <port>`（配置的工作目录作为 workspace 根），
 *     等端口就绪后打开窗口；关闭窗口=隐藏到托盘继续后台运行，
 *     只有托盘菜单"退出"才真正退出并停止自启的 dsh 进程（连同子进程）。
 *  4. 渲染进程崩溃/页面加载失败会自动重载恢复，不会整个窗口消失。
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

const { app, BrowserWindow, dialog, Menu, nativeImage, screen, shell, Tray } = require('electron');
const { spawn, spawnSync, execFileSync } = require('node:child_process');
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
/**
 * 默认工作区探测：读取 $DSH_HOME/storages/workspace.json，
 * 取最近使用的工作区路径（即 dsh 上次实际运行/用户上次工作的目录），
 * 这样桌面应用自启的服务和用户原工作区一致，重启后会话不会"消失"。
 */
function detectDefaultWorkspace() {
  try {
    const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
    const f = path.join(dshHome, 'storages', 'workspace.json');
    if (!fs.existsSync(f)) return '';
    const data = JSON.parse(fs.readFileSync(f, 'utf8'));
    const ids = data?.global?.workspaceIds || [];
    for (const id of ids) {
      const ws = data?.tables?.workspaces?.[id];
      if (ws?.path && fs.existsSync(ws.path)) return ws.path;
    }
  } catch { /* 忽略，回退默认 */ }
  return '';
}

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
  // workspace：显式配置/环境变量 > 最近使用的工作区 > 用户主目录
  const explicitWorkspace = process.env.DSH_DESKTOP_WORKSPACE !== undefined || cfg.workspace !== undefined;
  const detected = explicitWorkspace ? '' : detectDefaultWorkspace();
  const workspace = process.env.DSH_DESKTOP_WORKSPACE ?? cfg.workspace ?? detected ?? os.homedir();
  if (!explicitWorkspace && detected) log(`工作区未配置，自动采用最近使用的工作区：${detected}`);
  // dshCommand：显式指定（含环境变量）则尊重；否则走"自动"（本地安装 → PATH → 自动安装）
  const explicitDsh = process.env.DSH_DESKTOP_COMMAND !== undefined || cfg.dshCommand !== undefined;
  const dshCommand = explicitDsh ? (process.env.DSH_DESKTOP_COMMAND ?? cfg.dshCommand ?? 'dsh') : 'auto';
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

/** 给含空格的参数加引号（供 shell:true 的 spawn 使用，避免路径被空格截断） */
function q(s) {
  return /\s/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s;
}

/** 用 where 解析可执行文件全路径（Windows） */
function resolveExecutable(name) {
  try {
    const r = spawnSync('where', [name], { shell: true, windowsHide: true, encoding: 'utf8' });
    if (r.status === 0 && r.stdout) {
      const first = r.stdout.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
      if (first) return first;
    }
  } catch { /* 忽略 */ }
  return '';
}

function tail(lines, n = 20) {
  return lines.slice(-n).join('\n');
}

// ── dsh 探测与自动安装 ──────────────────────────────────────────────────────
// 应用自带一份 dsh 安装在 userData/dsh-install（用户目录，无需管理员权限）；
// 检测顺序：本地安装 → 系统 PATH → 都没有则自动 npm 安装。
const localDshDir = () => path.join(app.getPath('userData'), 'dsh-install');

function localDshCmd() {
  const dir = localDshDir();
  const win = path.join(dir, 'node_modules', '.bin', 'dsh.cmd');
  const unix = path.join(dir, 'node_modules', '.bin', 'dsh');
  return process.platform === 'win32'
    ? (fs.existsSync(win) ? win : '')
    : (fs.existsSync(unix) ? unix : '');
}

/** 探测某个 dsh 命令是否可用（--help 能正常退出即认为可用） */
function dshExists(command, timeoutMs = 5000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => { if (!done) { done = true; resolve(ok); } };
    try {
      // 路径含空格时给 shell 加引号；普通命令名直接传
      const cmd = /\s/.test(command) ? `"${command}"` : command;
      const child = spawn(cmd, ['--help'], { shell: true, windowsHide: true, stdio: 'ignore' });
      const timer = setTimeout(() => { try { child.kill(); } catch {} finish(false); }, timeoutMs);
      child.on('error', () => { clearTimeout(timer); finish(false); });
      child.on('exit', (code) => { clearTimeout(timer); finish(code === 0); });
    } catch {
      finish(false);
    }
  });
}

const INSTALL_HTML = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><style>
  body{margin:0;padding:20px;background:#0b1220;color:#e6edf3;font:13px/1.7 "Microsoft YaHei",system-ui,sans-serif}
  h1{font-size:15px;margin:0 0 12px}
  pre{background:#060a12;border:1px solid #243049;border-radius:8px;padding:12px;height:230px;overflow:auto;font-size:12px;color:#9fb3c8;white-space:pre-wrap;word-break:break-all}
  p{font-size:12px;color:#76839a;margin:12px 0 0}
</style></head><body>
<h1>首次运行：自动安装 DSH（DeepSeek Harness）</h1>
<pre id="log"></pre>
<p>安装完成后会自动启动，全程无需手动配置。</p>
<script>
function appendLog(t){var el=document.getElementById('log');el.textContent+=(el.textContent?'\\n':'')+t;el.scrollTop=el.scrollHeight;}
</script></body></html>`;

/** 自动安装 dsh 到应用目录；返回是否成功 */
async function autoInstallDsh() {
  const dir = localDshDir();
  log(`未检测到 dsh，开始自动安装到 ${dir}`);
  const win = new BrowserWindow({
    width: 560, height: 400, resizable: false, autoHideMenuBar: true,
    backgroundColor: '#0b1220', title: '安装 DSH…',
  });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(INSTALL_HTML));
  const showLog = (t) => {
    if (win.isDestroyed()) return;
    win.webContents.executeJavaScript(`appendLog(${JSON.stringify(String(t).slice(0, 400))})`).catch(() => {});
  };
  showLog('正在执行：本地安装 @deepseek-ai/dsh …');
  const ok = await new Promise((resolve) => {
    const npmCmd = resolveExecutable('npm.cmd') || resolveExecutable('npm');
    if (!npmCmd) {
      showLog('找不到 npm，请先安装 Node.js（https://nodejs.org）后重试。');
      resolve(false);
      return;
    }
    // 显式给每个含空格的参数加引号（--prefix 目标目录含空格，shell 拼接时会截断）
    const cmdline = [q(npmCmd), 'install', '--prefix', q(dir), '--no-audit', '--no-fund', '@deepseek-ai/dsh'].join(' ');
    const child = spawn(cmdline, {
      shell: true,
      windowsHide: true,
      env: { ...process.env, npm_config_cache: path.join(dir, '.npm-cache') },
    });
    child.stdout?.on('data', (d) => showLog(d.toString()));
    child.stderr?.on('data', (d) => showLog(d.toString()));
    child.on('error', (err) => {
      showLog('无法启动 npm：' + err.message);
      resolve(false);
    });
    child.on('exit', (code) => {
      showLog(code === 0 ? '安装完成 ✓' : '安装失败（退出码 ' + code + '）');
      resolve(code === 0);
    });
  });
  if (!win.isDestroyed()) win.destroy();
  return ok && !!localDshCmd();
}

/** 从某个路径向上找最近的 node_modules 目录 */
function findNodeModulesUp(fromDir) {
  let cur = fromDir;
  for (let i = 0; i < 12; i++) {
    const nm = path.join(cur, 'node_modules');
    if (fs.existsSync(nm)) return nm;
    const parent = path.dirname(cur);
    if (parent === cur) return '';
    cur = parent;
  }
  return '';
}

/** 根据解析出的 dsh 命令，推导其安装目录下的 node_modules（插件部署目标） */
function dshNodeModulesDirOf(command) {
  try {
    if (command && command !== 'dsh') {
      if (fs.existsSync(command)) return findNodeModulesUp(path.dirname(command));
    }
    const r = spawnSync('where', ['dsh'], { shell: true, windowsHide: true, encoding: 'utf8' });
    if (r.status === 0 && r.stdout) {
      const first = r.stdout.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
      if (first && fs.existsSync(first)) return findNodeModulesUp(path.dirname(first));
    }
  } catch { /* 忽略 */ }
  return '';
}

// 插件源目录：开发模式在项目目录；打包后通过 extraResources 放在 asar 外的 resources 目录
//（asar 里的目录 fs.cpSync 会 ENOENT，所以必须用 asar 外的真实目录）
const PLUGIN_SRC = __dirname.includes('app.asar')
  ? path.join(process.resourcesPath, 'plugin-token-cost')
  : path.join(__dirname, 'plugin-token-cost');

/** 用户 dsh 主目录（$DSH_HOME 或 ~/.dsh） */
function dshHomeDir() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

/**
 * 安装 token-cost 插件（作为 profile bundle，这是 dsh 官方支持的第三方插件方式）：
 * 1. 把插件包复制到两处（都先删后拷，避免复制目录时嵌套）：
 *    - dsh 安装目录 node_modules（loader 裸包名解析 + 浏览器 manifest 扫描）
 *    - $DSH_HOME/profiles/web/node_modules（loader 的 profile 链解析）
 * 2. 把 "token-cost" 注册进 profile 的 dsh.profile.bundles，其 dsh.bundle.patch
 *    会把自己的 host/client 行插入组合树。
 * 失败不致命：应用照常可用，仅无费用统计插件。
 */
function deployPlugins(dshNodeModulesDir) {
  try {
    if (!fs.existsSync(PLUGIN_SRC)) return false;
    const targets = [];
    if (dshNodeModulesDir && fs.existsSync(dshNodeModulesDir)) {
      targets.push(path.join(dshNodeModulesDir, 'token-cost'));
    }
    const profileDir = path.join(dshHomeDir(), 'profiles', 'web');
    targets.push(path.join(profileDir, 'node_modules', 'token-cost'));
    for (const t of targets) {
      fs.rmSync(t, { recursive: true, force: true });
      fs.cpSync(PLUGIN_SRC, t, { recursive: true });
    }
    // 注册进 profile bundles（幂等）
    const manifestPath = path.join(profileDir, 'package.json');
    if (fs.existsSync(manifestPath)) {
      const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      m.dsh = m.dsh || {};
      m.dsh.profile = m.dsh.profile || {};
      m.dsh.profile.bundles = m.dsh.profile.bundles || [];
      if (!m.dsh.profile.bundles.includes('token-cost')) {
        m.dsh.profile.bundles.push('token-cost');
        fs.writeFileSync(manifestPath, JSON.stringify(m, null, 2));
      }
    }
    log('已安装 token-cost 插件（profile bundle）');
    return true;
  } catch (e) {
    log('安装 token-cost 插件失败（应用仍可正常使用）:', e.message);
    return false;
  }
}

/** 候选 dsh 命令：应用自带 → PATH → npm 全局 → npx 缓存（双击环境里 PATH 可能不含 npx） */
function dshCandidates() {
  const list = [];
  const local = localDshCmd();
  if (local) list.push(local);
  list.push('dsh');
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  list.push(path.join(appData, 'npm', 'node_modules', '.bin', 'dsh.cmd'));
  const localData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const npxRoot = path.join(localData, 'npm-cache', '_npx');
  try {
    if (fs.existsSync(npxRoot)) {
      for (const name of fs.readdirSync(npxRoot)) {
        list.push(path.join(npxRoot, name, 'node_modules', '.bin', 'dsh.cmd'));
      }
    }
  } catch { /* 忽略 */ }
  return list;
}

/** 解析最终使用的 dsh 命令（自动模式：自带 → PATH → npm 全局 → npx 缓存 → 自动安装） */
async function resolveDshCommand(cfg) {
  if (cfg.dshCommand !== 'auto') {
    return { command: cfg.dshCommand, nodeModulesDir: dshNodeModulesDirOf(cfg.dshCommand) };
  }
  for (const cand of dshCandidates()) {
    if (await dshExists(cand)) {
      log(`使用 dsh：${cand}`);
      return { command: cand, nodeModulesDir: dshNodeModulesDirOf(cand) };
    }
  }
  log('未检测到 dsh，尝试自动安装…');
  if (await autoInstallDsh()) {
    const cmd = localDshCmd();
    log(`自动安装完成，DSH 位于：${cmd}`);
    return { command: cmd, nodeModulesDir: findNodeModulesUp(path.dirname(cmd)) };
  }
  return null;
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
  const spawnArgs = ['web', '--port', String(cfg.port)];
  log(`启动 dsh web（端口 ${cfg.port}，workspace "${cfg.workspace}"，命令 "${cfg.dshCommand}"）`);
  let spawnFailed = false;
  const child = spawn(q(cfg.dshCommand), spawnArgs, {
    cwd: cfg.workspace,
    shell: true,
    windowsHide: true,
  });
  serverChild = child;
  ownsServer = true;

  const out = [];
  child.stdout?.on('data', (d) => {
    const s = d.toString();
    out.push(s);
    log('[dsh]', s.trimEnd());
  });
  child.stderr?.on('data', (d) => {
    const s = d.toString();
    out.push(s);
    log('[dsh]', s.trimEnd());
  });
  child.on('error', (err) => {
    spawnFailed = true;
    log('无法启动 dsh 进程:', err.message);
  });
  child.on('exit', (code) => {
    // 退出原因留档；自愈监控会负责重启（见 startMonitor）
    log(`dsh 进程退出，code=${code}。最近输出：\n${tail(out)}`);
    if (ownsServer) { serverChild = null; ownsServer = false; }
  });

  // 3) 等待端口就绪（用局部 child 引用，避免 exit 回调置空 serverChild 后空指针）
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await probe(cfg.port)) {
      log(`DSH Web 服务就绪：http://127.0.0.1:${cfg.port}`);
      return `http://127.0.0.1:${cfg.port}`;
    }
    if (spawnFailed) {
      throw new Error(`无法启动 "${cfg.dshCommand}"。请确认 dsh 已安装且在 PATH 中（命令行执行 ${cfg.dshCommand} 测试）。`);
    }
    if (child.exitCode !== null) {
      throw new Error(`dsh web 提前退出（code ${child.exitCode}）。\n最近输出：\n${tail(out)}`);
    }
    await sleep(500);
  }
  throw new Error(`等待 DSH Web 服务超时（${READY_TIMEOUT_MS / 1000}s）。\n最近输出：\n${tail(out)}`);
}

// ── 服务自愈：健康检查 + 自动重启 ───────────────────────────────────────────
/** 轻量探测：端口有 HTTP 响应即认为存活（不校验页面内容） */
function lightProbe(port, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode < 500);
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

let monitorTimer = null;
let monitorFails = 0;

/**
 * 每 5 秒检查一次服务；连续 3 次(约15秒)探测失败就自动重启服务并刷新窗口。
 * 这样 dsh 服务进程无论因何崩溃（含工具调用期间），都会自动拉起，
 * 不会再出现"断开后没有重启"。
 */
function startMonitor(cfg, getUrl) {
  if (monitorTimer) clearInterval(monitorTimer);
  monitorFails = 0;
  monitorTimer = setInterval(async () => {
    if (quitting) return;
    const alive = await lightProbe(cfg.port);
    if (alive) { monitorFails = 0; return; }
    monitorFails++;
    if (monitorFails < 3) return;
    monitorFails = 0;
    log('检测到 DSH 服务不可用，自动重启中…');
    try {
      if (serverChild) { try { serverChild.kill(); } catch {} }
      serverChild = null;
      ownsServer = false;
      const url = await ensureServer(cfg);
      log(`DSH 服务已自动重启：${url}`);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.loadURL(url).catch((e) => log('重启后刷新页面失败:', e.message));
      }
    } catch (e) {
      log('自动重启失败，继续监控重试:', e.message);
    }
  }, 5000);
}

// ── 窗口 ────────────────────────────────────────────────────────────────────
let mainWindow = null;
let tray = null;

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createTray(iconPath) {
  try {
    const icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
    tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
    tray.setToolTip('DSH Desktop（双击显示，退出请用菜单）');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '显示主窗口', click: showMainWindow },
      { type: 'separator' },
      { label: '退出', click: () => app.quit() },
    ]));
    tray.on('click', showMainWindow);
    tray.on('double-click', showMainWindow);
    log('托盘图标已就绪（关窗后应用在后台继续运行）');
  } catch (e) {
    log('创建托盘图标失败:', e.message);
  }
}

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
  const iconPath = iconPathFor(cfg);
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

  // 冒烟测试钩子：DSH_DESKTOP_SMOKE_TEST=1 时，加载后验证「关窗隐藏」行为再自动退出
  if (process.env.DSH_DESKTOP_SMOKE_TEST === '1') {
    win.webContents.once('did-finish-load', () => {
      log('SMOKE TEST: 页面加载完成，开始验证「关窗隐藏到托盘」行为');
      setTimeout(() => {
        win.close(); // 应被 close 拦截为隐藏而非退出
        setTimeout(() => {
          const alive = !!mainWindow && !mainWindow.isDestroyed();
          const hidden = alive && !mainWindow.isVisible();
          log(`SMOKE TEST: 关窗后 窗口已隐藏=${!!hidden} 应用仍存活=${alive}`);
          app.quit();
        }, 1500);
      }, 6000);
    });
  }

  // 页面加载完成：每次（含崩溃后自动重载）都重新应用自定义样式
  win.webContents.on('did-finish-load', () => {
    log(`页面加载完成：${url}`);
    applyCustomizations(win, cfg).catch((e) => log('应用自定义样式失败:', e.message));
  });

  // 加载失败持续重试（应用运行期间一直重试，配合服务自愈；忽略主动跳转的 -3 中止）
  win.webContents.on('did-fail-load', (_e, code, desc, failedUrl, isMainFrame) => {
    if (!isMainFrame || code === -3) return;
    log(`页面加载失败 (${code}) ${desc}：${failedUrl}，3 秒后重试`);
    if (!quitting) {
      setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed() && !win.webContents.isLoading()) {
          win.webContents.reload();
        }
      }, 3000);
    }
  });

  // 渲染进程崩溃：自动恢复（重载页面），而不是让窗口消失/整个应用退出
  win.webContents.on('render-process-gone', (_e, details) => {
    log(`渲染进程异常退出：${details.reason} (exitCode=${details.exitCode})，1.5 秒后自动恢复…`);
    if (!quitting) {
      setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) win.webContents.reload();
      }, 1500);
    }
  });

  win.loadURL(url).catch((e) => log('页面加载异常:', e.message));

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

  // 关窗 = 隐藏到托盘，后台继续跑（只有托盘菜单里的"退出"才真正退出）
  win.on('close', (event) => {
    saveState();
    if (!quitting) {
      event.preventDefault();
      win.hide();
      log('窗口已隐藏到托盘（任务在后台继续，托盘菜单可退出）');
    }
  });
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
    showMainWindow();
  });

  app.whenReady().then(async () => {
    app.setAppUserModelId('com.deepseek.dsh.desktop');
    logStream = fs.createWriteStream(path.join(app.getPath('userData'), 'server.log'), { flags: 'a' });
    log('=== DSH Desktop 启动 ===');

    const cfg = loadConfig();
    const dsh = await resolveDshCommand(cfg);
    if (!dsh) {
      showFatal('自动安装 DSH 失败。\n\n请手动安装后重试：\n  npm install -g @deepseek-ai/dsh\n\n（需要本机已安装 Node.js：https://nodejs.org）');
      app.exit(1);
      return;
    }
    cfg.dshCommand = dsh.command;
    deployPlugins(dsh.nodeModulesDir);

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
    createTray(iconPathFor(cfg));
    startMonitor(cfg, () => url);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow(url, cfg);
    });
  });
}

function iconPathFor(cfg) {
  if (cfg.icon && fs.existsSync(cfg.icon)) return cfg.icon;
  // 打包后图标在 asar 外（extraResources），nativeImage 无法读 asar 路径
  return __dirname.includes('app.asar')
    ? path.join(process.resourcesPath, 'icon.png')
    : path.join(__dirname, 'build', 'icon.png');
}

app.on('window-all-closed', () => {
  // 不退出：窗口关闭已被 close 拦截为隐藏，这里兜底保持后台运行（托盘退出）
  log('所有窗口已关闭，应用保持后台运行（如需完全退出请用托盘菜单）');
});

app.on('before-quit', () => {
  quitting = true;
  if (monitorTimer) clearInterval(monitorTimer);
  killServerTree();
  try { tray?.destroy(); } catch { /* 忽略 */ }
});

process.on('exit', () => {
  try { logStream?.end(); } catch { /* 忽略 */ }
});
