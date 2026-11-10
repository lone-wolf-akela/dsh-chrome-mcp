#!/usr/bin/env node
/**
 * Stdio launcher for `chrome-devtools-mcp`.
 *
 * The dsh-chrome-mcp bundle mounts a stdio MCP client row that runs
 * chrome-devtools-mcp. DSH spawns the row's `command` with no shell, and
 * chrome-devtools-mcp is an npm package that lives outside this bundle, so this
 * launcher sits in between and does three jobs:
 *
 *   1. find the installed chrome-devtools-mcp (npm global by default),
 *   2. find a Chromium-family browser (Chrome first, then Edge), because
 *      chrome-devtools-mcp only resolves Chrome on its own,
 *   3. run the server with these stdio pipes so DSH talks to it directly.
 *
 * The plugins set the row's command to the Node executable that runs DSH itself
 * (with ELECTRON_RUN_AS_NODE=1), so no system `node` is required on PATH.
 *
 * Modes:
 *   (no mode)   run the MCP server over stdio; used by @deepseek-ai/dsh-mcp-client
 *   --detect    print a JSON report about server/browser/config discovery and exit
 *   --probe     start the server, initialize, list tools, open a page, print JSON
 *
 * Every other argument is forwarded to chrome-devtools-mcp unchanged. Browser
 * appearance and profile flags (headless, isolated, userDataDir, viewport) come
 * from a JSON config file that `chrome_bridge action=config` writes, so they can
 * change without editing this package; explicit forwarded flags still win.
 *
 * Environment:
 *   DSH_CHROME_MCP_CONFIG  explicit path to the JSON config file (the bundle's
 *                          patch points this at the profile directory)
 *   DSH_CHROME_MCP_ENTRY   explicit path to the package directory or to
 *                          build/src/bin/chrome-devtools-mcp.js
 *   DSH_CHROME_PATH        explicit browser executable to drive
 *   DSH_CHROME_CHANNEL     Chrome channel to pass through (stable|beta|dev|canary)
 *   CHROME_PATH, CHROME_BIN, PUPPETEER_EXECUTABLE_PATH
 *                          alternative browser executable variables
 */

import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { normalizeMaximizedWindowPlacement } from './profile-window-state.mjs'

const isWindows = process.platform === 'win32'
const require = createRequire(import.meta.url)

const ENTRY_REL = path.join('build', 'src', 'bin', 'chrome-devtools-mcp.js')
const SERVER_PACKAGE = 'chrome-devtools-mcp'
const REQUEST_TIMEOUT_MS = 45_000
const OVERALL_PROBE_TIMEOUT_MS = 150_000

const HINT_INSTALL =
  `chrome-devtools-mcp was not found. Install it once with:\n` +
  `  npm install -g ${SERVER_PACKAGE}@latest\n` +
  `or point DSH_CHROME_MCP_ENTRY at its ${ENTRY_REL.replace(/\\/g, '/')}.`

const HINT_BROWSER =
  `No Chromium-family browser was found. Install Google Chrome, set DSH_CHROME_PATH to a\n` +
  `chrome.exe / msedge.exe path, or set DSH_CHROME_CHANNEL (stable|beta|dev|canary).`

/** Browser appearance/profile defaults; overridden by the JSON config file. */
const CONFIG_DEFAULTS = {
  headless: true,
  isolated: true,
  userDataDir: '',
  viewport: '1280x720',
}

function configFile() {
  const explicit = process.env.DSH_CHROME_MCP_CONFIG?.trim()
  if (explicit) return explicit
  const home = process.env.USERPROFILE || process.env.HOME || homedir()
  return home ? path.join(home, '.dsh', 'chrome-mcp.json') : null
}

function readConfig() {
  const file = configFile()
  const config = { ...CONFIG_DEFAULTS }
  if (!file || !existsSync(file)) return { file, config, error: null }
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    if (typeof raw?.headless === 'boolean') config.headless = raw.headless
    if (typeof raw?.isolated === 'boolean') config.isolated = raw.isolated
    if (typeof raw?.userDataDir === 'string') config.userDataDir = raw.userDataDir.trim()
    if (typeof raw?.viewport === 'string' && raw.viewport.trim()) config.viewport = raw.viewport.trim()
    return { file, config, error: null }
  } catch (error) {
    return { file, config, error: String(error?.message ?? error) }
  }
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

