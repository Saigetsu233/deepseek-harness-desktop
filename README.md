# DSH Desktop

[![GitHub release](https://img.shields.io/github/v/release/Saigetsu233/deepseek-harness-desktop)](https://github.com/Saigetsu233/deepseek-harness-desktop/releases)
[![License](https://img.shields.io/github/license/Saigetsu233/deepseek-harness-desktop)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS-blue)](https://github.com/Saigetsu233/deepseek-harness-desktop/releases)

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web UI 的桌面版封装（Electron）。
双击一个图标，就能以原生窗口打开你的 DSH Web UI —— 自动帮你启动/复用本地的 `dsh web` 服务，关闭窗口自动停止，还支持自定义背景图、图标和样式。

## ✨ 特性

- 🖥️ **原生桌面窗口**：无浏览器地址栏，像本地应用一样用
- ⚙️ **服务全自动**：检测已有 `dsh web` 并复用；没有就自动拉起；关窗自动停止（只停自己启动的）
- 🎨 **自定义界面**：背景图、面板半透明、自定义 CSS、自定义图标、窗口底色
- 🚀 **多平台**：Windows（portable exe）+ macOS（dmg / zip，Intel & Apple Silicon）
- 🔒 **密钥安全**：应用本身**不接触、不存储任何模型 API 密钥**（见下方安全说明）
- 🧩 **开箱即用**：记住窗口位置、外链走系统浏览器、单实例、日志文件

## 🔒 安全说明（重要）

DSH Desktop **只是一个壳**，它只做两件事：调用你本机已安装的 `dsh` 命令，并打开一个窗口指向本地的 Web 服务。

- **它不读取、不转发、不存储任何 API 密钥**（仓库代码里没有任何密钥相关逻辑）
- 你的模型密钥（如 DeepSeek API Key）由你本机的 **dsh 配置** 提供 —— 通常配置在启动 `dsh` 时的环境变量，或 `$DSH_HOME`（Windows 下是 `C:\Users\<你>\.dsh`）下的 profile 配置里，**永远不会进入这个仓库**
- 服务只监听 `127.0.0.1`（本机回环地址），不对局域网/公网开放（DSH 自身也强制如此）

## 📥 下载

到 [Releases 页面](https://github.com/Saigetsu233/deepseek-harness-desktop/releases) 下载对应平台的最新版：

| 平台 | 文件 | 说明 |
|---|---|---|
| Windows x64 | `DSH-Desktop-<版本>.exe` | portable 单文件，双击即用，无需安装 |
| macOS Intel | `DSH-Desktop-<版本>-x64.dmg` / `.zip` | 拷贝到"应用程序"即可 |
| macOS Apple Silicon | `DSH-Desktop-<版本>-arm64.dmg` / `.zip` | 同上 |

> 未签名应用首次运行的提示：Windows SmartScreen 点"更多信息 → 仍要运行"；macOS 右键打开或在"系统设置 → 隐私与安全性"里允许。

## ✅ 使用前提

本应用需要你本机已经装好 **DSH（DeepSeek Harness）命令行**，因为它负责真正运行 Web 服务：

```bash
# 通过 npm 全局安装（也可以每次用 npx 临时调用）
npm install -g @deepseek-ai/dsh
```

验证：在命令行执行 `dsh web`，能打开 Web UI 即可。你的模型密钥照常配置在 dsh 的环境变量 / 配置里，与本应用无关。

## 🚀 快速开始

1. 下载并双击运行（或本地 `npm start`）
2. 第一次运行会自动启动 `dsh web`（默认端口 3080），稍等片刻窗口即出现
3. 关闭窗口 = 退出应用并自动停掉它启动的服务

## ⚙️ 配置

配置文件位于 `%APPDATA%\DSH Desktop\config.json`（Windows）/ `~/Library/Application Support/DSH Desktop/config.json`（macOS），没有就手动创建一个：

```json
{
  "port": 3080,
  "workspace": "F:\\AI项目",
  "dshCommand": "dsh",
  "icon": "C:\\Users\\me\\Pictures\\my-icon.png",
  "backgroundImage": "C:\\Users\\me\\Pictures\\wallpaper.png",
  "backgroundDim": 0.45,
  "customCss": "C:\\Users\\me\\my-dsh-theme.css",
  "windowBackground": "#0b1220"
}
```

| 字段 | 默认值 | 说明 |
|---|---|---|
| `port` | `3080` | 服务端口。已在该端口运行的 dsh 会被直接复用 |
| `workspace` | 用户主目录 | dsh 的工作根目录（agent 默认操作目录） |
| `dshCommand` | `dsh` | dsh 命令，可写成完整路径 |
| `icon` | 内置图标 | 窗口/任务栏图标（png / ico 路径） |
| `backgroundImage` | 无 | 背景图片路径，铺满窗口 |
| `backgroundDim` | `0.45` | 背景变暗程度（0-1），越大背景越暗、面板越透，保证文字可读 |
| `customCss` | 无 | 自定义 CSS 文件路径，页面加载后注入 |
| `windowBackground` | `#0b1220` | 窗口底色（加载期间/无背景图时可见） |

所有字段也支持环境变量覆盖：`DSH_DESKTOP_PORT`、`DSH_DESKTOP_WORKSPACE`、`DSH_DESKTOP_COMMAND`、`DSH_DESKTOP_ICON`、`DSH_DESKTOP_BACKGROUND`、`DSH_DESKTOP_BACKGROUND_DIM`、`DSH_DESKTOP_CUSTOM_CSS`、`DSH_DESKTOP_WINDOW_BACKGROUND`。

### 🎨 自定义玩法

**背景图**：设好 `backgroundImage` 后，界面各面板会自动变半透明露出背景（明暗主题自适应），`backgroundDim` 控制明暗对比。

**自定义 CSS**：DSH Web UI 的背景色全部由 CSS 设计变量控制，你可以用 `customCss` 深度定制，例如把侧栏做得更通透、改气泡圆角：

```css
/* my-dsh-theme.css 示例 */
body, body[data-ds-dark-theme] {
  --dsw-specific-sidebar-fill: rgba(13, 17, 23, 0.35) !important; /* 更透的侧栏 */
  --dsw-specific-bubble: rgba(22, 27, 34, 0.5) !important;        /* 半透明聊天气泡 */
  --dsw-alias-bg-layer-1: rgba(13, 17, 23, 0.55) !important;
}
.dsw-markdown { font-size: 14px; } /* 也可以直接改任何元素 */
```

> 常用变量：`--dsw-alias-bg-base`（主背景）、`--dsw-alias-bg-layer-1/2/3`（面板层级）、`--dsw-specific-sidebar-fill`（侧栏）、`--dsw-specific-bubble`（气泡）、`--dsw-specific-input-major`（输入区）。完整变量表可打开 DevTools 在 `body` 上查看。

## 🔧 从源码构建

需要 Node.js ≥ 20：

```bash
git clone https://github.com/Saigetsu233/deepseek-harness-desktop.git
cd deepseek-harness-desktop
npm install

npm start        # 开发模式运行
npm run dist     # 构建 Windows portable exe（在 Windows 上）
npm run dist:mac # 构建 macOS dmg + zip（必须在 macOS 上）
```

> macOS 的 dmg 只能在 macOS 上构建（依赖系统 `hdiutil`）。本仓库的 CI 已配置好：
> **打 tag（`v*`）即自动在云端构建 Windows + macOS 全部产物**并发布到 Releases。

## 🧭 行为细节

- **服务复用**：启动时探测端口；发现已有 DSH Web 服务（比如你手动跑着 `dsh web`）就直接连上，退出时**不会**动它
- **日志**：`%APPDATA%\DSH Desktop\server.log`（含 dsh 服务输出），排障看这里
- **外链**：文档等外部链接自动用系统默认浏览器打开
- **单实例**：重复打开会聚焦已有窗口

## ❓ 常见问题

**提示 "无法启动 dsh"**
确认命令行能执行 `dsh web`。若是 npx 方式安装，dsh 通常位于 npx 缓存（`%APPDATA%\npm\node_modules\.bin` 或 `...\npm-cache\_npx\...\node_modules\.bin`），可在配置里用 `dshCommand` 写完整路径。

**端口被占用 / 想换端口**
改配置里的 `port`。注意如果 3080 被别的程序占用，本应用会识别失败并尝试启动 dsh 报错 —— 先确认没有其他 dsh 实例。

**背景图不生效**
确认 `backgroundImage` 指向的文件存在、`backgroundDim` 在 0-1 之间；改完配置需要重启应用。

**如何卸载**
删除应用文件即可（Windows portable 无安装痕迹；macOS 把 dmg 里的应用拖进废纸篓）。配置残留可删 `%APPDATA%\DSH Desktop`。

## 🚢 发布流程（维护者）

```bash
git add -A && git commit -m "描述改动"
git push
git tag v1.1.0 && git push origin v1.1.0   # 触发 CI，自动构建并发版
```

## 📄 License

[MIT](LICENSE)

DSH Desktop 是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（MIT）的社区封装，与 DeepSeek 官方无隶属关系。
