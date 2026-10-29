/**
 * Client-half harness: loads `client.js` through a stand-in module loader, runs
 * its `apply` against a fake client context, and renders the settings page with
 * a minimal hook shim — no browser, no build.
 *
 *   node tests/client.mjs
 */
import assert from 'node:assert/strict'

/**
 * Minimal React stand-in: `createElement` returns a plain tree, `useState`
 * keeps its cells across renders, `useEffect` runs once per dependency change.
 * @returns the shim plus a render helper that resets the hook cursor.
 */
function createReact() {
  const cells = []
  const effects = []
  let cursor = 0

  const createElement = (type, props, ...children) => ({
    type,
    props: props ?? {},
    children: children.flat(),
  })

  return {
    createElement,
    useState(initial) {
      const index = cursor++
      if (cells[index] === undefined) {
        cells[index] = typeof initial === 'function' ? initial() : initial
      }
      const set = (next) => {
        cells[index] = typeof next === 'function' ? next(cells[index]) : next
      }
      return [cells[index], set]
    },
    useEffect(run, deps) {
      const index = cursor++
      const previous = effects[index]
      const unchanged = previous !== undefined
        && Array.isArray(deps)
        && deps.length === previous.deps.length
        && deps.every((value, offset) => value === previous.deps[offset])
      if (unchanged) return
      effects[index] = { deps }
      queueMicrotask(run)
    },
    /** Run one render with the hook cursor at the start. */
    render(component, props) {
      cursor = 0
      return component(props)
    },
    /** Drop every hook cell, so the next render mounts from scratch. */
    reset() {
      cells.length = 0
      effects.length = 0
    },
  }
}

/** Let every pending promise chain and microtask settle. */
async function settle() {
  for (let round = 0; round < 6; round += 1) {
    await new Promise((resolve) => setImmediate(resolve))
  }
}

/** Flatten a tree's text content. */
function textOf(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  return textOf(node.children ?? [])
}

/** Every element in the tree, depth first. */
function walk(node, found = []) {
  if (node === null || node === undefined || typeof node !== 'object') return found
  if (Array.isArray(node)) {
    for (const child of node) walk(child, found)
    return found
  }
  found.push(node)
  for (const child of node.children ?? []) walk(child, found)
  return found
}

/** The first element whose own text matches the label exactly. */
/** Every button whose text is exactly `text`. */
function buttonsNamed(tree, text) {
  return walk(tree).filter((node) => node.type === 'button' && textOf(node) === text)
}

/** The channel row whose label contains `text`. */
function rowFor(tree, text) {
  const row = walk(tree).find((node) => node.type === 'label' && textOf(node).includes(text))
  assert.ok(row !== undefined, `no channel row for ${text}`)
  return row
}

/** Placeholders of the credential fields, in render order. */
function passwordPlaceholders(tree) {
  return walk(tree)
    .filter((node) => node.type === 'input' && node.props.type === 'password')
    .map((node) => node.props.placeholder)
}

function byText(tree, label, type = undefined) {
  return walk(tree).find((node) => (type === undefined || node.type === type) && textOf(node) === label)
}

/** Notifications the page showed, newest last. */
const shown = []

/** Stand-in for the browser Notification API, permission granted. */
class FakeNotification {
  static permission = 'granted'
  static async requestPermission() {
    return 'granted'
  }
  constructor(title, options) {
    this.title = title
    this.options = options
    this.closed = false
    shown.push(this)
  }
  close() {
    this.closed = true
  }
}
globalThis.Notification = FakeNotification
globalThis.focus = () => {}

/** Event streams the page opened. */
const streams = []

/** Stand-in for the browser EventSource. */
class FakeEventSource {
  constructor(url) {
    this.url = url
    this.closed = false
    this.onopen = null
    this.onerror = null
    this.onmessage = null
    streams.push(this)
  }
  close() {
    this.closed = true
  }
}
globalThis.EventSource = FakeEventSource

