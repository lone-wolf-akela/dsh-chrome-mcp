# dsh-chrome-mcp

[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) bundle that gives the agent a browser **on demand**, through Google's [`chrome-devtools-mcp`](https://github.com/ChromeDevTools/chrome-devtools-mcp).

DSH already ships an MCP client, so `chrome-devtools-mcp` can be mounted like any other MCP server. Mounting it eagerly is the problem: the server publishes 32 tools, and their schemas ride along in every request whether or not the agent is doing browser work. This bundle ships that client row **disabled** and adds one cheap tool, `chrome_bridge`, that mounts or unmounts it when a browser is actually needed.

## Why it is not mounted at startup

Measured against `chrome-devtools-mcp` 1.12.0 with its default tool set:

| | |
|---|---|
| browser tools | 32 |
| their tool-schema JSON | ~29 KB (roughly 7k tokens) |
| default state here | not mounted, no connection, no browser process |

There is a second reason: `chrome-devtools-mcp` is an npm package that DSH must launch as a stdio child, and DSH spawns stdio commands **without a shell**. npm's Windows shims (`chrome-devtools-mcp.cmd`) therefore cannot be the command. This bundle ships `launcher.mjs`, which DSH runs with its own Node runtime and which locates both the MCP server and a browser.

## Behaviour

| State | What happens |
|---|---|
| default (off) | the `mcp-chrome` row is disabled: no connection, no retries, no Chrome tool schemas |
| `on` | probes the browser end to end, then mounts the row through Plugin Manager; 32 `mcp__chrome__*` tools become available |
| `off` | unmounts the row; the schemas leave subsequent requests |

The mount is a normal Plugin Manager entry toggle, so it is visible in the **Plugins** page, it persists in the profile, and it can be reverted there by hand.

`on` probes first: it starts `chrome-devtools-mcp`, initializes MCP, lists its tools and opens a page against the detected browser. If the browser cannot start, it returns the failure instead of mounting a connection whose tool calls would all fail. If the row is mounted but holds no tools (for example its reconnect budget ran out), `on` remounts it to force a fresh discovery.

## Works without Chrome

`chrome-devtools-mcp` only resolves Google Chrome by itself. `launcher.mjs` also detects Chromium-family browsers, so a machine with **Microsoft Edge** and no Chrome works out of the box:

1. `DSH_CHROME_PATH` / `CHROME_PATH` / `CHROME_BIN` / `PUPPETEER_EXECUTABLE_PATH`
2. Google Chrome (stable, beta, dev, canary)
3. Microsoft Edge (stable, beta, dev, canary)
4. Chromium, Brave
5. Puppeteer / Playwright browser caches

`Edge 157` is what the published measurements above were taken with. Any Chromium build supporting the DevTools protocol should work.

## Install

### 1. Install the MCP server

The bundle expects the server outside the plugin, in the global npm prefix:

```bash
npm install -g chrome-devtools-mcp@latest
```

`launcher.mjs` finds it in `%APPDATA%\npm\node_modules`, `%ProgramFiles%\nodejs\node_modules`, the npm prefix reported by `npm root -g`, or a `chrome-devtools-mcp` installed next to this package. Set `DSH_CHROME_MCP_ENTRY` to its package directory (or to `build/src/bin/chrome-devtools-mcp.js`) to use another location.

### 2. Install the bundle

From a DSH session, ask the agent to install the bundle, or use the plugin manager with this package as the target:

```text
plugin_manager install_bundle  github:lone-wolf-akela/dsh-chrome-mcp
```

A clone of this repository works too: point `install_bundle` at the checkout directory. The bundle is configuration plus one Host plugin and one browser half, with no install scripts.

Then start a session and call `chrome_bridge` with `action: 'on'`.

## Tool

`chrome_bridge` with `action`:

- `on` — probe the browser, then mount the Chrome DevTools toolset and connect.
- `off` — unmount it and free the context.
- `status` — report `loaded`, `fiberPhase`, `chromeTools`, the detected server/browser, the stored config, and the row diagnostic.
- `probe` — run the browser handshake once (initialize, `tools/list`, `list_pages`) and report, without mounting anything. It always runs headless, so diagnostics never flash a window on your desktop.
- `config` — read the browser appearance/profile settings; add `headless`, `isolated`, `userDataDir` or `viewport` to persist new ones.

Once loaded, the browser tools are named `mcp__chrome__<tool>`, for example `mcp__chrome__navigate_page`, `mcp__chrome__take_snapshot`, `mcp__chrome__take_screenshot`. Version 1.x requires a `pageId` on page-scoped tools: call `mcp__chrome__list_pages` first, then pass the number it reports.

## Screenshots render inline

`take_screenshot` returns a real MCP image block, and DSH's MCP client already admits it as a durable attachment, so the model sees the pixels either way. The transcript was the gap: a tool without a dedicated view falls through to the generic card, which flattens non-text blocks to JSON — the screenshot appeared as `{"type":"image","attachment":{…}}`.

