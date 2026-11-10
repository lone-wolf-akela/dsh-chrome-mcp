import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  normalizeMaximizedWindowPlacement,
  preferencesPath,
} from '../profile-window-state.mjs'

function makeProfile() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-chrome-mcp-window-state-'))
  mkdirSync(join(root, 'Default'), { recursive: true })
  return root
}

function writePreferences(root, preferences) {
  const file = preferencesPath(root)
  writeFileSync(file, JSON.stringify(preferences), 'utf8')
  return file
}

test('preferencesPath points at the profile Default document', () => {
  assert.equal(preferencesPath('C:\\profiles\\one'), join('C:\\profiles\\one', 'Default', 'Preferences'))
})

test('a persisted maximized placement is normalized to a normal window', () => {
  const root = makeProfile()
  try {
    const file = writePreferences(root, {
      browser: {
        window_placement: { maximized: true, left: 0, top: 174, right: 1302, bottom: 1032 },
      },
      profile: { name: 'user' },
    })
    const result = normalizeMaximizedWindowPlacement(root)
    assert.deepEqual(result, { path: file, changed: true, error: null })
    const after = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(after.browser.window_placement.maximized, false)
    assert.equal(after.browser.window_placement.right, 1302)
    assert.equal(after.profile.name, 'user')
    assert.deepEqual(
      readdirSync(join(root, 'Default')).filter(name => name.endsWith('.tmp')),
      [],
      'no temporary file is left behind',
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a normal or missing placement is left untouched', () => {
  const root = makeProfile()
  try {
    const file = writePreferences(root, { browser: { window_placement: { maximized: false } } })
    const before = readFileSync(file, 'utf8')
    assert.deepEqual(normalizeMaximizedWindowPlacement(root), { path: file, changed: false, error: null })
    assert.equal(readFileSync(file, 'utf8'), before)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a profile without Preferences is a no-op', () => {
  const root = makeProfile()
  try {
    const file = preferencesPath(root)
    assert.deepEqual(normalizeMaximizedWindowPlacement(root), { path: file, changed: false, error: null })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('an unreadable Preferences document reports an error and never throws', () => {
  const root = makeProfile()
  try {
    writeFileSync(preferencesPath(root), '{ not json', 'utf8')
    const result = normalizeMaximizedWindowPlacement(root)
    assert.equal(result.changed, false)
    assert.equal(typeof result.error, 'string')
    assert.ok(result.error.length > 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('an empty userDataDir skips the guard', () => {
  assert.deepEqual(normalizeMaximizedWindowPlacement(''), { path: null, changed: false, error: null })
})
