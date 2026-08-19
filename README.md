# DSH Desktop

[![GitHub release](https://img.shields.io/github/v/release/Saigetsu233/deepseek-harness-desktop)](https://github.com/Saigetsu233/deepseek-harness-desktop/releases)
[![License](https://img.shields.io/github/license/Saigetsu233/deepseek-harness-desktop)](LICENSE)

把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 Web UI 包成桌面应用（Electron）。
装上就是一个带桌面图标的原生应用：自动装好 dsh、自动起服务、崩溃自愈、关窗进托盘后台继续跑。

## 它做什么

- **安装即用**：首次运行自动检测 dsh，没有就自动装上（有进度窗口，全程无需命令行）
- **自动起服务**：拉起 `dsh web`（默认 3080），窗口直接指向本地服务；已有服务则直接复用
- **服务自愈**：每 5 秒健康检查，服务进程意外退出（包括工具调用期间）会自动重启并刷新窗口，不再"断开后没反应"
- **工作区智能识别**：默认采用你最近使用的工作区（读 dsh 的 workspace 记录），重启后会话不丢
- **后台托管**：关窗口 = 缩到托盘，任务继续跑；托盘菜单"退出"才真正结束（并停掉它自启的服务）
- **崩溃恢复**：渲染进程崩了自动重载页面，加载失败持续重试
- **内置插件**：自动加载 token 费用统计插件（见下）
- 记住窗口位置、外链走系统浏览器、单实例

## 下载与安装

去 [Releases](https://github.com/Saigetsu233/deepseek-harness-desktop/releases)：

| 平台 | 文件 | 说明 |
|---|---|---|
| Windows x64 | `DSH-Desktop-Setup-<版本>.exe` | **安装版**：可选目录、自动创建桌面图标和开始菜单 |
| Windows x64 | `DSH-Desktop-<版本>.exe` | portable 免安装版 |
| macOS Intel / Apple Silicon | `DSH.Desktop-<版本>-x64/arm64.dmg` `.zip` | 拷到"应用程序" |

安装版向导里可以直接改安装目录；桌面图标默认创建。卸载走"设置 → 应用"，应用数据（含 token 账本）默认保留。

应用未签名，首次运行的提示：Windows SmartScreen 点"更多信息 → 仍要运行"；macOS 右键打开。

## 关于 dsh 和密钥

- **dsh 自动就绪**：优先用应用自带的 dsh（装在用户目录，免管理员）；没有就自动 npm 安装；你手动装的（PATH 里有）也会直接用
- **应用里没有任何密钥**，也不碰你的密钥。模型 API Key 配置在你本机 dsh 的环境/配置里（`C:\Users\<你>\.dsh`），不进这个仓库、不被这个应用读取转发。服务只监听 127.0.0.1

## Token 费用统计插件

设置 → "费用统计"，实时显示：

- **今日花费**（¥），分高峰/低谷
- 按模型的输入/输出 token 与花费明细
- 缓存命中节省估算、最近 7 天趋势

计价按 **DeepSeek 官方 2026-08-17 公告**：V4-Flash / V4-Pro 高峰时段（每日 9:00–14:00 北京时间）价格为空闲时段的 2 倍，输入区分缓存命中/未命中。数据按北京时间每日累计，存在本机浏览器（localStorage），刷新、重启不丢。价格表在 `plugin-token-cost/pricing.js`，官方调价后改那里即可。

## 配置

配置文件：`%APPDATA%\DSH Desktop\config.json`（Windows）/ `~/Library/Application Support/DSH Desktop/config.json`（macOS）：

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
| `workspace` | 最近使用的工作区 | dsh 工作根目录；不配置就自动用最近的那个 |
| `dshCommand` | 自动 | dsh 命令，自动模式优先应用自带安装 |
| `icon` | 内置鲸鱼图标 | 窗口/托盘图标 |
| `backgroundImage` | 无 | 背景图，面板自动变半透明露出 |
| `backgroundDim` | `0.45` | 背景压暗程度（0-1） |
| `customCss` | 无 | 自定义 CSS 文件 |
| `windowBackground` | `#0b1220` | 窗口底色 |

环境变量覆盖：`DSH_DESKTOP_PORT`、`DSH_DESKTOP_WORKSPACE`、`DSH_DESKTOP_COMMAND`、`DSH_DESKTOP_ICON`、`DSH_DESKTOP_BACKGROUND`、`DSH_DESKTOP_BACKGROUND_DIM`、`DSH_DESKTOP_CUSTOM_CSS`、`DSH_DESKTOP_WINDOW_BACKGROUND`。

### 自定义界面

背景图：设 `backgroundImage`，界面背景色走 CSS 变量（`--dsw-alias-bg-*`），面板层自动半透明，明暗主题都适配。深度定制用 `customCss`，例如：

```css
body, body[data-ds-dark-theme] {
  --dsw-specific-sidebar-fill: rgba(13, 17, 23, 0.35) !important;
  --dsw-specific-bubble: rgba(22, 27, 34, 0.5) !important;
}
```

完整变量表在 DevTools 里看 `body`。

## 从源码构建

需要 Node ≥ 20：

```bash
git clone https://github.com/Saigetsu233/deepseek-harness-desktop.git
cd deepseek-harness-desktop
npm install

npm start        # 直接跑
npm run dist     # Windows 安装版 + portable（在 Windows 上）
npm run dist:mac # macOS dmg/zip（必须在 macOS 上）
```

CI 已配好：推 `v*` 标签自动在云端构建 Windows + macOS 全平台产物并发布。

## 日志与排障

`%APPDATA%\DSH Desktop\server.log`，含 dsh 服务输出、插件部署、自愈记录。服务意外退出时日志里会带出它最后的输出，好排查原因。

- **提示找不到 dsh**：确认命令行 `dsh web` 能跑；也可以 `dshCommand` 写完整路径
- **端口被占**：改 `port`；若是另一个 dsh 实例占着会直接复用
- **怎么完全退出**：托盘图标右键 → "退出"
- **背景图不生效**：确认路径存在、`backgroundDim` 在 0-1，改完重启

## 发布流程（维护者）

```bash
git add -A && git commit -m "改了什么"
git push
git tag v1.3.0 && git push origin v1.3.0
```

## License

[MIT](LICENSE)。社区封装，与 DeepSeek 官方无隶属关系；图标为 DeepSeek 官方鲸鱼标识。
