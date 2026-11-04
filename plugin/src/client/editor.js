// CodeMirror 6 SQL 编辑器
//
// 能力：按引擎（hive/impala/ck/doris）的语法高亮、关键字/函数/库/表/字段/别名补全、
// 悬浮字段注释、查找替换（CM search）、多光标、折叠、括号匹配、格式化、执行选区、${var} 高亮。
//
// 关键设计：
// - 一个 EditorView；切 SQL 标签用 per-(session,tab) 的 EditorState 缓存恢复（撤销栈/选区/滚动保留）。
// - 引擎切换用 Compartment 热替换 dialect，不重建视图、不丢内容。
// - tab.sql 是唯一事实源：docChanged → 立即写 tab.sql + 800ms 自动落盘；
//   外部写入（模型 write / 历史插入 / 收藏打开）由 props.sql 变化触发一次 dispatch 同步。
import { useEffect, useRef } from 'react'
import { EditorState, Compartment, Prec } from '@codemirror/state'
import {
  EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter,
  highlightSpecialChars, drawSelection, dropCursor, rectangularSelection, crosshairCursor,
  hoverTooltip, ViewPlugin, Decoration, tooltips,
} from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { bracketMatching, foldGutter, foldKeymap, indentOnInput, syntaxHighlighting, HighlightStyle } from '@codemirror/language'
import { closeBrackets, closeBracketsKeymap, autocompletion, completionKeymap, completionStatus, acceptCompletion } from '@codemirror/autocomplete'
import { search, searchKeymap, openSearchPanel, selectNextOccurrence, highlightSelectionMatches } from '@codemirror/search'
import { sql, SQLDialect } from '@codemirror/lang-sql'
import { tags } from '@lezer/highlight'

import { engineWords } from '../sql/engine-words.js'
import { buildCandidates, inputChain, aliasTableMap } from '../sql/completion-core.js'
import { formatSql } from './format.js'
import { activeTab, wsScheduleSave, showToast } from './store.js'
import { loadColumns } from './resources.js'
import { doRun } from './run.js'
import { h } from './util.js'

// ---------- 引擎 dialect ----------
const dialectCache = new Map()
function makeDialect(engine) {
  const key = String(engine || '')
  if (dialectCache.has(key)) return dialectCache.get(key)
  const w = engineWords(key)
  const kw = []
  w.keywords.forEach(function (k) { String(k).split(/\s+/).forEach(function (x) { if (x) kw.push(x.toLowerCase()) }) })
  const d = SQLDialect.define({
    keywords: Array.from(new Set(kw)).join(' '),
    builtin: w.functions.join(' '),
    types: w.types.join(' '),
    slashComments: true,
    hashComments: false,
    spaceAfterDashes: false,
    backslashEscapes: true,
    doubleQuotedStrings: false,
    identifierQuotes: '"',
    specialVar: '',
    caseInsensitiveIdentifiers: false,
  })
  dialectCache.set(key, d)
  return d
}
function sqlLang(engine) { return sql({ dialect: makeDialect(engine) }) }

