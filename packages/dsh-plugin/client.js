/**
 * Client half of the `@llmagentchatroom/dsh-plugin` DSH bundle.
 *
 * Registers the "聊天室" sidebar footer action: a full-width trigger that opens
 * a dimmed overlay with the room GUI (http://127.0.0.1:8787) in an iframe.
 *
 * Plain-JS bundle format: `react` is the only runtime module, no JSX, no assets.
 */
window.__ModuleLoader__.load({
  id: '@llmagentchatroom/dsh-plugin',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Host route that returns the room server URL and its owner token. */
    const BOOTSTRAP_PATH = '/api/llmroom/bootstrap'
    /** Marker attribute for the single injected stylesheet. */
    const STYLE_MARKER = 'data-llmroom-style'

    /**
     * Sidebar footer action: a trigger matching the shipped footer geometry
     * plus the iframe overlay. The overlay is rendered only while open.
     */
    function RoomButton() {
      const [open, setOpen] = React.useState(false)
      const [bootstrap, setBootstrap] = React.useState({ status: 'loading' })
      const [attempt, setAttempt] = React.useState(0)
      const triggerRef = React.useRef(null)

      React.useEffect(() => {
        const controller = new AbortController()
        setBootstrap({ status: 'loading' })
        fetch(BOOTSTRAP_PATH, {
          signal: controller.signal,
          headers: { accept: 'application/json' },
        })
          .then(async (response) => {
            let body = null
            try {
              body = await response.json()
            } catch {
              body = null
            }
            if (!response.ok) {
              const code = body && typeof body.error === 'string' ? body.error : `HTTP ${response.status}`
              throw new Error(code === 'token_missing' ? '聊天室尚未初始化（缺少 admin token）' : code)
            }
            if (!body || typeof body.server !== 'string' || typeof body.token !== 'string') {
              throw new Error('聊天室连接信息无效')
            }
            const server = body.server.replace(/\/+$/, '')
            setBootstrap({
              status: 'ready',
              url: `${server}/?token=${encodeURIComponent(body.token)}`,
            })
          })
          .catch((error) => {
            if (controller.signal.aborted) return
            setBootstrap({
              status: 'error',
              message: error instanceof Error ? error.message : String(error),
            })
          })
        return () => { controller.abort() }
      }, [attempt])

      /** Close the overlay and hand focus back to the trigger. */
      const close = React.useCallback(() => {
        setOpen(false)
        const trigger = triggerRef.current
        if (trigger !== null) trigger.focus({ preventScroll: true })
      }, [])

      const retry = React.useCallback(() => {
        setBootstrap({ status: 'loading' })
        setAttempt((value) => value + 1)
      }, [])

      React.useEffect(() => {
        if (!open) return undefined
        const onKeyDown = (event) => {
          if (event.key !== 'Escape' || event.defaultPrevented) return
          close()
        }
        document.addEventListener('keydown', onKeyDown)
        return () => { document.removeEventListener('keydown', onKeyDown) }
      }, [open, close])

      /** A click on the dim backdrop itself (not the panel) closes the overlay. */
      const onBackdropClick = (event) => {
        if (event.target === event.currentTarget) close()
      }

      const loginUrl = bootstrap.status === 'ready' ? bootstrap.url : null
      const body = bootstrap.status === 'loading'
        ? h('div', { key: 'loading', className: 'llmr-status', role: 'status' }, '正在启动聊天室…')
        : bootstrap.status === 'error'
          ? h('div', { key: 'error', className: 'llmr-status llmr-status-error', role: 'alert' }, [
            h('p', { key: 'message', className: 'llmr-error' }, `聊天室启动失败：${bootstrap.message}`),
            h('button', {
              key: 'retry',
              type: 'button',
              className: 'llmr-retry',
              onClick: retry,
            }, '重试'),
          ])
          : h('iframe', {
            key: 'frame',
            className: 'llmr-frame',
            src: bootstrap.url,
            title: 'LLMAgentChatRoom',
          })

      return h(React.Fragment, null, [
        h('button', {
          key: 'trigger',
          ref: triggerRef,
          type: 'button',
          className: 'llmr-trigger',
          title: '聊天室',
          'aria-label': '聊天室',
          'aria-haspopup': 'dialog',
          'aria-expanded': open,
          onClick: () => setOpen(true),
        }, [
          h('span', { key: 'dot', className: 'llmr-dot', 'aria-hidden': true }),
          h('span', { key: 'text', className: 'llmr-text' }, '聊天室'),
        ]),
        open
          ? h('div', {
            key: 'overlay',
            className: 'llmr-overlay',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': 'LLMAgentChatRoom',
            onClick: onBackdropClick,
          }, h('div', { className: 'llmr-panel' }, [
            h('header', { key: 'head', className: 'llmr-head' }, [
              h('span', { key: 'title', className: 'llmr-title' }, 'LLMAgentChatRoom'),
              h('span', { key: 'spacer', className: 'llmr-spacer' }),
              loginUrl
                ? h('a', {
                  key: 'link',
                  className: 'llmr-link',
                  href: loginUrl,
                  target: '_blank',
                  rel: 'noreferrer',
                }, '新窗口打开')
                : h('span', {
                  key: 'link',
                  className: 'llmr-link llmr-link-disabled',
                  'aria-disabled': 'true',
                }, '新窗口打开'),
              h('button', {
                key: 'close',
                type: 'button',
                className: 'llmr-close',
                onClick: close,
              }, '关闭'),
            ]),
            h('div', { key: 'body', className: 'llmr-body' }, body),
          ]))
          : null,
      ])
    }

    /** All overlay and trigger styling in one injected sheet. */
    const STYLES = `
      .llmr-trigger{display:flex;align-items:center;gap:8px;box-sizing:border-box;width:100%;height:32px;padding:0 8px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;line-height:20px;text-align:left;cursor:pointer;overflow:hidden}
      .llmr-trigger:hover,.llmr-trigger[aria-expanded="true"]{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}
      .llmr-dot{width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-state-business-primary,#2563eb);flex:none}
      .llmr-text{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      [class*="footerActions"]:has(.llmr-trigger) { flex-direction: column; align-items: stretch; gap: 0; width: 100%; }
      [class*="footerActions"]:has(.llmr-trigger) > * { width: 100%; min-width: 0; }
      .llmr-overlay{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;box-sizing:border-box;padding:16px;background:rgba(0,0,0,.55);backdrop-filter:blur(2px)}
      .llmr-panel{display:flex;flex-direction:column;width:min(1100px,92vw);height:min(760px,88vh);overflow:hidden;border:1px solid #262a33;border-radius:12px;background:#0f1115;color:#e6e6e6;box-shadow:0 24px 64px rgba(0,0,0,.55)}
      .llmr-head{flex:none;display:flex;align-items:center;gap:12px;padding:10px 14px;border-bottom:1px solid #262a33;background:#12151b;font:13px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif}
      .llmr-title{font-weight:600;letter-spacing:.2px}
      .llmr-spacer{flex:1}
      .llmr-link{flex:none;color:#8ab4ff;text-decoration:none;font-size:12px;white-space:nowrap}
      .llmr-link:hover{text-decoration:underline}
      .llmr-link[aria-disabled="true"],.llmr-link-disabled{color:#6b7280;cursor:default;text-decoration:none}
      .llmr-close{flex:none;padding:4px 12px;border:1px solid #333a46;border-radius:6px;background:#171b22;color:inherit;font:inherit;font-size:12px;cursor:pointer}
      .llmr-close:hover{background:#20252e}
      .llmr-body{flex:1;display:flex;min-height:0}
      .llmr-status{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;padding:24px;color:#aab2c0;font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;text-align:center}
      .llmr-status-error{color:#ffb4b4}
      .llmr-error{margin:0;max-width:560px;word-break:break-word}
      .llmr-retry{padding:5px 16px;border:1px solid #4a5568;border-radius:6px;background:#171b22;color:#e6e6e6;font:inherit;font-size:13px;cursor:pointer}
      .llmr-retry:hover{background:#20252e}
      .llmr-frame{flex:1;display:block;width:100%;min-height:0;border:0;background:#0f1115}
    `

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.effect(() => {
          for (const stale of document.querySelectorAll(`style[${STYLE_MARKER}]`)) stale.remove()
          const style = document.createElement('style')
          style.setAttribute(STYLE_MARKER, '')
          style.textContent = STYLES
          document.head.appendChild(style)
          return () => { style.remove() }
        }, 'llmagentchatroom: client styles')
        ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
          name: 'sidebar.footer.action',
          id: 'llmroom',
          order: 9,
          label: '聊天室',
        }, RoomButton))
      },
    }
  },
})
