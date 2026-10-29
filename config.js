/**
 * Non-secret configuration and the credential references it depends on.
 *
 * The configuration file is the single writer for everything that is not a
 * secret; credentials go through `ctx.credentials` so no secret ever lands in
 * that file. Both the host half and the settings page read this module.
 */
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Credential keys owned by this plugin, addressed by the Host credential seam. */
export const CREDENTIAL_KEYS = {
  ntfyTopic: 'DSH_NOTIFY_NTFY_TOPIC',
  ntfyToken: 'DSH_NOTIFY_NTFY_TOKEN',
  feishuToken: 'DSH_NOTIFY_FEISHU_TOKEN',
  feishuSecret: 'DSH_NOTIFY_FEISHU_SECRET',
}

/** Channels this build knows how to deliver through. */
export const KNOWN_CHANNELS = ['local', 'browser', 'ntfy', 'feishu']

/** Turn end kinds the settings page offers; `aborted` is absent on purpose. */
export const KNOWN_OUTCOMES = ['completed', 'error', 'max-tokens']

/** Platforms the desktop channel can reach; anything else has no local notification path. */
const LOCAL_PLATFORMS = ['darwin', 'win32', 'linux']

/**
 * Whether a host can raise a desktop notification at all.
 * @param platform - the platform string to check, `process.platform` by default.
 */
export function supportsLocal(platform = process.platform) {
  return LOCAL_PLATFORMS.includes(platform)
}

/** Titles every notification uses; a template's first line replaces them. */
export const DEFAULT_TITLES = {
  completed: '任务完成',
  error: '任务出错',
  maxTokens: '输出达到上限',
  approval: '需要你审批',
  question: '等你回答',
}

/**
 * The text each event sends. Line breaks matter: the first line is the title.
 * `{error}` is empty unless the turn failed, and a trailing empty line is trimmed.
 */
export const DEFAULT_TEMPLATES = {
  turnEnd: '{title}\n{project} · {duration}\n{preview}\n{error}',
  approval: '{title}\n{project} · {tool}\n{reason}',
  question: '{title}\n{project} · {question}',
}

/** Longest template accepted, in characters. */
export const MAX_TEMPLATE_CHARS = 2000

/** ntfy priorities accepted by the server. */
const KNOWN_PRIORITIES = ['min', 'low', 'default', 'high', 'max']

/** Configuration used when the file is missing or unreadable. */
export const DEFAULT_CONFIG = {
  channels: ['local'],
  notifyOn: ['completed', 'error', 'max-tokens'],
  notifyOnApproval: true,
  notifyOnQuestion: true,
  minTurnDurationMs: 0,
  local: { sound: true },
  ntfy: { baseUrl: 'https://ntfy.sh', priority: 'default' },
  feishu: { baseUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/' },
  templates: { ...DEFAULT_TEMPLATES },
}

/**
 * Where the configuration lives: beside the DSH home, not inside a profile, so
 * switching profiles keeps the notification setup.
 * @returns the absolute path of `config.json`.
 */
export function configPath() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'dsh-notify', 'config.json')
}

/**
 * Read the configuration file.
 * @param path - the file to read.
 * @returns the parsed object, or an empty object when the file is absent.
 */
export async function readConfigFile(path) {
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return {}
    throw error
  }
  return JSON.parse(text)
}

/**
 * Replace the configuration file atomically and keep it owner-only: it holds
 * no secret, but it still describes how this machine talks to the outside.
 * @param path - the file to write.
 * @param config - the normalized configuration.
 */
export async function writeConfigFile(path, config) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, path)
  await chmod(path, 0o600)
}

/**
 * Validate the non-secret configuration at the boundary: the file and the
 * settings page are both user input, so a bad value fails here with a message
 * the page can show.
 * @param raw - the parsed configuration.
 * @returns the normalized configuration with every default filled in.
 */
export function normalizeConfig(raw = {}) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('config must be an object')
  }

  const channels = raw.channels ?? DEFAULT_CONFIG.channels
  if (!Array.isArray(channels)) throw new Error('channels must be an array')
  for (const channel of channels) {
    if (!KNOWN_CHANNELS.includes(channel)) throw new Error(`unknown channel "${channel}"`)
  }

  const notifyOn = raw.notifyOn ?? DEFAULT_CONFIG.notifyOn
  if (!Array.isArray(notifyOn)) throw new Error('notifyOn must be an array')
  for (const kind of notifyOn) {
    if (!KNOWN_OUTCOMES.includes(kind)) throw new Error(`unknown turn outcome "${kind}"`)
  }

  const minTurnDurationMs = raw.minTurnDurationMs ?? DEFAULT_CONFIG.minTurnDurationMs
  if (!Number.isInteger(minTurnDurationMs) || minTurnDurationMs < 0) {
    throw new Error('minTurnDurationMs must be a non-negative integer')
  }

  return {
    channels: [...new Set(channels)],
    notifyOn: [...new Set(notifyOn)],
    notifyOnApproval: raw.notifyOnApproval ?? DEFAULT_CONFIG.notifyOnApproval,
    notifyOnQuestion: raw.notifyOnQuestion ?? DEFAULT_CONFIG.notifyOnQuestion,
    minTurnDurationMs,
    local: { sound: raw.local?.sound ?? DEFAULT_CONFIG.local.sound },
    ntfy: normalizeNtfy(raw.ntfy),
    feishu: normalizeFeishu(raw.feishu),
    templates: normalizeTemplates(raw.templates),
  }
}