// ---------- 主题 ----------
const baseTheme = EditorView.theme({
  // 注意：'&' 的规则类会被 CodeMirror 的 tooltip 容器（tooltips({parent:document.body}) 时
  // 追加到 body 的 div）复用；这里**不能**写任何尺寸规则（尤其 height:100%），否则该 div
  // 会撑出视口、让整个 DSH 页面出现滚动条（历史 bug）。尺寸由 styles.css 的
  // `.yh-olap-cm-host .cm-editor{height:100%}` 负责。
  '&': { backgroundColor: 'transparent', color: 'var(--dsw-alias-label-primary)' },
  '.cm-content': { caretColor: 'var(--dsw-alias-label-primary)', fontFamily: 'var(--dsh-font-family-code-default, ui-monospace, Menlo, Consolas, monospace)', padding: '6px 0' },
  '.cm-scroller': { fontFamily: 'var(--dsh-font-family-code-default, ui-monospace, Menlo, Consolas, monospace)', lineHeight: '1.62' },
  '.cm-gutters': { backgroundColor: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-tertiary)', border: 'none', paddingRight: '4px' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--dsw-alias-bg-layer-3)', color: 'var(--dsw-alias-label-secondary)' },
  '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--dsw-alias-label-primary) 5%, transparent)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': { backgroundColor: 'color-mix(in srgb, var(--dsw-alias-brand-primary) 30%, transparent) !important' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--dsw-alias-brand-primary)' },
  '&.cm-focused .cm-matchingBracket': { backgroundColor: 'color-mix(in srgb, var(--dsw-alias-brand-primary) 24%, transparent)', outline: '1px solid var(--dsw-alias-brand-primary)' },
  '.cm-searchMatch': { backgroundColor: 'color-mix(in srgb, var(--dsw-alias-brand-primary) 20%, transparent)' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'color-mix(in srgb, var(--dsw-alias-brand-primary) 48%, transparent)' },
  '.cm-panels': { backgroundColor: 'var(--dsw-alias-bg-overlay)', color: 'var(--dsw-alias-label-primary)', borderTop: '1px solid var(--dsw-alias-border-l1)' },
  '.cm-panel.cm-search': { padding: '5px 8px' },
  '.cm-textfield': { backgroundColor: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '6px', padding: '2px 6px' },
  '.cm-button': { backgroundColor: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)', border: '1px solid var(--dsw-alias-border-l2)', backgroundImage: 'none', borderRadius: '6px' },
  '.cm-tooltip': { backgroundColor: 'var(--dsw-alias-bg-overlay)', color: 'var(--dsw-alias-label-primary)', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '8px', boxShadow: '0 6px 20px rgba(0,0,0,.35)' },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'var(--dsw-alias-brand-primary)', color: '#fff' },
})
const highlightStyle = HighlightStyle.define([
  { tag: tags.keyword, color: 'var(--yh-k)' },
  { tag: tags.typeName, color: 'var(--yh-t)' },
  { tag: tags.standard(tags.name), color: 'var(--yh-f)' },
  { tag: tags.string, color: 'var(--yh-s)' },
  { tag: tags.number, color: 'var(--yh-n)' },
  { tag: [tags.bool, tags.null], color: 'var(--yh-n)' },
  { tag: tags.lineComment, color: 'var(--yh-c)', fontStyle: 'italic' },
  { tag: tags.blockComment, color: 'var(--yh-c)', fontStyle: 'italic' },
  { tag: tags.operator, color: 'var(--yh-x)' },
  { tag: tags.variableName, color: 'var(--yh-i)' },
  { tag: tags.special(tags.string), color: 'var(--yh-i)' },
])

// ---------- ${var} 参数高亮 ----------
const paramMark = Decoration.mark({ class: 'yh-cm-param' })
function buildParamDeco(view) {
  const ranges = []
  const re = /\$\{[^}]*\}/g
  for (const range of view.visibleRanges) {
    const text = view.state.doc.sliceString(range.from, range.to)
    let m
    while ((m = re.exec(text))) ranges.push(paramMark.range(range.from + m.index, range.from + m.index + m[0].length))
  }
  return Decoration.set(ranges, true)
}
const paramHighlight = ViewPlugin.fromClass(class {
  constructor(view) { this.decorations = buildParamDeco(view) }
  update(u) { if (u.docChanged || u.viewportChanged) this.decorations = buildParamDeco(u.view) }
}, { decorations: function (v) { return v.decorations } })

