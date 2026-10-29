/**
 * The settings page's HTTP transport.
 *
 * Two layers: `createRpcHandler` dispatches one endpoint to the controller the
 * host half owns, so the page can never reach past the same validation the file
 * goes through; `createRpcRoute` wraps that dispatch in one POST route. Results
 * use one envelope — `{ ok: true, value }` or `{ ok: false, error: { message } }`.
 *
 * The route is mounted by the plugin and fenced by the caller with the
 * Connection's admission check, so it never depends on `connection.rpc.handle`,
 * which throws outside the connection plugin's own scope on dsh 0.2.x.
 */

/** Absolute path the settings page posts to. */
export const RPC_PATH = '/dsh-notify/rpc'

/** Largest request body accepted; a settings save is a few kilobytes. */
const MAX_BODY_BYTES = 64 * 1024

/**
 * Dispatch one endpoint to the controller.
 * @param controller - `{ snapshot, save, test }` implemented by the host half.
 * @param logger - the plugin logger.
 */
export function createRpcHandler(controller, logger) {
  return async (endpoint, payload) => {
    try {
      if (endpoint === 'get') return ok(await controller.snapshot())
      if (endpoint === 'save') return ok(await controller.save(payload ?? {}))
      if (endpoint === 'test') return ok(await controller.test(String(payload?.channel ?? '')))
      return fail(`unknown endpoint "${String(endpoint)}"`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger.warn(`dsh-notify: ${String(endpoint)} failed: ${message}`)
      return fail(message)
    }
  }
}

/**
 * Build the POST route the settings page talks to.
 * @param controller - `{ snapshot, save, test }` implemented by the host half.
 * @param logger - the plugin logger.
 */
export function createRpcRoute(controller, logger) {
  const dispatch = createRpcHandler(controller, logger)
  return async (request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(405)
      response.end()
      return
    }
    let body
    try {
      body = await readJson(request)
    } catch (error) {
      writeJson(response, 400, fail(error instanceof Error ? error.message : String(error)))
      return
    }
    writeJson(response, 200, await dispatch(body?.endpoint, body?.payload))
  }
}

/**
 * Read and parse one JSON request body, refusing anything oversized.
 * @param request - the Node request.
 */
async function readJson(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('request body too large')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text === '') throw new Error('empty request body')
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('request body is not JSON')
  }
}

/**
 * Answer with one envelope.
 * @param response - the Node response.
 * @param status - the HTTP status.
 * @param value - the envelope.
 */
function writeJson(response, status, value) {
  const payload = JSON.stringify(value)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  })
  response.end(payload)
}

/** Wrap a successful result. */
function ok(value) {
  return { ok: true, value }
}

/** Wrap a failure the settings page renders as-is. */
function fail(message) {
  return { ok: false, error: { message } }
}