function serverFromDir(packageDir) {
  if (!packageDir) return null
  const entry = path.join(packageDir, ENTRY_REL)
  if (!existsSync(entry)) return null
  const manifest = readJson(path.join(packageDir, 'package.json'))
  return { entry, packageDir, version: manifest?.version ?? null }
}

function serverFromEntryFile(entry) {
  let dir = path.dirname(entry)
  for (let depth = 0; depth < 6; depth++) {
    const manifest = readJson(path.join(dir, 'package.json'))
    if (manifest?.name === SERVER_PACKAGE) {
      return { entry, packageDir: dir, version: manifest.version ?? null }
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return { entry, packageDir: path.dirname(entry), version: null }
}

/** Directories where a global `node_modules` may live on this platform. */
function globalNodeModules() {
  const roots = new Set()
  const add = value => {
    if (value) roots.add(path.normalize(value))
  }
  if (isWindows) {
    add(process.env.APPDATA && path.join(process.env.APPDATA, 'npm', 'node_modules'))
    add(process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'npm', 'node_modules'))
    add(path.join(path.dirname(process.execPath), 'node_modules'))
    add(process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'nodejs', 'node_modules'))
    add(process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'nodejs', 'node_modules'))
    add(process.env.npm_config_prefix && path.join(process.env.npm_config_prefix, 'node_modules'))
  } else {
    add('/usr/local/lib/node_modules')
    add('/usr/lib/node_modules')
    add(process.env.HOME && path.join(process.env.HOME, '.npm-global', 'lib', 'node_modules'))
    add(path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules'))
    add(process.env.npm_config_prefix && path.join(process.env.npm_config_prefix, 'lib', 'node_modules'))
  }
  return [...roots]
}

/** `npm root -g` as a last resort; it also covers custom prefixes. */
function npmGlobalRoot() {
  try {
    const result = spawnSync(isWindows ? 'npm.cmd' : 'npm', ['root', '-g'], {
      encoding: 'utf8',
      timeout: 8_000,
      windowsHide: true,
      shell: isWindows,
    })
    const root = (result.stdout ?? '').trim()
    return result.status === 0 && root ? root : null
  } catch {
    return null
  }
}

function findServer() {
  const explicit = process.env.DSH_CHROME_MCP_ENTRY?.trim()
  if (explicit) {
    if (existsSync(explicit) && explicit.toLowerCase().endsWith('.js')) {
      return serverFromEntryFile(explicit)
    }
    const fromDir = serverFromDir(explicit)
    if (fromDir) return fromDir
  }
  try {
    const manifest = require.resolve(`${SERVER_PACKAGE}/package.json`)
    const resolved = serverFromDir(path.dirname(manifest))
    if (resolved) return resolved
  } catch {
    // not resolvable from this package; fall through to global locations
  }
  for (const root of globalNodeModules()) {
    const resolved = serverFromDir(path.join(root, SERVER_PACKAGE))
    if (resolved) return resolved
  }
  const npmRoot = npmGlobalRoot()
  if (npmRoot) {
    const resolved = serverFromDir(path.join(npmRoot, SERVER_PACKAGE))
    if (resolved) return resolved
  }
  return null
}

function scanCache(base, pattern, executableParts) {
  const found = []
  if (!base || !existsSync(base)) return found
  let names = []
  try {
    names = readdirSync(base)
  } catch {
    return found
  }
  for (const name of names) {
    if (!pattern.test(name)) continue
    const executable = path.join(base, name, ...executableParts)
    if (existsSync(executable)) found.push({ executable, label: `cached ${name}` })
  }
  return found
}

