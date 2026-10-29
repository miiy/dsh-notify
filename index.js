/**
 * dsh-notify — notifications for DeepSeek Harness.
 *
 * Host half: it watches the session log for `turn/end` and `approval/asked`,
 * observes the user-question waterfall, skips subagent work, and fans each
 * event out to the configured channels (desktop, browser page, ntfy, Feishu),
 * and it owns the settings page's RPC channel, so the page edits the same
 * configuration this half reads.
 *
 * Notification failures are logged and never affect the work that produced them.
 */
import { basename } from 'node:path'
import { EVENTS_PATH, createBrowserBridge } from './browser.js'
import { sendAll } from './channels.js'
import {
  DEFAULT_CONFIG,
  DEFAULT_TEMPLATES,
  DEFAULT_TITLES,
  KNOWN_CHANNELS,
  buildSettings,
  configPath,
  describeSecrets,
  normalizeConfig,
  readConfigFile,
  readSecrets,
  writeConfigFile,
  writeSecret,
} from './config.js'
import { RPC_PATH, createRpcRoute } from './rpc.js'
import { createSeen } from './seen.js'

export const name = 'dsh-notify'
/**
 * The credentials service is read straight off the context, and cordis refuses
 * property access that the plugin has not declared, so it has to be named here.
 * A profile always provides it; a profile without it is not one this plugin runs in.
 */
export const inject = ['credentials']

/** Preview length for the assistant's closing text. */
const PREVIEW_MAX_CHARS = 140

/** Message the settings page sends when the user presses a test button. */
const TEST_MESSAGE = { title: 'dsh-notify 测试', body: '设置页发起的测试消息，收到说明这条渠道通了。' }

/**
 * Activate the row: load the configuration, subscribe to the notification
 * seams, and publish the settings channel.
 * @param ctx - the plugin context.
 */
export async function apply(ctx) {
  const state = {
    config: normalizeConfig(DEFAULT_CONFIG),
    secrets: { ntfyTopic: '', ntfyToken: '', feishuToken: '', feishuSecret: '' },
    settings: null,
  }
  state.settings = buildSettings(state.config, state.secrets).settings

  const bridge = createBrowserBridge()
  const seen = createSeen()
  const deliver = createDeliver({ logger: ctx.logger, bridge })

  const controller = createController(ctx, state, bridge, seen)
  await controller.reload()
  // One boot line: enough to tell from the host log that the row is live.
  ctx.logger.info(`dsh-notify: ready, channels: ${state.settings.channels.join(', ') || 'none'}`)

  const turns = new Map()
  // One held message per pending notification, keyed "<session>#<kind>": the idle
  // window is how long the user has to stay quiet before they are told.
  const held = new Map()

  // Turn boundaries drive the duration and the closing excerpt.
  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/start') {
      // A new turn is the user back at the keyboard: nothing held survives it.
      dropSession(held, session.id)
      turns.set(session.id, { startedAt: Date.now(), preview: '' })
      return
    }
    if (event.type === 'approval/asked') {
      hold(held, `${session.id}#approval:${event.data.id}`, state.settings.userIdleMs,
        () => notifyApproval(state.settings, session, event.data, deliver), ctx.logger)
      return
    }
    if (event.type === 'approval/decided') {
      // Answered by the user themselves; the held message has nothing left to say.
      dropHeld(held, `${session.id}#approval:${event.data.id}`)
      return
    }
    const turn = turns.get(session.id)
    if (turn === undefined) return
    if (event.type === 'assistant/message') {
      turn.preview = extractText(event.data.message)
      return
    }
    if (event.type === 'turn/end') {
      turns.delete(session.id)
      // The only gate that asks the page: a reply the user is already reading needs
      // no announcement. Approvals and questions are not asked about — they come
      // with buttons, and a receipt cannot exist while a turn still runs.
      hold(held, `${session.id}#turn`, state.settings.userIdleMs,
        () => notify(state.settings, session, turn, event.data, deliver), ctx.logger,
        (heldAt) => seen.since(session.id, heldAt))
    }
  })

  // Questions have no session event of their own: observe the waterfall without
  // ever claiming it, so the real answerer still decides. The switch is read per
  // request, because the settings page can turn it off while this runs.
  ctx.on('user-questions/request', (request, next) => {
    const key = `${request?.agent?.session?.id ?? ''}#question`
    if (state.settings.notifyOnQuestion) {
      hold(held, key, state.settings.userIdleMs,
        () => notifyQuestion(state.settings, request, deliver), ctx.logger)
    }
    const answered = next()
    // The answer is the user being present: drop the message the moment they reply.
    answered.then(() => dropHeld(held, key), () => dropHeld(held, key))
    return answered
  })

  ctx.on('session/disposed', (session) => {
    turns.delete(session.id)
    dropSession(held, session.id)
  })

  // Both faces of the page are plain routes on the Host web server: the settings
  // transport, and the event stream the browser channel pushes through. They are
  // registered here rather than through `connection.rpc.handle`, which on this
  // release only works inside the connection plugin's own scope. A profile
  // without a web server (headless) simply has no page.
  const fence = (handler) => (request, response) => {
    // The same admission `/api` uses: cookie plus Host/Origin. Read through the
    // unchecked accessor, so the route never depends on this fiber's inject list.
    const connection = ctx.get('connection')
    if (connection === undefined) {
      response.writeHead(503)
      response.end()
      return
    }
    const rejection = connection.requestRejection(request)
    if (rejection !== undefined) {
      response.writeHead(rejection)
      response.end()
      return
    }
    return handler(request, response)
  }

  const eventsRoute = (request, response) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405)
      response.end()
      return
    }
    bridge.attach(response)
  }

  ctx.inject(['webServer'], (scoped) => {
    const rpcRoute = createRpcRoute(controller, ctx.logger)
    scoped.effect(() => {
      const disposeRpc = scoped.webServer.register({ kind: 'exact', path: RPC_PATH, handler: fence(rpcRoute) })
      const disposeEvents = scoped.webServer.register({ kind: 'exact', path: EVENTS_PATH, handler: fence(eventsRoute) })
      return () => {
        disposeRpc()
        disposeEvents()
        bridge.stop()
      }
    }, 'dsh-notify: web routes')
  })
}