/**
 * Validate the ntfy slice, whose secrets live elsewhere.
 * @param raw - the `ntfy` config slice.
 */
function normalizeNtfy(raw) {
  const baseUrl = raw?.baseUrl ?? DEFAULT_CONFIG.ntfy.baseUrl
  if (typeof baseUrl !== 'string' || !/^https?:\/\//.test(baseUrl)) {
    throw new Error('ntfy.baseUrl must be an http(s) URL')
  }
  const priority = raw?.priority ?? DEFAULT_CONFIG.ntfy.priority
  if (!KNOWN_PRIORITIES.includes(priority)) {
    throw new Error(`ntfy.priority must be one of ${KNOWN_PRIORITIES.join(', ')}`)
  }
  return { baseUrl: baseUrl.replace(/\/+$/, ''), priority }
}

/**
 * Normalize the template slice: an empty string means "use the built-in text".
 * @param raw - the `templates` slice as it arrived.
 */
function normalizeTemplates(raw) {
  const templates = {}
  for (const [key, fallback] of Object.entries(DEFAULT_CONFIG.templates)) {
    const value = raw?.[key] ?? fallback
    if (typeof value !== 'string') throw new Error(`templates.${key} must be a string`)
    if (value.length > MAX_TEMPLATE_CHARS) {
      throw new Error(`templates.${key} must be at most ${MAX_TEMPLATE_CHARS} characters`)
    }
    // A blank box would send an empty message, so it means "the default text".
    templates[key] = value.trim() === '' ? fallback : value
  }
  return templates
}

/**
 * Normalize the Feishu slice: the token itself is a credential, so only the
 * webhook prefix lives here, always ending in one slash.
 * @param raw - the `feishu` slice as it arrived.
 */
function normalizeFeishu(raw) {
  const baseUrl = raw?.baseUrl ?? DEFAULT_CONFIG.feishu.baseUrl
  if (typeof baseUrl !== 'string' || !/^https?:\/\//.test(baseUrl)) {
    throw new Error('feishu.baseUrl must be an http(s) URL')
  }
  return { baseUrl: `${baseUrl.replace(/\/+$/, '')}/` }
}

/**
 * Merge the stored secrets into the senders' settings.
 *
 * A channel whose required secret is missing is left out and reported, so the
 * host keeps running after a credential is cleared instead of failing every
 * send; the settings page shows the same list as "not configured".
 * @param config - normalized configuration.
 * @param secrets - resolved credential values, empty strings when absent.
 * @returns the settings for `sendAll` plus the channels that are not ready.
 */
export function buildSettings(config, secrets, platform = process.platform) {
  const missing = []
  const channels = config.channels.filter((channel) => {
    if (channel === 'local' && !supportsLocal(platform)) {
      missing.push(`desktop notifications on ${platform}`)
      return false
    }
    if (channel === 'ntfy' && secrets.ntfyTopic === '') {
      missing.push('ntfy topic')
      return false
    }
    if (channel === 'feishu' && secrets.feishuToken === '') {
      missing.push('feishu token')
      return false
    }
    return true
  })

  return {
    missing,
    settings: {
      channels,
      notifyOn: config.notifyOn,
      notifyOnApproval: config.notifyOnApproval,
      notifyOnQuestion: config.notifyOnQuestion,
      minTurnDurationMs: config.minTurnDurationMs,
      local: { sound: config.local.sound },
      ntfy: {
        baseUrl: config.ntfy.baseUrl,
        priority: config.ntfy.priority,
        topic: secrets.ntfyTopic,
        token: secrets.ntfyToken,
      },
      templates: {
        turnEnd: config.templates.turnEnd,
        approval: config.templates.approval,
        question: config.templates.question,
      },
      feishu: {
        baseUrl: config.feishu.baseUrl,
        token: secrets.feishuToken,
        secret: secrets.feishuSecret,
      },
    },
  }
}

/**
 * Resolve every credential this plugin owns.
 * @param credentials - the Host credential service.
 * @returns one entry per key; `''` when the key is absent.
 */
export async function readSecrets(credentials) {
  const secrets = { ntfyTopic: '', ntfyToken: '', feishuToken: '', feishuSecret: '' }
  if (credentials === undefined) return secrets
  for (const [field, key] of Object.entries(CREDENTIAL_KEYS)) {
    const hit = await credentials.resolve(key)
    if (hit !== undefined && typeof hit.value === 'string') secrets[field] = hit.value
  }
  return secrets
}

/**
 * Report which credentials are set without returning any value.
 * @param credentials - the Host credential service.
 * @returns one boolean per key.
 */
export async function describeSecrets(credentials) {
  const described = { ntfyTopic: false, ntfyToken: false, feishuToken: false, feishuSecret: false }
  if (credentials === undefined) return described
  for (const [field, key] of Object.entries(CREDENTIAL_KEYS)) {
    const info = await credentials.describe(key)
    described[field] = info.configured === true
  }
  return described
}

/**
 * Store or clear one credential. An empty string clears the key.
 * @param credentials - the Host credential service.
 * @param field - the field in {@link CREDENTIAL_KEYS}.
 * @param value - the new value, or `''` to remove the key.
 */
export async function writeSecret(credentials, field, value) {
  if (credentials === undefined) throw new Error('the Host credential service is unavailable')
  const key = CREDENTIAL_KEYS[field]
  if (value === '') await credentials.unset(key)
  else await credentials.set(key, value)
}
