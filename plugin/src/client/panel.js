// OLAP 面板：右侧栏 tab 的正文。
// 结构：SQL 标签条 + 工具栏 + [库表/收藏树 | 编辑器 + 结果区] + 各类弹窗/菜单 + toast。
// 会话身份直接来自 slot standard props 的 sessionId（不再轮询 sessions.current）。
// 面板注册/关闭、可见性、全屏由 DSH 右侧栏负责；这里只做面板内容与 per-session 持久化。
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { h, toArray } from './util.js'
import { callHost } from './rpc.js'
import {
  useStore, getStore, emitStore, showToast, activeTab,
  wsMetaFor, wsLoad, wsApplyToStore, wsScheduleSave, wsNextTabId, wsNoteFile,
  uploadPanelState, schedulePanelUpload, sessionRows, sessionEnabledFor,
} from './store.js'
import {
  loadDatasources, loadCollect, loadHistory, loadDownloads, collectRefresh,
} from './resources.js'
import { doRun, killRun, downloadSimple } from './run.js'
import { referTab } from './refer.js'
import { SqlEditor } from './editor.js'
import { SchemaTree, CollectTree, CollectMenu, SchemaMenu, CollectSaveModal } from './tree.js'
import { ResultView, HistoryView, DownloadView, DownloadDetailModal, renderLog } from './results.js'
import {
  ParamModal, SessionParamModal, AccountManageModal, AccountSel, DlgModal,
} from './modals.js'

