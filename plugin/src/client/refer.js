// 编辑器选区引用 / 标签引用：把引用块插入聊天输入框（官方 InputActions）。
import { showToast } from './store.js'
import { copyToClipboard } from './util.js'

    function captureRefSpan(input) {
      try {
        const actions = input && input.actions
        if (actions && typeof actions.captureInsertion === 'function') {
          const span = actions.captureInsertion()
          if (span && typeof span.start === 'number' && typeof span.end === 'number') return span
        }
        const snap = input && input.state ? input.state.getSnapshot() : undefined
        const draft = (snap && snap.draft) || ''
        return { start: draft.length, end: draft.length, draftRev: snap ? snap.draftRev : 0 }
      } catch (e) { return null }
    }
    // 把文本追加到聊天输入框。
    // 0.1.7 起 composer 是 Lexical contenteditable（不再是 textarea），旧选择器 textarea[data-phase]
    // 恒不匹配；官方写法是 InputActions.insertText(text, span)（纯文本，由 lexicon 装饰成块）。
    // 旧 textarea 写法保留给 0.1.5 及更早。
    function fillComposer(text, input) {
      try {
        const actions = input && input.actions
        if (actions && typeof actions.insertText === 'function') {
          const span = captureRefSpan(input)
          if (span && actions.insertText(text, span) === true) return true
        }
      } catch (e) { /* 落到旧路径 */ }
      try {
        const ta = document.querySelector('textarea[data-phase]')
        if (!ta) return false
        const proto = window.HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : null
        const setter = proto && Object.getOwnPropertyDescriptor(proto, 'value')
        if (!setter || !setter.set) return false
        const cur = ta.value || ''
        setter.set.call(ta, cur ? cur + ' ' + text : text)
        ta.focus()
        ta.dispatchEvent(new Event('input', { bubbles: true }))
        return true
      } catch (e) { return false }
    }
    function referSelection(tab, selStart, selEnd, st) {
      if (!tab || selStart === undefined || selEnd === undefined || selEnd <= selStart) return false
      const sid = (st && st.__id) || null
      // 计算选中区间的逻辑起止行（1-based）
      const before = (tab.sql || '').slice(0, selStart)
      const lineStart = (before.match(/\n/g) || []).length + 1
      const selText = (tab.sql || '').slice(selStart, selEnd)
      // 选区以换行结尾（如整行选中含末尾 \n）时，结束行取最后非空内容行，避免多算一行
      const trimmed = selText.replace(/\n+$/, '')
      const lineEnd = lineStart + (trimmed.match(/\n/g) || []).length
      const rangeRef = 'olap' + tab.id + ':L' + lineStart + '-' + lineEnd
      // label 显示片段摘要（单行截断，块内可见）
      const firstLine = (selText.split('\n')[0] || '').trim()
      const label = '#' + tab.id + ' L' + lineStart + '-' + lineEnd + (firstLine ? ' 「' + (firstLine.length > 28 ? firstLine.slice(0, 28) + '…' : firstLine) + '」' : '')
      let done = false
      let input = null
      try {
        const conv = getService('conversation')
        const sessionsSvc = getService('sessions')
        if (conv && conv.input && sessionsSvc && sid && typeof sessionsSvc.scope === 'function') {
          const actx = sessionsSvc.scope(sid)
          input = actx ? conv.input.for(actx) : undefined
          const span = captureRefSpan(input)
          const reference = { source: 'olap', ref: rangeRef, label: label, clipboardText: '@' + rangeRef }
          if (input && span && typeof input.insertReference === 'function') {
            done = input.insertReference(reference, span) === true
          }
        }
      } catch (e) { done = false }
      if (done) { showToast(st, '已引用选中片段 ' + label + '（聊天框内显示为块）'); return true }
      // 兜底：纯文本引用
      const ref = '@' + rangeRef
      if (fillComposer(ref, input)) { showToast(st, '已添加选中片段引用 ' + ref); return true }
      else if (copyToClipboard(ref)) { showToast(st, '已复制 ' + ref + '，粘贴到聊天框即可（会显示为块）'); return true }
      return false
    }

    function referTab(t, st) {
      // ===== WORKSTATION: 引用插入真正的 occurrence 块（与 @olap 菜单 onPick 同款 ReferenceInsert）。
      // label 用标签名（任意文本，含中文/空格），块在 composer 中显示为 chip；
      // 提交时经 codec.serialize('olap'+id) 展开成 @olapN 给模型。
      // 不走旧的纯文本 + textRef 扫描路径：框架扫描正则只认 [\w-]+，中文名永远无法靠 lexicon 装饰成块。
      // =====
      const sid = (st && st.__id) || null
      let done = false
      let input = null
      try {
        const conv = getService('conversation')
        const sessionsSvc = getService('sessions')
        if (conv && conv.input && sessionsSvc && sid && typeof sessionsSvc.scope === 'function') {
          const actx = sessionsSvc.scope(sid)
          input = actx ? conv.input.for(actx) : undefined
          const span = captureRefSpan(input)
          const reference = { source: 'olap', ref: 'olap' + t.id, label: t.name || ('Tab' + t.id), clipboardText: '@olap' + t.id }
          if (input && span && typeof input.insertReference === 'function') {
            done = input.insertReference(reference, span) === true
          }
        }
      } catch (e) { done = false }
      if (done) { showToast(st, '已添加标签引用 @' + (t.name || ('Tab' + t.id)) + '（聊天框内显示为块）'); return }
      // 兜底：拿不到输入 shell / 正在提交不可插入时，退回纯文本或复制
      const nm = /^[\w-]+$/.test(t.name || '') ? t.name : ('Tab' + t.id)
      const ref = '@' + nm
      if (fillComposer(ref, input)) showToast(st, '已添加标签引用 ' + ref + '（聊天框内显示为块）')
      else if (copyToClipboard(ref)) showToast(st, '已复制 ' + ref + '，粘贴到聊天框即可（会显示为块）')
      else showToast(st, '复制失败，请手动输入：' + ref)
    }

export { captureRefSpan, fillComposer, referSelection, referTab }
