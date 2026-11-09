/**
 * On-demand Chrome DevTools MCP bridge.
 *
 * The `mcp-chrome` row in this bundle's patch ships with `disabled: true`, so a
 * fresh session carries none of chrome-devtools-mcp's ~32 `mcp__chrome__*` tool
 * schemas. This plugin contributes one cheap tool that mounts or unmounts that
 * row through the profile's Plugin Manager, so the browser toolset is loaded
 * only when the user asked for browser work or the model decides it needs it.
 *
 * The MCP server itself is started through `launcher.mjs`, because DSH spawns a
 * stdio command without a shell and chrome-devtools-mcp needs the one thing it
 * cannot find on its own on machines without Chrome: a Chromium-family browser.
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const MODULE_NAME = '@deepseek-ai/dsh-mcp-client'
const PATCH_ID = 'mcp-chrome'
const TOOL_PREFIX = 'mcp__chrome__'
const LAUNCHER = fileURLToPath(new URL('./launcher.mjs', import.meta.url))
const LAUNCHER_ENV = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
const SERVER_ARGS = ['--no-usage-statistics', '--no-performance-crux']
const DETECT_TIMEOUT_MS = 30_000
const PROBE_TIMEOUT_MS = 180_000
const TOOL_WAIT_MS = 20_000

/** Browser appearance/profile defaults; must match launcher.mjs. */
const CONFIG_DEFAULTS = {
  headless: true,
  isolated: true,
  userDataDir: '',
  viewport: '1280x720',
}

const CONFIG_KEYS = ['headless', 'isolated', 'userDataDir', 'viewport']

function configFile(ctx) {
  const base = ctx?.baseUrl
  if (typeof base !== 'string') return null
  try {
    return fileURLToPath(new URL('chrome-mcp.json', base))
  } catch {
    return null
  }
}

function readConfig(file) {
  const config = { ...CONFIG_DEFAULTS }
  if (!file || !existsSync(file)) return { config, error: null }
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    if (typeof raw?.headless === 'boolean') config.headless = raw.headless
    if (typeof raw?.isolated === 'boolean') config.isolated = raw.isolated
    if (typeof raw?.userDataDir === 'string') config.userDataDir = raw.userDataDir.trim()
    if (typeof raw?.viewport === 'string' && raw.viewport.trim()) config.viewport = raw.viewport.trim()
    return { config, error: null }
  } catch (error) {
    return { config, error: String(error?.message ?? error) }
  }
}

function mergeConfig(current, args) {
  const next = { ...current }
  if (typeof args?.headless === 'boolean') next.headless = args.headless
  if (typeof args?.isolated === 'boolean') next.isolated = args.isolated
  if (typeof args?.userDataDir === 'string') next.userDataDir = args.userDataDir.trim()
  if (typeof args?.viewport === 'string' && args.viewport.trim()) next.viewport = args.viewport.trim()
  // A named profile directory is a request for persistence; keep one owner.
  if (next.userDataDir) next.isolated = false
  return next
}

