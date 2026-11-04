// 左栏数据树：库表清单（库/表/字段 + 右键复制）与收藏树（目录/收藏 + 右键菜单）、
// 以及「保存到收藏」弹窗。组件 props 沿用旧签名（{ st, sid, bump }），状态全部在 per-session store。
import { useState, useEffect, useRef } from 'react'
import { h, toArray, copyToClipboard } from './util.js'
import { callHost } from './rpc.js'
import { showToast, activeTab, wsNextTabId, wsNoteFile } from './store.js'
import { loadTables, loadColumns, collectRefresh, collectNewDir, collectRename, collectDelete } from './resources.js'

// ===== WORKSTATION: 收藏右键菜单（新建子目录/重命名/删除/刷新）=====
function CollectMenu(props) {
  const { st, sid, bump } = props
  // 菜单打开时监听 document 点击：点到菜单外即关闭（拾取焦点也关闭）
  // ===== hooks 必须在任何 early-return 之前（旧代码把 useEffect 写在 `if (!m) return null` 之后，
  // 菜单从关→开时 hook 数量 0→1，真 React 下会抛 Rendered more hooks…；此处上移，行为不变）=====
  useEffect(function () {
    const onDoc = function (e) {
      const el = document.querySelector('.yh-olap-cmenu')
      if (el && !el.contains(e.target)) { st.collectMenu = null; bump() }
    }
    document.addEventListener('mousedown', onDoc)
    return function () { document.removeEventListener('mousedown', onDoc) }
  }, [st.collectMenu])
  const m = st.collectMenu
  if (!m) return null
  const node = m.node
  const isDir = node.nodeType === 2
  const items = []
  const act = function (fn) { st.collectMenu = null; bump(); fn() }
  if (isDir) items.push({ label: '新建子目录', fn: function () { collectNewDir(st, bump, node.id, node.name) } })
  items.push({ label: '重命名', fn: function () { collectRename(st, bump, node) } })
  items.push({ label: '删除', fn: function () { collectDelete(st, bump, node) } })
  items.push({ label: '刷新', fn: function () { collectRefresh(st, sid, bump) } })
  const px = Math.min(m.x, window.innerWidth - 150)
  const py = Math.min(m.y, window.innerHeight - items.length * 30 - 10)
  return h('div', { className: 'yh-olap-cmenu', style: { left: px, top: py }, onMouseDown: function (e) { e.stopPropagation() }, onContextMenu: function (e) { e.preventDefault(); e.stopPropagation() } },
    items.map(function (it) {
      return h('div', { key: it.label, className: 'yh-olap-citem', onClick: function () { act(it.fn) } }, it.label)
    }))
}

// ===== WORKSTATION: 库表清单右键菜单 —— 复制库名/表名/字段名 =====
function SchemaMenu(props) {
  const { st, bump } = props
  // ===== hooks 必须在 early-return 之前（同 CollectMenu，旧代码 0→1 hooks 会崩）=====
  // 菜单打开时监听 document 点击：点到菜单外即关闭
  useEffect(function () {
    const onDoc = function (e) {
      const el = document.querySelector('.yh-olap-cmenu')
      if (el && !el.contains(e.target)) { st.schemaMenu = null; bump() }
    }
    document.addEventListener('mousedown', onDoc)
    return function () { document.removeEventListener('mousedown', onDoc) }
  }, [st.schemaMenu])
  const m = st.schemaMenu
  if (!m) return null
  const items = []
  const act = function (fn) { st.schemaMenu = null; bump(); fn() }
  const copyItem = function (label, text) {
    return { label: label, fn: function () {
      if (copyToClipboard(text)) showToast(st, '已复制 ' + text)
      else showToast(st, '复制失败')
    } }
  }
  if (m.schema) items.push(copyItem('复制库名', m.schema))
  if (m.table) items.push(copyItem('复制表名', m.table))
  if (m.field) items.push(copyItem('复制字段名', m.field))
  if (!items.length) return null
  const px = Math.min(m.x, window.innerWidth - 150)
  const py = Math.min(m.y, window.innerHeight - items.length * 30 - 10)
  return h('div', { className: 'yh-olap-cmenu', style: { left: px, top: py }, onMouseDown: function (e) { e.stopPropagation() }, onContextMenu: function (e) { e.preventDefault(); e.stopPropagation() } },
    items.map(function (it) {
      return h('div', { key: it.label, className: 'yh-olap-citem', onClick: function () { act(it.fn) } }, it.label)
    }))
}