function browserCandidates() {
  const candidates = []
  const push = (executable, label) => {
    if (executable) candidates.push({ executable, label })
  }

  if (isWindows) {
    const programFiles = process.env.ProgramFiles
    const programFilesX86 = process.env['ProgramFiles(x86)']
    const localAppData = process.env.LOCALAPPDATA

    // Chrome stable, in the order most Windows installs use.
    for (const base of [programFiles, programFilesX86, localAppData]) {
      push(base && path.join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'), 'Chrome stable')
    }
    for (const channel of ['Chrome Beta', 'Chrome Dev', 'Chrome Canary', 'Chrome SxS']) {
      for (const base of [programFiles, programFilesX86, localAppData]) {
        push(base && path.join(base, 'Google', channel, 'Application', 'chrome.exe'), channel)
      }
    }
    // Edge ships as a Chromium browser and exposes the same DevTools protocol.
    for (const base of [programFilesX86, programFiles, localAppData]) {
      push(base && path.join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), 'Edge stable')
    }
    for (const channel of ['Edge Beta', 'Edge Dev', 'Edge Canary']) {
      for (const base of [programFilesX86, programFiles, localAppData]) {
        push(base && path.join(base, 'Microsoft', channel, 'Application', 'msedge.exe'), channel)
      }
    }
    for (const base of [programFiles, programFilesX86, localAppData]) {
      push(base && path.join(base, 'Chromium', 'Application', 'chrome.exe'), 'Chromium')
      push(base && path.join(base, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'), 'Brave')
    }
    // Browser caches used by Puppeteer and Playwright.
    const home = process.env.USERPROFILE
    candidates.push(
      ...scanCache(localAppData && path.join(localAppData, 'ms-playwright'), /^chromium-\d+$/, ['chrome-win', 'chrome.exe']),
    )
    candidates.push(
      ...scanCache(home && path.join(home, '.cache', 'puppeteer', 'chrome'), /^\d+\./, ['chrome-win64', 'chrome.exe']),
    )
    candidates.push(
      ...scanCache(home && path.join(home, '.cache', 'puppeteer', 'chrome'), /^\d+\./, ['chrome-win', 'chrome.exe']),
    )
  } else if (process.platform === 'darwin') {
    push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', 'Chrome stable')
    push('/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary', 'Chrome Canary')
    push('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', 'Edge stable')
    push('/Applications/Chromium.app/Contents/MacOS/Chromium', 'Chromium')
  } else {
    push('/usr/bin/google-chrome', 'Chrome stable')
    push('/usr/bin/google-chrome-stable', 'Chrome stable')
    push('/opt/google/chrome/chrome', 'Chrome stable')
    push('/usr/bin/google-chrome-beta', 'Chrome beta')
    push('/usr/bin/chromium', 'Chromium')
    push('/usr/bin/chromium-browser', 'Chromium')
    push('/snap/bin/chromium', 'Chromium')
    push('/usr/bin/microsoft-edge', 'Edge stable')
    push('/usr/bin/microsoft-edge-stable', 'Edge stable')
  }
  return candidates
}

function findBrowser() {
  for (const name of ['DSH_CHROME_PATH', 'CHROME_PATH', 'CHROME_BIN', 'PUPPETEER_EXECUTABLE_PATH']) {
    const value = process.env[name]?.trim()
    if (value && existsSync(value)) return { executable: value, label: name }
  }
  for (const candidate of browserCandidates()) {
    if (existsSync(candidate.executable)) return candidate
  }
  return null
}

const CONNECT_FLAGS = new Set([
  '--executablePath',
  '-e',
  '--channel',
  '--browserUrl',
  '-u',
  '--wsEndpoint',
  '-w',
  '--autoConnect',
])

function wantsOwnBrowser(forwarded) {
  return forwarded.some(argument => {
    const name = argument.split('=')[0]
    return CONNECT_FLAGS.has(name)
  })
}

const PROFILE_FLAGS = new Set([
  '--userDataDir',
  '--isolated',
  '--channel',
  '--browserUrl',
  '-u',
  '--wsEndpoint',
  '-w',
  '--autoConnect',
])

/** Browser appearance/profile flags the caller did not pass explicitly. */
function configFlags(config, forwarded) {
  const has = name => forwarded.some(argument => argument === name || argument.startsWith(`${name}=`))
  const hasProfileChoice = forwarded.some(argument => PROFILE_FLAGS.has(argument.split('=')[0]))
  const flags = []

  if (!has('--headless') && !has('--no-headless') && config.headless) flags.push('--headless')

  if (!hasProfileChoice) {
    if (config.userDataDir) flags.push('--userDataDir', config.userDataDir)
    else if (config.isolated) flags.push('--isolated')
  }

  if (!has('--viewport') && config.viewport) flags.push(`--viewport=${config.viewport}`)

  return flags
}

function resolveLaunch(forwarded, { quiet = false } = {}) {
  const server = findServer()
  if (!server) {
    return { ok: false, error: HINT_INSTALL, server: null, browser: null }
  }
  const browser = findBrowser()
  const channel = process.env.DSH_CHROME_CHANNEL?.trim() || null
  const { file: configPath, config, error: configError } = readConfig()

  if (config.userDataDir && config.isolated) {
    // A persistent profile is the reason to name a directory; keep one owner.
    config.isolated = false
  }
  let profileWindowState = null
  if (config.userDataDir) {
    try {
      mkdirSync(config.userDataDir, { recursive: true })
    } catch {
      // the browser reports a clearer error than we can here
    }
    // Chromium restores a persisted maximized window even for headless
    // launches, and chrome-devtools-mcp's viewport call is refused in that
    // state; normalize it before the server (and its browser) starts.
    profileWindowState = normalizeMaximizedWindowPlacement(config.userDataDir)
  }

  const args = [server.entry, ...forwarded, ...configFlags(config, forwarded)]
  if (!wantsOwnBrowser(forwarded)) {
    if (channel) args.push('--channel', channel)
    else if (browser) args.push('--executablePath', browser.executable)
    else if (!quiet) console.error(`[dsh-chrome-mcp] ${HINT_BROWSER}`)
  }
  return { ok: true, server, browser, channel, config, configPath, configError, profileWindowState, args }
}

function detectReport() {
  const launch = resolveLaunch([], { quiet: true })
  const report = {
    ok: Boolean(launch.ok),
    platform: process.platform,
    node: process.version,
    server: launch.server
      ? { entry: launch.server.entry, version: launch.server.version, packageDir: launch.server.packageDir }
      : null,
    browser: launch.browser ?? null,
    channel: launch.channel ?? null,
    config: {
      path: launch.configPath ?? null,
      ...(launch.config ?? CONFIG_DEFAULTS),
      error: launch.configError ?? null,
    },
    profileWindowState: launch.profileWindowState ?? null,
    error: launch.ok ? null : launch.error,
    hint: launch.ok ? (launch.browser || launch.channel ? null : HINT_BROWSER) : HINT_INSTALL,
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  process.exit(0)
}

function killTree(pid) {
  if (!pid) return
  if (isWindows) {
    try {
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      return
    } catch {
      // fall through to the generic kill
    }
  }
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    // already gone
  }
}

function stopChild(child) {
  return new Promise(resolve => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      resolve()
    }
    child.once('exit', finish)
    try {
      child.stdin?.end()
    } catch {
      // ignore
    }
    setTimeout(() => {
      killTree(child.pid)
      finish()
    }, 3_000).unref()
  })
}

