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

    /** Room GUI origin; the iframe and the "new window" link share it. */
    const SERVER = 'http://127.0.0.1:8787'
    /** Marker attribute for the single injected stylesheet. */
    const STYLE_MARKER = 'data-llmroom-style'

    /**
     * Sidebar footer action: a trigger matching the shipped footer geometry
     * plus the iframe overlay. The overlay is rendered only while open.
     */
    function RoomButton() {
      const [open, setOpen] = React.useState(false)
      const triggerRef = React.useRef(null)

      /** Close the overlay and hand focus back to the trigger. */
      const close = React.useCallback(() => {
        setOpen(false)
        const trigger = triggerRef.current
        if (trigger !== null) trigger.focus({ preventScroll: true })
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
              h('a', {
                key: 'link',
                className: 'llmr-link',
                href: SERVER,
                target: '_blank',
                rel: 'noreferrer',
              }, '新窗口打开'),
              h('button', {
                key: 'close',
                type: 'button',
                className: 'llmr-close',
                onClick: close,
              }, '关闭'),
            ]),
            h('iframe', {
              key: 'frame',
              className: 'llmr-frame',
              src: SERVER,
              title: 'LLMAgentChatRoom',
            }),
          ]))
          : null,
      ])
    }

    /** All overlay and trigger styling in one injected sheet. */
    const STYLES = `
      .llmr-trigger{display:flex;align-items:center;gap:8px;box-sizing:border-box;width:100%;height:42px;padding:0 10px 0 8px;border:0;border-radius:12px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;line-height:20px;text-align:left;cursor:pointer;overflow:hidden}
      .llmr-trigger:hover,.llmr-trigger[aria-expanded="true"]{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}
      .llmr-dot{width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-state-business-primary,#2563eb);flex:none}
      .llmr-text{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .llmr-overlay{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;box-sizing:border-box;padding:16px;background:rgba(0,0,0,.55);backdrop-filter:blur(2px)}
      .llmr-panel{display:flex;flex-direction:column;width:min(1100px,92vw);height:min(760px,88vh);overflow:hidden;border:1px solid #262a33;border-radius:12px;background:#0f1115;color:#e6e6e6;box-shadow:0 24px 64px rgba(0,0,0,.55)}
      .llmr-head{flex:none;display:flex;align-items:center;gap:12px;padding:10px 14px;border-bottom:1px solid #262a33;background:#12151b;font:13px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif}
      .llmr-title{font-weight:600;letter-spacing:.2px}
      .llmr-spacer{flex:1}
      .llmr-link{flex:none;color:#8ab4ff;text-decoration:none;font-size:12px;white-space:nowrap}
      .llmr-link:hover{text-decoration:underline}
      .llmr-close{flex:none;padding:4px 12px;border:1px solid #333a46;border-radius:6px;background:#171b22;color:inherit;font:inherit;font-size:12px;cursor:pointer}
      .llmr-close:hover{background:#20252e}
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
