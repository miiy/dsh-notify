/**
 * Harness for dsh-notify: drives the plugin with a fake context, a temporary
 * DSH home and an in-memory credential store, so the wiring is verified without
 * loading a real DSH host or touching the network.
 *
 *   node tests/harness.mjs
 */
import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, inject, name, renderTemplate } from '../index.js'
import { toastCommand } from '../channels.js'
import { RPC_PATH } from '../rpc.js'
import { EVENTS_PATH } from '../browser.js'
import { DEFAULT_CONFIG, DEFAULT_TEMPLATES, buildSettings, normalizeConfig } from '../config.js'

// Sends are stubbed at the process boundary: a fake binary first on PATH for the
// desktop channel, and a fake `fetch` for ntfy and Feishu. Nothing leaves the machine.
const STUB_BIN = await mkdtemp(join(tmpdir(), 'dsh-notify-bin-'))
for (const binary of ['osascript', 'notify-send']) {
  await writeFile(join(STUB_BIN, binary), '#!/bin/sh\nexit 0\n')
  await chmod(join(STUB_BIN, binary), 0o755)
}
process.env.PATH = `${STUB_BIN}:${process.env.PATH}`
const FETCHED = []
globalThis.fetch = async (url, init) => {
  FETCHED.push({ url, init })
  return { ok: true, status: 200, json: async () => ({}), text: async () => '' }
}

/** Cwd the fake sessions run in. */
const CWD = '/tmp/demo-project'

/** Configuration every case starts from: two channels, both stubbed at the boundary. */
const BASE = {
  channels: ['local', 'ntfy'],
  notifyOn: ['completed', 'error', 'max-tokens'],
  // The suite drives a delivery per turn; the idle window has its own cases.
  userIdleMs: 0,
}

/** Browser-only and live: nothing leaves the machine, so the frames must really be written. */
const BROWSER = {
  channels: ['browser'],
  notifyOn: ['completed', 'error', 'max-tokens'],
  userIdleMs: 0,
}

/** Point the plugin at a throwaway DSH home and write its configuration file. */
async function makeHome(config) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-notify-'))
  process.env.DSH_HOME = home
  if (config !== undefined) {
    await mkdir(join(home, 'dsh-notify'), { recursive: true })
    await writeFile(join(home, 'dsh-notify', 'config.json'), JSON.stringify(config))
  }
  return home
}

/** In-memory stand-in for the Host credential seam. */
function fakeCredentials(initial = {}) {
  const store = new Map(Object.entries(initial))
  return {
    store,
    async resolve(ref) {
      return store.has(ref) ? { value: store.get(ref) } : undefined
    },
    async describe(ref) {
      return { configured: store.has(ref) }
    },
    async set(ref, value) {
      store.set(ref, value)
    },
    async unset(ref) {
      store.delete(ref)
    },
  }
}

/** Fake root Context: records handlers and mounts the plugin's two routes. */
function createContext({ credentials = fakeCredentials(), reject = undefined, connection = true } = {}) {
  const handlers = new Map()
  const lines = []
  const routes = new Map()
  const connectionService = connection
    ? {
        requestRejection() {
          return reject
        },
      }
    : undefined
  const scoped = {
    webServer: {
      register(registered) {
        routes.set(registered.path, registered)
        return () => {
          routes.delete(registered.path)
        }
      },
    },
    effect(run) {
      return run()
    },
    on() {},
  }
  const injected = []
  const ctx = {
    credentials,
    get(name) {
      return name === 'connection' ? connectionService : undefined
    },
    inject(deps, callback) {
      injected.push(deps)
      callback(scoped)
    },
    on(type, handler) {
      handlers.set(type, handler)
    },
    logger: {
      info: (line) => lines.push({ level: 'info', line }),
      warn: (line) => lines.push({ level: 'warn', line }),
    },
  }
  return {
    ctx,
    lines,
    credentials,
    injected,
    routes,
    get route() {
      const route = routes.get(EVENTS_PATH)
      assert.ok(route !== undefined, 'the event stream route was never registered')
      return route
    },
    emit(type, ...args) {
      const handler = handlers.get(type)
      assert.ok(handler !== undefined, `no handler for ${type}`)
      return handler(...args)
    },
    /**
     * Call one settings endpoint the way the page does: one POST to the route.
     * @param endpoint - `get`, `save` or `test`.
     * @param payload - the request body.
     */
    async rpc(endpoint, payload = {}) {
      const route = routes.get(RPC_PATH)
      assert.ok(route !== undefined, 'the settings transport was never registered')
      const response = fakeResponse()
      await route.handler(fakeRequest({ endpoint, payload }), response)
      assert.equal(response.status, 200, `unexpected status ${response.status}`)
      return JSON.parse(response.body())
    },
  }
}

