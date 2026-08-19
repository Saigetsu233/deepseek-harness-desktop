# DSH Desktop

[![GitHub release](https://img.shields.io/github/v/release/Saigetsu233/deepseek-harness-desktop)](https://github.com/Saigetsu233/deepseek-harness-desktop/releases)
[![License](https://img.shields.io/github/license/Saigetsu233/deepseek-harness-desktop)](LICENSE)

把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 Web UI 包成一个桌面应用（Electron）。
双击打开就是个独立窗口，不用先开终端敲 `dsh web` 再开浏览器。

## 它做什么

- 启动时自动拉起 `dsh web`（端口默认 3080），窗口直接指向本地服务
- 如果你已经手动跑着 `dsh web`，它直接连上，不会重复起服务
- 关窗口 = 最小化到托盘，任务在后台继续跑；托盘菜单里的"退出"才会真正关掉（包括停掉它自己拉起的服务）
- 渲染进程崩了会自动重载页面，不会整个窗口消失
- 记住窗口位置、外链走系统浏览器、单实例（重复打开会聚焦已有窗口）

## 下载

去 [Releases](https://github.com/Saigetsu233/deepseek-harness-desktop/releases) 页面：

| 平台 | 文件 |
|---|---|
| Windows x64 | `DSH-Desktop-<版本>.exe`（portable，双击即用） |
| macOS Intel | `DSH.Desktop-<版本>.dmg` / `.zip` |
| macOS Apple Silicon | `DSH.Desktop-<版本>-arm64.dmg` / `.zip` |

应用没做签名，首次运行的提示按下面处理：

- Windows：SmartScreen 弹"已保护你的电脑" → 点"更多信息" → "仍要运行"
- macOS：右键应用图标 → "打开"，或在"系统设置 → 隐私与安全性"里允许

## 前提：你得先有 dsh

这个应用只是个壳，真正干活的是 `dsh` 命令行。先确保它能用：

```bash
npm install -g @deepseek-ai/dsh
dsh web   # 能打开 Web UI 就行
```

## 关于密钥

**应用里没有任何密钥，也不碰你的密钥。** 它只是调起 `dsh`，你的模型 API Key（比如 DeepSeek 的）配置在你自己本机的 dsh 环境/配置里（`C:\Users\<你>\.dsh` 或环境变量），不会进这个仓库，也不会被这个应用读取或转发。服务只监听 127.0.0.1。

## 配置

配置文件：`%APPDATA%\DSH Desktop\config.json`（Windows）/
`~/Library/Application Support/DSH Desktop/config.json`（macOS）。没有就自己建一个：

```json
{
  "port": 3080,
  "workspace": "F:\\AI项目",
  "icon": "C:\\Users\\me\\my-icon.png",
  "backgroundImage": "C:\\Users\\me\\wallpaper.png",
  "backgroundDim": 0.45,
  "customCss": "C:\\Users\\me\\my-style.css"
}
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `port` | `3080` | 服务端口 |
| `workspace` | 用户主目录 | dsh 的工作根目录（agent 默认在这里干活） |
| `dshCommand` | `dsh` | dsh 命令，找不到时可以写完整路径 |
| `icon` | 内置鲸鱼图标 | 窗口/托盘图标（png/ico） |
| `backgroundImage` | 无 | 背景图，铺满窗口，界面面板自动变半透明 |
| `backgroundDim` | `0.45` | 背景压暗程度（0-1），越大越暗、面板越透 |
| `customCss` | 无 | 自定义 CSS 文件路径，加载后注入 |
| `windowBackground` | `#0b1220` | 窗口底色 |

所有字段也支持环境变量（`DSH_DESKTOP_PORT`、`DSH_DESKTOP_WORKSPACE` 等，一一对应）。

### 自定义界面

- **背景图**：设 `backgroundImage` 即可。DSH 界面的背景色都走 CSS 变量（`--dsw-alias-bg-*` 那套），应用会把面板层改成半透明让背景透出来，明暗主题都适配。
- **自定义 CSS**：想再往深了调就写个 css 文件给 `customCss`。常用变量：

  ```css
  body, body[data-ds-dark-theme] {
    --dsw-specific-sidebar-fill: rgba(13, 17, 23, 0.35) !important; /* 侧栏更透 */
    --dsw-specific-bubble: rgba(22, 27, 34, 0.5) !important;        /* 气泡半透明 */
  }
  ```

  完整变量表在 DevTools 里看 `body` 元素。

## 从源码构建

需要 Node ≥ 20：

```bash
git clone https://github.com/Saigetsu233/deepseek-harness-desktop.git
cd deepseek-harness-desktop
npm install

npm start        # 直接跑
npm run dist     # 打 Windows exe（在 Windows 上）
npm run dist:mac # 打 macOS dmg/zip（必须在 macOS 上）
```

macOS 的 dmg 只能在 macOS 上打。仓库的 CI 配好了：**推 `v*` 标签会自动在云端把 Windows 和 macOS 的产物都打出来发到 Releases**，不用自己装环境。

## 日志

`%APPDATA%\DSH Desktop\server.log`，含 dsh 服务输出和应用自己的运行日志，排障先看这里。

## 常见问题

**提示找不到 dsh**：命令行确认 `dsh web` 能跑；npx 装的 dsh 在 `%APPDATA%\npm` 或 npx 缓存里，可以在配置里用 `dshCommand` 写全路径。

**端口被占**：改 `port`。注意如果是另一个 dsh 实例占着，应用会直接复用。

**背景图不生效**：确认路径存在、`backgroundDim` 在 0-1 之间，改完配置重启应用。

**怎么完全退出**：托盘图标右键 → "退出"（或者任务管理器）。

## 发布流程（维护者）

```bash
git add -A && git commit -m "改了什么"
git push
git tag v1.2.0 && git push origin v1.2.0
```

## License

[MIT](LICENSE)

社区封装，和 DeepSeek 官方没有隶属关系；图标用的是 DeepSeek 官方鲸鱼标识。
