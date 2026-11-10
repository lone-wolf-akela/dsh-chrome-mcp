# dsh-chrome-mcp

[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）插件包：让 Agent **按需**获得一个可操控的浏览器，底层是 Google 的 [`chrome-devtools-mcp`](https://github.com/ChromeDevTools/chrome-devtools-mcp)。

DSH 自带 MCP 客户端，`chrome-devtools-mcp` 本来就可以像其他 MCP 服务器一样挂载。问题在于“常驻挂载”：该服务器发布 32 个工具，无论当前是否在做浏览器相关的活，这些工具的结构定义都会进入每一次请求。本插件把这行 MCP 客户端声明为**默认禁用**，只额外提供一个轻量的 `chrome_bridge` 工具，真正需要浏览器时才挂载、用完即卸载。

## 为什么不在启动时挂载

对 `chrome-devtools-mcp` 1.12.0 默认工具集的实测：

| | |
|---|---|
| 浏览器工具数 | 32 |
| 工具结构定义 JSON | 约 29 KB（约 7k tokens） |
| 默认状态 | 不挂载、不连接、不启动浏览器进程 |

还有第二个原因：`chrome-devtools-mcp` 是一个 npm 包，DSH 必须以 stdio 子进程方式启动它，而 DSH 启动 stdio 命令时**不经过 shell**，所以 npm 在 Windows 上生成的 `chrome-devtools-mcp.cmd` 不能直接作为命令。本插件附带 `launcher.mjs`：DSH 用自身的 Node 运行时执行它，由它同时定位 MCP 服务器和浏览器。

## 行为

| 状态 | 发生什么 |
|---|---|
| 默认（关闭） | `mcp-chrome` 行处于禁用：不连接、不重试、不携带 Chrome 工具结构定义 |
| `on` | 先端到端探测浏览器，再通过 Plugin Manager 挂载该行；32 个 `mcp__chrome__*` 工具可用 |
| `off` | 卸载该行；结构定义从后续请求中消失 |

挂载就是普通的 Plugin Manager 条目开关，因此它会出现在 **插件** 页面、会持久化在 profile 中，也可以在那里手动还原。

`on` 会先做探测：启动 `chrome-devtools-mcp`、完成 MCP 初始化、列出工具，并用检测到的浏览器打开一个页面。若浏览器无法启动，它会直接返回失败原因，而不是挂上一个每次调用都报错的连接。如果该行已挂载却没有工具（例如重连预算耗尽），`on` 会先卸载再挂载，强制重新发现。

## 没有 Chrome 也能用

`chrome-devtools-mcp` 自身只会寻找 Google Chrome。`launcher.mjs` 还会检测 Chromium 系浏览器，所以只有 **Microsoft Edge**、没有 Chrome 的机器也能直接使用：

1. `DSH_CHROME_PATH` / `CHROME_PATH` / `CHROME_BIN` / `PUPPETEER_EXECUTABLE_PATH`
2. Google Chrome（stable / beta / dev / canary）
3. Microsoft Edge（stable / beta / dev / canary）
4. Chromium、Brave
5. Puppeteer / Playwright 下载的浏览器缓存

上面的实测数据就是在 `Edge 157` 上得到的。任何支持 DevTools 协议的 Chromium 内核浏览器都应可用。

## 安装

### 1. 安装 MCP 服务器

插件期望该服务器安装在全局 npm 目录中：

```bash
npm install -g chrome-devtools-mcp@latest
```

`launcher.mjs` 会在 `%APPDATA%\npm\node_modules`、`%ProgramFiles%\nodejs\node_modules`、`npm root -g` 报告的前缀，或与本包相邻的 `chrome-devtools-mcp` 中查找。如需使用其他位置，把 `DSH_CHROME_MCP_ENTRY` 指向其包目录（或 `build/src/bin/chrome-devtools-mcp.js`）。

### 2. 安装插件包

在 DSH 会话中让 Agent 安装，或用插件管理器直接安装：

```text
plugin_manager install_bundle  github:lone-wolf-akela/dsh-chrome-mcp
```

也可以把 `install_bundle` 指向本仓库的克隆目录。本包是配置加一个 Host 插件，没有安装脚本。

然后在会话中调用 `chrome_bridge`，参数 `action: 'on'`。

## 工具

`chrome_bridge` 的 `action`：

- `on` —— 探测浏览器，然后挂载 Chrome DevTools 工具集并连接。
- `off` —— 卸载，释放上下文。
- `status` —— 报告 `loaded`、`fiberPhase`、`chromeTools`、检测到的服务器/浏览器、当前配置，以及该行的诊断信息。
- `probe` —— 只做一次浏览器握手（初始化、`tools/list`、`list_pages`）并报告，不挂载任何东西。它始终以无头模式运行，诊断时不会在桌面上闪窗。
- `config` —— 读取浏览器外观/profile 设置；附加 `headless`、`isolated`、`userDataDir` 或 `viewport` 可持久化新值。

挂载后，浏览器工具名为 `mcp__chrome__<tool>`，例如 `mcp__chrome__navigate_page`、`mcp__chrome__take_snapshot`、`mcp__chrome__take_screenshot`。1.x 版本的页面级工具要求 `pageId`：先调用 `mcp__chrome__list_pages`，再把返回的编号传进去。

## 浏览器外观与 profile

这些设置存放在 profile 级的 JSON 文件 `<profile>/chrome-mcp.json` 中，launcher 每次启动都会读取。通过 `chrome_bridge` 修改即可 —— 不用改包内文件，也不用重启 DSH：

| 设置 | 默认 | 含义 |
|---|---|---|
| `headless` | `true` | 无界面运行；`false` 显示真实浏览器窗口 |
| `isolated` | `true` | 每次启动使用一次性临时 profile |
| `userDataDir` | `''` | 持久 profile 目录；优先于 `isolated` |
| `viewport` | `1280x720` | 初始视口尺寸 |

常见用法：

```text
# 人工观察 Agent 操作浏览器
chrome_bridge action=config headless=false

# 人工登录网银 + AI 操作：跨会话保留登录态与 Cookie
chrome_bridge action=on headless=false userDataDir="D:\\dsh-chrome-profile"

# 恢复隐私友好的默认值
chrome_bridge action=config headless=true isolated=true userDataDir=""
```

`config`（以及带这些参数的 `on`）会持久化配置，并在工具集已挂载时自动重挂载，下一次浏览器启动立即生效。文件采用原子写入，并发会话不会读到半截配置。`cordis.patch.yml` 里显式写出的参数优先级仍高于配置文件。

Chromium 还会在持久 profile 中保存上次的窗口位置：只要有一次会话以最大化窗口结束，之后每次启动都会恢复成最大化。而 `chrome-devtools-mcp` 用 `Browser.setContentsSize` 设置视口，Chromium 在最大化状态下会拒绝该调用（`Restore window to normal state before setting content size`），于是浏览器工具集会彻底不可用。现在 `launcher.mjs` 会在启动 server 之前把持久化的最大化状态复位为普通窗口；当它改写了文件或读不到文件时，`status` / `probe` 的 `profileWindowState` 字段会给出说明。

## 配置

`cordis.patch.yml`：

```yaml
- insert:
    - id: mcp-chrome
      name: '@deepseek-ai/dsh-mcp-client'
      disabled: true
      config:
        serverName: chrome
        transport: stdio
        command: !!js 'process.execPath'
        env:
          ELECTRON_RUN_AS_NODE: '1'
          DSH_CHROME_MCP_CONFIG: !!js 'process.getBuiltinModule("node:url").fileURLToPath(new URL("chrome-mcp.json", ctx.baseUrl))'
        args:
          - !!js 'process.getBuiltinModule("node:url").fileURLToPath(new URL("node_modules/@local/dsh-chrome-mcp/launcher.mjs", ctx.baseUrl))'
          - '--no-usage-statistics'
          - '--no-performance-crux'
        toolCallTimeoutMs: 120000
        failOnStartupError: false
        reconnect:
          initialDelayMs: 500
          maxDelayMs: 30000
          maxAttempts: 240

    - id: chrome-bridge-control
      name: '@local/dsh-chrome-mcp'
      config: {}
```

- `command` 与 `args[0]` 在加载时解析：用 DSH 自身的可执行文件以 Node 模式运行 `launcher.mjs`，launcher 路径从 profile 的 `node_modules` 解析，不写死用户名或 profile 名。
- `serverName: chrome` 决定工具前缀：`mcp__chrome__<tool>`。
- `DSH_CHROME_MCP_CONFIG` 把 launcher 指向 profile 的 JSON 配置，由 `chrome_bridge action=config` 维护。浏览器参数（`headless`、`isolated`、`userDataDir`、`viewport`）都从该配置推导，因此不需要改这里。
- launcher 路径之后的参数会原样转发给 `chrome-devtools-mcp`；显式传入的 `--headless`、`--userDataDir=<dir>` 等参数优先级高于配置文件。
- 只有在调用方没有显式指定浏览器时，launcher 才追加 `--executablePath <浏览器>`。设置 `DSH_CHROME_CHANNEL=stable|beta|dev|canary` 可改用 Chrome 通道解析。
- `--no-usage-statistics` 关闭服务器向 Google 上报使用统计；`--no-performance-crux` 阻止性能工具把 trace URL 发给 CrUX API。

## 要求

- DSH 桌面版 profile，包含 `@deepseek-ai/dsh-mcp-client`、`@deepseek-ai/dsh-plugin-manager` 与 HMR（标准桌面 profile 均有）。
- 全局安装 [`chrome-devtools-mcp`](https://github.com/ChromeDevTools/chrome-devtools-mcp)（实测 1.12.0）。
- Chromium 系浏览器：Google Chrome、Microsoft Edge、Chromium 或 Brave。

## 限制

- 在某个 profile 中首次使用时需要启动浏览器，冷启动需要几秒。
- 每个 profile 只能有一个 `chrome` server name：该行按模块名加 patch id `mcp-chrome` 定位。
- 默认的一次性 profile（`isolated: true`）让自动化不碰日常浏览器数据，但也意味着不保留登录态；人工登录场景请设置 `userDataDir`，该目录会保存登录态与 Cookie，应按敏感数据对待。
- 读写本地文件的工具（`upload_file`、workspace 路径）默认被限制在系统临时目录内，因为 DSH 的 MCP 客户端不协商 MCP roots；可用 `--workspace <dir>` 放宽。
- 窗口状态守卫是尽力而为的：如果已有浏览器实例正用着同一个 profile，它可能在守卫执行后再写回最大化状态，下一次启动会再次修复；profile 的其它内容不会被改动。
- 浏览器操控能力很强：工具集挂载期间，Agent 可以查看和修改该浏览器实例中的任何内容。`off`（或结束会话）即可卸载。

## 许可证

MIT —— 见 [LICENSE](LICENSE)。