// ---------- store 数据 → completion 输入 ----------
function schemasOf(st, tab) {
  const key = String(tab && tab.dsId)
  return ((st.schemas && st.schemas[key]) || []).map(function (s) { return { name: s.name } })
}
function tablesOf(st, tab) {
  const ds = String(tab && tab.dsId)
  const out = []
  const schemaList = (st.schemas && st.schemas[ds]) || []
  Object.keys(st.tables || {}).forEach(function (k) {
    if (k.indexOf(ds + '/') !== 0) return
    const rec = st.tables[k]
    if (!rec || !rec.list) return
    const schemaId = k.split('/')[1]
    const sch = schemaList.find(function (s) { return String(s.id) === schemaId })
    rec.list.forEach(function (t) {
      out.push({ schema: sch ? sch.name : schemaId, name: t.name, schemaId: t.schemaId, tableId: t.tableId })
    })
  })
  return out
}
function columnsOf(st, tab, tables) {
  const out = []
  Object.keys(st.columns || {}).forEach(function (k) {
    const rec = st.columns[k]
    if (!rec || !rec.columns) return
    const parts = k.split('/')
    const tbl = tables.find(function (t) { return String(t.schemaId) === parts[0] && String(t.tableId) === parts[1] })
    if (!tbl) return
    rec.columns.forEach(function (c) {
      out.push({ schema: tbl.schema, table: tbl.name, name: c.name, comment: c.comment, cnName: c.cnName, type: c.type })
    })
  })
  return out
}
function ensureColumnsLoaded(st, sid, tab, sql) {
  if (!tab) return
  const tables = tablesOf(st, tab)
  const amap = aliasTableMap(sql)
  const todo = []
  Object.keys(amap).forEach(function (alias) {
    const a = amap[alias]
    const hit = tables.find(function (t) {
      if (String(t.name).toLowerCase() !== String(a.table || '').toLowerCase()) return false
      if (a.schema && String(t.schema).toLowerCase() !== String(a.schema).toLowerCase()) return false
      return true
    })
    if (!hit) return
    const key = String(hit.schemaId) + '/' + String(hit.tableId)
    if (!(st.columns && st.columns[key])) todo.push(hit)
  })
  todo.slice(0, 6).forEach(function (hit) {
    loadColumns(st, sid, tab.engine, hit.schemaId, hit.tableId, function () {})
  })
}
function completionOptions(st, sid, tab, state, pos, explicit) {
  const before = state.doc.sliceString(0, pos)
  const word = (/[\w$.\u4e00-\u9fa5]*$/.exec(before) || [''])[0]
  if (!word && !explicit) return null
  ensureColumnsLoaded(st, sid, tab, state.doc.toString())
  const tables = tablesOf(st, tab)
  const items = buildCandidates({
    engine: tab.engine,
    sql: state.doc.toString(),
    before: before,
    schemas: schemasOf(st, tab),
    tables: tables,
    columns: columnsOf(st, tab, tables),
  })
  if (!items.length) return null
  const typeOf = { kw: 'keyword', fn: 'function', tbl: 'type', sch: 'namespace', col: 'property', alias: 'variable' }
  const detailOf = { tbl: '表', col: '字段', fn: '函数', sch: '库', alias: '别名', kw: '关键字' }
  return {
    from: pos - word.length,
    filter: false,
    options: items.map(function (it) {
      const opt = {
        label: it.text,
        type: typeOf[it.kind] || 'text',
        detail: it.detail || detailOf[it.kind] || '',
        boost: 100 - items.indexOf(it) * 0.01,
      }
      if (it.kind === 'fn') {
        opt.apply = function (view, completion, from, to) {
          view.dispatch({
            changes: { from: from, to: to, insert: it.text + '()' },
            selection: { anchor: from + it.text.length + 1 },
          })
        }
      }
      return opt
    }),
  }
}

// ---------- 悬浮信息 ----------
function makeHoverTooltip(propsRef) {
  return hoverTooltip(function (view, pos) {
    try {
      const p = propsRef.current
      const tab = activeTab(p.st)
      if (!tab) return null
      const line = view.state.doc.lineAt(pos)
      const text = line.text
      let s = pos - line.from
      let e = s
      while (s > 0 && /[\w$\u4e00-\u9fa5]/.test(text[s - 1])) s--
      while (e < text.length && /[\w$\u4e00-\u9fa5]/.test(text[e])) e++
      const word = text.slice(s, e)
      if (!word) return null
      const lower = word.toLowerCase()
      const w = engineWords(tab.engine)
      if (w.functions.indexOf(lower) >= 0) {
        return { pos: line.from + s, end: line.from + e, create: function () { return { dom: makeTip('函数 · ' + word + ' · ' + engineLabel(tab.engine)) } } }
      }
      if (w.keywords.some(function (k) { return k.toLowerCase() === lower })) return null
      const st = p.st
      const tables = tablesOf(st, tab)
      const cols = columnsOf(st, tab, tables)
      const hit = cols.find(function (c) { return String(c.name).toLowerCase() === lower })
      if (!hit) return null
      const head = [hit.name, hit.type].filter(Boolean).join('  ·  ')
      const cmt = hit.cnName || hit.comment || ''
      return { pos: line.from + s, end: line.from + e, create: function () { return { dom: makeTip(head + (cmt ? '\n' + cmt : '')) } } }
    } catch (e2) { return null }
  })
}
function makeTip(text) {
  const el = document.createElement('div')
  el.className = 'yh-cm-hover'
  el.textContent = text
  return el
}
function engineLabel(engine) {
  const e = String(engine)
  return e === '1' ? 'hive' : e === '2' ? 'impala' : e === '3' ? 'ck' : e === '4' ? 'doris' : 'sql'
}

// ---------- per-tab 状态缓存 ----------
const stateCache = new Map()
function cacheKey(sid, tabId) { return String(sid) + '|' + String(tabId) }