/** The React module and the plugin the loader received. */
const React = createReact()
globalThis.window = {
  __ModuleLoader__: {
    load({ id, factory }) {
      globalThis.window.__pluginId = id
      globalThis.window.__plugin = factory((name) => {
        if (name === 'react') return React
        throw new Error(`unexpected module "${name}"`)
      })
    },
  },
}
await import('../client.js')

const plugin = globalThis.window.__plugin
assert.equal(globalThis.window.__pluginId, 'dsh-notify')
assert.deepEqual(plugin.inject, ['slots', 'locale'])

/** Configuration the fake host reports. */
const snapshot = {
  platform: 'darwin',
  defaults: {
    templates: {
      turnEnd: '{title}\n{project} · {duration}\n{preview}\n{error}',
      approval: '{title}\n{project} · {tool}\n{reason}',
      question: '{title}\n{project} · {question}',
    },
  },
  config: {
    feishu: { baseUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/' },
    templates: {
      turnEnd: '{title}\n{project} · {duration}\n{preview}\n{error}',
      approval: '{title}\n{project} · {tool}\n{reason}',
      question: '{title}\n{project} · {question}',
    },
    channels: ['local'],
    notifyOn: ['completed'],
    notifyOnApproval: true,
    notifyOnQuestion: true,
    minTurnDurationMs: 0,
    local: { sound: true },
    ntfy: { baseUrl: 'https://ntfy.sh', priority: 'default' },
  },
  secrets: { ntfyTopic: true, ntfyToken: false, feishuToken: true, feishuSecret: false },
  channels: [
    { name: 'local', enabled: true, ready: true },
    { name: 'ntfy', enabled: false, ready: true },
    { name: 'feishu', enabled: false, ready: false },
  ],
}

/** Recorded RPC calls, in order. */
const calls = []

/** What the fake host answers per endpoint. */
const answers = {
  get: () => ({ ok: true, value: snapshot }),
  // A real save adopts what was posted, so the page re-renders from it.
  save: (payload) => ({ ok: true, value: { ...snapshot, config: payload.config } }),
  test: () => ({ ok: true, value: { delivered: true, error: undefined } }),
}

/** The client context the plugin registers into. */
const registered = {}
const effects = []
const cleanups = []
const copy = {}
const ctx = {
  effect(run, label) {
    effects.push(label)
    cleanups.push(run())
  },
  locale: {
    register(namespace, dictionaries) {
      copy[namespace] = dictionaries
    },
    bind(namespace) {
      return (key) => copy[namespace]?.zh?.[key] ?? key
    },
  },
  slots: {
    inject(name, register) {
      assert.equal(name, 'settings.section')
      register()
    },
    register(options, component) {
      registered.options = options
      registered.component = component
      return () => {}
    },
  },
}

/** The page posts one JSON envelope per call; answer it from `answers`. */
globalThis.fetch = async (url, init) => {
  const request = JSON.parse(init.body)
  calls.push({ url, method: init.method, endpoint: request.endpoint, payload: request.payload })
  const answer = answers[request.endpoint]
  assert.ok(answer !== undefined, `unexpected endpoint ${request.endpoint}`)
  const body = JSON.stringify(answer(request.payload))
  return { ok: true, status: 200, text: async () => body }
}

plugin.apply(ctx)

assert.deepEqual(registered.options.name, 'settings.section')
assert.equal(registered.options.id, 'dsh-notify')
assert.equal(registered.options.order, 2)
assert.equal(registered.options.label(), '通知')
assert.deepEqual(effects, [
  'dsh-notify: copy',
  'dsh-notify: browser channel',
  'dsh-notify: settings section',
])

// The browser channel opens one event stream as soon as permission is granted.
assert.equal(streams.length, 1)
assert.equal(streams[0].url, '/dsh-notify/events')

// A frame becomes a system notification, one per event.
streams[0].onopen()
streams[0].onmessage({ data: JSON.stringify({ title: '任务完成', body: 'demo-project · 12s' }) })
assert.equal(shown.length, 1)
assert.equal(shown[0].title, '任务完成')
assert.equal(shown[0].options.body, 'demo-project · 12s')

const props = registered.options.inject()
assert.equal(typeof props.t, 'function')

// First paint: nothing loaded yet.
const loading = React.render(registered.component, props)
assert.match(textOf(loading), /读取中/)

// The load effect resolves, so the form appears.
await settle()
const form = React.render(registered.component, props)
assert.match(textOf(form), /渠道/)
assert.match(textOf(form), /飞书/)
const getCall = calls.find((entry) => entry.endpoint === 'get')
assert.equal(getCall.url, '/dsh-notify/rpc')
assert.equal(getCall.method, 'POST')

// The turn-end row folds its outcomes away and remembers them.
assert.match(textOf(form), /出错/)
rowFor(form, '回合完成').children[0].props.onChange({ target: { checked: false } })
await settle()
const folded = React.render(registered.component, props)
assert.doesNotMatch(textOf(folded), /出错/)
rowFor(folded, '回合完成').children[0].props.onChange({ target: { checked: true } })
await settle()
assert.match(textOf(React.render(registered.component, props)), /出错/)

// Channel settings stay folded while the channel is off.
assert.deepEqual(passwordPlaceholders(form), [])
assert.equal(buttonsNamed(form, '发测试').length, 0)

// Turning a channel on unfolds its settings, with the credentials in place.
const ntfyChannel = rowFor(form, 'ntfy 推送')
ntfyChannel.children[0].props.onChange({ target: { checked: true } })
await settle()
const withNtfy = React.render(registered.component, props)
assert.deepEqual(passwordPlaceholders(withNtfy), ['已配置，留空则保持不变', '未配置'])

const browserChannel = rowFor(withNtfy, '浏览器通知')
browserChannel.children[0].props.onChange({ target: { checked: true } })
await settle()
const withBrowser = React.render(registered.component, props)
assert.match(textOf(withBrowser), /已连接/)

const feishuChannel = rowFor(withBrowser, '飞书')
feishuChannel.children[0].props.onChange({ target: { checked: true } })
await settle()
const toggled = React.render(registered.component, props)
assert.deepEqual(passwordPlaceholders(toggled), [
  '已配置，留空则保持不变', '未配置', '已配置，留空则保持不变', '未配置',
])
// A stored secret never comes back, so an empty field has nothing to reveal.
const eyesBefore = walk(toggled).filter((node) => node.type === 'button' && node.props?.['aria-label'] === '显示')
assert.equal(eyesBefore.length, 0, 'no eye should be offered with nothing typed')

// Typing into one field offers the eye, and clicking it reveals that field only.
const emptyToken = walk(toggled).find((node) => node.type === 'input'
  && node.props?.type === 'password' && node.props.value === '')
await emptyToken.props.onChange({ target: { value: 'paste-me' } })
await settle()
const typedField = React.render(registered.component, props)
const eyes = walk(typedField).filter((node) => node.type === 'button' && node.props?.['aria-label'] === '显示')
assert.equal(eyes.length, 1, 'one typed field, one eye')
await eyes[0].props.onClick()
await settle()
const shownField = walk(React.render(registered.component, props))
  .filter((node) => node.type === 'input' && node.props?.type === 'text')
assert.equal(shownField.length, 1, 'exactly one field should be revealed')

// Templates stay folded until the group is opened.
assert.equal(walk(toggled).filter((node) => node.type === 'textarea').length, 0)
const disclosure = walk(toggled)
  .find((node) => node.type === 'button' && node.props?.['aria-expanded'] === false)
assert.ok(disclosure !== undefined, 'the templates group is not collapsible')
await disclosure.props.onClick()
await settle()
const opened = React.render(registered.component, props)
const boxes = walk(opened).filter((node) => node.type === 'textarea')
assert.equal(boxes.length, 3, 'one template per event')
// Each box arrives filled with the text that is actually sent.
assert.deepEqual(boxes.map((box) => box.props.value), [
  '{title}\n{project} · {duration}\n{preview}\n{error}',
  '{title}\n{project} · {tool}\n{reason}',
  '{title}\n{project} · {question}',
])
// Each row explains itself through an info tooltip, not on the page.
const info = walk(opened).filter((node) => node.props?.role === 'img' && node.props?.['aria-label'] !== undefined)
assert.equal(info.length, 3, 'one info icon per template')
assert.match(info[1].props['aria-label'], /\{title\} 标题，默认「需要你审批」\n\{project\} 项目目录名/)
assert.match(info[1].props['aria-label'], /\{tool\} 工具名/)
assert.doesNotMatch(textOf(opened), /项目目录名/)

// Hovering opens the panel; leaving closes it.
await info[1].props.onMouseEnter()
await settle()
const hovered = React.render(registered.component, props)
assert.match(textOf(hovered), /项目目录名/)
const iconNow = walk(hovered).filter((node) => node.props?.role === 'img')[1]
await iconNow.props.onMouseLeave()
await settle()
assert.doesNotMatch(textOf(React.render(registered.component, props)), /项目目录名/)

// A custom template reaches the save payload.
await boxes[0].props.onChange({ target: { value: '{title}\n{project} · {duration}' } })
await settle()
const ready = React.render(registered.component, props)
const saveButton = byText(ready, '保存', 'button')
assert.ok(saveButton !== undefined, 'save button is missing')
await saveButton.props.onClick()
await settle()

const saveCall = calls.find((entry) => entry.endpoint === 'save')
// Insertion order: the page appends each channel as it is switched on.
assert.deepEqual(saveCall.payload.config.channels, ['local', 'ntfy', 'browser', 'feishu'])
assert.equal(saveCall.payload.config.userIdleMs, 0)
assert.equal(saveCall.payload.config.templates.turnEnd, '{title}\n{project} · {duration}')
// The value typed for the eye test is the only pending secret.
assert.deepEqual(saveCall.payload.secrets, { ntfyTopic: 'paste-me' })

// A box that was edited can be put back to the default text.
const restoreButton = byText(React.render(registered.component, props), '恢复默认', 'button')
assert.ok(restoreButton !== undefined, 'the restore button is missing')
await restoreButton.props.onClick()
await settle()
const restoredBoxes = walk(React.render(registered.component, props)).filter((node) => node.type === 'textarea')
assert.equal(restoredBoxes[0].props.value, '{title}\n{project} · {duration}\n{preview}\n{error}')

// The test button reports the host's verdict.
const afterSave = React.render(registered.component, props)
const testButtons = buttonsNamed(afterSave, '发测试')
assert.equal(testButtons.length, 2)
await testButtons[1].props.onClick()
await settle()

const testCall = calls.find((entry) => entry.endpoint === 'test')
assert.equal(testCall.payload.channel, 'feishu')
assert.match(textOf(React.render(registered.component, props)), /测试消息已发出/)

// Unload closes the stream and opens nothing else.
cleanups[1]()
assert.equal(streams.length, 1)
assert.equal(streams[0].closed, true)

console.log('ok   the client half loads under the module loader and registers one Settings section')
console.log('ok   the browser channel opens one event stream and shows every frame')
console.log('ok   the page loads its state over RPC and renders every channel')
console.log('ok   a configured credential reads as set, a missing one as not configured')
console.log('ok   saving sends the edited configuration back')
console.log('ok   the test button calls the host and reports the result')

// A host with no notification path keeps the plain label and explains itself underneath.
snapshot.platform = 'freebsd'
React.reset()
React.render(registered.component, props)
await settle()
const unsupported = React.render(registered.component, props)
assert.match(textOf(unsupported), /当前系统不支持/)
assert.equal(walk(unsupported).some((node) => node.props?.disabled === true), false)
console.log('ok   a host without a notification path explains it under the checked row')