/**
 * Own the live configuration: read it at activation, replace it when the page
 * saves, answer the page's questions about what is configured, and take in what
 * each open page reports about the human in front of it.
 * @param ctx - the plugin context.
 * @param state - the live configuration and derived settings.
 * @param bridge - the browser channel's long poll.
 * @param seen - the read receipts every open page sends.
 */
function createController(ctx, state, bridge, seen) {
  /**
   * Adopt one configuration and its secrets, and report channels held back.
   * @param config - normalized configuration.
   * @param secrets - resolved credential values.
   */
  async function adopt(config, secrets) {
    const { settings, missing } = buildSettings(config, secrets)
    state.config = config
    state.secrets = secrets
    state.settings = settings
    if (missing.length > 0) {
      ctx.logger.warn(`dsh-notify: enabled but cannot fire here, left off: ${missing.join(', ')}`)
    }
  }

  /** Read the file and the credentials, then adopt them; a broken file never blocks startup. */
  async function reload() {
    try {
      await adopt(normalizeConfig(await readConfigFile(configPath())), await readSecrets(ctx.credentials))
    } catch (error) {
      ctx.logger.warn(`dsh-notify: ${configPath()} is unusable, using defaults: ${messageOf(error)}`)
      await adopt(normalizeConfig(DEFAULT_CONFIG), state.secrets)
    }
  }

  /** What the settings page renders: the configuration, never a secret. */
  async function snapshot() {
    const described = await describeSecrets(ctx.credentials)
    return {
      // The page decides whether this host can raise a desktop notification at all.
      platform: process.platform,
      // The page needs the built-in text to offer "restore default".
      defaults: { templates: DEFAULT_TEMPLATES },
      config: state.config,
      secrets: described,
      channels: KNOWN_CHANNELS.map((channel) => ({
        name: channel,
        enabled: state.config.channels.includes(channel),
        ready: isReady(channel, described),
      })),
    }
  }

  /**
   * Validate, persist and adopt one edit from the settings page.
   * @param input - `{ config, secrets }`; a secret is set when it is a string
   *   and cleared when that string is empty, and left alone when absent.
   */
  async function save(input) {
    const config = normalizeConfig(input.config)
    const changes = input.secrets ?? {}
    for (const [field, value] of Object.entries(changes)) {
      if (typeof value !== 'string') throw new Error(`credential "${field}" must be a string`)
      await writeSecret(ctx.credentials, field, value.trim())
    }

    const secrets = await readSecrets(ctx.credentials)
    const unready = config.channels.filter((channel) => !isReady(channel, secrets))
    if (unready.length > 0) {
      throw new Error(`fill in the credentials for ${unready.join(', ')} before enabling them`)
    }

    await writeConfigFile(configPath(), config)
    await adopt(config, secrets)
    return snapshot()
  }

  /**
   * Send one message through one channel, whether or not it is enabled.
   * @param channel - the channel to exercise.
   */
  async function test(channel) {
    if (!KNOWN_CHANNELS.includes(channel)) throw new Error(`unknown channel "${channel}"`)
    if (channel === 'browser') {
      const result = bridge.publish(TEST_MESSAGE)
      return { delivered: result.ok, error: result.error }
    }
    const secrets = await readSecrets(ctx.credentials)
    const { settings } = buildSettings({ ...state.config, channels: [channel] }, secrets)
    if (!settings.channels.includes(channel)) return { delivered: false, error: 'not configured yet' }
    const [result] = await sendAll({ ...settings, channels: [channel] }, TEST_MESSAGE)
    return { delivered: result.ok, error: result.error }
  }

  /**
   * Adopt one page's read receipt: the conversation a human was looking at. A
   * receipt without a name is refused, so a malformed one cannot silence anything.
   * @param input - `{ sessionId }`.
   */
  function reportSeen(input) {
    if (seen.mark(input?.sessionId) !== true) throw new Error('a read receipt needs a session id')
    return { ok: true }
  }

  return { reload, snapshot, save, test, seen: reportSeen }
}

