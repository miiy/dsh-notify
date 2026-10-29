/**
 * Client half of dsh-notify: the settings page and the page's read receipts.
 *
 * One Settings entry, no build step. It reads the live configuration over the
 * Host connection, edits it, and sends test messages per channel. Secrets are
 * write-only here: the page learns whether a credential is set, never its
 * value, because the Host credential seam never returns one.
 *
 * It also watches for reading — a scroll, a click, a keystroke after the output
 * finished — because the Host can see every session event but has no way of
 * knowing that the reply is already on the user's screen.
 */
window.__ModuleLoader__.load({
  id: 'dsh-notify',
  factory(require) {
    const React = require('react')
    const { useEffect, useState } = React
    const h = React.createElement

    /** Locale namespace of this plugin's copy. */
    const NS = 'dshNotify'

    /** Absolute channel the Host half serves. */
    const RPC_PATH = '/dsh-notify/rpc'

    // Mirrors config.js, which cannot be imported here: it pulls node:fs.
    const LOCAL_PLATFORMS = ['darwin', 'win32', 'linux']

    /** Event stream the Host half holds open. Mirrored in `browser.js`. */
    const EVENTS_PATH = '/dsh-notify/events'

    /** Simplified Chinese copy. */
    const zh = {
      section: '通知',
      intro: '执行长任务期间无需值守：任务结束、等待审批或等待回答时，通过已启用的渠道发出提醒。',
      channels: '渠道',
      channelLocal: '桌面通知',
      localUnsupportedHint: '当前系统不支持桌面通知。',
      channelBrowser: '浏览器通知',
      channelNtfy: 'ntfy 推送',
      channelFeishu: '飞书机器人',
      allow: '允许通知',
      browserLive: '已连接，通知会进系统通知中心。',
      browserRetrying: '已允许，连接断了，正在重连。',
      browserAsk: '还没授权，点「允许通知」才会弹。',
      browserDenied: '已被浏览器拒绝，点地址栏左侧的图标改回「允许」。',
      browserUnsupported: '这个浏览器不支持通知，改勾桌面通知更合适。',
      browserKeepOpen: '保持这个 DeepSeek Web 页面打开，关掉就收不到。',
      ntfy: 'ntfy',
      feishu: '飞书',
      baseUrl: '服务器地址',
      priority: '优先级',
      topic: 'Topic',
      token: '访问令牌（可选）',
      webhook: 'Webhook 地址',
      token: 'Token',
      signSecret: '签名密钥（可选）',
      show: '显示',
      hide: '隐藏',
      set: '已配置，留空则保持不变',
      unset: '未配置',
      clear: '清除',
      when: '通知时机',
      onComplete: '回合完成',
      outcomeCompleted: '完成',
      outcomeError: '出错',
      outcomeLimit: '超时/超限',
      onApproval: '等你审批',
      onQuestion: '等你回答',
      idleNotify: '无交互（秒）后才通知',
      templates: '通知内容',
      templateShape: '第一行是标题，其余是正文；花括号会替换成真实值。',
      templateTurnEnd: '回合结束',
      templateApproval: '等待审批',
      templateQuestion: '等待回答',
      templatePlaceholder: '留空使用默认文案',
      reset: '恢复默认',
      legendTitle: '标题，默认「任务完成」',
      legendTitleApproval: '标题，默认「需要你审批」',
      legendTitleQuestion: '标题，默认「等你回答」',
      legendOutcome: '结束原因：completed / error / max-tokens',
      legendProject: '项目目录名',
      legendDuration: '这一轮花了多久',
      legendPreview: '回复的最后一句',
      legendError: '出错时的错误行，没出错就没有',
      legendTool: '工具名',
      legendReason: '需要审批的理由',
      legendQuestion: '被问的问题',
      legendCount: '问题总数',
      save: '保存',
      saved: '已保存并生效',
      test: '发测试',
      testing: '发送中…',
      testOk: '测试消息已发出',
      testFail: '发送失败',
      needSave: '改完凭据要先保存，测试读的是已保存的值',
      loading: '读取中…',
      retry: '重试',
      authLost: '会话未授权，刷新页面再试一下',
    }

    /** English copy. */
    const en = {
      section: 'Notifications',
      intro: 'No attendance is required while a long task runs: when it ends, or waits for your approval or answer, the enabled channels send a notification.',
      channels: 'Channels',
      channelLocal: 'Desktop',
      localUnsupportedHint: 'Desktop notifications are not supported on this system.',
      channelBrowser: 'Browser',
      channelNtfy: 'ntfy push',
      channelFeishu: 'Feishu bot',
      allow: 'Allow notifications',
      browserLive: 'Connected: alerts land in the system notification centre.',
      browserRetrying: 'Allowed, reconnecting.',
      browserAsk: 'Not authorized yet — press Allow notifications.',
      browserDenied: 'Blocked by the browser; allow it from the icon left of the address bar.',
      browserUnsupported: 'This browser has no notification support; the desktop channel suits this machine.',
      browserKeepOpen: ' Keep this DeepSeek Web page open — once it closes, nothing arrives.',
      ntfy: 'ntfy',
      feishu: 'Feishu',
      baseUrl: 'Server URL',
      priority: 'Priority',
      topic: 'Topic',
      token: 'Access token (optional)',
      webhook: 'Webhook URL',
      token: 'Token',
      signSecret: 'Sign secret (optional)',
      show: 'Show',
      hide: 'Hide',
      set: 'configured — leave empty to keep it',
      unset: 'not configured',
      clear: 'clear',
      when: 'When',
      onComplete: 'Turn completes',
      outcomeCompleted: 'Completed',
      outcomeError: 'Error',
      outcomeLimit: 'Token limit',
      onApproval: 'Waiting for approval',
      onQuestion: 'Waiting for an answer',
      idleNotify: 'Only after (seconds) without input',
      templates: 'Message text',
      templateShape: 'First line is the title, the rest is the body; names in braces are replaced with real values.',
      templateTurnEnd: 'Turn ends',
      templateApproval: 'Waiting for approval',
      templateQuestion: 'Waiting for an answer',
      templatePlaceholder: 'Empty uses the built-in text',
      reset: 'Restore',
      legendTitle: 'Title, defaults to "Task complete"',
      legendTitleApproval: 'Title, defaults to "Needs your approval"',
      legendTitleQuestion: 'Title, defaults to "Waiting for your answer"',
      legendOutcome: 'Why the turn ended: completed / error / max-tokens',
      legendProject: 'Project directory name',
      legendDuration: 'How long the turn took',
      legendPreview: 'Last line of the reply',
      legendError: 'The error line on a failed turn; absent when nothing failed',
      legendTool: 'Tool name',
      legendReason: 'Why approval is needed',
      legendQuestion: 'The question asked',
      legendCount: 'Total number of questions',
      save: 'Save',
      saved: 'Saved and live',
      test: 'Send test',
      testing: 'Sending…',
      testOk: 'Test message sent',
      testFail: 'Send failed',
      needSave: 'Save before testing: the test reads the stored values',
      loading: 'Loading…',
      retry: 'Retry',
      authLost: 'Not authorized — reload the page',
    }

    /** What the browser says about notification permission right now. */
    function browserPermission() {
      if (typeof globalThis.Notification !== 'function') return 'unsupported'
      return globalThis.Notification.permission
    }

    /** The one stream per page; `null` while it is not open. */
    let browserStream = null

    /** `idle` before the first connect, `live` while open, `retrying` after a drop. */
    let linkState = 'idle'

    /** Everything watching the link state, in practice the settings page. */
    const linkListeners = new Set()

    const linkNow = () => linkState

    /** Publish a link-state change to whoever is watching. */
    function setLinkState(next) {
      if (linkState === next) return
      linkState = next
      for (const listener of linkListeners) listener(next)
    }

    /**
     * Subscribe to link-state changes.
     * @param listener - called with the new state.
     * @returns the unsubscribe function.
     */
    function subscribeLink(listener) {
      linkListeners.add(listener)
      return () => linkListeners.delete(listener)
    }

    /**
     * Open the event stream and show one notification per frame. The browser
     * reconnects on its own, so there is no retry loop here — only the state
     * that tells the page whether the channel is actually live.
     */
    function startBrowserStream() {
      if (browserStream !== null || browserPermission() !== 'granted') return
      if (typeof globalThis.EventSource !== 'function') return
      const source = new globalThis.EventSource(EVENTS_PATH)
      browserStream = source
      source.onopen = () => setLinkState('live')
      source.onerror = () => setLinkState('retrying')
      source.onmessage = (event) => {
        let message = null
        try {
          message = JSON.parse(event.data)
        } catch {
          return
        }
        showNotification(message)
      }
    }

    /** Close the stream when the plugin unloads. */
    function stopBrowserStream() {
      browserStream?.close()
      browserStream = null
      setLinkState('idle')
    }

    /**
     * Show one Host message as a system notification; a click returns to the page.
     * @param message - `{ title, body }`.
     */
    function showNotification(message) {
      const notification = new globalThis.Notification(message.title, { body: message.body })
      notification.onclick = () => {
        globalThis.focus()
        notification.close()
      }
    }

    /** Least gap between two read receipts: one burst of input is one act. */
    const SEEN_THROTTLE_MS = 1_000

    /** The input events only a person can produce; see `startReading`. */
    const HUMAN_EVENTS = ['pointerdown', 'wheel', 'touchmove', 'keydown']

    /**
     * The conversation the main view holds, when the client catalog is reachable.
     * @param ctx - the client context.
     */
    function mainRow(ctx) {
      try {
        const byId = ctx.get?.('sessions')?.list?.getSnapshot?.()?.byId ?? {}
        // Walked, not collected: this runs on every wheel tick of a long scroll.
        for (const id in byId) {
          const entry = byId[id]
          if ((entry?.retainedBy?.mainView ?? 0) > 0) return entry
        }
        return undefined
      } catch {
        return undefined
      }
    }

    /**
     * Tell the host that somebody is reading this conversation.
     *
     * The page notices the turn finish at the same moment the host does: `running`
     * goes false. That is the moment to start listening, and the moment the GUI's
     * own follow-the-output scrolling stops. From there on, anything the page
     * receives was made by a person — a scroll, a click, a keystroke — and each one
     * is a read receipt for the session on screen. Bytes from the agent never
     * produce these events, so a page nobody is touching stays silent, and silence
     * is what keeps a message on its way out.
     * @param ctx - the client context.
     * @returns the teardown.
     */
    function startReading(ctx) {
      const doc = globalThis.document
      if (doc === undefined || typeof doc.addEventListener !== 'function') return () => {}

      /** Last receipt posted; one burst of input is one act, not one per event. */
      let sentAt = 0

      /** Post one receipt; the host is the only reader and a failure changes nothing. */
      function post(sessionId) {
        try {
          void Promise.resolve(fetch(RPC_PATH, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ endpoint: 'seen', payload: { sessionId } }),
            credentials: 'same-origin',
          })).catch(() => {})
        } catch {
          // A page that cannot reach the host simply leaves the message alone.
        }
      }

      /**
       * One act in the page. Ignored while the turn still runs: the output is not
       * final, and the page is scrolling by itself.
       */
      function report() {
        const row = mainRow(ctx)
        if (row === undefined || row.running !== false) return
        const now = Date.now()
        if (now - sentAt < SEEN_THROTTLE_MS) return
        sentAt = now
        post(row.id)
      }

      const attached = []
      for (const type of HUMAN_EVENTS) {
        doc.addEventListener(type, report, { passive: true })
        attached.push(type)
      }

      return () => {
        for (const type of attached) doc.removeEventListener(type, report)
      }
    }

    /**
     * The permission line's text.
     * @param permission - the state `browserPermission` reported.
     */
    function permissionText(permission, link, t) {
      // No page, no notification: the last sentence holds whatever the state.
      if (permission === 'unsupported') return t('browserUnsupported')
      if (permission === 'denied') return t('browserDenied') + t('browserKeepOpen')
      if (permission !== 'granted') return t('browserAsk') + t('browserKeepOpen')
      return (link === 'live' ? t('browserLive') : t('browserRetrying')) + t('browserKeepOpen')
    }

    const PRIORITIES = ['min', 'low', 'default', 'high', 'max']
    const OUTCOMES = [
      { key: 'completed', copy: 'outcomeCompleted' },
      { key: 'error', copy: 'outcomeError' },
      { key: 'max-tokens', copy: 'outcomeLimit' },
    ]

    const styles = {
      // Geometry and tokens follow the built-in Settings sections.
      root: {
        display: 'flex', flexDirection: 'column', gap: 20, padding: '4px 2px', maxWidth: 720,
        color: 'var(--dsw-alias-label-primary, #111827)',
      },
      intro: { margin: 0, fontSize: 14, lineHeight: '22px', color: 'var(--dsw-alias-label-tertiary, #6b7280)' },
      group: { display: 'flex', flexDirection: 'column', gap: 6 },
      groupTitle: { fontSize: 14, fontWeight: 500, lineHeight: '22px' },
      box: { display: 'flex', flexDirection: 'column', gap: 0 },
      row: { display: 'flex', alignItems: 'center', gap: 8 },
      channelFirst: { display: 'flex', flexDirection: 'column', gap: 6, paddingTop: 6, paddingBottom: 10 },
      channel: {
        display: 'flex', flexDirection: 'column', gap: 6, paddingTop: 10, paddingBottom: 10,
        borderTop: '0.5px solid var(--dsw-alias-border-l2, #e5e7eb)',
      },
      channelBody: {
        display: 'flex', flexDirection: 'column', gap: 8, paddingLeft: 24, paddingTop: 2,
      },
      label: { width: 132, flex: '0 0 132px', fontSize: 13 },
      fieldTail: { flex: '0 0 28px', textAlign: 'right', fontSize: 12 },
      inputWrap: { position: 'relative', flex: 1, minWidth: 0, display: 'flex' },
      disclosure: {
        display: 'flex', alignItems: 'center', gap: 6, padding: 0, border: 'none',
        background: 'transparent', cursor: 'pointer', color: 'inherit', font: 'inherit',
      },
      chevron: { flex: 'none', width: 16, height: 16, color: 'var(--dsw-alias-label-secondary, #6b7280)' },
      info: {
        position: 'relative', flex: 'none', display: 'inline-flex', alignItems: 'center',
        justifyContent: 'center', width: 16, height: 16,
        color: 'var(--dsw-alias-label-tertiary, #9ca3af)', cursor: 'help',
      },
      tip: {
        position: 'absolute', top: 'calc(100% + 6px)', left: -8, zIndex: 20, width: 300,
        padding: '8px 10px', whiteSpace: 'pre-line', cursor: 'default',
        borderRadius: 'var(--dsw-radius-md, 6px)',
        border: '0.5px solid var(--dsw-alias-border-l3, #d1d5db)',
        background: 'var(--dsw-alias-bg-layer-2, #fff)',
        boxShadow: '0 6px 20px rgba(0, 0, 0, 0.12)',
        fontSize: 12, lineHeight: '18px',
        color: 'var(--dsw-alias-label-secondary, #6b7280)',
        textAlign: 'left', fontWeight: 400,
      },
      textarea: {
        boxSizing: 'border-box', width: '100%', minHeight: 56, padding: '6px 10px', fontSize: 14,
        lineHeight: '20px', fontFamily: 'inherit', resize: 'vertical',
        borderRadius: 'var(--dsw-radius-md, 6px)',
        border: '0.5px solid var(--dsw-alias-border-l1, #e5e7eb)',
        background: 'var(--dsw-alias-bg-layer-2, #fff)',
        color: 'var(--dsw-alias-label-primary, #111827)',
      },
      eye: {
        position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)',
        width: 20, height: 20, padding: 0, border: 'none', background: 'transparent',
        cursor: 'pointer', color: 'var(--dsw-alias-label-tertiary, #9ca3af)', lineHeight: 0,
      },
      input: {
        flex: 1, minWidth: 0, boxSizing: 'border-box', height: 32, padding: '0 10px', fontSize: 14,
        borderRadius: 'var(--dsw-radius-md, 6px)',
        border: '0.5px solid var(--dsw-alias-border-l1, #e5e7eb)',
        background: 'var(--dsw-alias-bg-layer-2, #fff)',
        color: 'var(--dsw-alias-label-primary, #111827)',
      },
      select: {
        flex: 1, minWidth: 0, boxSizing: 'border-box', height: 32, padding: '0 8px', fontSize: 14,
        borderRadius: 'var(--dsw-radius-md, 6px)',
        border: '0.5px solid var(--dsw-alias-border-l1, #e5e7eb)',
        background: 'var(--dsw-alias-bg-layer-2, #fff)', color: 'var(--dsw-alias-label-primary, #111827)',
      },
      hint: { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-secondary, #6b7280)' },
      optionLabel: { fontSize: 14, lineHeight: '22px' },
      button: {
        boxSizing: 'border-box', height: 32, padding: '0 12px', fontSize: 14, fontFamily: 'inherit',
        borderRadius: 'var(--dsw-radius-md, 6px)', cursor: 'pointer',
        border: '0.5px solid var(--dsw-alias-border-l3, #d1d5db)', background: 'transparent',
        color: 'var(--dsw-alias-label-primary, #111827)',
      },
      primary: {
        boxSizing: 'border-box', height: 36, padding: '0 14px', fontSize: 14, fontFamily: 'inherit',
        borderRadius: 'var(--dsw-radius-md, 6px)', cursor: 'pointer', border: 'none',
        background: 'var(--dsw-alias-button-primary-fill, #111827)',
        color: 'var(--dsw-alias-label-primary-foreground, #fff)',
      },
      status: { fontSize: 12 },
      ok: { color: '#059669' },
      bad: { color: '#dc2626' },
    }

    /**
     * Post one endpoint to the host half and return its envelope.
     * @param rpcEndpoint - `get`, `save` or `test`.
     * @param payload - the request body.
     */
    async function rpcCall(rpcEndpoint, payload) {
      const response = await fetch(RPC_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ endpoint: rpcEndpoint, payload }),
        credentials: 'same-origin',
      })
      const text = await response.text()
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      try {
        return JSON.parse(text)
      } catch {
        throw new Error(`HTTP ${response.status}, body was not JSON`)
      }
    }

    /**
     * The settings page.
     * @param props - `t(key)` from the slot inject.
     */
    function NotifySettings({ t }) {
      const [view, setView] = useState(null)
      const [form, setForm] = useState(null)
      const [secrets, setSecrets] = useState({})
      const [busy, setBusy] = useState(false)
      const [status, setStatus] = useState(null)
      const [testing, setTesting] = useState(null)
      const [lastOutcomes, setLastOutcomes] = useState(['completed', 'error', 'max-tokens'])
      const [revealed, setRevealed] = useState({})
      const [showTemplates, setShowTemplates] = useState(false)
      const [openTip, setOpenTip] = useState(null)
      const [permission, setPermission] = useState(browserPermission())
      const [link, setLink] = useState(linkNow())

      // One call, unwrapping the envelope and naming the two auth statuses.
      const call = async (endpoint, payload) => {
        let result
        try {
          result = await rpcCall(endpoint, payload)
        } catch (error) {
          const message = String(error?.message ?? error)
          throw new Error(/^HTTP (401|403)$/.test(message) ? t('authLost') : message)
        }
        if (!result?.ok) throw new Error(result?.error?.message ?? 'request failed')
        return result.value
      }

      const adopt = (snapshot) => {
        setView(snapshot)
        setForm({
          ...snapshot.config,
          userIdleSec: Math.round((snapshot.config.userIdleMs ?? 0) / 1000),
        })
      }

      const load = async () => {
        setStatus(null)
        try {
          adopt(await call('get', {}))
        } catch (error) {
          setStatus({ kind: 'bad', text: String(error.message ?? error) })
        }
      }

      useEffect(() => {
        void load()
        return subscribeLink(setLink)
      }, [])

      // Before the first snapshot: either the loading line or the failure and its retry.
      if (form === null) {
        return h('div', { style: styles.root }, [
          h('p', { key: 'line', style: styles.intro }, status?.text ?? t('loading')),
          status?.kind === 'bad'
            ? h('button', {
                key: 'retry',
                type: 'button',
                style: styles.button,
                onClick: () => {
                  void load()
                },
              }, t('retry'))
            : null,
        ])
      }

      const patch = (change) => setForm((current) => ({ ...current, ...change }))
      const toggleChannel = (name) => {
        const channels = form.channels.includes(name)
          ? form.channels.filter((entry) => entry !== name)
          : [...form.channels, name]
        patch({ channels })
      }

      const localSupported = view?.platform === undefined || LOCAL_PLATFORMS.includes(view.platform)

      // One checkbox for the whole turn-end row; switching it off keeps the outcomes for later.
      const turnEndOn = form.notifyOn.length > 0
      const toggleTurnEnd = () => {
        if (turnEndOn) {
          setLastOutcomes(form.notifyOn)
          patch({ notifyOn: [] })
          return
        }
        patch({ notifyOn: lastOutcomes })
      }

      const toggleOutcome = (key) => {
        const notifyOn = form.notifyOn.includes(key)
          ? form.notifyOn.filter((entry) => entry !== key)
          : [...form.notifyOn, key]
        patch({ notifyOn })
      }

      const save = async () => {
        setBusy(true)
        setStatus(null)
        try {
          const config = {
            channels: form.channels,
            notifyOn: form.notifyOn,
            notifyOnApproval: form.notifyOnApproval,
            notifyOnQuestion: form.notifyOnQuestion,
            userIdleMs: Math.max(0, Math.round(Number(form.userIdleSec ?? 0) * 1000)),
            local: form.local,
            ntfy: form.ntfy,
            feishu: form.feishu,
            templates: form.templates,
          }
          adopt(await call('save', { config, secrets }))
          setSecrets({})
          setStatus({ kind: 'ok', text: t('saved') })
        } catch (error) {
          setStatus({ kind: 'bad', text: String(error.message ?? error) })
        } finally {
          setBusy(false)
        }
      }

      /** Ask the browser for notification permission; a click is the gesture it wants. */
      const askPermission = async () => {
        if (browserPermission() !== 'default') return
        const answer = await globalThis.Notification.requestPermission()
        setPermission(answer)
        if (answer === 'granted') startBrowserStream()
      }

      const test = async (channel) => {
        setTesting(channel)
        setStatus(null)
        try {
          const result = await call('test', { channel })
          setStatus(result.delivered
            ? { kind: 'ok', text: `${t('testOk')} (${channel})` }
            : { kind: 'bad', text: `${t('testFail')} (${channel}) ${result.error ?? ''}` })
        } catch (error) {
          setStatus({ kind: 'bad', text: String(error.message ?? error) })
        } finally {
          setTesting(null)
        }
      }

      // One credential input: blank means unchanged, the clear link removes it.
      // What each placeholder means, in the order it appears in the default format.
      const LEGENDS = {
        turnEnd: [['{title}', 'legendTitle'], ['{outcome}', 'legendOutcome'], ['{project}', 'legendProject'],
          ['{duration}', 'legendDuration'], ['{preview}', 'legendPreview'], ['{error}', 'legendError']],
        approval: [['{title}', 'legendTitleApproval'], ['{project}', 'legendProject'],
          ['{tool}', 'legendTool'], ['{reason}', 'legendReason']],
        question: [['{title}', 'legendTitleQuestion'], ['{project}', 'legendProject'],
          ['{question}', 'legendQuestion'], ['{count}', 'legendCount']],
      }

      // The circle explains one template: every name, then what it means.
      const infoIcon = (key) => {
        // One entry per line: the name, then what it means, with no blank lines.
        const lines = LEGENDS[key].map(([token, copy]) => `${token} ${t(copy)}`)
        const text = [t('templateShape'), ...lines].join('\n')
        return h('span', {
          key: 'info',
          style: styles.info,
          role: 'img',
          tabIndex: 0,
          'aria-label': text,
          onMouseEnter: () => setOpenTip(key),
          onMouseLeave: () => setOpenTip(null),
          onFocus: () => setOpenTip(key),
          onBlur: () => setOpenTip(null),
        }, [
          h('svg', {
            key: 'icon',
            viewBox: '0 0 16 16',
            width: 14,
            height: 14,
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: 1.3,
          }, [
            h('circle', { key: 'c', cx: 8, cy: 8, r: 6.3 }),
            h('path', { key: 'i', d: 'M8 7.2v4', strokeLinecap: 'round' }),
            h('circle', { key: 'd', cx: 8, cy: 4.9, r: 0.5, fill: 'currentColor' }),
          ]),
          openTip === key ? h('div', { key: 'tip', style: styles.tip }, text) : null,
        ])
      }

      // One template: a name, the text, then the placeholders it accepts.
      const templateRow = (key, label, first) =>
        h('div', { key, style: first ? styles.channelFirst : styles.channel }, [
          h('div', { key: 'head', style: styles.row }, [
            h('span', { key: 'l', style: styles.optionLabel }, label),
            infoIcon(key),
            h('button', {
              key: 'reset',
              type: 'button',
              style: { ...styles.button, height: 24, marginLeft: 'auto', fontSize: 12, padding: '0 10px' },
              onClick: () => patch({ templates: { ...form.templates, [key]: view.defaults.templates[key] } }),
            }, t('reset')),
          ]),
          h('textarea', {
            key: 'ta',
            rows: 2,
            style: styles.textarea,
            value: form.templates[key],
            placeholder: t('templatePlaceholder'),
            onChange: (event) => patch({ templates: { ...form.templates, [key]: event.target.value } }),
          }),

        ])

      // One shape for every field row: fixed label, flexible control, fixed tail.
      const fieldRow = (key, label, control, tail) =>
        h('div', { key, style: styles.row }, [
          h('label', { key: 'l', style: styles.label }, label),
          control,
          tail ?? h('span', { key: 't', style: styles.fieldTail }),
        ])

      // The eye shows what is typed, so a pasted token can be checked before saving.
      const eyeButton = (field) => {
        const open = revealed[field] === true
        return h('button', {
          key: 'eye',
          type: 'button',
          style: styles.eye,
          'aria-label': open ? t('hide') : t('show'),
          'aria-pressed': open,
          onClick: () => setRevealed((current) => ({ ...current, [field]: !open })),
        }, h('svg', {
          viewBox: '0 0 16 16', width: 16, height: 16, fill: 'none',
          stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round',
        }, [
          h('path', { key: 'lid', d: 'M1.5 8S4 3.75 8 3.75 14.5 8 14.5 8 12 12.25 8 12.25 1.5 8 1.5 8z' }),
          h('circle', { key: 'iris', cx: 8, cy: 8, r: 2.1 }),
          open ? h('path', { key: 'slash', d: 'M2.5 2.5l11 11' }) : null,
        ]))
      }

      const secretField = (field, label) => {
        const configured = view?.secrets?.[field] === true
        const pending = secrets[field]
        // The eye is only there when something is typed: a stored secret never comes back.
        const typed = (pending ?? '') !== ''
        const control = h('div', { key: 'i', style: styles.inputWrap }, [
          h('input', {
            key: 'in',
            type: revealed[field] === true ? 'text' : 'password',
            style: { ...styles.input, paddingRight: typed ? 30 : 10 },
            value: pending ?? '',
            placeholder: configured ? t('set') : t('unset'),
            onChange: (event) => setSecrets((current) => ({ ...current, [field]: event.target.value })),
          }),
          typed ? eyeButton(field) : null,
        ])
        const tail = h('span', { key: 't', style: styles.fieldTail }, h('span', {
          key: 'c',
          style: { ...styles.hint, cursor: 'pointer' },
          onClick: () => setSecrets((current) => ({ ...current, [field]: '' })),
        }, configured && pending === undefined ? t('clear') : ''))
        return fieldRow(field, label, control, tail)
      }

      const checkbox = (checked, onChange, label, key) =>
        h('label', { key, style: { ...styles.row, cursor: 'pointer' } }, [
          h('input', { key: 'c', type: 'checkbox', checked, onChange }),
          h('span', { key: 's', style: styles.optionLabel }, label),
        ])

      // One channel: the checkbox, then its settings once the channel is on.
      const channelRow = (key, label, first, settings) => {
        const on = form.channels.includes(key)
        return h('div', { key, style: first ? styles.channelFirst : styles.channel }, [
          checkbox(on, () => toggleChannel(key), label, `${key}-check`),
          on && settings !== null ? h('div', { key: 'body', style: styles.channelBody }, settings()) : null,
        ])
      }

      const testButton = (channel) =>
        h('button', {
          style: styles.button, disabled: testing !== null,
          onClick: () => void test(channel),
        }, testing === channel ? t('testing') : t('test'))

      return h('div', { style: styles.root }, [
        h('p', { key: 'intro', style: styles.intro }, t('intro')),

        h('div', { key: 'channels', style: styles.group }, [
          h('div', { key: 't', style: styles.groupTitle }, t('channels')),
          h('div', { key: 'b', style: styles.box }, [
            // Nothing to configure when it works; when it cannot, the row says so underneath.
            channelRow('local', t('channelLocal'), true, localSupported ? null : () => [
              h('span', { key: 'hint', style: styles.hint }, t('localUnsupportedHint')),
            ]),
            channelRow('browser', t('channelBrowser'), false, () => [
              h('span', { key: 'text', style: styles.hint }, permissionText(permission, link, t)),
              browserPermission() === 'default'
                ? h('button', {
                  key: 'allow', style: styles.button, onClick: () => void askPermission(),
                }, t('allow'))
                : null,
            ]),
            channelRow('ntfy', t('channelNtfy'), false, () => [
              fieldRow('url', t('baseUrl'), h('input', {
                key: 'i', style: styles.input, value: form.ntfy.baseUrl,
                onChange: (event) => patch({ ntfy: { ...form.ntfy, baseUrl: event.target.value } }),
              })),
              fieldRow('pri', t('priority'), h('select', {
                key: 's', style: styles.select, value: form.ntfy.priority,
                onChange: (event) => patch({ ntfy: { ...form.ntfy, priority: event.target.value } }),
              }, PRIORITIES.map((entry) => h('option', { key: entry, value: entry }, entry)))),
              secretField('ntfyTopic', t('topic')),
              secretField('ntfyToken', t('token')),
              h('div', { key: 'test', style: styles.row }, testButton('ntfy')),
            ]),
            channelRow('feishu', t('channelFeishu'), false, () => [
              fieldRow('url', t('webhook'), h('input', {
                key: 'i', style: styles.input, value: form.feishu.baseUrl,
                onChange: (event) => patch({ feishu: { ...form.feishu, baseUrl: event.target.value } }),
              })),
              secretField('feishuToken', t('token')),
              secretField('feishuSecret', t('signSecret')),
              h('div', { key: 'test', style: styles.row }, testButton('feishu')),
            ]),
          ]),
        ]),

        h('div', { key: 'when', style: styles.group }, [
          h('div', { key: 't', style: styles.groupTitle }, t('when')),
          h('div', { key: 'b', style: styles.box }, [
            // Timing comes before the triggers: it decides whether a message leaves at
            // all, and it is the only setting here that is not a trigger.
            h('div', { key: 'idle', style: styles.channelFirst }, [
              fieldRow('idle', t('idleNotify'), h('input', {
                key: 'i', type: 'number', min: 0, style: styles.input,
                value: form.userIdleSec,
                onChange: (event) => patch({ userIdleSec: event.target.value }),
              })),
            ]),
            h('div', { key: 'approval', style: styles.channel }, [
              checkbox(form.notifyOnApproval, () => patch({ notifyOnApproval: !form.notifyOnApproval }), t('onApproval'), 'approval'),
            ]),
            h('div', { key: 'question', style: styles.channel }, [
              checkbox(form.notifyOnQuestion, () => patch({ notifyOnQuestion: !form.notifyOnQuestion }), t('onQuestion'), 'question'),
            ]),
            h('div', { key: 'turn-end', style: styles.channel }, [
              checkbox(turnEndOn, toggleTurnEnd, t('onComplete'), 'turn-end'),
              // The outcomes are this row's settings, folded away when the row is off.
              turnEndOn
                ? h('div', { key: 'body', style: styles.channelBody }, [
                  h('div', { key: 'outcomes', style: { ...styles.row, gap: 18 } }, OUTCOMES.map((entry) => checkbox(
                    form.notifyOn.includes(entry.key),
                    () => toggleOutcome(entry.key),
                    t(entry.copy),
                    entry.key,
                  ))),
                ])
                : null,
            ]),
          ]),
        ]),

        h('div', { key: 'copy', style: styles.group }, [
          h('button', {
            key: 't',
            type: 'button',
            style: styles.disclosure,
            'aria-expanded': showTemplates,
            onClick: () => setShowTemplates(!showTemplates),
          }, [
            h('svg', {
              key: 'c',
              viewBox: '0 0 16 16',
              style: { ...styles.chevron, transform: showTemplates ? 'rotate(90deg)' : 'none', transition: 'transform 120ms' },
              fill: 'none',
              stroke: 'currentColor',
              strokeWidth: 1.6,
              strokeLinecap: 'round',
              strokeLinejoin: 'round',
            }, h('path', { d: 'M6 3.5L10.5 8 6 12.5' })),
            h('span', { key: 'l' }, t('templates')),
          ]),
          showTemplates
            ? h('div', { key: 'b', style: styles.box }, [
              templateRow('turnEnd', t('templateTurnEnd'), true),
              templateRow('approval', t('templateApproval')),
              templateRow('question', t('templateQuestion')),
            ])
            : null,
        ]),

        h('div', { key: 'actions', style: { ...styles.row, gap: 12 } }, [
          h('button', {
            key: 'save', style: styles.primary, disabled: busy,
            onClick: () => void save(),
          }, busy ? t('saved') : t('save')),
          Object.keys(secrets).length > 0
            ? h('span', { key: 'hint', style: styles.hint }, t('needSave'))
            : null,
          status !== null
            ? h('span', { key: 'status', style: { ...styles.status, ...(status.kind === 'ok' ? styles.ok : styles.bad) } }, status.text)
            : null,
        ]),
      ])
    }

    return {
      inject: ['slots', 'locale'],
      /**
       * Register the copy and the Settings entry.
       * @param ctx - Client root Context with slots and locale.
       */
      apply(ctx) {
        const translate = ctx.locale.bind(NS)

        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-notify: copy')
        ctx.effect(() => {
          startBrowserStream()
          return stopBrowserStream
        }, 'dsh-notify: browser channel')
        // Every open page listens for reading, not only the one showing Settings:
        // the whole point is knowing about the page the user is already in.
        ctx.effect(() => startReading(ctx), 'dsh-notify: reading')
        ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'dsh-notify',
          order: 2,
          label: () => translate('section'),
          inject: () => ({ t: translate }),
        }, NotifySettings)), 'dsh-notify: settings section')
      },
    }
  },
})