function nodeRow(label, color, depth, hasKids, open, onClick, extra, tip, icon) {
  return h('div', { className: 'yh-olap-node', title: tip !== undefined ? tip : label, style: { paddingLeft: 6 + depth * 12 }, onClick: onClick },
    h('span', { className: 'tw' }, hasKids ? (open ? '▾' : '▸') : ''),
    icon ? h('span', { className: 'yh-olap-ic' }, icon) : null,
    h('span', { style: { color: color } }, label),
    extra || null)
}

function SchemaTree(props) {
  const { st, sid, bump } = props
  const tab = activeTab(st)
  const dsKey = String(tab && tab.dsId)
  const schemas = st.schemas[dsKey] || []
  const rows = []
  schemas.forEach(function (s) {
    const eKey = 's' + s.id
    const open = !!st.expanded[eKey]
    // ===== WORKSTATION: 右键库 → 复制库名 =====
    rows.push(h('div', { onContextMenu: function (e) { e.preventDefault(); e.stopPropagation(); st.schemaMenu = { kind: 'schema', schema: s.name, x: e.clientX, y: e.clientY }; bump() } },
      nodeRow(s.name, 'var(--dsw-alias-label-primary,#e8eef5)', 0, true, open, function () {
        if (open) delete st.expanded[eKey]
        else { st.expanded[eKey] = true; loadTables(st, sid, tab.dsId, tab.engine, s.id, bump) }
        bump()
      })))
    if (open) {
      const tbls = st.tables[dsKey + '/' + s.id]
      if (tbls && tbls.list) {
        tbls.list.forEach(function (t) {
          const tKey = 't' + t.tableId
          const to = !!st.expanded[tKey]
          // ===== WORKSTATION: 右键表 → 复制库名/表名 =====
          rows.push(h('div', { onContextMenu: function (e) { e.preventDefault(); e.stopPropagation(); st.schemaMenu = { kind: 'table', schema: s.name, table: t.name, x: e.clientX, y: e.clientY }; bump() } },
            nodeRow(t.name, 'var(--dsw-alias-label-primary,#e8eef5)', 1, true, to, function () {
              if (to) delete st.expanded[tKey]
              else { st.expanded[tKey] = true; loadColumns(st, sid, tab.engine, s.id, t.tableId, bump) }
              bump()
            })))
          if (to) {
            const cs = st.columns[s.id + '/' + t.tableId]
            if (cs && cs.columns) cs.columns.forEach(function (c) {
              const cm = c.cnName || c.comment || ''
              rows.push(h('div', { className: 'yh-olap-node yh-olap-field', title: cm ? (c.name + (c.cnName ? '  ' + c.cnName : '') + (c.comment && c.comment !== c.cnName ? '  ' + c.comment : '')) : c.name, style: { paddingLeft: 6 + 2 * 12 },
                // ===== WORKSTATION: 右键字段 → 复制库名/表名/字段名 =====
                onContextMenu: function (e) { e.preventDefault(); e.stopPropagation(); st.schemaMenu = { kind: 'field', schema: s.name, table: t.name, field: c.name, x: e.clientX, y: e.clientY }; bump() } },
                h('span', { className: 'tw' }, ''),
                h('span', { className: 'yh-olap-fname' }, c.name),
                c.type ? h('span', { className: 'yh-olap-ftype' }, c.type) : null,
                cm ? h('span', { className: 'yh-olap-fcmt' }, cm) : null))
            })
          }
        })
      }
    }
  })
  return h('div', { className: 'yh-olap-ltree' },
    rows.length ? rows : h('div', { className: 'yh-olap-hint' }, '选择数据源后显示库表'))
}

