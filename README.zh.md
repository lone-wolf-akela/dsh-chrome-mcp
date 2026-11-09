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
- `status` —— 报告 `loaded`、`fiberPhase`、`chromeTools`、检测到的服务器/浏览器，以及该行的诊断信息。
- `probe` —— 只做一次浏览器握手（初始化、`tools/list`、`list_pages`）并报告，不挂载任何东西。

挂载后，浏览器工具名为 `mcp__chrome__<tool>`，例如 `mcp__chrome__navigate_page`、`mcp__chrome__take_snapshot`、`mcp__chrome__take_screenshot`。1.x 版本的页面级工具要求 `pageId`：先调用 `mcp__chrome__list_pages`，再把返回的编号传进去。

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
        args:
          - !!js 'process.getBuiltinModule("node:url").fileURLToPath(new URL("node_modules/@local/dsh-chrome-mcp/launcher.mjs", ctx.baseUrl))'
          - '--headless'
          - '--isolated'
          - '--viewport=1280x720'
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
- launcher 路径之后的参数会原样转发给 `chrome-devtools-mcp`。**删掉 `--headless` 并重启 DSH** 就能看到浏览器实际界面；`--isolated` 使用一次性临时 profile，不会碰你日常浏览器的数据。
- 只有在调用方没有显式指定浏览器时，launcher 才追加 `--executablePath <浏览器>`。设置 `DSH_CHROME_CHANNEL=stable|beta|dev|canary` 可改用 Chrome 通道解析。
- `--no-usage-statistics` 关闭服务器向 Google 上报使用统计；`--no-performance-crux` 阻止性能工具把 trace URL 发给 CrUX API。

## 要求

- DSH 桌面版 profile，包含 `@deepseek-ai/dsh-mcp-client`、`@deepseek-ai/dsh-plugin-manager` 与 HMR（标准桌面 profile 均有）。
- 全局安装 [`chrome-devtools-mcp`](https://github.com/ChromeDevTools/chrome-devtools-mcp)（实测 1.12.0）。
- Chromium 系浏览器：Google Chrome、Microsoft Edge、Chromium 或 Brave。

## 限制

- 在某个 profile 中首次使用时需要启动浏览器，冷启动需要几秒。
- 每个 profile 只能有一个 `chrome` server name：该行按模块名加 patch id `mcp-chrome` 定位。
- `--isolated` 意味着每个 DSH 会话都从全新的浏览器 profile 开始：不共享登录态和 Cookie。去掉该参数即可复用持久 profile 目录。
- 读写本地文件的工具（`upload_file`、workspace 路径）默认被限制在系统临时目录内，因为 DSH 的 MCP 客户端不协商 MCP roots；可用 `--workspace <dir>` 放宽。
- 浏览器操控能力很强：工具集挂载期间，Agent 可以查看和修改该浏览器实例中的任何内容。`off`（或结束会话）即可卸载。

## 许可证

MIT —— 见 [LICENSE](LICENSE)。