// ---------- 图标（内联 SVG，currentColor） ----------
function icon(paths) {
  return h('svg', { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
    paths.map(function (p, i) { return h('path', Object.assign({ key: i, stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round' }, p)) }))
}
const IconRun = function () { return icon([{ d: 'M5 3.5v9l7-4.5z', fill: 'currentColor', stroke: 'none' }]) }
const IconStop = function () { return icon([{ d: 'M4.5 4.5h7v7h-7z', fill: 'currentColor', stroke: 'none' }]) }
const IconFormat = function () { return icon([{ d: 'M2.5 4h11M2.5 8h7M2.5 12h9' }, { d: 'M12 7l1.5 1-1.5 1' }]) }
const IconFind = function () { return icon([{ d: 'M7 2.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9z' }, { d: 'M10.4 10.4L14 14' }]) }
const IconSave = function () { return icon([{ d: 'M3 3h8l2 2v8H3z' }, { d: 'M5.5 3v3h5V3M5.5 9.5h5v3.5h-5z' }]) }
const IconDownload = function () { return icon([{ d: 'M8 2.5v7M5 7l3 3 3-3' }, { d: 'M3 12.5h10' }]) }
const IconTable = function () { return icon([{ d: 'M2.5 3.5h11v9h-11z' }, { d: 'M2.5 6.5h11M6 3.5v9' }]) }
const IconParam = function () { return icon([{ d: 'M3 5h3.5M3 11h3.5M9 5h4M9 11h4M6.5 3.5v9' }]) }
const IconSession = function () { return icon([{ d: 'M4 3h8v10H4z' }, { d: 'M6 6h4M6 8.5h4' }]) }

// ---------- 工具栏按钮 ----------
function ToolButton(props) {
  return h('button', {
    type: 'button',
    className: 'yh-olap-fbtn' + (props.primary ? ' primary' : '') + (props.active ? ' active' : ''),
    title: props.title || props.label,
    disabled: !!props.disabled,
    onClick: props.onClick,
  }, props.icon ? h(props.icon, null) : null, h('span', { className: 'lbl' }, props.label))
}

// ---------- SQL 标签条 ----------
function SqlTabsBar(props) {
  const { st, sid, bump } = props
  const addTab = function () {
    const base = activeTab(st)
    const nid = wsNextTabId(st)
    st.tabs.push({ id: nid, name: 'Tab' + nid, sql: '', engine: base ? base.engine : '2', dsId: base ? base.dsId : 2, params: {}, autoSave: true, bottomTab: 'result', running: false, executeId: '', finish: '', log: '', errMsg: '', result: null, wsFile: String(nid) })
    st.activeTab = nid
    wsNoteFile(st, String(nid))
    callHost('ws.workspace.save', { sessionId: sid, kind: 'sql', name: String(nid), content: '' })
    callHost('ws.workspace.save', { sessionId: sid, kind: 'params', name: String(nid), content: JSON.stringify({ __name: 'Tab' + nid }) })
    bump()
  }
  const removeTab = function (t) {
    const removeFiles = function () {
      const base = String(t.wsFile !== undefined && t.wsFile !== null ? t.wsFile : t.id)
      ;['sql', 'params'].forEach(function (k) {
        callHost('ws.workspace.remove', { sessionId: st.__id || sid, kind: k, name: base })
      })
      if (st.__wsKnownFiles) st.__wsKnownFiles.delete(base)
    }
    if (st.tabs.length <= 1) {
      removeFiles()
      const keepEngine = t.engine, keepDs = t.dsId
      st.tabs = []
      const nid = 1
      wsNoteFile(st, String(nid))
      st.tabs.push({ id: nid, name: 'Tab1', sql: '', engine: keepEngine || '2', dsId: keepDs || 2, params: {}, autoSave: true, bottomTab: 'result', running: false, executeId: '', finish: '', log: '', errMsg: '', result: null, wsFile: String(nid) })
      st.activeTab = nid
      callHost('ws.workspace.save', { sessionId: st.__id || sid, kind: 'sql', name: '1', content: '' })
      callHost('ws.workspace.save', { sessionId: st.__id || sid, kind: 'params', name: '1', content: JSON.stringify({ __name: 'Tab1' }) })
      bump()
      return
    }
    removeFiles()
    const i = st.tabs.indexOf(t)
    st.tabs.splice(i, 1)
    if (st.activeTab === t.id) st.activeTab = st.tabs[Math.max(0, i - 1)].id
    bump()
  }
  const startRename = function (t) { st.editingTab = t.id; st.editingName = t.name; bump() }
  const commitRename = function (t) {
    const nm = (st.editingName || '').trim()
    if (nm) t.name = nm
    st.editingTab = null; st.editingName = ''
    bump()
  }
  return h('div', { className: 'yh-olap-tabsbar' },
    h('div', { className: 'yh-olap-tabs-wrap' },
      st.tabs.map(function (t) {
        if (st.editingTab === t.id) {
          return h('input', {
            key: t.id, className: 'yh-olap-tab-inp', autoFocus: true, defaultValue: st.editingName,
            onChange: function (e) { st.editingName = e.target.value },
            onBlur: function () { commitRename(t) },
            onKeyDown: function (e) {
              if (e.key === 'Enter') commitRename(t)
              else if (e.key === 'Escape') { st.editingTab = null; bump() }
            },
          })
        }
        return h('span', {
          key: t.id,
          className: 'yh-olap-tab' + (t.id === st.activeTab ? ' on' : ''),
          onClick: function () { st.activeTab = t.id; bump() },
          onDoubleClick: function () { startRename(t) },
          onContextMenu: function (e) { e.preventDefault(); e.stopPropagation(); st.tabMenu = { tabId: t.id, x: e.clientX, y: e.clientY }; bump() },
          title: '自动保存，刷新/重开会话恢复；双击重命名，右键更多操作',
        }, t.name + (t.running ? ' ●' : ''),
          h('span', { className: 'tabx', onClick: function (e) { e.stopPropagation(); removeTab(t) }, title: '删除标签' }, '×'))
      }),
      h('button', { className: 'yh-olap-tab-add', onClick: addTab, title: '新建标签' }, '+')),
    h('div', { className: 'yh-olap-tabs-right' }, h(AccountSel, { st: st, sid: sid, bump: bump })),
    h(TabMenu, { st: st, bump: bump, onRename: startRename, onRemove: removeTab }))
}

function TabMenu(props) {
  const { st, bump, onRename, onRemove } = props
  const m = st.tabMenu
  useEffect(function () {
    if (!m) return
    const onDoc = function (e) {
      const el = document.querySelector('.yh-olap-tmenu')
      if (el && !el.contains(e.target)) { st.tabMenu = null; bump() }
    }
    document.addEventListener('mousedown', onDoc)
    return function () { document.removeEventListener('mousedown', onDoc) }
  }, [m])
  if (!m) return null
  const tab = st.tabs.find(function (x) { return x.id === m.tabId })
  const px = Math.min(m.x, window.innerWidth - 200)
  const py = Math.min(m.y, window.innerHeight - 130)
  const act = function (fn) { st.tabMenu = null; bump(); fn() }
  return createPortal(h('div', { className: 'yh-olap-tmenu', style: { left: px, top: py }, onMouseDown: function (e) { e.stopPropagation() }, onContextMenu: function (e) { e.preventDefault(); e.stopPropagation() } },
    h('div', { className: 'yh-olap-titem', onClick: function () { act(function () { if (tab) referTab(tab, st) }) } }, '引用（添加到聊天输入框）'),
    h('div', { className: 'yh-olap-titem', onClick: function () { act(function () { if (tab) onRename(tab) }) } }, '重命名'),
    h('div', { className: 'yh-olap-titem danger', onClick: function () { act(function () { if (tab) onRemove(tab) }) } }, '删除标签')), document.body)
}

// ---------- 工具栏 ----------
function Toolbar(props) {
  const { st, sid, bump, apiRef } = props
  const tab = activeTab(st)
  if (!tab) return null
  const dsOptions = st.datasources.map(function (d) {
    const en = { '1': 'hive', '2': 'impala', '3': 'ck', '4': 'doris' }[String(d.engine)] || String(d.engine)
    const label = String(d.name || '').toLowerCase().indexOf(en) >= 0 ? d.name : d.name + ' (' + en + ')'
    return h('option', { value: String(d.id), key: d.id }, label)
  })
  const api = function () { return apiRef.current || {} }
  return h('div', { className: 'yh-olap-func' },
    h('button', { className: 'yh-olap-tree-toggle' + (st.leftCollapsed ? '' : ' on'), title: st.leftCollapsed ? '显示库表/收藏' : '隐藏库表/收藏', onClick: function () { st.leftCollapsed = !st.leftCollapsed; bump() } }, h(IconTable, null)),
    h('select', {
      className: 'yh-olap-fsel',
      title: '数据源 / 引擎',
      value: String(tab.dsId),
      onChange: function (e) {
        const ds = st.datasources.find(function (d) { return String(d.id) === e.target.value })
        tab.dsId = Number(e.target.value)
        tab.engine = ds ? String(ds.engine) : tab.engine
        bump()
        loadDatasources(st, sid, bump)
      },
    }, dsOptions),
    h('span', { className: 'yh-olap-fgap' }),
    tab.running
      ? h(ToolButton, { primary: true, icon: IconStop, label: '停止', title: '停止当前查询', onClick: function () { killRun(st, sid, bump) } })
      : h(ToolButton, { primary: true, icon: IconRun, label: '执行', title: '执行（⌘/Ctrl+Enter；有选区只跑选区）', onClick: function () { doRun(st, sid, bump) } }),
    h(ToolButton, { icon: IconFormat, label: '格式化', title: '格式化 SQL（⌘/Ctrl+Alt+L）', onClick: function () { if (api().format) api().format() } }),
    h(ToolButton, { icon: IconFind, label: '查找', title: '查找替换（⌘/Ctrl+F）', onClick: function () { if (api().openSearch) api().openSearch() } }),
    h('span', { className: 'yh-olap-fgap' }),
    h(ToolButton, { icon: IconParam, label: '参数', title: '设置 SQL 的 ${} 参数', onClick: function () { st.paramModalFor = true; bump() } }),
    h(ToolButton, {
      icon: IconSession, label: 'Session', title: 'Session 参数（hive 虚拟参数；切到 hive 引擎后可用）',
      disabled: !sessionEnabledFor(tab),
      onClick: function () {
        if (!sessionEnabledFor(tab)) return
        st.sessionDraft = sessionRows(tab).map(function (r) { return { id: r.id, key: r.key, value: r.value, selected: !!r.selected } })
        st.sessionModalFor = true
        bump()
      },
    }),
    h('span', { className: 'yh-olap-fgap' }),
    h(ToolButton, {
      icon: IconSave, label: '保存', title: '保存到收藏：收藏标签更新原收藏，普通标签新建收藏',
      onClick: function () {
        const stab = activeTab(st)
        if (!stab) return
        const sql = stab.sql || ''
        if (!sql.trim()) { showToast(st, '当前无 SQL 可保存'); return }
        const paramsArr = Object.keys(stab.params || {}).map(function (k) { return { key: k, value: stab.params[k] } })
        if (stab.collectId) {
          callHost('olap.collect.update', { patch: { id: stab.collectId, querySql: sql } }).then(function (r) {
            if (r && r.ok) { showToast(st, '已更新收藏「' + (stab.name || '') + '」'); collectRefresh(st, sid, bump) }
            else showToast(st, '更新失败: ' + ((r && r.error) || '未知'))
          })
        } else {
          st.collectSaveName = stab.name || ''
          st.collectSaveFor = true
          bump()
        }
      },
    }),
    h(ToolButton, { icon: IconDownload, label: '下载', title: '全量下载当前 SQL 的完整结果', onClick: function () { downloadSimple(st, sid, bump) } }))
}

// ---------- 左栏（库表 / 收藏） ----------
function LeftArea(props) {
  const { st, sid, bump } = props
  const startDrag = function (e) {
    e.preventDefault()
    const startX = e.clientX
    const startW = st.leftWidth || 220
    const move = function (ev) {
      st.leftWidth = Math.max(140, Math.min(420, startW + (ev.clientX - startX)))
      bump()
    }
    const up = function () {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }
  return h('div', { className: 'yh-olap-left', style: { width: (st.leftWidth || 220) + 'px' } },
    h('div', { className: 'yh-olap-tabs2' },
      h('span', { className: st.leftTab === 'schema' ? 'on' : '', onClick: function () { st.leftTab = 'schema'; bump() } }, '库表'),
      h('span', { className: st.leftTab === 'collect' ? 'on' : '', onClick: function () { st.leftTab = 'collect'; loadCollect(st, sid, bump) } }, '收藏'),
      h('button', { className: 'yh-olap-left-close', title: '收起', onClick: function () { st.leftCollapsed = true; bump() } }, '×')),
    st.leftTab === 'schema' ? h(SchemaTree, { st: st, sid: sid, bump: bump }) : h(CollectTree, { st: st, sid: sid, bump: bump }),
    h('div', { className: 'yh-olap-resizer', onMouseDown: startDrag, title: '拖动调整宽度' }))
}

// ---------- 底栏 ----------
function BottomBar(props) {
  const { st, sid, bump } = props
  const tabs = [['log', '日志'], ['result', '结果'], ['history', '历史'], ['download', '下载']]
  const curTab = activeTab(st)
  const bt = (curTab && curTab.bottomTab) || 'result'
  const result = curTab && curTab.result
  const rows = result ? toArray(result.list).length : 0
  const total = result && result.total !== undefined ? result.total : rows
  return h('div', { className: 'yh-olap-bot' },
    h('div', { className: 'yh-olap-tabs yh-olap-bot-tabs' },
      tabs.map(function (tb) {
        return h('span', {
          key: tb[0],
          className: 'yh-olap-btab' + (bt === tb[0] ? ' on' : ''),
          onClick: function () {
            const t = activeTab(st)
            if (!t) return
            t.bottomTab = tb[0]
            if (tb[0] === 'history') loadHistory(st, sid, bump)
            if (tb[0] === 'download') loadDownloads(st, sid, bump)
            bump()
          },
        }, tb[1])
      }),
      curTab && curTab.running ? h('span', { className: 'yh-olap-bot-state run' }, '执行中…') : null,
      !curTab || !curTab.running
        ? h('span', { className: 'yh-olap-bot-state' + (curTab && curTab.finish === 'error' ? ' err' : '') },
          curTab && curTab.finish === 'error' ? '失败' : (result ? '结果 ' + total + ' 行' : (curTab && curTab.finish ? '完成' : '')))
        : null),
    h('div', { className: 'yh-olap-view' },
      bt === 'log' ? h('div', { className: 'yh-olap-log' }, renderLog(curTab))
        : bt === 'result' ? h(ResultView, { st: st, bump: bump })
          : bt === 'history' ? h(HistoryView, { st: st, sid: sid, bump: bump })
            : h(DownloadView, { st: st, sid: sid, bump: bump })))
}

// ---------- 命令队列（模型 write/run/stop 由面板轮询消费） ----------
function applyCommands(st, sid, cmds, bump) {
  let needsFlush = false
  const localBump = function () { bump(); needsFlush = true }
  for (const c of cmds) {
    if (c.type === 'write') {
      let tab = null
      if (c.newTab) {
        const base = activeTab(st)
        const nid = wsNextTabId(st)
        tab = { id: nid, name: 'Tab' + nid, sql: '', engine: base ? base.engine : '2', dsId: base ? base.dsId : 2, params: {}, autoSave: true, bottomTab: 'result', running: false, executeId: '', finish: '', log: '', errMsg: '', result: null, wsFile: String(nid) }
        wsNoteFile(st, String(nid))
        st.tabs.push(tab)
        st.activeTab = nid
      } else {
        tab = c.tabId ? st.tabs.find(function (t) { return t.id === c.tabId }) : null
        if (!tab) tab = activeTab(st)
      }
      if (tab) {
        let s = c.sql
        if (c.lines && Array.isArray(c.lines) && c.lines.length === 2) {
          const arr = (tab.sql || '').split('\n')
          const a = Math.max(1, Math.floor(c.lines[0]))
          const b = Math.min(arr.length, Math.floor(c.lines[1]))
          s = arr.slice(0, a - 1).concat(String(c.sql == null ? '' : c.sql).split('\n'), arr.slice(b)).join('\n')
        }
        if (s !== undefined && s !== null) {
          tab.sql = s
          wsScheduleSave(sid, 200)
        }
        localBump()
      }
    } else if (c.type === 'reflect') {
      const tab = c.tabId ? st.tabs.find(function (t) { return t.id === c.tabId }) : activeTab(st)
      if (tab) {
        tab.finish = 'done'
        tab.executeId = c.executeId
        if (c.log) tab.log = c.log
        tab.result = c.result || null
        localBump()
      }
    } else if (c.type === 'stop') {
      const tab = c.tabId ? st.tabs.find(function (t) { return t.id === c.tabId }) : activeTab(st)
      if (tab && tab.running) {
        tab.running = false
        tab.finish = 'cancel'
        tab.log = '已请求终止'
        if (tab.executeId) callHost('olap.kill', { requestId: tab.executeId, engine: tab.engine, dsId: tab.dsId })
        localBump()
      }
    }
  }
  if (needsFlush) {
    // 立即上传（绕过 300ms 节流）：模型 write 后马上 state 验证
    uploadPanelState(getStore(sid), sid)
  }
}

// ---------- 面板主体 ----------
export function OlapPanel(props) {
  const sid = props.sessionId || ''
  const st = useStore(sid)
  const rootRef = useRef(null)
  const apiRef = useRef(null)
  const [dark, setDark] = useState(function () {
    try { return document.body.hasAttribute('data-ds-dark-theme') } catch (e) { return false }
  })
  const [ready, setReady] = useState(false)
  const bump = function () {
    st.version++
    emitStore(sid)
    schedulePanelUpload(st, sid)
  }

  // 主题（DSH presenter 在 body 上切 data-ds-dark-theme）
  useEffect(function () {
    const read = function () {
      try { setDark(document.body.hasAttribute('data-ds-dark-theme')) } catch (e) { setDark(false) }
    }
    read()
    let mo = null
    try { mo = new MutationObserver(read); mo.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] }) } catch (e) {}
    return function () { if (mo) mo.disconnect() }
  }, [])

  // 会话初始化：恢复工作区 → 上传状态 → 拉数据源/收藏/账号 → 轮询命令
  useEffect(function () {
    if (!sid) return
    const s = getStore(sid)
    let alive = true
    const done = function () {
      if (!alive) return
      wsApplyToStore(getStore(sid), sid)
      uploadPanelState(getStore(sid), sid)
      setReady(true)
    }
    const wm = wsMetaFor(sid)
    if (wm.loaded) done()
    else wsLoad(done, sid)
    callHost('olap.accounts.list').then(function (r) {
      if (alive && r && r.ok) { s.accounts = r.accounts; s.currentAccount = r.current; emitStore(sid) }
    })
    loadDatasources(s, sid, bump)
    loadCollect(s, sid, bump)
    const stop = setInterval(function () {
      if (!alive) return
      uploadPanelState(getStore(sid), sid)
      callHost('olap.panel.poll', { sessionId: sid }).then(function (r) {
        if (!alive || !r || !r.ok || !r.commands || !r.commands.length) return
        applyCommands(getStore(sid), sid, r.commands, function () { getStore(sid).version++; emitStore(sid) })
      })
    }, 1500)
    return function () {
      alive = false
      clearInterval(stop)
      callHost('olap.panel.offline', { sessionId: sid })
    }
  }, [sid])

  const tab = activeTab(st)
  const editorRatio = Math.max(0.12, Math.min(0.92, st.editorRatio || 0.62))

  const startResize = function (downEv) {
    downEv.preventDefault()
    const splitEl = downEv.currentTarget.parentNode
    const move = function (ev) {
      const rect = splitEl.getBoundingClientRect()
      if (rect.height <= 0) return
      st.editorRatio = Math.max(0.12, Math.min(0.92, (ev.clientY - rect.top) / rect.height))
      emitStore(sid)
    }
    const up = function () {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  const portal = function (comp) { return comp ? createPortal(comp, document.body) : null }

  return h('div', { className: 'yh-olap-panel', ref: rootRef, 'data-yh-theme': dark ? 'dark' : 'light', 'data-yh-olap-root': '1' },
    h(SqlTabsBar, { st: st, sid: sid, bump: bump }),
    h(Toolbar, { st: st, sid: sid, bump: bump, apiRef: apiRef }),
    h('div', { className: 'yh-olap-body' },
      st.leftCollapsed ? null : h(LeftArea, { st: st, sid: sid, bump: bump }),
      h('div', { className: 'yh-olap-main' },
        h('div', { className: 'yh-olap-split', style: null },
          h('div', { className: 'yh-olap-editor-wrap', style: { flex: editorRatio * 10, minHeight: 60 } },
            tab ? h(SqlEditor, { st: st, sid: sid, bump: bump, dark: dark, onApi: function (a) { apiRef.current = a } }) : null,
            ready ? null : h('div', { className: 'yh-olap-loading' }, '正在恢复工作区…')),
          h('div', { className: 'yh-olap-resizer', onMouseDown: startResize, title: '拖动调整编辑器/结果高度' }),
          h('div', { className: 'yh-olap-bot', style: { flex: (1 - editorRatio) * 10 } }, h(BottomBar, { st: st, sid: sid, bump: bump }))))),
    portal(h(CollectSaveModal, { st: st, sid: sid, bump: bump })),
    portal(h(ParamModal, { st: st, sid: sid, bump: bump })),
    portal(h(SessionParamModal, { st: st, sid: sid, bump: bump })),
    portal(h(AccountManageModal, { st: st, sid: sid, bump: bump })),
    portal(h(DownloadDetailModal, { st: st, sid: sid, bump: bump })),
    portal(h(DlgModal, { st: st, sid: sid, bump: bump })),
    portal(h(CollectMenu, { st: st, sid: sid, bump: bump })),
    portal(h(SchemaMenu, { st: st, sid: sid, bump: bump })),
    st.toast ? h('div', { className: 'yh-olap-toast' }, st.toast) : null)
}