This bundle also ships a browser half, `client.js`, that claims the `mcp__chrome__take_screenshot` tool row and renders the result as a **Screenshot** card: the summary row names the image dimensions and size, and the image itself sits in the row's expandable body — the same presentation as the built-in `read_image` tool. Click the image for a full-size view. A screenshot saved with `filePath`, an image the current model route refused, and a failed call all keep a readable text row.

The view is keyed to the `chrome` server name this bundle's patch sets. If you change `serverName`, change `SCREENSHOT_TOOL` in `client.js` to match. A browser half that did not exist when the page booted needs one page reload.

## Browser appearance and profile

Settings live in a profile-scoped JSON file, `<profile>/chrome-mcp.json`, and are read by the launcher on every start. Change them through `chrome_bridge` — no package edit and no DSH restart:

| Setting | Default | Meaning |
|---|---|---|
| `headless` | `true` | run without a window; `false` shows the real browser |
| `isolated` | `true` | each launch uses a throw-away profile |
| `userDataDir` | `''` | persistent profile directory; takes precedence over `isolated` |
| `viewport` | `1280x720` | initial viewport |

Common calls:

```text
# Watch the browser work while the agent drives it
chrome_bridge action=config headless=false

# Human sign-in + agent operation: keep cookies and logins across sessions
chrome_bridge action=on headless=false userDataDir="C:\\Users\\me\\AppData\\Local\\dsh-chrome-profile"

# Back to the privacy-friendly defaults
chrome_bridge action=config headless=true isolated=true userDataDir=""
```

`config` (and `on` with these arguments) persists the values and remounts an already loaded toolset, so the next browser launch uses them immediately. The file is written atomically, so concurrent sessions never read a partial config. Arguments passed explicitly in `cordis.patch.yml` still win over the stored values.

Chromium also persists the last window placement in a persistent profile, and one session that ended maximized makes every later launch restore a maximized window. `chrome-devtools-mcp` applies its viewport with `Browser.setContentsSize`, which Chromium refuses in that state (`Restore window to normal state before setting content size`), so a maximized window used to make the browser toolset unusable. `launcher.mjs` now normalizes a persisted maximized placement to a normal window before it starts the server; `status` and `probe` reports include `profileWindowState` when it rewrote the file or could not read it.

## Configuration

`cordis.patch.yml`:

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

- `command` and `args[0]` are resolved at load time: DSH's own executable runs `launcher.mjs` as Node, and the launcher path comes from the profile's `node_modules`, so nothing is hard-coded to a user name or profile.
- `serverName: chrome` fixes the tool prefix: `mcp__chrome__<tool>`.
- `DSH_CHROME_MCP_CONFIG` points the launcher at the profile's JSON config, which `chrome_bridge action=config` maintains. Browser flags (`headless`, `isolated`, `userDataDir`, `viewport`) are derived from it, so they never have to be edited here.
- Every argument after the launcher path is forwarded to `chrome-devtools-mcp` unchanged; explicit flags such as `--headless` or `--userDataDir=<dir>` override the stored config.
- The launcher adds `--executablePath <browser>` only when no browser was requested explicitly. `DSH_CHROME_CHANNEL=stable|beta|dev|canary` switches to Chrome channel resolution instead.
- `--no-usage-statistics` opts out of the server's Google usage statistics; `--no-performance-crux` stops performance tools from sending trace URLs to the CrUX API.

## Requirements

- DSH desktop profile with `@deepseek-ai/dsh-mcp-client`, `@deepseek-ai/dsh-plugin-manager` and HMR available (the standard desktop profile has all three).
- [`chrome-devtools-mcp`](https://github.com/ChromeDevTools/chrome-devtools-mcp) installed globally (tested with 1.12.0).
- A Chromium-family browser: Google Chrome, Microsoft Edge, Chromium or Brave.

## Limitations

- The first use of a profile launches a browser; cold start takes a few seconds.
- One `chrome` server name per profile: the row is discovered by module name plus patch id `mcp-chrome`.
- The default throw-away profile (`isolated: true`) keeps automation away from your normal browser data, but it also means no saved logins. For human sign-in work set `userDataDir`; that directory then holds the logins and cookies, so treat it as sensitive.
- Tools that read or write local files (`upload_file`, workspace paths) are restricted to the OS temp directory unless you pass `--workspace <dir>`, because DSH's MCP client does not negotiate MCP roots.
- The window-state guard is best effort: a browser instance still running with the same profile can rewrite the placement after the guard runs, and the next launch repairs it again. Nothing else in the profile is changed.
- Browser control is as powerful as it sounds: while the toolset is mounted, the agent can inspect and modify anything in that browser instance. `off` (or ending the session) unmounts it.

## License

MIT — see [LICENSE](LICENSE).
