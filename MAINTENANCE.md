# Maintenance

This plugin copies no DSH code: the host half subscribes to documented session events,
observes one documented waterfall, talks to the credential seam and serves one RPC
channel; the client half registers one slot body. Everything it depends on is listed
here, together with what breaks when upstream changes it — that table plus the procedure
below is the whole adaptation guide.

## What it depends on

### Host half (`index.js`, `config.js`, `rpc.js`)

| Dependency | Upstream location | Symptom when it changes |
|---|---|---|
| `ctx.on('session/event', (session, event) => …)` | `packages/agent/agent-loop` (the dispatcher that appends session events) | nothing fires at all; no log line, no notification |
| Event types `turn/start`, `assistant/message`, `turn/end` | `packages/core/session` (`SessionEventMap`) | the affected step is skipped: no duration, no excerpt, or no notification |
| `turn/end` payload `{ turn, reason: { kind } }`, kinds `completed` / `error` / `max-tokens` / `aborted` | `packages/core/session` (`TurnEndReasonMap`) | an unmapped kind is filtered out by `notifyOn` and silently stops notifying |
| `reason.error.message` for the `error` kind | same | the body loses its error line |
| `assistant/message` payload `data.message.content[]` with `{ type: 'text', text }` blocks | `packages/sdk/llm` (`TextBlock`), `packages/core/session` | the excerpt goes empty; the notification still arrives with directory and duration |
| `session.header` fields `cwd`, `origin`, `delegationDepth` | `packages/core/session` (`SessionHeader`) | subagent turns start notifying, or the directory disappears from the body |
| `approval/asked` payload `{ id, toolName, callId?, reason? }` | `packages/core/user-approval` (module augmentation of `SessionEventMap`) | approval notifications lose their tool name or stop firing |
| `ctx.on('user-questions/request', (request, next) => …)` — waterfall, observer only, must return `next()` | `packages/core/user-questions` | questions stop notifying; **returning anything but `next()` would claim the question and break the real answerer** |
| `request.questions[].question`, `request.agent.session.header` | same | the question notification degrades to the directory alone |
| `ctx.on('session/disposed', …)` | same | a stale per-session entry is kept; memory only, no visible fault |
| `ctx.credentials.resolve(ref)` / `.describe(ref)` / `.set(ref, value)` / `.unset(ref)` | `packages/credentials/dsh-credentials` (`CredentialRef` matches `^[A-Za-z_][A-Za-z0-9_]*$`) | channels stay off and the page shows "not configured" for every key |
| `ctx.inject(['webServer'], …)` + `webServer.register({ kind: 'exact', path, handler })` | `packages/host/webserver` | the settings page and the browser channel both go dark; the OS, ntfy and Feishu channels keep working |
| `export const inject = ['credentials']` | `@deepseek-ai/cordis` (property access outside the inject list throws `cannot get property "credentials" without inject`) | the whole plugin fails to activate and the settings page never appears |
| `ctx.get('connection').requestRejection(request)` | `packages/client/connection` host side (`HostConnectionService`, the same fence `/api` uses) | the routes answer `503`; never remove the call, or the stream would hand turn data to an unauthenticated caller |

| `ctx.effect` / `ctx.on('dispose')` | `@deepseek-ai/cordis` | the RPC channel or handlers stay mounted after a reload |
| `ctx.logger.info` / `.warn` | `@deepseek-ai/cordis` | delivery happens but nothing is reported |
| `osascript display notification` (macOS), `notify-send` (Linux) | the OS | the `local` channel fails at runtime; other channels still send |
| `process.platform` in `supportsLocal` (`config.js`) and the `platform` field of the settings snapshot | Node, and the page's own copy of the list (it cannot import `config.js`, which pulls `node:fs`) | the two lists drift: the page enables a channel the host drops, or hides one it could use |
| `powershell.exe -NoProfile -NonInteractive -EncodedCommand` + WinRT `ToastNotificationManager` / `XmlDocument` | Windows PowerShell 5.1 shipped with Windows 10/11 | `local failed: …` in the log and no toast; nothing else is affected. The script writes no registry key, no shortcut and no file, and uses the AppUserModelID Windows already ships for PowerShell, so the toast is attributed to "Windows PowerShell" |
| ntfy JSON publish: `POST <baseUrl>` with `{ topic, title, message, priority }`, `Authorization: Bearer <token>` | ntfy server API | `ntfy answered <status>` in the log |
| Feishu custom bot: `POST <baseUrl><token>` with `{ msg_type: 'text', content: { text } }`, optional `timestamp` + `sign` = base64(HMAC-SHA256(key: `<timestamp>\n<secret>`, data: '')) | Feishu open platform | `feishu answered code <code>` in the log; 19021 means the bot requires a sign secret |