/** Let a fire-and-forget notification finish its microtasks. */
function flush() {
  return new Promise((resolve) => setImmediate(resolve))
}

/** Lines where one channel reports its outcome. */
function reports(lines) {
  return lines.filter((entry) => / sent \(| failed: /.test(entry.line))
}

/**
 * Wait for `count` channels to report. A send runs out of process, so the
 * journal is the only completion signal; `count` of zero opens a short window
 * instead, because a missing notification cannot be waited for.
 * @param booted - the booted context, whose `lines` grow as work lands.
 * @param count - how many channels must report before this resolves.
 */
async function waitForReports(booted, count) {
  const startedAt = Date.now()
  const window = count === 0 ? 120 : 3000
  while (Date.now() - startedAt < window) {
    if (count > 0 && reports(booted.lines).length >= count) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  if (count > 0) throw new Error(`expected ${count} channel reports, got ${reports(booted.lines).length}`)
}

/** A session as the plugin receives it. */
function sessionOf(id, header = {}) {
  return { id, header: { cwd: CWD, ...header } }
}

/** Decode the toast XML back out of the encoded PowerShell command. */
function decodeToast(encoded) {
  const script = Buffer.from(encoded, 'base64').toString('utf16le')
  const payload = script.match(/FromBase64String\('([^']+)'\)/)
  assert.ok(payload !== null, 'the script carries no XML payload')
  return Buffer.from(payload[1], 'base64').toString('utf8')
}

/** Stand-in for the Node response of the event stream route. */
function fakeResponse() {
  const closers = []
  return {
    status: null,
    ended: false,
    destroyed: false,
    frames: [],
    writeHead(status, headers = {}) {
      this.status = status
      this.headers = headers
    },
    write(chunk) {
      this.frames.push(chunk)
    },
    end(body) {
      this.ended = true
      this.endedWith = body
    },
    destroy() {
      this.destroyed = true
    },
    on(event, handler) {
      if (event === 'close') closers.push(handler)
    },
    close() {
      for (const handler of closers) handler()
    },
    body() {
      return String(this.endedWith ?? '')
    },
  }
}

/** Stand-in for the Node request of the settings route: one JSON body. */
function fakeRequest(body) {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  return {
    method: 'POST',
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(text, 'utf8')
    },
  }
}

/** Attach one fake page to the stream route and return it. */
function openPage(booted) {
  const page = fakeResponse()
  booted.route.handler({ method: 'GET' }, page)
  return page
}

/** How many channels the boot line says are live. */
function liveChannels(booted) {
  const line = booted.lines.find((entry) => entry.line.includes('ready, channels:'))
  const tail = line.line.slice(line.line.indexOf('ready, channels:') + 'ready, channels:'.length).trim()
  return tail === 'none' ? 0 : tail.split(',').length
}

/** The delivery lines, one per channel that accepted the message. */
function deliveries(lines) {
  return lines.filter((entry) => entry.level === 'info' && entry.line.includes(' sent ('))
}

/** Drive one full turn and return the delivery lines. */
async function runTurn(booted, { kind = 'completed', header = {}, preview = 'ok', expect } = {}) {
  const session = sessionOf('session-1', header)
  booted.emit('session/event', session, { type: 'turn/start', data: { turn: 1 } })
  booted.emit('session/event', session, {
    type: 'assistant/message',
    data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: preview }] } },
  })
  booted.emit('session/event', session, { type: 'turn/end', data: { turn: 1, reason: { kind } } })
  await flush()
  // The boot line names the channels that are actually live; every turn reports
  // once per live channel, and a silent turn has to be waited out instead.
  await waitForReports(booted, expect ?? liveChannels(booted))
  return deliveries(booted.lines)
}