function CollectNode(props) {
  const { st, sid, node, depth, bump } = props
  const isDir = node.nodeType === 2
  const open = !!st.expanded['c' + node.id]
  const kids = node.subNodeListVO
  const onClick = isDir ? function () {
    if (open) delete st.expanded['c' + node.id]; else st.expanded['c' + node.id] = true
    bump()
  } : function () {
    // ===== WORKSTATION: 点击收藏 → 新建标签打开（标签名 = 收藏名），标记 collectId 供「保存」更新用。
    // 全自动保存模型：收藏标签也本地落盘一份（wsFile 关联），关标签删本地副本不影响服务端收藏。
    // 同一收藏只允许一个标签 —— 已打开则直接激活，不重复新建
    // （collectId 随自动保存写入 params(__collectId)，刷新恢复后仍能命中）=====
    const existing = st.tabs.find(function (t) { return t.collectId === node.id })
    if (existing) {
      st.activeTab = existing.id
      bump()
      showToast(st, '已切换到 ' + existing.name)
      return
    }
    const nid = wsNextTabId(st)
    const ntab = { id: nid, name: node.name || ('收藏' + nid), sql: node.querySql || '', engine: '2', dsId: 2, params: {}, note: '', autoSave: true, bottomTab: 'result', running: false, executeId: '', finish: '', log: '', errMsg: '', result: null, collectId: node.id, wsFile: String(nid) }
    try {
      const p = JSON.parse(node.params || '[]')
      if (Array.isArray(p)) { const po = {}; p.forEach(function (it) { po[it.key] = it.value }); ntab.params = po }
    } catch (e) { /* ignore */ }
    st.tabs.push(ntab)
    st.activeTab = nid
    wsNoteFile(st, String(nid))
    // 立即落盘（含 __name = 收藏名、__collectId = 收藏 id，刷新恢复时显示名/去重）
    callHost('ws.workspace.save', { sessionId: sid, kind: 'sql', name: String(nid), content: ntab.sql })
    callHost('ws.workspace.save', { sessionId: sid, kind: 'params', name: String(nid), content: JSON.stringify(Object.assign({}, ntab.params, { __name: ntab.name, __collectId: ntab.collectId })) })
    bump()
  }
  return h('div', { onContextMenu: function (e) { e.preventDefault(); e.stopPropagation(); st.collectMenu = { node: node, x: e.clientX, y: e.clientY }; bump() } },
    nodeRow(node.name, 'var(--dsw-alias-label-primary,#e8eef5)', depth, isDir, open, onClick, null, undefined, undefined),
    open && isDir && kids ? kids.map(function (k) { return h(CollectNode, { st: st, sid: sid, node: k, depth: depth + 1, bump: bump }) }) : null)
}

function CollectTree(props) {
  const { st, sid, bump } = props
  const closeMenu = function () { if (st.collectMenu) { st.collectMenu = null; bump() } }
  // 根节点「我的收藏」：右键可新建子目录/刷新（不提供重命名/删除，与需求一致）
  const rootRow = h('div', { onContextMenu: function (e) { e.preventDefault(); e.stopPropagation(); st.collectMenu = { node: { id: 0, name: '我的收藏', nodeType: 2 }, x: e.clientX, y: e.clientY }; bump() } },
    nodeRow('我的收藏', 'var(--dsw-alias-label-primary,#e8eef5)', 0, false, false, function () { st.leftTab === 'collect' ? collectRefresh(st, sid, bump) : null; bump() }, null, undefined, undefined))
  return h('div', { className: 'yh-olap-ltree', onClick: closeMenu, onContextMenu: closeMenu },
    rootRow,
    st.collectTree.length ? st.collectTree.map(function (node) {
      return h(CollectNode, { st: st, sid: sid, node: node, depth: 1, bump: bump })
    }) : null)
}

// ===== WORKSTATION: 收藏目录树（仅目录，nodeType 2）路径查找，供保存弹窗树状选择 =====
function collectFindPath(nodes, id, chain) {
  const list = toArray(nodes)
  for (let i = 0; i < list.length; i++) {
    const n = list[i]
    if (!n) continue
    const next = chain.concat([n.name || ('目录' + n.id)])
    if (n.nodeType === 2 && String(n.id) === id) return next
    if (n.nodeType === 2 && Array.isArray(n.subNodeListVO)) {
      const r = collectFindPath(n.subNodeListVO, id, next)
      if (r) return r
    }
  }
  return null
}