/**
 * Whether one channel has the credential it needs.
 * @param channel - the channel name.
 * @param secrets - credential values or their presence flags.
 */
function isReady(channel, secrets) {
  if (channel === 'local' || channel === 'browser') return true
  if (channel === 'ntfy') return secrets.ntfyTopic !== '' && secrets.ntfyTopic !== false
  if (channel === 'feishu') return secrets.feishuToken !== '' && secrets.feishuToken !== false
  return false
}

/**
 * Whether this session is a user-facing one; subagent and delegated work is noise.
 * @param header - the session header.
 */
function isTopLevel(header) {
  return !(header?.origin === 'subagent' || (header?.delegationDepth ?? 0) > 0)
}

/**
 * Send one message now, or hold it for the idle window. Anything the user does
 * inside that window drops it instead: the message exists to cover their absence,
 * so an action taken at the keyboard makes it redundant. The window closes with
 * one last question — has the page reported reading this conversation since the
 * message was held? — and a reply already being read never leaves.
 * @param held - held timers by key.
 * @param key - `<session>#<kind>`, unique per pending notification.
 * @param waitMs - the idle window; `0` delivers immediately.
 * @param message - builds the delivery promise at the moment it is sent.
 * @param logger - the host logger.
 * @param skip - decides at delivery time, given when the message was held, whether
 *   it still has a job.
 */
function hold(held, key, waitMs, message, logger, skip) {
  dropHeld(held, key)
  const heldAt = Date.now()
  const send = () => {
    if (skip?.(heldAt) === true) {
      logger.info(`dsh-notify: ${key} dropped, the page reported reading that conversation`)
      return
    }
    fire(message(), logger)
  }
  if (waitMs <= 0) {
    send()
    return
  }
  const timer = setTimeout(() => {
    held.delete(key)
    send()
  }, waitMs)
  // A held message must not keep the host process alive on its own.
  timer.unref?.()
  held.set(key, timer)
}

/**
 * Drop the held message for one key, if any.
 * @param held - held timers by key.
 * @param key - the notification whose message no longer applies.
 */
function dropHeld(held, key) {
  const timer = held.get(key)
  if (timer === undefined) return
  clearTimeout(timer)
  held.delete(key)
}

/**
 * Drop every held message for one session: the user is back in it.
 * @param held - held timers by key.
 * @param sessionId - the session the user returned to.
 */
function dropSession(held, sessionId) {
  const prefix = `${sessionId}#`
  for (const key of [...held.keys()]) {
    if (key.startsWith(prefix)) dropHeld(held, key)
  }
}

/**
 * Run a notification without letting a failure reach the caller: these are
 * fire-and-forget from inside event handlers that must stay synchronous.
 * @param promise - the pending notification.
 * @param logger - the plugin logger.
 */
function fire(promise, logger) {
  promise.catch((error) => logger.warn(`dsh-notify: notify failed: ${messageOf(error)}`))
}

/** Flatten an unknown rejection into one line. */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Decide whether this turn end deserves a notification, then send it.
 * @param settings - normalized settings.
 * @param session - the session that ended the turn.
 * @param turn - what was recorded for this turn.
 * @param data - the `turn/end` event payload.
 * @param deliver - fans one message out to the enabled channels.
 */
async function notify(settings, session, turn, data, deliver) {
  const header = session.header ?? {}
  if (!isTopLevel(header)) return

  const kind = data.reason?.kind ?? 'unknown'
  if (!settings.notifyOn.includes(kind)) return

  const elapsedMs = Date.now() - turn.startedAt

  const { title, body } = renderTemplate(settings.templates.turnEnd, {
    title: titleFor(kind),
    outcome: kind,
    project: basename(header.cwd ?? '') || header.cwd || 'session',
    duration: formatDuration(elapsedMs),
    preview: excerptOf(turn.preview),
    error: errorLine(data.reason),
  })
  await deliver(settings, { title: title || titleFor(kind), body })
}

