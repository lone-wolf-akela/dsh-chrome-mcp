/**
 * Browser half: render `chrome-devtools-mcp` screenshots inline.
 *
 * The Host already receives a real MCP image block: DSH's MCP client admits it,
 * stores it as a durable attachment, and hands the model the pixels. The
 * transcript was the weak link. A call to `mcp__chrome__take_screenshot` has no
 * keyed Tool view, so it falls through to the generic row, whose expanded body
 * flattens every non-text block to JSON — the screenshot appeared as
 * `{"type":"image","attachment":{...}}`.
 *
 * This module claims that one key and draws the result the way the built-in
 * `read_image` card does: a summary row naming the image, and the durable image
 * itself in the expanded body, loaded through the Gateway-authorized
 * `loadImage` prop the Tool layer already provides. It imports no Harness
 * Client package — React from the module table plus this file's own markup and
 * CSS — so a Harness update cannot blank the row by moving an internal module.
 *
 * The registration is unconditional: the keyed slot accepts a view for a tool
 * that is not currently mounted, and the row simply starts rendering the next
 * time `chrome_bridge action=on` makes `take_screenshot` available. Failures,
 * non-image results (a screenshot saved to `filePath`), running calls, and
 * results whose image was refused all keep a sensible text row.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-chrome-mcp',
  factory(require) {
    const React = require('react')
    const ReactDOM = require('react-dom')
    const h = React.createElement

    /** Runtime locale namespace owned by this bundle. */
    const NS = 'chrome-mcp'

    /** The one wire name this view claims; the bundle's patch fixes `serverName: chrome`. */
    const SCREENSHOT_TOOL = 'mcp__chrome__take_screenshot'

    const DICTIONARIES = {
      en: {
        'screenshot.title': 'Screenshot',
        'screenshot.running': 'Taking a screenshot…',
        'screenshot.summary': '{width}×{height} px · {size}',
        'screenshot.empty': 'The screenshot tool returned no image',
        'screenshot.failed': 'Screenshot failed',
        'screenshot.imageAlt': 'Browser screenshot',
        'screenshot.open': 'Open the screenshot at full size',
        'screenshot.loading': 'Loading screenshot…',
        'screenshot.loadFailed': 'The screenshot could not be loaded.',
        'screenshot.retry': 'Retry',
        'screenshot.close': 'Close',
        'screenshot.runningStatus': 'Screenshot in progress',
      },
      zh: {
        'screenshot.title': '截图',
        'screenshot.running': '正在截取页面…',
        'screenshot.summary': '{width}×{height} 像素 · {size}',
        'screenshot.empty': '截图工具没有返回图片',
        'screenshot.failed': '截图失败',
        'screenshot.imageAlt': '浏览器截图',
        'screenshot.open': '查看完整截图',
        'screenshot.loading': '正在加载截图…',
        'screenshot.loadFailed': '无法加载截图。',
        'screenshot.retry': '重试',
        'screenshot.close': '关闭',
        'screenshot.runningStatus': '正在截取页面',
      },
    }

    // Sizes, colors, and spacing mirror the shipped Tool row: 24px summary line,
    // 16px leading box with a 14px glyph, 2px separator dot, secondary type for
    // the title and summary. Image frames reuse the code-block surface the
    // read_image card uses, so light and dark both come from the theme.
    const CSS = [
      '.dsh-chrome-shot{display:flex;flex-direction:column;width:100%;min-width:0}',
      '.dsh-chrome-shot-row{position:relative;display:flex;align-items:center;height:calc(24px + var(--dsh-content-font-delta,0px));min-width:0;overflow:hidden;color:var(--dsw-alias-label-tertiary);transition:color .1s}',
      '.dsh-chrome-shot-row[data-expandable="true"]{cursor:pointer}',
      '.dsh-chrome-shot-row:hover{color:var(--dsw-alias-label-secondary)}',
      '.dsh-chrome-shot-row:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px;border-radius:var(--dsw-radius-sm)}',
      '.dsh-chrome-shot-leading{position:relative;flex:0 0 auto;width:calc(16px + var(--dsh-content-font-delta,0px));height:calc(16px + var(--dsh-content-font-delta,0px));display:inline-flex;align-items:center;justify-content:center;margin-right:6px;color:inherit}',
      '.dsh-chrome-shot-leading svg{width:calc(14px + var(--dsh-content-font-delta,0px));height:calc(14px + var(--dsh-content-font-delta,0px))}',
      '.dsh-chrome-shot-icon{display:inline-flex;opacity:1;transition:opacity .1s}',
      '.dsh-chrome-shot-chevron{position:absolute;inset:0;margin:auto;opacity:0;transition:opacity .1s,transform .15s ease}',
      '.dsh-chrome-shot-row:hover .dsh-chrome-shot-icon,.dsh-chrome-shot-row[aria-expanded="true"] .dsh-chrome-shot-icon{opacity:0}',
      '.dsh-chrome-shot-row:hover .dsh-chrome-shot-chevron,.dsh-chrome-shot-row[aria-expanded="true"] .dsh-chrome-shot-chevron{opacity:1}',
      '.dsh-chrome-shot-row[aria-expanded="true"] .dsh-chrome-shot-chevron{transform:rotate(90deg)}',
      '.dsh-chrome-shot-title{flex:0 0 auto;font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(24px + var(--dsh-content-font-delta,0px));color:inherit}',
      '.dsh-chrome-shot-sep{flex:none;width:2px;height:2px;border-radius:1px;margin:0 8px;background:var(--dsw-alias-label-caption)}',
      '.dsh-chrome-shot-summary{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(24px + var(--dsh-content-font-delta,0px))}',
      '.dsh-chrome-shot-summary[data-error="true"]{color:var(--dsw-alias-state-error-primary)}',
      '.dsh-chrome-shot-body{display:flex;flex-direction:column;margin:4px 0 4px 4px}',
      '.dsh-chrome-shot-gallery{display:flex;flex-wrap:wrap;gap:8px}',
      '.dsh-chrome-shot-frame{display:block;margin:0;padding:0;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-markdown-code-block);overflow:hidden;line-height:0;cursor:zoom-in}',
      '.dsh-chrome-shot-frame img{display:block;width:auto;height:auto;max-width:min(480px,100%);max-height:320px}',
      '.dsh-chrome-shot-placeholder{display:flex;align-items:center;justify-content:center;width:240px;height:140px;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-markdown-code-block);color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xs-13)}',
      '.dsh-chrome-shot-retry{padding:0;border:none;background:none;color:var(--dsw-alias-brand-primary);font:inherit;cursor:pointer;text-decoration:underline}',
      '.dsh-chrome-shot-meta{margin-top:4px;white-space:pre-wrap;overflow-wrap:anywhere;font:var(--dsw-font-markdown-code-block-small);color:var(--dsw-alias-label-tertiary)}',
      '.dsh-chrome-shot-text{margin-top:4px;white-space:pre-wrap;overflow-wrap:anywhere;font:var(--dsw-font-xs-13);color:var(--dsw-alias-label-tertiary)}',
      '.dsh-chrome-shot-text[data-error="true"]{color:var(--dsw-alias-state-error-primary)}',
      '.dsh-chrome-shot-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}',
      '.dsh-chrome-shot-lightbox{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;padding:24px;background:color-mix(in srgb,#000 66%,transparent)}',
      '.dsh-chrome-shot-lightbox-image{max-width:92vw;max-height:92vh;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-base);box-shadow:0 8px 32px #00000066}',
      // The close control sits at the bottom center, not the top-right: the
      // Desktop window's minimize/maximize/close controls own the top-right
      // corner of the viewport, and a button there cannot be clicked. A bottom
      // pill stays reachable in the Desktop app and in a plain browser tab.
      '.dsh-chrome-shot-lightbox-close{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);display:inline-flex;align-items:center;gap:6px;padding:8px 18px;border:.5px solid var(--dsw-alias-border-l3);border-radius:999px;background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);font:var(--dsw-font-xs-13);cursor:pointer;box-shadow:0 4px 16px #00000033}',
      '.dsh-chrome-shot-lightbox-close:hover{background:var(--dsw-alias-interactive-bg-hover-solid)}',
      '.dsh-chrome-shot-lightbox-close:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}',
    ].join('\n')

    /** Join every text block of a settled result, in order. */
    function resultText(block) {
      const parts = []
      for (const part of block.content ?? []) {
        if (part !== null && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string') {
          parts.push(part.text)
        }
      }
      return parts.join('\n')
    }

    /**
     * Narrow the result's image blocks to loadable attachment references.
     * Every field arrives unvalidated over the wire, so a malformed block is
     * skipped rather than rendered as a broken frame; the text row remains.
     */
    function imageReferences(block) {
      const references = []
      for (const part of block.content ?? []) {
        if (part === null || typeof part !== 'object' || part.type !== 'image') continue
        const attachment = part.attachment
        if (attachment === null || typeof attachment !== 'object') continue
        if (typeof attachment.attachmentId !== 'string' || attachment.attachmentId === '') continue
        if (typeof attachment.mediaType !== 'string') continue
        if (typeof attachment.bytes !== 'number' || typeof attachment.width !== 'number' || typeof attachment.height !== 'number') continue
        references.push(attachment)
      }
      return references
    }

    /** First display line of a multi-line result. */
    function firstLine(text) {
      const newline = text.indexOf('\n')
      return newline === -1 ? text : text.slice(0, newline)
    }

    /** Human byte size for the under-image meta line. */
    function formatBytes(bytes) {
      if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return ''
      if (bytes < 1024) return `${Math.round(bytes)} B`
      if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
      return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    }

    /**
     * Derive one row's display facts from the call's current stage.
     * A running call has no result yet, so it shows the localized progress line
     * and offers no body. A settled call prefers the image dimensions as the
     * summary (the server's English sentence stays visible in the body) and
     * falls back to the result text for refusals and file-path saves.
     */
    function screenshotModel(block, t) {
      if (!('kind' in block)) {
        return { state: 'running', summary: t('screenshot.running'), images: [], text: '', expandable: false }
      }
      const text = resultText(block)
      if (block.isError) {
        const failure = text !== '' ? text : block.error === undefined ? '' : `${block.error.name}: ${block.error.code}`
        return {
          state: 'error',
          summary: firstLine(failure) === '' ? t('screenshot.failed') : firstLine(failure),
          images: [],
          text: failure,
          expandable: failure !== '',
        }
      }
      const images = imageReferences(block)
      if (images.length > 0) {
        const first = images[0]
        return {
          state: 'ok',
          summary: t('screenshot.summary', {
            width: first.width,
            height: first.height,
            size: formatBytes(first.bytes),
          }),
          images,
          text,
          expandable: true,
        }
      }
      return {
        state: 'ok',
        summary: text === '' ? t('screenshot.empty') : firstLine(text),
        images,
        text,
        expandable: text !== '',
      }
    }

    /** The leading browser-window glyph; decorative, so it carries no title. */
    function BrowserGlyph() {
      return h('svg', { viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.2, 'aria-hidden': true, focusable: 'false' },
        h('rect', { x: 1.6, y: 2.4, width: 12.8, height: 11.2, rx: 1.6 }),
        h('path', { d: 'M1.6 5.4h12.8' }),
        h('circle', { cx: 3.6, cy: 3.9, r: 0.45, fill: 'currentColor', stroke: 'none' }),
        h('circle', { cx: 5.2, cy: 3.9, r: 0.45, fill: 'currentColor', stroke: 'none' }))
    }

    /** Hover-revealed chevron, matching the shipped disclosure rows. */
    function ChevronGlyph() {
      return h('svg', { viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, focusable: 'false' },
        h('path', { d: 'M6 3.5 10.5 8 6 12.5' }))
    }

    /** Full-size viewer for one screenshot, portaled over the transcript. */
    function ScreenshotLightbox({ src, label, closeLabel, onClose }) {
      const closeRef = React.useRef(null)
      const restoreRef = React.useRef(null)
      React.useEffect(() => {
        restoreRef.current = document.activeElement
        closeRef.current?.focus()
        const previousOverflow = document.body.style.overflow
        document.body.style.overflow = 'hidden'
        const onKeyDown = (event) => {
          if (event.key === 'Escape') onClose()
        }
        document.addEventListener('keydown', onKeyDown)
        return () => {
          document.removeEventListener('keydown', onKeyDown)
          document.body.style.overflow = previousOverflow
          const previous = restoreRef.current
          if (previous !== null && typeof previous.focus === 'function') previous.focus()
        }
      }, [onClose])
      return ReactDOM.createPortal(
        h('div',
          {
            className: 'dsh-chrome-shot-lightbox',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': label,
            onClick: onClose,
          },
          h('img', {
            className: 'dsh-chrome-shot-lightbox-image',
            src,
            alt: label,
            onClick: (event) => event.stopPropagation(),
          }),
          h('button', {
            ref: closeRef,
            type: 'button',
            className: 'dsh-chrome-shot-lightbox-close',
            'aria-label': closeLabel,
            title: closeLabel,
            onClick: onClose,
          },
          h('span', { 'aria-hidden': true }, '×'),
          h('span', null, closeLabel))),
        document.body,
      )
    }

    /**
     * One durable image: load its Gateway-authorized URL, then show the frame
     * with a loading placeholder and a retry control on failure.
     */
    function ScreenshotImage({ attachment, loadImage, t }) {
      const attachmentId = attachment.attachmentId
      const peek = () => {
        try {
          return typeof loadImage.peek === 'function' ? (loadImage.peek(attachment) ?? null) : null
        } catch {
          return null
        }
      }
      const [url, setUrl] = React.useState(peek)
      const [failed, setFailed] = React.useState(false)
      const [attempt, setAttempt] = React.useState(0)
      const [open, setOpen] = React.useState(false)
      const label = attachment.name ?? t('screenshot.imageAlt')

      React.useEffect(() => {
        let live = true
        setFailed(false)
        setUrl(peek())
        Promise.resolve()
          .then(() => loadImage(attachment))
          .then((next) => {
            if (live) setUrl(next)
          })
          .catch(() => {
            if (live) setFailed(true)
          })
        return () => {
          live = false
        }
        // The identity of the stored image is its attachment id; a re-rendered
        // block carrying the same id must not restart the load.
      }, [attachmentId, loadImage, attempt])

      const close = React.useCallback(() => setOpen(false), [])
      const frame = failed
        ? h('div', { className: 'dsh-chrome-shot-placeholder' },
          h('span', null,
            t('screenshot.loadFailed'),
            ' ',
            h('button', {
              type: 'button',
              className: 'dsh-chrome-shot-retry',
              onClick: () => setAttempt(value => value + 1),
            }, t('screenshot.retry'))))
        : url === null
          ? h('div', { className: 'dsh-chrome-shot-placeholder' }, t('screenshot.loading'))
          : h('button', {
            type: 'button',
            className: 'dsh-chrome-shot-frame',
            title: t('screenshot.open'),
            'aria-label': t('screenshot.open'),
            onClick: () => setOpen(true),
          }, h('img', { src: url, alt: label }))

      return h(React.Fragment, null,
        frame,
        open && url !== null
          ? h(ScreenshotLightbox, { src: url, label, closeLabel: t('screenshot.close'), onClose: close })
          : null)
    }

    /** One screenshot call: summary row plus the result-side image card. */
    function ScreenshotRow(props) {
      const { block, useDisclosure, loadImage, toolName, t } = props
      const { expanded, toggle } = useDisclosure()
      const model = screenshotModel(block, t)
      const open = expanded && model.expandable
      const onKeyDown = (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          toggle()
        }
      }
      const meta = model.images
        .map((attachment) => t('screenshot.summary', {
          width: attachment.width,
          height: attachment.height,
          size: formatBytes(attachment.bytes),
        }))
        .join('\n')

      return h('div', {
        className: 'dsh-chrome-shot',
        'data-chrome-shot': true,
        'data-tool': toolName,
        'data-state': model.state,
      },
        h('div',
          {
            className: 'dsh-chrome-shot-row',
            'data-expandable': String(model.expandable),
            role: model.expandable ? 'button' : undefined,
            tabIndex: model.expandable ? 0 : undefined,
            'aria-expanded': model.expandable ? String(open) : undefined,
            onClick: model.expandable ? toggle : undefined,
            onKeyDown: model.expandable ? onKeyDown : undefined,
          },
          h('span', { className: 'dsh-chrome-shot-leading', 'aria-hidden': true },
            h('span', { className: 'dsh-chrome-shot-icon' }, h(BrowserGlyph)),
            model.expandable ? h('span', { className: 'dsh-chrome-shot-chevron' }, h(ChevronGlyph)) : null),
          h('span', { className: 'dsh-chrome-shot-title' }, t('screenshot.title')),
          h('span', { className: 'dsh-chrome-shot-sep', 'aria-hidden': true }),
          h('span', {
            className: 'dsh-chrome-shot-summary',
            'data-error': model.state === 'error' ? 'true' : undefined,
            title: model.summary,
          }, model.summary)),
        model.state === 'running'
          ? h('span', { className: 'dsh-chrome-shot-sr' }, t('screenshot.runningStatus'))
          : null,
        open
          ? h('div', { className: 'dsh-chrome-shot-body' },
            model.images.length > 0
              ? h('div', { className: 'dsh-chrome-shot-gallery' },
                model.images.map((attachment, index) => h(ScreenshotImage, {
                  key: `${attachment.attachmentId}:${index}`,
                  attachment,
                  loadImage,
                  t,
                })))
              : null,
            model.images.length > 0 ? h('div', { className: 'dsh-chrome-shot-meta' }, meta) : null,
            model.text !== ''
              ? h('div', {
                className: 'dsh-chrome-shot-text',
                'data-error': model.state === 'error' ? 'true' : undefined,
              }, model.text)
              : null)
          : null)
    }

    /**
     * Register the screenshot row and its dictionaries.
     * @param ctx - browser plugin context with the Slot registry and locale service.
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, DICTIONARIES), 'chrome-mcp: dictionaries')

      ctx.effect(() => {
        const tag = document.createElement('style')
        tag.dataset.plugin = '@local/dsh-chrome-mcp'
        tag.textContent = CSS
        document.head.appendChild(tag)
        return () => {
          tag.remove()
        }
      }, 'chrome-mcp: screenshot styles')

      ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
        name: 'tool.call.toolview',
        key: SCREENSHOT_TOOL,
        locale: NS,
      }, ScreenshotRow))
    }

    return {
      inject: ['slots', 'locale'],
      apply,
    }
  },
})
