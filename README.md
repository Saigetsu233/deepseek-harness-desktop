# DSH Desktop

DeepSeek Harness Web UI 的桌面版（Electron 封装）。双击打开一个原生窗口，
自动帮你启动/复用本地的 `dsh web` 服务。

## 它能做什么

- 打开独立桌面窗口承载 Web UI（无浏览器地址栏，像原生应用）
- 自动启动 `dsh web` 服务；**关闭窗口即自动停止**（仅停自己启动的那个）
- 如果你已经在终端里跑着 `dsh web`（端口相同），它**直接复用**，不重复启动、退出时也不会误杀你的服务
- 外链（文档等）自动用系统默认浏览器打开
- 记住窗口位置、大小、最大化状态

## 目录结构

```
dsh-desktop/
├── main.js                 # Electron 主进程（全部逻辑都在这里）
├── package.json
├── scripts/gen-icon.mjs    # 生成应用图标（无第三方依赖）
├── build/icon.png          # 生成的图标
└── README.md
```

## 运行（开发模式）

```bash
npm install      # 安装 electron（首次会下载约 100MB，网络慢可设镜像，见下文）
npm start        # 启动桌面应用
```

## 打包成 exe

```bash
npm run dist
```

产物在 `dist/DSH-Desktop-1.0.0.exe`（portable 单文件版，双击即用，无需安装）。
如果需要安装版（开始菜单、桌面快捷方式），把 `package.json` 里 `build.win.target`
的 `portable` 改成 `nsis` 再打包。

## 配置

按优先级从高到低：

| 来源 | 键 | 说明 |
|---|---|---|
| 环境变量 | `DSH_DESKTOP_PORT` | 端口，默认 `3080` |
| 环境变量 | `DSH_DESKTOP_WORKSPACE` | dsh 的工作目录（workspace 根），默认用户主目录 |
| 环境变量 | `DSH_DESKTOP_COMMAND` | dsh 命令，默认 `dsh` |
| 配置文件 | `%APPDATA%\DSH Desktop\config.json` | 同名字段覆盖默认值 |

配置文件示例（`C:\Users\<你>\AppData\Roaming\DSH Desktop\config.json`）：

```json
{
  "port": 3080,
  "workspace": "F:\\AI项目",
  "dshCommand": "dsh"
}
```

> workspace 就是 agent 的默认工作根目录（相当于在哪个目录执行 `dsh web`）。
> 想沿用当前习惯，就把它设成你平时启动 dsh 的目录。

## 日志

运行日志（含 dsh 服务输出）追加写入：
`%APPDATA%\DSH Desktop\server.log`

## 常见问题

- **npm install 下载 electron 太慢/失败**：设置国内镜像后重装
  ```bash
  $env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
  npm install
  ```
- **提示 dsh 找不到**：确认命令行里能执行 `dsh web`（npx 安装的 dsh 通常在
  `%APPDATA%\npm\` 或 npx 缓存里）。也可以在 config.json 里把 `dshCommand`
  写成完整路径，例如 `"dshCommand": "C:\\Users\\JIANG\\AppData\\Local\\npm-cache\\_npx\\1e7f6d9597241db0\\node_modules\\.bin\\dsh.cmd"`。
- **端口被别的程序占用**：换一个端口（config.json 的 `port`），同时确保之前
  没有手动启动的 `dsh web` 占着这个端口。