/**
 * Notify that a tool call is waiting for a decision.
 * @param settings - normalized settings.
 * @param session - the session that raised the approval.
 * @param data - the `approval/asked` event payload.
 * @param deliver - fans one message out to the enabled channels.
 */
async function notifyApproval(settings, session, data, deliver) {
  if (!settings.notifyOnApproval) return
  const header = session.header ?? {}
  if (!isTopLevel(header)) return
  const fallback = titleFor('approval')
  const { title, body } = renderTemplate(settings.templates.approval, {
    title: fallback,
    project: basename(header.cwd ?? '') || header.cwd || 'session',
    tool: data.toolName ?? 'tool',
    reason: excerptOf(data.reason),
  })
  await deliver(settings, { title: title || fallback, body })
}

/**
 * Notify that the agent is waiting for an answer; never claims the question.
 * @param settings - normalized settings.
 * @param request - the `user-questions/request` payload.
 * @param deliver - fans one message out to the enabled channels.
 */
async function notifyQuestion(settings, request, deliver) {
  const header = request?.agent?.session?.header ?? {}
  if (!isTopLevel(header)) return
  const questions = request?.questions
  if (!Array.isArray(questions) || questions.length === 0) return
  const fallback = titleFor('question')
  const { title, body } = renderTemplate(settings.templates.question, {
    title: fallback,
    project: basename(header.cwd ?? '') || header.cwd || 'session',
    question: excerptOf(questions[0]?.question),
    count: questions.length,
  })
  await deliver(settings, { title: title || fallback, body })
}

/**
 * Build the fan-out for one plugin instance: the browser channel hands the
 * message to a parked page, every other channel leaves the machine, and the
 * per-channel outcome is logged here and nowhere else.
 * @param options - the plugin logger and the browser bridge.
 * @returns `(settings, message) => Promise<void>`.
 */
function createDeliver({ logger, bridge }) {
  return async function deliver(settings, message) {
    const results = []
    if (settings.channels.includes('browser')) results.push(bridge.publish(message))

    const remote = settings.channels.filter((channel) => channel !== 'browser')
    if (remote.length > 0) {
      try {
        results.push(...await sendAll({ ...settings, channels: remote }, message))
      } catch (error) {
        logger.warn(`dsh-notify: send failed: ${messageOf(error)}`)
      }
    }

    for (const result of results) {
      if (result.ok) logger.info(`dsh-notify: ${result.channel} sent (${message.title})`)
      else logger.warn(`dsh-notify: ${result.channel} failed: ${result.error}`)
    }
  }
}

/**
 * The line a failed turn adds; empty when nothing failed.
 * @param reason - the turn-end reason carried by the event.
 */
function errorLine(reason) {
  const message = reason?.error?.message
  return message ? `error: ${message}` : ''
}

/**
 * Fill one template with its variables. The first line is the title, the rest
 * is the body; an unknown placeholder is left alone so a typo stays visible.
 * @param template - the template text, already non-blank (see `normalizeConfig`).
 * @param vars - values keyed by placeholder name, without braces.
 * @returns `{ title, body }`; the title is empty when the first line renders blank.
 */
export function renderTemplate(template, vars) {
  const filled = template.replace(/\{(\w+)\}/g, (match, key) => (key in vars ? String(vars[key] ?? '') : match))
  const [first, ...rest] = filled.split('\n')
  return { title: first.trim(), body: rest.join('\n').trim() }
}

/** Map a turn end kind to the title shown in the notification. */
function titleFor(kind) {
  if (kind === 'max-tokens') return DEFAULT_TITLES.maxTokens
  return DEFAULT_TITLES[kind] ?? `回合结束 (${kind})`
}

/** Render a duration as whole seconds above one second, milliseconds below. */
function formatDuration(elapsedMs) {
  if (elapsedMs < 1000) return `${elapsedMs}ms`
  const seconds = Math.round(elapsedMs / 1000)
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m${seconds % 60}s`
}

/** Collapse a value into one short line. */
function excerptOf(text) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (flat === '') return ''
  return flat.length > PREVIEW_MAX_CHARS ? `${flat.slice(0, PREVIEW_MAX_CHARS)}…` : flat
}

/** Join the text blocks of an assistant message, ignoring reasoning and tool calls. */
function extractText(message) {
  const blocks = message?.content
  if (!Array.isArray(blocks)) return ''
  return blocks
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}