function writeConfig(file, config) {
  mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.tmp`
  writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
  renameSync(temporary, file)
}

function describeConfig(config) {
  const profile = config.userDataDir
    ? `persistent profile ${config.userDataDir}`
    : config.isolated
      ? 'throw-away profile (--isolated)'
      : 'default persistent profile'
  return `${config.headless ? 'headless' : 'visible window'}, ${profile}, viewport ${config.viewport}`
}

export const inject = ['tools']

const DESCRIPTION = [
  'Loads or unloads the Chrome DevTools browser toolset (`mcp__chrome__*` tools) and stores how the browser is shown.',
  '',
  'The browser toolset is NOT loaded by default, because its ~32 tool schemas would be sent with every request.',
  "Call this with action 'on' before any browser work (open pages, click, type, inspect the console or network, take screenshots, record performance traces), and with action 'off' when that work is finished so the context is freed again.",
  "'on' first probes the browser end to end: it launches chrome-devtools-mcp against the detected Chromium-family browser (Chrome or Edge), initializes MCP, lists its tools and opens a page. If that probe fails, the tool reports what to fix instead of mounting a connection that cannot work.",
  "Defaults come from a profile-scoped config file: headless true (no window), isolated true (throw-away profile), viewport 1280x720. For human sign-in work pass headless=false to watch the browser, and userDataDir=\"<folder>\" to keep cookies and logins across sessions; any of these optional arguments persist to the config file and remount an already loaded toolset.",
  "Use action 'config' alone to read the current settings without changing anything.",
  'Once loaded, page-scoped `mcp__chrome__*` tools take a `pageId` from `mcp__chrome__list_pages`; call that first.',
].join('\n')

const PARAMETERS = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['on', 'off', 'status', 'probe', 'config'],
      description:
        "on: probe the browser, then mount the Chrome DevTools toolset. off: unmount it. status: report the current state without changing anything. probe: run the browser handshake once and report, without mounting or unmounting. config: read (or, with the optional fields, update and persist) how the browser is shown.",
    },
    headless: {
      type: 'boolean',
      description: 'Whether the browser runs without a window. Persisted for later launches; false shows the real window.',
    },
    isolated: {
      type: 'boolean',
      description:
        'Whether each launch uses a throw-away browser profile. Ignored (turned off) when userDataDir is set.',
    },
    userDataDir: {
      type: 'string',
      description:
        'Persistent browser profile directory to keep cookies and sign-ins across launches. An empty string clears it. Takes precedence over isolated.',
    },
    viewport: {
      type: 'string',
      description: "Initial viewport, for example '1280x720'.",
    },
  },
  required: ['action'],
  additionalProperties: false,
}

const OUTPUT = {
  schema: {
    type: 'object',
    properties: {
      ok: { type: 'boolean', description: 'Whether the requested action succeeded.' },
      message: { type: 'string', description: 'One-line human/model-readable outcome.' },
    },
    additionalProperties: true,
  },
  render(_args, value) {
    const message = value?.message
    if (typeof message === 'string') {
      const rest = { ...value }
      delete rest.message
      const extra = Object.keys(rest).length > 0 ? `\n\n${JSON.stringify(rest, null, 2)}` : ''
      return [{ type: 'text', text: `${message}${extra}` }]
    }
    return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
  },
}

function chromeToolCount(ctx) {
  return ctx.tools.definitions().filter(definition => definition.name.startsWith(TOOL_PREFIX)).length
}

async function waitForTools(ctx, timeoutMs = TOOL_WAIT_MS) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const count = chromeToolCount(ctx)
    if (count > 0 || Date.now() >= deadline) return count
    await new Promise(resolve => setTimeout(resolve, 250))
  }
}

/** Run launcher.mjs once and parse the JSON report it prints on stdout. */
function runLauncher(extraArgs, timeoutMs, env) {
  return new Promise(resolve => {
    let child
    try {
      child = spawn(process.execPath, [LAUNCHER, ...extraArgs], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: env ?? LAUNCHER_ENV,
        windowsHide: true,
      })
    } catch (error) {
      resolve({ ok: false, error: String(error?.message ?? error) })
      return
    }

    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = value => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        // ignore
      }
      finish({ ok: false, error: `launcher timed out after ${timeoutMs} ms`, stderr })
    }, timeoutMs)

    child.stdout.on('data', chunk => {
      stdout += chunk
    })
    child.stderr.on('data', chunk => {
      stderr += chunk
      if (stderr.length > 8_000) stderr = stderr.slice(-8_000)
    })
    child.on('error', error => finish({ ok: false, error: String(error?.message ?? error), stderr }))
    child.on('exit', code => {
      const text = stdout.trim()
      const start = text.indexOf('{')
      const end = text.lastIndexOf('}')
      if (start >= 0 && end > start) {
        try {
          finish({ ...JSON.parse(text.slice(start, end + 1)), launcherExitCode: code, stderr })
          return
        } catch {
          // fall through to the diagnostic below
        }
      }
      finish({ ok: false, error: `launcher exited with code ${code}`, stderr, stdout: text.slice(0, 2_000) })
    })
  })
}

function launcherEnv(ctx) {
  const env = { ...LAUNCHER_ENV }
  const file = configFile(ctx)
  if (file) env.DSH_CHROME_MCP_CONFIG = file
  return env
}

const detect = ctx => runLauncher(['--detect'], DETECT_TIMEOUT_MS, launcherEnv(ctx))
const probe = ctx => runLauncher(['--probe', ...SERVER_ARGS], PROBE_TIMEOUT_MS, launcherEnv(ctx))

async function resolveRow(ctx) {
  const manager = ctx.get('pluginManager')
  if (!manager) {
    return { message: 'The pluginManager service is not mounted in this profile, so the Chrome bridge cannot be toggled.' }
  }
  const plugins = await manager.listPlugins()
  const row =
    plugins.find(plugin => plugin.moduleName === MODULE_NAME && plugin.patchId === PATCH_ID) ??
    plugins.find(plugin => plugin.moduleName === MODULE_NAME)
  if (!row) {
    return { message: `No ${MODULE_NAME} row (patch id ${PATCH_ID}) exists in this profile composition.` }
  }
  return { manager, row }
}

function describeProbe(report) {
  const version = report.server?.version ? ` chrome-devtools-mcp ${report.server.version}` : ''
  const browser = report.browser?.label
    ? `${report.browser.label} (${report.browser.executable})`
    : report.channel
      ? `Chrome channel ${report.channel}`
      : 'browser'
  const page = report.page ? `, page ${report.page.pageId} "${report.page.title}"` : ''
  const config = report.config ? `, ${describeConfig(report.config)}` : ''
  return `${browser},${version}, ${report.tools} tools${page}${config}`
}

function probeFailure(report) {
  const detail = report.error ?? 'the browser handshake failed'
  const stderr = typeof report.stderr === 'string' && report.stderr.trim() ? ` Server log: ${report.stderr.trim().split('\n').slice(-4).join(' | ')}` : ''
  return `${detail}${stderr}`
}

export function apply(ctx) {
  ctx.effect(() =>
    ctx.tools.register({
      name: 'chrome_bridge',
      description: DESCRIPTION,
      parameters: PARAMETERS,
      output: OUTPUT,
      async execute(args) {
        const action = args?.action

        if (action === 'status') {
          const resolved = await resolveRow(ctx)
          if (resolved.message) return { ok: false, message: resolved.message }
          const detection = await detect(ctx)
          const count = chromeToolCount(ctx)
          const failed = resolved.row.fiberPhase === 'failed'
          const loaded = resolved.row.enabled && count > 0
          const message = loaded
            ? `Chrome toolset loaded: ${count} mcp__chrome__* tools available.`
            : failed
              ? `Chrome toolset failed to load${resolved.row.diagnostic ? `: ${resolved.row.diagnostic}` : '.'}`
              : resolved.row.enabled
                ? "Chrome toolset is enabled but exposes no tools; run chrome_bridge with action 'on' to remount it."
                : 'Chrome toolset not loaded.'
          return {
            ok: true,
            message,
            loaded,
            enabled: resolved.row.enabled,
            fiberPhase: resolved.row.fiberPhase ?? null,
            chromeTools: count,
            diagnostic: resolved.row.diagnostic ?? null,
            server: detection.server ?? null,
            browser: detection.browser ?? null,
            channel: detection.channel ?? null,
            config: detection.config ?? null,
            discoveryError: detection.ok ? null : (detection.error ?? null),
          }
        }

        if (action === 'off') {
          const resolved = await resolveRow(ctx)
          if (resolved.message) return { ok: false, message: resolved.message }
          if (!resolved.row.enabled) {
            return { ok: true, message: 'Chrome toolset is already unloaded.', chromeTools: chromeToolCount(ctx) }
          }
          const result = await resolved.manager.setPluginEnabled(resolved.row.entryId, false)
          if (result.application !== 'applied') {
            return {
              ok: false,
              message: `Could not unload the Chrome toolset: ${result.application}${result.error ? ` (${result.error.code})` : ''}.`,
              application: result.application,
            }
          }
          return {
            ok: true,
            message: `Chrome toolset unloaded. ${chromeToolCount(ctx)} chrome tools visible; their schemas no longer enter requests.`,
            chromeTools: chromeToolCount(ctx),
          }
        }

        if (action === 'probe') {
          const report = await probe(ctx)
          if (!report.ok) {
            return { ok: false, message: `Browser probe failed: ${probeFailure(report)}`, probe: report }
          }
          return { ok: true, message: `Browser probe succeeded: ${describeProbe(report)}.`, probe: report }
        }

        if (action === 'config') {
          const file = configFile(ctx)
          if (!file) return { ok: false, message: 'Cannot resolve the profile directory for the Chrome config file.' }
          const { config: current, error: readError } = readConfig(file)
          const merged = mergeConfig(current, args)
          const changed = JSON.stringify(merged) !== JSON.stringify(current)
          if (!changed) {
            return {
              ok: true,
              message: `Chrome config (${file}): ${describeConfig(merged)}.`,
              config: merged,
              configPath: file,
              changed: false,
              readError,
            }
          }
          try {
            writeConfig(file, merged)
          } catch (error) {
            return { ok: false, message: `Could not write ${file}: ${String(error?.message ?? error)}` }
          }
          const resolved = await resolveRow(ctx)
          if (resolved.message) {
            return { ok: false, message: resolved.message, config: merged, configPath: file, changed: true }
          }
          if (!resolved.row.enabled) {
            return {
              ok: true,
              message: `Chrome config saved to ${file}: ${describeConfig(merged)}. It applies on the next chrome_bridge action 'on'.`,
              config: merged,
              configPath: file,
              changed: true,
              remounted: false,
            }
          }
          await resolved.manager.setPluginEnabled(resolved.row.entryId, false)
          const enabled = await resolved.manager.setPluginEnabled(resolved.row.entryId, true)
          if (enabled.application !== 'applied') {
            return {
              ok: false,
              message: `Config saved, but remounting the toolset failed: ${enabled.application}${enabled.error ? ` (${enabled.error.code})` : ''}. Run chrome_bridge action 'on' to retry.`,
              config: merged,
              configPath: file,
              changed: true,
            }
          }
          const count = await waitForTools(ctx)
          if (count === 0) {
            return {
              ok: false,
              message: "Config saved and the row remounted, but it registered no tools. Run chrome_bridge action 'probe' to diagnose the browser.",
              config: merged,
              configPath: file,
              changed: true,
              chromeTools: 0,
            }
          }
          return {
            ok: true,
            message: `Chrome config saved to ${file}: ${describeConfig(merged)}. Toolset remounted with the new settings (${count} tools).`,
            config: merged,
            configPath: file,
            changed: true,
            remounted: true,
            chromeTools: count,
          }
        }

        if (action !== 'on') {
          return { ok: false, message: "Unknown action; use 'on', 'off', 'status', 'probe' or 'config'." }
        }

        const resolved = await resolveRow(ctx)
        if (resolved.message) return { ok: false, message: resolved.message }

        const file = configFile(ctx)
        const overrides = {}
        for (const key of CONFIG_KEYS) {
          if (args?.[key] !== undefined) overrides[key] = args[key]
        }
        const hasOverrides = Object.keys(overrides).length > 0
        let configChanged = false
        if (hasOverrides) {
          if (!file) return { ok: false, message: 'Cannot resolve the profile directory for the Chrome config file.' }
          const { config: current } = readConfig(file)
          const merged = mergeConfig(current, overrides)
          configChanged = JSON.stringify(merged) !== JSON.stringify(current)
          if (configChanged) {
            try {
              writeConfig(file, merged)
            } catch (error) {
              return { ok: false, message: `Could not write ${file}: ${String(error?.message ?? error)}` }
            }
          }
        }

        if (!configChanged && resolved.row.enabled && chromeToolCount(ctx) > 0) {
          const { config: current } = readConfig(file)
          return {
            ok: true,
            message: `Chrome toolset already loaded: ${chromeToolCount(ctx)} mcp__chrome__* tools available (${describeConfig(current)}). Call chrome_bridge with action 'off' when the browser work is done.`,
            chromeTools: chromeToolCount(ctx),
            config: current,
          }
        }

        const detection = await detect(ctx)
        if (!detection.ok || !detection.server) {
          return {
            ok: false,
            message: detection.error ?? detection.hint ?? 'chrome-devtools-mcp was not found.',
            discovery: detection,
          }
        }
        if (!detection.browser && !detection.channel) {
          return { ok: false, message: detection.hint ?? 'No Chromium-family browser was found.', discovery: detection }
        }

        // A mounted row can hold no tools, for example after its reconnect
        // budget ran out while the browser was closed. Unmount it before
        // probing, so activation performs a fresh connection and discovery.
        if (resolved.row.enabled) {
          await resolved.manager.setPluginEnabled(resolved.row.entryId, false)
        }

        const report = await probe(ctx)
        if (!report.ok) {
          return {
            ok: false,
            message: `The browser is not usable, so the Chrome toolset was not loaded: ${probeFailure(report)}`,
            probe: report,
          }
        }

        const result = await resolved.manager.setPluginEnabled(resolved.row.entryId, true)
        if (result.application !== 'applied') {
          const detail = result.error
            ? ` ${result.error.code}${result.error.diagnostic ? `: ${result.error.diagnostic}` : ''}`
            : ''
          return {
            ok: false,
            message: `Could not load the Chrome toolset: ${result.application}.${detail}`,
            application: result.application,
            probe: report,
          }
        }

        const count = await waitForTools(ctx)
        if (count === 0) {
          return {
            ok: false,
            message: `The Chrome bridge row reported applied but registered no tools. Run chrome_bridge with action 'status' to inspect the row diagnostic.`,
            chromeTools: 0,
            probe: report,
          }
        }
        return {
          ok: true,
          message: `Chrome toolset loaded: ${count} mcp__chrome__* tools available (${describeProbe(report)}). Call chrome_bridge with action 'off' when the browser work is done.`,
          chromeTools: count,
          browser: report.browser ?? null,
          server: report.server ?? null,
          page: report.page ?? null,
        }
      },
    }),
  )
}
