/**
 * Persistent-profile window-state guard.
 *
 * Chromium persists the last window placement (`browser.window_placement`) in a
 * profile's `Default/Preferences` and restores it on every launch, *including
 * headless launches*. `chrome-devtools-mcp` applies its viewport with
 * `Browser.setContentsSize`, and Chromium refuses that call while the window
 * state is maximized:
 *
 *   Restore window to normal state before setting content size
 *
 * One visible session that ended maximized therefore poisons every later
 * launch of that profile. The bundled probe always runs headless, so the user
 * sees this as "the browser toolset no longer loads", with no way back short of
 * editing the profile by hand.
 *
 * This guard normalizes a persisted maximized placement back to a normal window
 * before the server is spawned. It is deliberately best effort: a missing or
 * unreadable profile changes nothing, and a failed write never blocks the
 * launch (an already running browser may hold the file, and the next launch
 * retries).
 *
 * @module @local/dsh-chrome-mcp/profile-window-state
 */

import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** A UTF-8 BOM is not valid at the start of a JSON document. */
const LEADING_BOM = /^\uFEFF/

/**
 * The Chromium `Preferences` document of a persistent profile directory.
 * @param {string} userDataDir - the configured `--userDataDir`.
 * @returns {string} the absolute Preferences path to inspect.
 */
export function preferencesPath(userDataDir) {
  return join(userDataDir, 'Default', 'Preferences')
}

/**
 * Clear a persisted maximized window placement, keeping every other setting.
 *
 * Rewriting is atomic (temporary file + rename) so a concurrent reader never
 * sees a half-written document. Preferences is a single JSON object shared by
 * every Chromium setting, so only the one field is changed.
 *
 * @param {string} userDataDir - the configured `--userDataDir`; empty skips.
 * @returns {{ path: string | null, changed: boolean, error: string | null }}
 *   `path` is the Preferences file inspected, `changed` whether it was
 *   rewritten, `error` a diagnostic when the profile could not be normalized.
 */
export function normalizeMaximizedWindowPlacement(userDataDir) {
  if (!userDataDir) return { path: null, changed: false, error: null }
  const file = preferencesPath(userDataDir)

  let preferences
  try {
    preferences = JSON.parse(readFileSync(file, 'utf8').replace(LEADING_BOM, ''))
  } catch (error) {
    if (error?.code === 'ENOENT') return { path: file, changed: false, error: null }
    return { path: file, changed: false, error: String(error?.message ?? error) }
  }

  const placement = preferences?.browser?.window_placement
  if (placement?.maximized !== true) return { path: file, changed: false, error: null }

  placement.maximized = false
  try {
    const temporary = `${file}.dsh-chrome-mcp.tmp`
    writeFileSync(temporary, JSON.stringify(preferences), 'utf8')
    renameSync(temporary, file)
  } catch (error) {
    return { path: file, changed: false, error: String(error?.message ?? error) }
  }
  return { path: file, changed: true, error: null }
}