// ---------- React 组件 ----------
export function SqlEditor(props) {
  const hostRef = useRef(null)
  const statusRef = useRef(null)
  const viewRef = useRef(null)
  const propsRef = useRef(props)
  propsRef.current = props
  const bumpTimer = useRef(null)
  const prevRef = useRef({ sid: props.sid, tabId: 0 })

  const comps = useRef({ dialect: new Compartment(), theme: new Compartment() }).current
  const tab = activeTab(props.st)
  const tabId = tab ? tab.id : 0
  const sql = tab ? tab.sql : ''
  const engine = tab ? String(tab.engine) : '2'

  function currentTab() { return activeTab(propsRef.current.st) }

  function buildExtensions(initialEngine, initialDark) {
    const runKey = {
      key: 'Mod-Enter',
      run: function (view) {
        const p = propsRef.current
        const t = currentTab()
        if (!t) return false
        const sel = view.state.selection.main
        const selText = sel && !sel.empty ? view.state.sliceDoc(sel.from, sel.to) : ''
        doRun(p.st, p.sid, p.bump, null, selText)
        return true
      },
    }
    const formatKey = {
      key: 'Mod-Alt-l',
      run: function (view) {
        const p = propsRef.current
        const t = currentTab()
        if (!t) return false
        const src = view.state.doc.toString()
        const out = formatSql(src)
        if (out === src) { showToast(p.st, 'SQL 无需调整或暂不支持解析'); return true }
        view.dispatch({ changes: { from: 0, to: src.length, insert: out } })
        wsScheduleSave(p.sid, 200)
        showToast(p.st, '已格式化')
        return true
      },
    }
    const commentKey = {
      key: 'Mod-/',
      run: function (view) {
        const sel = view.state.selection.main
        const first = view.state.doc.lineAt(sel.from)
        const last = view.state.doc.lineAt(sel.to)
        const lines = []
        for (let n = first.number; n <= last.number; n++) lines.push(view.state.doc.line(n))
        const allCommented = lines.every(function (l) { return /^\s*--/.test(l.text) })
        const changes = lines.map(function (l) {
          if (allCommented) {
            const idx = l.text.indexOf('--')
            return { from: l.from + idx, to: l.from + idx + 2, insert: '' }
          }
          return { from: l.from, to: l.from, insert: '-- ' }
        })
        view.dispatch({ changes: changes })
        return true
      },
    }
    const source = async function (context) {
      const p = propsRef.current
      const t = currentTab()
      if (!t) return null
      try { return completionOptions(p.st, p.sid, t, context.state, context.pos, context.explicit) } catch (e) { return null }
    }
    // Tab：补全弹层打开时接受当前选中项（主流 SQL 编辑器习惯）；未打开时返回 false，
    // 继续走下面的 indentWithTab（缩进 / Shift-Tab 反缩进）。
    const tabKey = {
      key: 'Tab',
      run: function (view) {
        if (completionStatus(view.state) !== 'active') return false
        acceptCompletion(view)
        return true
      },
    }
    return [
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightSpecialChars(),
      history(),
      foldGutter(),
      drawSelection(),
      dropCursor(),
      EditorState.allowMultipleSelections.of(true),
      indentOnInput(),
      bracketMatching(),
      closeBrackets(),
      autocompletion({ override: [source], activateOnTyping: true, closeOnBlur: true, icons: false }),
      rectangularSelection(),
      crosshairCursor(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      search({ top: false }),
      tooltips({ parent: document.body }),
      paramHighlight,
      syntaxHighlighting(highlightStyle),
      baseTheme,
      makeHoverTooltip(propsRef),
      comps.theme.of(EditorView.theme({}, { dark: !!initialDark })),
      comps.dialect.of(sqlLang(initialEngine)),
      keymap.of([
        ...closeBracketsKeymap,
        ...defaultKeymap,
        ...searchKeymap,
        ...historyKeymap,
        ...foldKeymap,
        ...completionKeymap,
        indentWithTab,
        { key: 'Mod-d', run: selectNextOccurrence },
      ]),
      Prec.highest(keymap.of([runKey, formatKey, commentKey, tabKey])),
      EditorView.lineWrapping,
      EditorView.updateListener.of(function (u) {
        if (u.docChanged) onDocChanged(u.view)
        if (u.selectionSet || u.docChanged) updateStatus(u.view, statusRef.current)
      }),
    ]
  }

  function onDocChanged(view) {
    const p = propsRef.current
    const t = currentTab()
    if (!t) return
    t.sql = view.state.doc.toString()
    wsScheduleSave(p.sid, 800)
    if (bumpTimer.current) clearTimeout(bumpTimer.current)
    bumpTimer.current = setTimeout(function () { if (propsRef.current.bump) propsRef.current.bump() }, 250)
  }

  // 创建视图（仅一次；StrictMode 双挂载时缓存/销毁安全）
  useEffect(function () {
    const host = hostRef.current
    if (!host) return
    const p = propsRef.current
    const t0 = currentTab()
    const key = cacheKey(p.sid, t0 ? t0.id : 0)
    const cached = stateCache.get(key)
    const startDoc = (cached && cached.state.doc.toString() === (t0 ? t0.sql : '')) ? cached.state : EditorState.create({ doc: t0 ? t0.sql : '', extensions: buildExtensions(engine, props.dark) })
    const view = new EditorView({ state: startDoc, parent: host })
    viewRef.current = view
    prevRef.current = { sid: p.sid, tabId: t0 ? t0.id : 0 }
    if (cached) { try { view.scrollDOM.scrollTop = cached.top || 0; view.scrollDOM.scrollLeft = cached.left || 0 } catch (e) {} }
    updateStatus(view, statusRef.current)
    if (p.onApi) p.onApi({
      openSearch: function () { openSearchPanel(view) },
      format: function () { formatKeyRun(view) },
      focus: function () { view.focus() },
      getView: function () { return view },
    })
    let ro = null
    try { ro = new ResizeObserver(function () { view.requestMeasure() }); ro.observe(host) } catch (e) {}
    return function () {
      if (bumpTimer.current) { clearTimeout(bumpTimer.current); bumpTimer.current = null }
      if (ro) { try { ro.disconnect() } catch (e) {} }
      const cur = currentTab()
      if (cur) stateCache.set(cacheKey(propsRef.current.sid, cur.id), { state: view.state, top: view.scrollDOM.scrollTop, left: view.scrollDOM.scrollLeft })
      if (propsRef.current.onApi) propsRef.current.onApi(null)
      try { view.destroy() } catch (e) {}
      viewRef.current = null
    }
  }, [])

  // 切标签：保存旧 tab 状态 → 恢复缓存/新建
  useEffect(function () {
    const view = viewRef.current
    if (!view) return
    const prev = prevRef.current
    if (prev.tabId !== tabId || prev.sid !== props.sid) {
      stateCache.set(cacheKey(prev.sid, prev.tabId), { state: view.state, top: view.scrollDOM.scrollTop, left: view.scrollDOM.scrollLeft })
    }
    prevRef.current = { sid: props.sid, tabId: tabId }
    const cached = stateCache.get(cacheKey(props.sid, tabId))
    if (cached && cached.state.doc.toString() === sql) {
      view.setState(cached.state)
      try { view.scrollDOM.scrollTop = cached.top || 0; view.scrollDOM.scrollLeft = cached.left || 0 } catch (e) {}
    } else {
      view.setState(EditorState.create({ doc: sql, extensions: buildExtensions(engine, props.dark) }))
    }
    try { view.focus() } catch (e) {}
    updateStatus(view, statusRef.current)
  }, [props.sid, tabId])

  // 外部写入（模型 / 历史 / 收藏）同步进 doc
  useEffect(function () {
    const view = viewRef.current
    if (!view) return
    const cur = view.state.doc.toString()
    if (cur === sql) return
    try {
      view.dispatch({
        changes: { from: 0, to: cur.length, insert: sql },
        selection: { anchor: Math.min(view.state.selection.main.head, sql.length) },
      })
    } catch (e) {}
  }, [sql])

  // 引擎切换：热替换 dialect
  useEffect(function () {
    const view = viewRef.current
    if (!view) return
    view.dispatch({ effects: comps.dialect.reconfigure(sqlLang(engine)) })
  }, [engine])

  // 主题切换
  useEffect(function () {
    const view = viewRef.current
    if (!view) return
    view.dispatch({ effects: comps.theme.reconfigure(EditorView.theme({}, { dark: !!props.dark })) })
  }, [props.dark])

  return h('div', { className: 'yh-olap-cm-wrap' },
    h('div', { className: 'yh-olap-cm-host', ref: hostRef }),
    h('div', { className: 'yh-olap-cm-status', ref: statusRef }, '行 1, 列 1'))
}

function formatKeyRun(view) {
  const src = view.state.doc.toString()
  const out = formatSql(src)
  if (out === src) return
  view.dispatch({ changes: { from: 0, to: src.length, insert: out } })
}

function updateStatus(view, el) {
  if (!el) return
  const sel = view.state.selection.main
  const line = view.state.doc.lineAt(sel.head)
  const col = sel.head - line.from + 1
  const selN = sel.empty ? 0 : Math.abs(sel.to - sel.from)
  el.textContent = '行 ' + line.number + ', 列 ' + col + (selN ? ' · 选中 ' + selN + ' 字符' : '') + ' · ' + view.state.doc.lines + ' 行'
}
