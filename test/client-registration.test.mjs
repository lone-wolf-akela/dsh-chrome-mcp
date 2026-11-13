/**
 * Wiring test for the browser half.
 *
 * The module cannot be imported (it registers itself into the page's
 * `__ModuleLoader__` and needs a document), so this loads it in a VM with a
 * minimal page and asserts the one contract that matters: it claims the
 * `take_screenshot` Tool row, registers its dictionaries and styles, and
 * imports no Harness Client package. Rendering itself is verified in the live
 * Web GUI; this test catches a renamed key, a changed namespace, or a
 * dependency on an internal module.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const CLIENT_URL = new URL('../client.js', import.meta.url)
const SOURCE = readFileSync(CLIENT_URL, 'utf8')

/** Evaluate client.js against a fake page and return the module definition. */
function loadDefinition() {
  const loaded = []
  const appended = []
  const context = {
    window: { __ModuleLoader__: { load(definition) { loaded.push(definition) } } },
    document: {
      head: { appendChild(element) { appended.push(element) } },
      createElement() {
        return { dataset: {}, textContent: '', remove() {} }
      },
      body: {},
    },
    console,
  }
  vm.runInNewContext(SOURCE, context, { filename: 'client.js' })
  assert.equal(loaded.length, 1, 'client.js must register exactly one module definition')
  return { definition: loaded[0], appended }
}

/** Minimal React surface: the module only builds elements and calls hooks inside views. */
function fakeRequire(specifier) {
  if (specifier === 'react') {
    return {
      createElement() { return {} },
      useState() { return [null, () => {}] },
      useEffect() {},
      useRef() { return { current: null } },
      useCallback(fn) { return fn },
      Fragment: { fragment: true },
    }
  }
  if (specifier === 'react-dom') return { createPortal(node) { return node } }
  throw new Error(`client.js must not import ${specifier}`)
}

test('client half claims the screenshot tool row through the module table', () => {
  assert.equal(/require\((['"])@deepseek-ai\//.test(SOURCE), false,
    'client.js must not load a Harness Client package as a module')

  const { definition, appended } = loadDefinition()
  assert.equal(definition.id, '@local/dsh-chrome-mcp')

  const plugin = definition.factory(fakeRequire)
  assert.deepEqual([...plugin.inject], ['slots', 'locale'])

  const dictionaries = []
  const registrations = []
  const ctx = {
    effect(factory) { return factory() },
    locale: { register(namespace, dictionary) { dictionaries.push({ namespace, dictionary }) } },
    slots: {
      inject(owner, callback) {
        assert.equal(owner, 'tool.call.toolview')
        return callback()
      },
      register(options, component) {
        registrations.push({ options, component })
        return () => {}
      },
    },
  }

  plugin.apply(ctx)

  assert.equal(registrations.length, 1, 'exactly one Tool row is claimed')
  const [{ options, component }] = registrations
  assert.equal(options.name, 'tool.call.toolview')
  assert.equal(options.key, 'mcp__chrome__take_screenshot')
  assert.equal(options.locale, 'chrome-mcp')
  assert.equal(typeof component, 'function')

  assert.equal(dictionaries.length, 1)
  assert.equal(dictionaries[0].namespace, 'chrome-mcp')
  assert.equal(dictionaries[0].dictionary.en['screenshot.title'], 'Screenshot')
  assert.equal(dictionaries[0].dictionary.zh['screenshot.title'], '截图')
  for (const locale of ['en', 'zh']) {
    assert.equal(typeof dictionaries[0].dictionary[locale]['screenshot.summary'], 'string')
    assert.equal(typeof dictionaries[0].dictionary[locale]['screenshot.close'], 'string')
  }

  assert.equal(appended.length, 1, 'the module injects its stylesheet')
  assert.equal(appended[0].dataset.plugin, '@local/dsh-chrome-mcp')
  assert.match(appended[0].textContent, /\.dsh-chrome-shot-row/)
})