`connection.rpc.handle` is deliberately unused: on dsh 0.2.x it registers through the connection
service's own Context, so a call from any plugin outside it fails and takes the rest of the plugin's
setup with it. The page posts to `/dsh-notify/rpc` instead — one `POST`, one `{ endpoint, payload }`
body, one `{ ok, value }` / `{ ok, error: { message } }` envelope.

### Client half (`client.js`)

| Dependency | Upstream location | Symptom when it changes |
|---|---|---|
| `window.__ModuleLoader__.load({ id, factory(require) })` | `packages/client/shell` (module loader) | the page never appears, and the browser console reports a load failure |
| `require('react')` | the baseline module set | the entry throws while rendering |
| `ctx.locale.register(ns, { zh, en })` + `ctx.locale.bind(ns)` | `packages/client/locale` | the entry and labels show raw keys |
| `ctx.slots.inject('settings.section', () => ctx.slots.register({ name, id, order, label, inject }, Component))` | `packages/client/ui-slots`; `order` runs after General | the Settings entry disappears, or the injected `rpcCall` / `t` is undefined |
| `fetch('/dsh-notify/rpc', { method: 'POST' })` with the `{ ok, value }` / `{ ok, error: { message } }` envelope | the browser (`window.fetch`), same-origin, cookie included | the page shows the failure line and a retry button; check the network panel for `401`/`503` |
| `@deepseek-ai/dsh-client-*` package names in `package.json` → `dsh.client.inject` | the shipped client packages | the row loads but its `inject` list is not satisfied; the page stays absent |
| `new Notification(title, { body })` and `Notification.requestPermission()` | the browser (`window`) | the browser channel shows nothing; the page reports `unsupported` |
| `webServer.register({ kind: 'exact', path, handler })` | `packages/host/webserver` (`UpgradeRoute`/`Route` registry; the SSE path is excluded from compression) | the stream route never mounts and the browser channel reports `no page is listening` |
| `connection.requestRejection(request)` | `packages/client/connection` host side (`HostConnectionService`, same fence `/api` uses) | remove it and the stream leaks turns to an unauthenticated caller — keep the call even if the signature moves |
| `new EventSource('/dsh-notify/events')` + `onopen` / `onmessage` / `onerror` | the browser (`window`) | the page stays on "Allowed, reconnecting." and never pops; the host still logs `browser failed: no page is listening` |

### Package metadata

| Dependency | Upstream location | Symptom when it changes |
|---|---|---|
| `package.json` `icon` (relative path inside the package) and `exports["./locale/*.json"]` | `packages/host/app-boot` (`readPluginMeta`, `iconOf`) | the plugin card falls back to the package name and no icon: the locale files resolve only through `exports`, and a missing `icon` leaves the default artwork |
| `engines.dsh` in `package.json` | the plugin market (`manifestFacts`) | the market lists the host requirement as undeclared instead of checking it |
| README images resolving to `raw.githubusercontent.com` | the plugin market (`extractReadmeImageCandidates`) | the install dialog has no screenshots; landscape images at least 280×150 score highest |

## Run from a checkout

With no install at all, write a patch overlay and pass it on every start:

```yaml
# dev.patch.yml
- insert:
    - id: dsh-notify
      name: /absolute/path/to/dsh-notify/index.js
```

```sh
dsh --profile web --patch /absolute/path/to/dev.patch.yml --no-open
```

The row names the entry file by absolute path, because nothing in the profile answers to
the package name. The trade-off: the plugin does not appear in the Plugins page and each
start needs the flag.

## Behaviour

- One message per event, rendered from that event's template.
- Approvals and questions are announced while the turn is still open, so answering one is
  followed by a turn-end notification as well.
- Every channel is attempted concurrently, each capped at 5 seconds; one dead provider is
  logged and never blocks the others or the turn.
- The browser channel publishes to open streams only. Nothing is queued: with no page
  attached the send is reported as `no page is listening`.
- `userIdleMs` is the only gate on delivery: every message is held for that long and
  dropped when the user acts first. A `turn/start` clears the session, `approval/decided`
  clears that ask, and answering a question clears it, so a message leaves only once the
  user has actually stepped away. Default 60 s; `0` delivers immediately. Held timers are
  unref'd, so a pending message never keeps the host alive, and a host that exits inside
  the window loses that message.

