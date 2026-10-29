/**
 * Outbound channels for dsh-notify: everything that leaves the machine.
 *
 * Every sender takes its own configuration slice plus a `{ title, body }`
 * message and resolves once the provider has answered. Failures reject with a
 * message that names the channel and the provider's status, never a credential.
 * The browser channel is not here — it never leaves the machine and the host
 * half publishes it straight into a parked page.
 */
import { execFile } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** Upper bound for one provider call; a stuck channel must not hold the others. */
const REQUEST_TIMEOUT_MS = 5000

/** Upper bound for one local notification: PowerShell pays a cold start. */
const LOCAL_TIMEOUT_MS = 15_000

/**
 * The AppUserModelID every Windows install already has for PowerShell. Using it
 * means no registry write, no shortcut and no module; the toast is attributed to
 * "Windows PowerShell" instead of this plugin.
 */
const WINDOWS_APP_ID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'

/** Channel name to sender. Adding a channel means adding one entry here and one config slice. */
export const CHANNELS = {
  local: sendLocal,
  ntfy: sendNtfy,
  feishu: sendFeishu,
}

/**
 * Deliver one message to every enabled channel concurrently.
 * @param settings - normalized plugin settings.
 * @param message - the `{ title, body }` notification.
 * @returns one result per channel; a failure never rejects this call.
 */
export async function sendAll(settings, message) {
  const results = await Promise.all(
    settings.channels.map(async (channel) => {
      try {
        await CHANNELS[channel](settings[channel], message)
        return { channel, ok: true, error: null }
      } catch (error) {
        return { channel, ok: false, error: describe(error) }
      }
    }),
  )
  return results
}

/**
 * Flatten an unknown rejection into one log-safe line.
 * @param error - whatever the sender threw.
 * @returns the provider status or the error message, collapsed to one line.
 */
function describe(error) {
  const text = error instanceof Error ? error.message : String(error)
  return text.replace(/\s+/g, ' ').slice(0, 200)
}

/** Quote a value for an AppleScript double-quoted string. */
function osaValue(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, ' ')}"`
}

/**
 * Desktop notification through the OS: Notification Center on macOS,
 * `notify-send` on Linux, a toast through the built-in WinRT API on Windows.
 * Other platforms are a configuration error.
 * @param config - the `local` slice.
 * @param message - the notification.
 */
async function sendLocal(config, message) {
  if (process.platform === 'darwin') {
    const sound = config.sound ? ' sound name "Glass"' : ''
    const script = `display notification ${osaValue(message.body)} with title ${osaValue(message.title)}${sound}`
    await run('osascript', ['-e', script], { timeout: REQUEST_TIMEOUT_MS })
    return
  }
  if (process.platform === 'win32') {
    await run('powershell.exe', toastCommand(message, config.sound), {
      timeout: LOCAL_TIMEOUT_MS,
      windowsHide: true,
    })
    return
  }
  if (process.platform === 'linux') {
    await run('notify-send', [message.title, message.body], { timeout: REQUEST_TIMEOUT_MS })
    return
  }
  throw new Error(`unsupported platform ${process.platform}`)
}

/**
 * Escape one value for an XML text node.
 * @param value - the raw text.
 */
function xmlText(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/**
 * Build the PowerShell script that shows one toast. The XML travels as base64 so
 * neither PowerShell quoting nor the command line can mangle it, and the script
 * only touches the WinRT APIs Windows already ships.
 * @param message - the `{ title, body }` notification.
 * @param sound - whether the default notification sound plays.
 */
function toastScript(message, sound) {
  const audio = sound ? '<audio src="ms-winsoundevent:Notification.Default"/>' : '<audio silent="true"/>'
  const xml = '<toast><visual><binding template="ToastGeneric">'
    + `<text>${xmlText(message.title)}</text><text>${xmlText(message.body)}</text>`
    + `</binding></visual>${audio}</toast>`
  const payload = Buffer.from(xml, 'utf8').toString('base64')
  return [
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
    '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null',
    '$document = New-Object Windows.Data.Xml.Dom.XmlDocument',
    `$document.LoadXml([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')))`,
    '$toast = New-Object Windows.UI.Notifications.ToastNotification $document',
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${WINDOWS_APP_ID}').Show($toast)`,
  ].join('; ')
}

/**
 * The argv that shows one toast, encoded as UTF-16LE base64 so no console code
 * page or shell quoting can corrupt the script. Exported for the test harness.
 * @param message - the `{ title, body }` notification.
 * @param sound - whether the default notification sound plays.
 */
export function toastCommand(message, sound) {
  const script = toastScript(message, sound)
  return ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]
}

/**
 * ntfy push through the JSON publish endpoint, which keeps UTF-8 titles intact
 * (the header form only carries ASCII).
 * @param config - the `ntfy` slice.
 * @param message - the notification.
 */
async function sendNtfy(config, message) {
  const headers = { 'Content-Type': 'application/json' }
  if (config.token !== '') headers.Authorization = `Bearer ${config.token}`
  const body = JSON.stringify({
    topic: config.topic,
    title: message.title,
    message: message.body,
    priority: config.priority,
  })
  const response = await fetch(config.baseUrl, {
    method: 'POST',
    headers,
    body,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`ntfy answered ${response.status}`)
}

/**
 * Feishu custom-bot webhook. A bot with signature verification enabled needs
 * its secret here; without one the request is refused with code 19021.
 * @param config - the `feishu` slice.
 * @param message - the notification.
 */
async function sendFeishu(config, message) {
  const payload = {
    msg_type: 'text',
    content: { text: `${message.title}\n${message.body}` },
  }
  if (config.secret !== '') {
    const timestamp = Math.floor(Date.now() / 1000).toString()
    payload.timestamp = timestamp
    payload.sign = createHmac('sha256', `${timestamp}\n${config.secret}`).update('').digest('base64')
  }
  const response = await fetch(`${config.baseUrl}${config.token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`feishu answered ${response.status}`)
  const answer = await response.json().catch(() => ({}))
  const code = answer.code ?? answer.StatusCode ?? 0
  if (code !== 0) throw new Error(`feishu answered code ${code} ${answer.msg ?? ''}`.trim())
}
