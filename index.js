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
import { fileURLToPath } from 'node:url'

const MODULE_NAME = '@deepseek-ai/dsh-mcp-client'
const PATCH_ID = 'mcp-chrome'
const TOOL_PREFIX = 'mcp__chrome__'
const LAUNCHER = fileURLToPath(new URL('./launcher.mjs', import.meta.url))
const LAUNCHER_ENV = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
const SERVER_ARGS = [
  '--headless',
  '--isolated',
  '--viewport=1280x720',
  '--no-usage-statistics',
  '--no-performance-crux',
]
const DETECT_TIMEOUT_MS = 30_000
const PROBE_TIMEOUT_MS = 180_000
const TOOL_WAIT_MS = 20_000

export const inject = ['tools']

const DESCRIPTION = [
  'Loads or unloads the Chrome DevTools browser toolset (`mcp__chrome__*` tools).',
  '',
  'The browser toolset is NOT loaded by default, because its ~32 tool schemas would be sent with every request.',
  "Call this with action 'on' before any browser work (open pages, click, type, inspect the console or network, take screenshots, record performance traces), and with action 'off' when that work is finished so the context is freed again.",
  "'on' first probes the browser end to end: it launches chrome-devtools-mcp against the detected Chromium-family browser (Chrome or Edge), initializes MCP, lists its tools and opens a page. If that probe fails, the tool reports what to fix instead of mounting a connection that cannot work.",
  'Once loaded, page-scoped `mcp__chrome__*` tools take a `pageId` from `mcp__chrome__list_pages`; call that first.',
].join('\n')

const PARAMETERS = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['on', 'off', 'status', 'probe'],
      description:
        "on: probe the browser, then mount the Chrome DevTools toolset. off: unmount it. status: report the current state without changing anything. probe: run the browser handshake once and report, without mounting or unmounting.",
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
function runLauncher(extraArgs, timeoutMs) {
  return new Promise(resolve => {
    let child
    try {
      child = spawn(process.execPath, [LAUNCHER, ...extraArgs], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: LAUNCHER_ENV,
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

const detect = () => runLauncher(['--detect'], DETECT_TIMEOUT_MS)
const probe = () => runLauncher(['--probe', ...SERVER_ARGS], PROBE_TIMEOUT_MS)

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
  return `${browser},${version}, ${report.tools} tools${page}`
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
          const detection = await detect()
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
          const report = await probe()
          if (!report.ok) {
            return { ok: false, message: `Browser probe failed: ${probeFailure(report)}`, probe: report }
          }
          return { ok: true, message: `Browser probe succeeded: ${describeProbe(report)}.`, probe: report }
        }

        if (action !== 'on') {
          return { ok: false, message: "Unknown action; use 'on', 'off', 'status' or 'probe'." }
        }

        const resolved = await resolveRow(ctx)
        if (resolved.message) return { ok: false, message: resolved.message }

        if (resolved.row.enabled && chromeToolCount(ctx) > 0) {
          return {
            ok: true,
            message: `Chrome toolset already loaded: ${chromeToolCount(ctx)} mcp__chrome__* tools available. Call chrome_bridge with action 'off' when the browser work is done.`,
            chromeTools: chromeToolCount(ctx),
          }
        }

        const detection = await detect()
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

        const report = await probe()
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