## Storage contract

| Item | Path / key |
|---|---|
| Configuration | `$DSH_HOME/dsh-notify/config.json`, mode 0600, written atomically (temp file + rename) |
| Credentials | `$DSH_HOME/.credentials.yaml` through the credential seam — `DSH_NOTIFY_NTFY_TOPIC`, `DSH_NOTIFY_NTFY_TOKEN`, `DSH_NOTIFY_FEISHU_TOKEN`, `DSH_NOTIFY_FEISHU_SECRET` |

The plugin is the only writer on both sides: the settings page goes through `rpc.save`,
which validates with `normalizeConfig` before writing, and the host reads the same file at
boot. Editing `config.json` by hand is supported; a file that fails validation is logged
and replaced by the defaults in memory, never rewritten.

## After upgrading DSH

```sh
# 1. See what moved upstream (other packages are irrelevant to this plugin)
git -C <dsh-checkout> log --oneline <old>..<new> -- \
  packages/core/session/src/types.ts \
  packages/agent/agent-loop/src/index.ts \
  packages/core/user-approval/src/index.ts \
  packages/core/user-questions/src/index.ts \
  packages/credentials \
  packages/client/connection \
  packages/client/ui-slots/src/index.ts

# 2. Fix the matching few lines against the table above

# 3. Self-check
node --check index.js && node --check client.js && node --check config.js && node --check rpc.js \
  && node --check channels.js && node --check browser.js
node tests/harness.mjs
node tests/client.mjs

# 4. Reinstall the linked package, then restart dsh web so a fresh
#    JavaScript module generation is loaded
#    plugin_manager: install_bundle, target = this directory
```

## Smoke test

1. **Host**: the log must carry `dsh-notify: ready, channels: …` after startup. Then send any
   message, wait for the turn to end, and read the host log:
   - `dsh-notify: local sent` / `ntfy sent` / `feishu sent` → delivered as configured
   - `dsh-notify: ntfy failed: ntfy answered 404` → the topic is wrong or the server URL is
   - `dsh-notify: feishu failed: feishu answered code 19021` → the bot has signing enabled;
     fill in **Sign secret** on the settings page
   - `left off: ntfy topic` → the channel is enabled but its credential is missing;
     `left off: desktop notifications on freebsd` → the host has no notification path
   - `sent (<title>)` when a tool waits for a decision or the agent asks a question; the
     title is that event's word from `DEFAULT_TITLES`
   - no line at all → the row is not mounted, the event kind is excluded, or
     `notifyOnApproval` / `notifyOnQuestion` is off
2. **Page**: open Settings → Notifications. It must list four channels, mark the
   credentials that exist as configured, save without a restart, and the **Send test**
   button must deliver a real message.
3. **Windows**: the same run on Windows must log `local sent` and pop a toast in the
   notification centre. Attribution reads "Windows PowerShell"; that is the cost of not
   registering an AppUserModelID. `local failed: …` means PowerShell 5.1 or the WinRT
   projection is unavailable (`pwsh` 7 alone is not enough — the sender calls
   `powershell.exe`).
4. **Browser channel**: enable it, press **Allow notifications**, then send a message.
   The desktop should pop a Chrome notification while the GUI tab is in the background;
   clicking it returns to the page. Host log: `dsh-notify: browser sent`.
   `browser failed: no page is listening` means no tab holds an event stream — the page is
   closed, or permission is not granted, so the stream never opened. The settings page
   shows "Connected" only while the stream is actually open.

## Deliberate non-goals

- **Chat back**: this is one-way. Answering a pending approval or question from the
  phone belongs to a bidirectional IM plugin, not here.
- **Claiming the question**: the observer calls `next()` unconditionally. Anything else
  would make this plugin the answerer whenever it is the first listener.
- **Reading a secret back**: the page never receives a credential value, only whether it
  is set — the seam has no read-back by design and the UI must not imply one.
- **Writing system state for attribution**: a toast cannot carry this plugin's own name
  without an AppUserModelID, which means a Start-menu shortcut or a registry value. The
  Windows sender reuses the ID Windows already ships for PowerShell instead, so it stays
  a pure runtime caller.
- **Queueing for a closed page**: the browser channel publishes only to open streams.
  Buffering would let a stale notification surface minutes later and would make the test
  button lie; Web Push (which does survive a closed tab) is a different feature with a
  push service, VAPID keys and an https origin, and is not part of this plugin.