/** Minimal newline-delimited JSON-RPC client over the server's stdio. */
function createRpcClient(child) {
  const pending = new Map()
  let nextId = 1
  let buffer = ''
  let stderr = ''

  child.stdout.setEncoding('utf8')
  child.stdout.on('data', chunk => {
    buffer += chunk
    let index
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (!line) continue
      let message
      try {
        message = JSON.parse(line)
      } catch {
        continue
      }
      if (message.id && pending.has(message.id)) {
        const { resolve, reject } = pending.get(message.id)
        pending.delete(message.id)
        if (message.error) reject(new Error(JSON.stringify(message.error)))
        else resolve(message.result)
      }
    }
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', chunk => {
    stderr += chunk
    if (stderr.length > 8_000) stderr = stderr.slice(-8_000)
  })

  return {
    request(method, params = {}) {
      const id = nextId++
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error(`${method} timed out after ${REQUEST_TIMEOUT_MS} ms`))
        }, REQUEST_TIMEOUT_MS)
        pending.set(id, {
          resolve: value => {
            clearTimeout(timer)
            resolve(value)
          },
          reject: error => {
            clearTimeout(timer)
            reject(error)
          },
        })
      })
    },
    notify(method, params = {}) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
    },
    stderr: () => stderr,
  }
}

function toolText(result) {
  const blocks = result?.content ?? []
  return blocks
    .filter(block => block?.type === 'text')
    .map(block => block.text)
    .join('\n')
}