/**
 * Emit one approval ask and wait for the channels to report.
 * @param booted - the booted context.
 * @param options - `header` for the session and `data` for the event.
 * @param expect - channel reports to wait for; defaults to every live channel.
 */
async function askApproval(booted, { header = {}, data = { id: 'a1', toolName: 'bash' } } = {}, expect) {
  booted.emit('session/event', sessionOf('s1', header), { type: 'approval/asked', data })
  await flush()
  await waitForReports(booted, expect ?? liveChannels(booted))
  return deliveries(booted.lines)
}

/** Start the plugin over one home and credential store. */
async function boot(config, credentials) {
  await makeHome(config)
  const booted = createContext({ credentials })
  await apply(booted.ctx)
  return booted
}

/** Ask one question through the waterfall observer and report what happened. */
async function askQuestion(booted, questions, expect) {
  let delegated = 0
  const answer = booted.emit('user-questions/request', {
    questions,
    agent: { session: sessionOf('s1') },
  }, () => {
    delegated += 1
    return Promise.resolve({ answers: [] })
  })
  await answer
  await flush()
  await waitForReports(booted, expect ?? liveChannels(booted))
  return { delegated, lines: deliveries(booted.lines) }
}

const cases = [
  {
    name: 'a template fills its placeholders, first line as the title',
    run: async () => {
      const filled = renderTemplate('{title} | {project}\n{tool}\n\n{missing}', {
        title: '需要你审批', project: 'demo', tool: 'bash',
      })
      assert.deepEqual(filled, { title: '需要你审批 | demo', body: 'bash\n\n{missing}' })
      assert.deepEqual(renderTemplate('   ', {}), { title: '', body: '' })
    },
  },
  {
    name: 'a custom turn-end template replaces the built-in text',
    run: async () => {
      const booted = await boot(
        { ...BASE, channels: ['feishu'], templates: { turnEnd: '{outcome}:{title}\n{project} {duration}' } },
        fakeCredentials({ DSH_NOTIFY_FEISHU_TOKEN: 'token-1' }),
      )
      FETCHED.length = 0
      const lines = await runTurn(booted)
      assert.match(lines[0].line, /feishu sent \(completed:任务完成\)/)
      // The request body carries title and body together.
      assert.match(FETCHED[0].init.body, /completed:任务完成\\ndemo-project /)
    },
  },
  {
    name: 'the Feishu webhook is composed from its prefix and the token',
    run: async () => {
      const booted = await boot({ ...BASE, channels: ['feishu'] }, fakeCredentials({ DSH_NOTIFY_FEISHU_TOKEN: 'token-1' }))
      FETCHED.length = 0
      await runTurn(booted)
      const call = FETCHED.find((entry) => entry.url.includes('open.feishu.cn'))
      assert.equal(call.url, 'https://open.feishu.cn/open-apis/bot/v2/hook/token-1')
      assert.match(call.init.body, /任务完成/)
    },
  },
  {
    name: 'a completed turn notifies every enabled channel',
    run: async () => {
      const booted = await boot(BASE, fakeCredentials({ DSH_NOTIFY_NTFY_TOPIC: 'topic-1' }))
      const lines = await runTurn(booted)
      assert.equal(lines.length, 2)
      assert.deepEqual(lines.map((entry) => entry.line).sort(), [
        'dsh-notify: local sent (任务完成)',
        'dsh-notify: ntfy sent (任务完成)',
      ])
    },
  },
  {
    name: 'an enabled channel without its credential stays off',
    run: async () => {
      const booted = await boot(BASE, fakeCredentials())
      const lines = await runTurn(booted)
      assert.equal(lines.length, 1)
      assert.match(lines[0].line, /local sent/)
      assert.ok(booted.lines.some((entry) => entry.line.includes('left off: ntfy topic')))
    },
  },
  {
    name: 'subagent turns stay silent',
    run: async () => {
      const booted = await boot(BASE, fakeCredentials({ DSH_NOTIFY_NTFY_TOPIC: 'topic-1' }))
      assert.equal((await runTurn(booted, { header: { origin: 'subagent' }, expect: 0 })).length, 0)
    },
  },
  {
    name: 'deep delegation stays silent',
    run: async () => {
      const booted = await boot(BASE, fakeCredentials())
      assert.equal((await runTurn(booted, { header: { delegationDepth: 2 }, expect: 0 })).length, 0)
    },
  },
  {
    name: 'an aborted turn stays silent',
    run: async () => {
      const booted = await boot(BASE, fakeCredentials())
      assert.equal((await runTurn(booted, { kind: 'aborted', expect: 0 })).length, 0)
    },
  },
  {
    name: 'the idle window holds the turn-end message',
    run: async () => {
      const booted = await boot({ ...BASE, userIdleMs: 120 }, fakeCredentials())
      const session = sessionOf('session-1')
      booted.emit('session/event', session, { type: 'turn/start', data: { turn: 1 } })
      booted.emit('session/event', session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
      await flush()
      assert.equal(reports(booted.lines).length, 0, 'the message went out before the window closed')
      await waitForReports(booted, liveChannels(booted))
      assert.equal(deliveries(booted.lines).length, liveChannels(booted))
    },
  },
  {
    name: 'a turn starting inside the idle window cancels the message',
    run: async () => {
      const booted = await boot({ ...BASE, userIdleMs: 100 }, fakeCredentials())
      const session = sessionOf('session-1')
      booted.emit('session/event', session, { type: 'turn/start', data: { turn: 1 } })
      booted.emit('session/event', session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
      booted.emit('session/event', session, { type: 'turn/start', data: { turn: 2 } })
      // Outlast the window: waitForReports(0) polls for longer than it, so a
      // surviving timer would have fired by the time this returns.
      await waitForReports(booted, 0)
      assert.equal(reports(booted.lines).length, 0, 'a cancelled message was still delivered')
    },
  },
  {
    name: 'the idle window holds an approval ask',
    run: async () => {
      const booted = await boot({ ...BASE, userIdleMs: 120 }, fakeCredentials())
      booted.emit('session/event', sessionOf('s1'), {
        type: 'approval/asked',
        data: { id: 'a1', toolName: 'bash', reason: 'needs approval' },
      })
      await flush()
      assert.equal(reports(booted.lines).length, 0, 'the message went out before the window closed')
      await waitForReports(booted, liveChannels(booted))
      assert.equal(deliveries(booted.lines)[0] !== undefined, true)
    },
  },
  {
    name: 'answering an approval inside the idle window cancels the message',
    run: async () => {
      const booted = await boot({ ...BASE, userIdleMs: 100 }, fakeCredentials())
      const session = sessionOf('s1')
      booted.emit('session/event', session, { type: 'approval/asked', data: { id: 'a1', toolName: 'bash' } })
      booted.emit('session/event', session, { type: 'approval/decided', data: { id: 'a1', outcome: 'allowed-once' } })
      await waitForReports(booted, 0)
      assert.equal(reports(booted.lines).length, 0, 'a cancelled message was still delivered')
    },
  },
  {
    name: 'answering a question inside the idle window cancels the message',
    run: async () => {
      const booted = await boot({ ...BASE, userIdleMs: 100 }, fakeCredentials())
      // The waterfall settles when the answerer replies, which is the signal the
      // held message watches: the user is at the keyboard, so nothing is sent.
      await askQuestion(booted, [{ question: 'which one?' }], 0)
      assert.equal(reports(booted.lines).length, 0, 'a cancelled message was still delivered')
    },
  },
  {
    name: 'an approval ask notifies',
    run: async () => {
      const booted = await boot(BASE, fakeCredentials())
      const lines = await askApproval(booted, { data: { id: 'a1', toolName: 'bash', reason: 'needs approval' } })
      assert.equal(lines.length, 1)
      assert.match(lines[0].line, /需要你审批/)
    },
  },
  {
    name: 'subagent approvals stay silent',
    run: async () => {
      const booted = await boot(BASE, fakeCredentials())
      assert.equal((await askApproval(booted, { header: { origin: 'subagent' } }, 0)).length, 0)
    },
  },
  {
    name: 'notifyOnApproval false stays silent',
    run: async () => {
      const booted = await boot({ ...BASE, notifyOnApproval: false }, fakeCredentials())
      assert.equal((await askApproval(booted, {}, 0)).length, 0)
    },
  },
  {
    name: 'a question notifies and still delegates to the real answerer',
    run: async () => {
      const booted = await boot({ ...BASE, channels: ['local'] }, fakeCredentials())
      const { delegated, lines } = await askQuestion(booted, [{ id: 'q1', question: 'Proceed?' }])
      assert.equal(delegated, 1)
      assert.equal(lines.length, 1)
      assert.match(lines[0].line, /等你回答/)
    },
  },
  {
    name: 'an empty question list delegates without notifying',
    run: async () => {
      const booted = await boot({ ...BASE, channels: ['local'] }, fakeCredentials())
      const { delegated, lines } = await askQuestion(booted, [], 0)
      assert.equal(delegated, 1)
      assert.equal(lines.length, 0)
    },
  },
  {
    name: 'notifyOnQuestion false still delegates, without a notification',
    run: async () => {
      const booted = await boot({ ...BASE, channels: ['local'], notifyOnQuestion: false }, fakeCredentials())
      const { delegated, lines } = await askQuestion(booted, [{ id: 'q1', question: 'Proceed?' }], 0)
      assert.equal(delegated, 1)
      assert.equal(lines.length, 0)
    },
  },
  {
    name: 'an unknown channel is rejected at the boundary',
    run: async () => {
      assert.throws(() => normalizeConfig({ channels: ['carrier-pigeon'] }), /unknown channel/)
    },
  },
  {
    name: 'a malformed base URL is rejected at the boundary',
    run: async () => {
      assert.throws(() => normalizeConfig({ ntfy: { baseUrl: 'ntfy.sh' } }), /http\(s\) URL/)
    },
  },
  {
    name: 'an out-of-range idle window is rejected at the boundary',
    run: async () => {
      assert.throws(() => normalizeConfig({ userIdleMs: -1 }), /between 0 and 3600000/)
      assert.throws(() => normalizeConfig({ userIdleMs: 3_600_001 }), /between 0 and 3600000/)
    },
  },
  {
    name: 'buildSettings reports the channel a missing credential holds back',
    run: async () => {
      const { settings, missing } = buildSettings(
        normalizeConfig({ channels: ['local', 'feishu'] }),
        { ntfyTopic: '', ntfyToken: '', feishuToken: '', feishuSecret: '' },
      )
      assert.deepEqual(settings.channels, ['local'])
      assert.deepEqual(missing, ['feishu token'])
    },
  },
  {
    name: 'the settings channel reports configuration without any secret',
    run: async () => {
      const booted = await boot(BASE, fakeCredentials({ DSH_NOTIFY_NTFY_TOPIC: 'topic-1' }))
      const result = await booted.rpc('get')
      assert.equal(result.ok, true)
      assert.deepEqual(result.value.secrets, {
        ntfyTopic: true, ntfyToken: false, feishuToken: false, feishuSecret: false,
      })
      assert.deepEqual(result.value.channels.map((entry) => [entry.name, entry.enabled, entry.ready]), [
        ['local', true, true],
        ['browser', false, true],
        ['ntfy', true, true],
        ['feishu', false, false],
      ])
      assert.equal(JSON.stringify(result.value).includes('topic-1'), false)
    },
  },
  {
    name: 'saving a channel without its credential is refused',
    run: async () => {
      const booted = await boot(BASE, fakeCredentials())
      const result = await booted.rpc('save', { config: { channels: ['feishu'] }, secrets: {} })
      assert.equal(result.ok, false)
      assert.match(result.error.message, /credentials for feishu/)
    },
  },
  {
    name: 'saving writes the file and swaps the live settings',
    run: async () => {
      const home = await makeHome({ channels: ['local'] })
      const booted = createContext()
      await apply(booted.ctx)
      // The settings page sends the whole configuration, idle window included.
      const result = await booted.rpc('save', {
        config: { channels: ['local', 'ntfy'], userIdleMs: 0 },
        secrets: { ntfyTopic: 'fresh-topic' },
      })
      assert.equal(result.ok, true)
      assert.equal(booted.credentials.store.get('DSH_NOTIFY_NTFY_TOPIC'), 'fresh-topic')
      const written = JSON.parse(await readFile(join(home, 'dsh-notify', 'config.json'), 'utf8'))
      assert.deepEqual(written.channels, ['local', 'ntfy'])
      assert.equal((await runTurn(booted)).length, 2)
    },
  },
  {
    name: 'clearing a credential leaves the channel off',
    run: async () => {
      const booted = await boot(BASE, fakeCredentials({ DSH_NOTIFY_NTFY_TOPIC: 'topic-1' }))
      const result = await booted.rpc('save', {
        config: { channels: ['local', 'ntfy'] },
        secrets: { ntfyTopic: '' },
      })
      assert.equal(result.ok, false)
      assert.match(result.error.message, /credentials for ntfy/)
    },
  },
  {
    name: 'the test button refuses a channel that is not configured',
    run: async () => {
      const booted = await boot(BASE, fakeCredentials())
      const result = await booted.rpc('test', { channel: 'feishu' })
      assert.equal(result.ok, true)
      assert.deepEqual(result.value, { delivered: false, error: 'not configured yet' })
    },
  },
  {
    name: 'the browser stream pushes one frame per notification',
    run: async () => {
      const booted = await boot(BROWSER, fakeCredentials())
      const page = openPage(booted)
      const lines = await runTurn(booted)
      assert.equal(lines.length, 1)
      assert.match(lines[0].line, /browser sent/)
      const frame = page.frames.find((entry) => entry.startsWith('data: '))
      assert.ok(frame !== undefined)
      assert.equal(JSON.parse(frame.slice(6)).title, '任务完成')
    },
  },
  {
    name: 'the browser channel reports a page that is not listening',
    run: async () => {
      const booted = await boot(BROWSER, fakeCredentials())
      const lines = await runTurn(booted)
      assert.equal(lines.length, 0)
      assert.ok(booted.lines.some((entry) => entry.level === 'warn'
        && entry.line.includes('browser failed: no page is listening')))
    },
  },
  {
    name: 'a closed page stops counting as a listener',
    run: async () => {
      const booted = await boot(BROWSER, fakeCredentials())
      const page = openPage(booted)
      page.close()
      await runTurn(booted)
      assert.ok(booted.lines.some((entry) => entry.line.includes('no page is listening')))
    },
  },
  {
    name: 'the test button reaches an open page',
    run: async () => {
      const booted = await boot(BASE, fakeCredentials())
      const page = openPage(booted)
      const result = await booted.rpc('test', { channel: 'browser' })
      // The route answers JSON, which drops an undefined `error`; the page reads `delivered`.
      assert.equal(result.value.delivered, true)
      const frame = page.frames.find((entry) => entry.startsWith('data: '))
      assert.equal(JSON.parse(frame.slice(6)).title, 'dsh-notify 测试')
    },
  },
  {
    name: 'the stream route opens an event stream for an admitted request',
    run: async () => {
      const booted = await boot(BASE, fakeCredentials())
      const page = fakeResponse()
      booted.route.handler({ method: 'GET' }, page)
      assert.equal(page.status, 200)
      assert.equal(page.frames[0], ': connected\n\n')
    },
  },
  {
    name: 'the stream route refuses a request the connection fence rejects',
    run: async () => {
      await makeHome(BASE)
      const booted = createContext({ reject: 403 })
      await apply(booted.ctx)
      const page = fakeResponse()
      booted.route.handler({ method: 'GET' }, page)
      assert.equal(page.status, 403)
      assert.equal(page.frames.length, 0)
    },
  },
  {
    name: 'the stream route refuses a non-GET request',
    run: async () => {
      const booted = await boot(BASE, fakeCredentials())
      const page = fakeResponse()
      booted.route.handler({ method: 'POST' }, page)
      assert.equal(page.status, 405)
    },
  },
  {
    name: 'both routes are mounted on the web server',
    run: async () => {
      const booted = await boot(BASE, fakeCredentials())
      assert.deepEqual(booted.injected, [['webServer']])
      assert.deepEqual([...booted.routes.keys()].sort(), [EVENTS_PATH, RPC_PATH].sort())
    },
  },
  {
    name: 'a host without a notification path cannot enable the desktop channel',
    run: async () => {
      const booted = await boot(BASE, fakeCredentials())
      const snapshot = (await booted.rpc('get')).value
      assert.equal(snapshot.platform, process.platform)
      const config = normalizeConfig({ ...DEFAULT_CONFIG, channels: ['local'] })
      const secrets = { ntfyTopic: '', ntfyToken: '', feishuToken: '', feishuSecret: '' }
      const { settings, missing } = buildSettings(config, secrets, 'freebsd')
      assert.deepEqual(settings.channels, [])
      assert.deepEqual(missing, ['desktop notifications on freebsd'])
    },
  },
  {
    name: 'the settings route answers a POST with one envelope',
    run: async () => {
      const booted = await boot(BASE, fakeCredentials())
      const response = fakeResponse()
      await booted.routes.get(RPC_PATH).handler(fakeRequest({ endpoint: 'get', payload: {} }), response)
      assert.equal(response.status, 200)
      assert.match(response.headers['content-type'], /application\/json/)
      const envelope = JSON.parse(response.body())
      assert.equal(envelope.ok, true)
      assert.deepEqual(envelope.value.config.channels, BASE.channels)
    },
  },
  {
    name: 'the settings route refuses a non-POST request',
    run: async () => {
      const booted = await boot(BASE, fakeCredentials())
      const response = fakeResponse()
      await booted.routes.get(RPC_PATH).handler({ method: 'GET' }, response)
      assert.equal(response.status, 405)
    },
  },
  {
    name: 'the settings route rejects a body that is not JSON',
    run: async () => {
      const booted = await boot(BASE, fakeCredentials())
      const response = fakeResponse()
      await booted.routes.get(RPC_PATH).handler(fakeRequest('{ nope'), response)
      assert.equal(response.status, 400)
      assert.match(JSON.parse(response.body()).error.message, /not JSON/)
    },
  },
  {
    name: 'a route answers 503 when no connection service exists',
    run: async () => {
      await makeHome(BASE)
      const booted = createContext({ connection: false })
      await apply(booted.ctx)
      const response = fakeResponse()
      await booted.routes.get(RPC_PATH).handler(fakeRequest({ endpoint: 'get' }), response)
      assert.equal(response.status, 503)
    },
  },
  {
    name: 'the plugin declares every service it reads off the context',
    run: async () => {
      assert.equal(name, 'dsh-notify')
      assert.deepEqual(inject, ['credentials'])
    },
  },
  {
    name: 'an unknown RPC endpoint fails without throwing',
    run: async () => {
      const booted = await boot(BASE, fakeCredentials())
      const result = await booted.rpc('nope')
      assert.equal(result.ok, false)
      assert.match(result.error.message, /unknown endpoint/)
    },
  },
  {
    name: 'a corrupt configuration file falls back to the defaults',
    run: async () => {
      const home = await makeHome(undefined)
      await mkdir(join(home, 'dsh-notify'), { recursive: true })
      await writeFile(join(home, 'dsh-notify', 'config.json'), '{ not json')
      const booted = createContext()
      await apply(booted.ctx)
      assert.ok(booted.lines.some((entry) => entry.line.includes('unusable, using defaults')))
    },
  },
  {
    name: 'the windows toast carries both lines and the default sound',
    run: async () => {
      const argv = toastCommand({ title: '任务完成', body: 'demo-project · 12s' }, true)
      assert.deepEqual(argv.slice(0, 3), ['-NoProfile', '-NonInteractive', '-EncodedCommand'])
      const xml = decodeToast(argv[3])
      assert.match(xml, /<text>任务完成<\/text>/)
      assert.match(xml, /<text>demo-project · 12s<\/text>/)
      assert.match(xml, /ms-winsoundevent:Notification.Default/)
      assert.match(xml, /^<toast>/)
    },
  },
  {
    name: 'the windows toast escapes markup and honours the sound switch',
    run: async () => {
      const argv = toastCommand({ title: '<&>', body: "it's" }, false)
      const xml = decodeToast(argv[3])
      assert.match(xml, /<text>&lt;&amp;&gt;<\/text>/)
      assert.match(xml, /<text>it&apos;s<\/text>/)
      assert.match(xml, /<audio silent="true"\/>/)
    },
  },
  {
    name: 'the windows toast targets the built-in PowerShell profile',
    run: async () => {
      const script = Buffer.from(toastCommand({ title: 't', body: 'b' }, true)[3], 'base64').toString('utf16le')
      assert.match(script, /CreateToastNotifier\('\{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7\}\\WindowsPowerShell\\v1\.0\\powershell\.exe'\)/)
      assert.equal(script.includes('Set-ItemProperty'), false)
      assert.equal(script.includes('New-Item'), false)
    },
  },
  {
    name: 'the default template produces the built-in turn-end message',
    run: async () => {
      const booted = await boot(
        { ...BASE, channels: ['feishu'] },
        fakeCredentials({ DSH_NOTIFY_FEISHU_TOKEN: 'token-1' }),
      )
      FETCHED.length = 0
      await runTurn(booted)
      // Feishu sends title and body as one string.
      const payload = JSON.parse(FETCHED[0].init.body)
      assert.match(payload.content.text, /^任务完成\ndemo-project · \S+\nok$/)
    },
  },
  {
    name: 'a failed turn carries its error line in the default template',
    run: async () => {
      const booted = await boot(
        { ...BASE, channels: ['feishu'] },
        fakeCredentials({ DSH_NOTIFY_FEISHU_TOKEN: 'token-1' }),
      )
      FETCHED.length = 0
      await runTurn(booted, { kind: 'error', header: {} })
      assert.match(FETCHED[0].init.body, /任务出错/)
    },
  },
  {
    name: 'a blank template falls back to the default text',
    run: async () => {
      const config = normalizeConfig({ ...DEFAULT_CONFIG, templates: { turnEnd: '   ' } })
      assert.equal(config.templates.turnEnd, DEFAULT_TEMPLATES.turnEnd)
    },
  },
]

let failed = 0
for (const testCase of cases) {
  try {
    await testCase.run()
    console.log(`ok   ${testCase.name}`)
  } catch (error) {
    failed += 1
    console.error(`FAIL ${testCase.name}`)
    console.error(`     ${error.message}`)
  }
}
if (failed > 0) process.exit(1)
console.log(`\n${cases.length} cases passed`)
