/**
 * The browser channel: one server-sent-events stream per open GUI page.
 *
 * The Host Connection has no server-push carrier of its own, so this registers
 * an exact route on the web server and holds the response open. A page parks
 * one `EventSource` and the Host writes a frame the moment it has a
 * notification: no polling, no request churn, and the browser reconnects on its
 * own after a Host restart.
 *
 * The route reuses the Connection's own admission fence, so the same cookie and
 * Host/Origin checks that guard `/api` guard this stream too. Nothing is queued:
 * with no page attached the message is dropped and reported, which is what makes
 * the settings page's test button trustworthy.
 */

/** Exact route the page subscribes to. Mirrored in `client.js`. */
export const EVENTS_PATH = '/dsh-notify/events'

/** Comment frame that keeps intermediaries from closing an idle stream. */
const PING_FRAME = ': ping\n\n'

/** How often the ping goes out. */
const PING_MS = 30_000

/**
 * Build the stream registry the browser channel publishes through.
 * @returns `{ attach, publish, stop }`.
 */
export function createBrowserBridge() {
  /** One open response per page. */
  const pages = new Set()
  /** Keep-alive timer, armed only while at least one page is attached. */
  let ping = null

  /** Start the keep-alive once, on the first attached page. */
  function startPing() {
    if (ping !== null) return
    ping = setInterval(() => {
      for (const res of pages) res.write(PING_FRAME)
    }, PING_MS)
    ping.unref?.()
  }

  /** Stop the keep-alive when the last page goes away. */
  function stopPing() {
    if (ping === null) return
    clearInterval(ping)
    ping = null
  }

  /**
   * Hand one page the stream and keep it open.
   * @param res - the Node HTTP response for the exact route.
   */
  function attach(res) {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    res.write(': connected\n\n')
    pages.add(res)
    startPing()
    res.on('close', () => {
      pages.delete(res)
      if (pages.size === 0) stopPing()
    })
  }

  /**
   * Write one notification to every attached page.
   * @param message - the `{ title, body }` notification.
   * @returns the delivery result for this channel.
   */
  function publish(message) {
    if (pages.size === 0) return { channel: 'browser', ok: false, error: 'no page is listening' }
    const frame = `data: ${JSON.stringify({ title: message.title, body: message.body })}\n\n`
    for (const res of pages) res.write(frame)
    return { channel: 'browser', ok: true }
  }

  /** Close every stream and the keep-alive timer on unload. */
  function stop() {
    stopPing()
    for (const res of pages) res.destroy()
    pages.clear()
  }

  return { attach, publish, stop }
}