function CollectSaveModal(props) {
  const { st, bump } = props
  const tab = activeTab(st)
  // 展开/选中状态收敛进组件（store 只留 collectSaveFor 开关）：弹窗从关→开时重置
  const [sel, setSel] = useState('0')
  const [exp, setExp] = useState(null)
  const openedRef = useRef(false)
  useEffect(function () {
    if (!!st.collectSaveFor && !openedRef.current) {
      openedRef.current = true
      // ===== WORKSTATION: 默认只展开根「我的收藏」，子目录全部折叠（点 ▸ 手动展开）=====
      const init = { '0': true }
      setExp(init)
      setSel('0')
    }
    if (!st.collectSaveFor) openedRef.current = false
  }, [st.collectSaveFor, st.collectTree])
  if (!st.collectSaveFor) return null
  const expMap = exp || {}
  const toggle = function (id) {
    const nx = Object.assign({}, expMap)
    if (nx[id]) delete nx[id]
    else nx[id] = true
    setExp(nx)
  }
  // 可见目录行：根 + 各层已展开子目录（walk 只收集 nodeType 2）
  const walk = function (list, depth) {
    let o = []
    toArray(list).forEach(function (n) {
      if (!n || n.nodeType !== 2) return
      o.push({ id: String(n.id), name: n.name || ('目录' + n.id), depth: depth, kids: (n.subNodeListVO || []).filter(function (k) { return k && k.nodeType === 2 }).length })
      if (expMap[n.id] === true) o = o.concat(walk(n.subNodeListVO, depth + 1))
    })
    return o
  }
  const rows = (function () {
    const rootKids = toArray(st.collectTree).filter(function (n) { return n && n.nodeType === 2 }).length
    return [{ id: '0', name: '我的收藏', depth: 0, kids: rootKids }].concat(expMap['0'] === true ? walk(st.collectTree, 1) : [])
  })()
  const selPath = sel === '0' ? '我的收藏（根）' : (function () { const p = collectFindPath(st.collectTree, sel, []); return p ? p.join(' / ') : '我的收藏（根）' })()
  const save = function () {
    const name = document.querySelector('.yh-olap-coladd input[data-k="n"]')
    const n = (name && name.value || '').trim()
    if (!n) { showToast(st, '请输入收藏名称'); return }
    const sql = (tab && tab.sql) || ''
    if (!sql.trim()) { showToast(st, '当前无 SQL 可保存'); return }
    const pv = sel || '0'
    callHost('olap.collect.create', { node: { nodeType: 1, name: n, pid: Number(pv), querySql: sql } }).then(function (r) {
      if (r && r.ok) { st.collectSaveFor = false; st.collectSaveName = ''; if (name) name.value = ''; bump(); showToast(st, '已保存到收藏') }
      else showToast(st, '保存失败: ' + ((r && r.error) || '未知'))
    })
  }
  return h('div', { className: 'yh-olap-mask', onClick: function () { st.collectSaveFor = false; bump() } },
    h('div', { className: 'yh-olap-modal yh-olap-coladd', onClick: function (e) { e.stopPropagation() } },
      h('h4', null, '保存到收藏'),
      h('input', { placeholder: '收藏名称', 'data-k': 'n', defaultValue: st.collectSaveName || (tab ? tab.name : '') }),
      h('div', { className: 'yh-olap-dirlabel' }, '保存到目录：'),
      h('div', { className: 'yh-olap-dirs' },
        rows.length ? rows.map(function (row) {
          const expanded = !!expMap[row.id]
          const isSel = sel === row.id
          return h('div', { key: row.id, className: 'yh-olap-dirrow' + (isSel ? ' sel' : ''), style: { paddingLeft: 6 + row.depth * 15 }, onClick: function () { setSel(row.id) }, title: row.name },
            h('span', { className: 'tw', onClick: function (e) { e.stopPropagation(); if (row.id === '0' || row.kids > 0) toggle(row.id) } }, row.kids > 0 || row.id === '0' ? (expanded ? '▾' : '▸') : ''),
            h('span', { className: 'nm' }, row.name),
            isSel ? h('span', { className: 'ck' }, '✓') : null)
        }) : h('div', { className: 'yh-olap-hint' }, '目录加载中…')),
      h('div', { className: 'yh-olap-dirpath', title: selPath }, selPath),
      h('div', { className: 'row', style: { marginTop: 8 } },
        h('button', { className: 'pri', onClick: save }, '保存'),
        h('button', { onClick: function () { st.collectSaveFor = false; bump() } }, '取消'))))
}

export { CollectMenu, SchemaMenu, nodeRow, SchemaTree, CollectNode, CollectTree, collectFindPath, CollectSaveModal }