async function probe(forwarded) {
  const launch = resolveLaunch(forwarded)
  if (!launch.ok) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: launch.error, hint: HINT_INSTALL }, null, 2)}\n`)
    process.exit(0)
  }
  if (!launch.browser && !launch.channel) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: HINT_BROWSER, hint: HINT_BROWSER }, null, 2)}\n`)
    process.exit(0)
  }

  const child = spawn(process.execPath, launch.args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: process.env.ELECTRON_RUN_AS_NODE ?? '1' },
    windowsHide: true,
  })
  const client = createRpcClient(child)
  const timer = setTimeout(() => {
    killTree(child.pid)
  }, OVERALL_PROBE_TIMEOUT_MS)

  const report = {
    ok: false,
    server: { entry: launch.server.entry, version: launch.server.version },
    browser: launch.browser ?? null,
    channel: launch.channel ?? null,
    config: {
      path: launch.configPath ?? null,
      ...(launch.config ?? CONFIG_DEFAULTS),
      error: launch.configError ?? null,
    },
    profileWindowState: launch.profileWindowState ?? null,
    tools: 0,
    toolSchemaBytes: 0,
    pages: 0,
    page: null,
    error: null,
    stderr: '',
    args: launch.args.slice(1),
  }

  try {
    await client.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'dsh-chrome-mcp-probe', version: '1.0.0' },
    })
    client.notify('notifications/initialized')

    const tools = await client.request('tools/list', {})
    report.tools = tools?.tools?.length ?? 0
    report.toolSchemaBytes = Buffer.byteLength(JSON.stringify(tools?.tools ?? []))

    const pages = await client.request('tools/call', { name: 'list_pages', arguments: {} })
    const pagesText = toolText(pages)
    const pageMatches = [...pagesText.matchAll(/^\s*(\d+):\s(.*)$/gm)]
    report.pages = pageMatches.length
    if (pageMatches.length > 0) {
      const first = pageMatches[0]
      report.page = { pageId: Number(first[1]), title: first[2].replace(/\s*\[selected\]\s*$/, '') }
    } else if (pages?.isError) {
      throw new Error(pagesText || 'list_pages failed')
    }
    report.ok = true
  } catch (error) {
    report.error = String(error?.message ?? error)
  } finally {
    clearTimeout(timer)
    report.stderr = client.stderr()
    await stopChild(child)
  }

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  process.exit(0)
}

function runServer(forwarded) {
  const launch = resolveLaunch(forwarded)
  if (!launch.ok) {
    console.error(`[dsh-chrome-mcp] ${launch.error}`)
    process.exit(1)
  }

  const child = spawn(process.execPath, launch.args, {
    stdio: ['pipe', 'inherit', 'inherit'],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: process.env.ELECTRON_RUN_AS_NODE ?? '1' },
    windowsHide: true,
  })

  // Proxy stdin: when DSH closes it, the server sees EOF on its own stdin and
  // shuts the browser down cleanly, even if this launcher is killed abruptly.
  process.stdin.on('error', () => {})
  child.stdin.on('error', () => {})
  process.stdin.pipe(child.stdin)

  const forward = signal => {
    try {
      child.kill(signal)
    } catch {
      // ignore
    }
  }
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    process.on(signal, () => forward(signal))
  }
  process.on('exit', () => {
    try {
      child.kill()
    } catch {
      // ignore
    }
  })
  child.on('error', error => {
    console.error(`[dsh-chrome-mcp] failed to start chrome-devtools-mcp: ${String(error?.message ?? error)}`)
    process.exit(1)
  })
  child.on('exit', code => process.exit(code ?? 0))
}

const argv = process.argv.slice(2)
if (argv.includes('--detect')) {
  detectReport()
} else if (argv.includes('--probe')) {
  probe(argv.filter(argument => argument !== '--probe'))
} else {
  runServer(argv)
}
