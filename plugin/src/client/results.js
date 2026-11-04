// 底栏视图：执行结果表格 / 历史记录 / 下载工单 / 下载工单详情 / 日志渲染。
// 组件 props 沿用旧签名（{ st, sid, bump }）；硬编码颜色换成语义 token。
import { useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { h, toArray, fmtLog, copyToClipboard } from './util.js'
import { shortT } from './timefmt.js'
import { callHost } from './rpc.js'
import { showToast, activeTab } from './store.js'
import { loadHistory, loadDownloads } from './resources.js'
import { downloadBlob } from './run.js'

const STATE_NAME = { 1: '执行中', 2: '执行成功', 3: '数据生成失败', 4: 'kerberos失败', 5: 'hive错误', 6: 'consul失败', 7: '自动取消', 8: '执行取消' }
// 时间统一格式：MM-dd HH:mm（实现见 timefmt.js，纯函数可单测）
// 长 id 缩略：uuid 显示前 8 位 + …
function shortId(id) {
  const str = String(id == null ? '' : id)
  return str.length > 12 ? str.slice(0, 8) + '…' : str
}
// 清单行信息 span 的公共样式（窄容器下可收缩省略）
const INFO_SPAN = { color: 'var(--dsw-alias-label-secondary)', fontSize: 11, flexShrink: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }

function ResultView(props) {
  const { st, bump } = props
  const tab = activeTab(st)
  const r = tab && tab.result
  const [menu, setMenu] = useState(null) // { x, y, value, row }
  const [loadingMore, setLoadingMore] = useState(false)
  useEffect(function () {
    if (!menu) return
    const onDoc = function () { setMenu(null) }
    document.addEventListener('mousedown', onDoc)
    return function () { document.removeEventListener('mousedown', onDoc) }
  }, [menu])
  if (!r) return h('div', { className: 'yh-olap-hint' }, '无结果')
  const cols = toArray(r.columnNameList).map(function (c, i) { return { key: i, name: c } })
  const rows = toArray(r.list)
  const total = r.total !== undefined ? r.total : rows.length
  const cellOf = function (row, c) {
    if (row && typeof row === 'object' && !Array.isArray(row)) {
      if (Object.prototype.hasOwnProperty.call(row, c.name)) return row[c.name]
    }
    return row[c.key]
  }
  const textOf = function (v) { return v === null || v === undefined ? '' : String(v) }
  const rowText = function (row) {
    return cols.map(function (c) { return textOf(cellOf(row, c)) }).join('\t')
  }
  const copy = function (text, label) {
    setMenu(null)
    if (copyToClipboard(text)) showToast(st, '已复制' + label)
    else showToast(st, '复制失败')
  }
  const loadMore = function () {
    const execId = tab && tab.executeId
    if (!execId || loadingMore) return
    setLoadingMore(true)
    const pageNo = Math.floor(rows.length / 200) + 1
    callHost('olap.result', { requestId: execId, pageNo: pageNo, pageSize: 200 }).then(function (res) {
      setLoadingMore(false)
      if (res && res.ok && res.data && Array.isArray(res.data.list) && res.data.list.length) {
        tab.result = Object.assign({}, tab.result, {
          list: rows.concat(res.data.list),
          total: res.data.total !== undefined ? res.data.total : total,
        })
        if (bump) bump()
      } else {
        showToast(st, '没有更多数据')
      }
    })
  }
  const head = h('thead', null, h('tr', null,
    h('th', { key: '__idx', className: 'yh-olap-th-idx' }, '#'),
    cols.map(function (c) { return h('th', { key: c.key, title: c.name }, c.name) })))
  const body = h('tbody', null, rows.map(function (row, ri) {
    const cells = cols.map(function (c) {
      const v = cellOf(row, c)
      return h('td', {
        key: c.key,
        title: textOf(v),
        onContextMenu: function (e) { e.preventDefault(); e.stopPropagation(); setMenu({ x: e.clientX, y: e.clientY, value: textOf(v), row: rowText(row) }) },
      }, v === null || v === undefined ? h('span', { className: 'yh-olap-null' }, 'NULL') : String(v))
    })
    return h('tr', { key: ri }, h('td', { className: 'yh-olap-td-idx' }, ri + 1), cells)
  }))
  const menuEl = menu ? createPortal(h('div', { className: 'yh-olap-cmenu', style: { left: menu.x, top: menu.y }, onMouseDown: function (e) { e.stopPropagation() } },
    h('div', { className: 'yh-olap-citem', onClick: function () { copy(menu.value, '单元格') } }, '复制单元格'),
    h('div', { className: 'yh-olap-citem', onClick: function () { copy(menu.row, '整行（Tab 分隔）') } }, '复制整行')), document.body) : null
  return h('div', { className: 'yh-olap-reswrap' },
    h('div', { className: 'yh-olap-hint' },
      '共 ' + total + ' 行（已加载 ' + rows.length + ' 行）',
      total > rows.length && tab && tab.executeId
        ? h('button', { className: 'yh-olap-mini', style: { marginLeft: 8 }, disabled: loadingMore, onClick: loadMore }, loadingMore ? '加载中…' : '加载更多')
        : null),
    h('table', { className: 'yh-olap-table' }, head, body),
    menuEl)
}

function HistoryDlBtn(props) {
  const { st, bump, row } = props
  const [open, setOpen] = useState(false)
  const [eng, setEng] = useState(row.engine === 1 ? 1 : 2)
  const ref = useRef(null)
  const submit = function () {
    callHost('olap.history.order', { requestId: row.requestId, engine: eng }).then(function (r) {
      if (r && r.ok && (r.data || r.id)) showToast(st, '全量下载工单已提交，请到「下载」页下载')
      else showToast(st, '工单提交失败: ' + ((r && r.error) || (r && r.message) || '未知'))
    })
  }
  // 打开时点击外部关闭
  useEffect(function () {
    if (!open) return
    const onDoc = function (e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return function () { document.removeEventListener('mousedown', onDoc) }
  }, [open])
  const pick = function (v) { setEng(v); setOpen(false) }
  return h('div', { ref: ref, className: 'yh-olap-histdlbtn', style: { position: 'relative', display: 'inline-flex', alignItems: 'center' } },
    h('button', { className: 'yh-olap-mini blue', style: { borderTopRightRadius: 0, borderBottomRightRadius: 0, marginRight: 0 }, onClick: submit, title: '提交全量下载工单（引擎: ' + (eng === 1 ? 'hive' : 'impala') + '），完成后到下载页取件' }, '全量工单'),
    h('button', { className: 'yh-olap-mini blue yh-olap-histdlarr', style: { borderTopLeftRadius: 0, borderBottomLeftRadius: 0, padding: '0 4px', minWidth: 18 }, onClick: function (e) { e.stopPropagation(); setOpen(!open) }, title: '选择下载引擎' }, '▾'),
    open ? h('div', { className: 'yh-olap-histdlmenu', style: { position: 'absolute', right: 0, top: '100%', zIndex: 30, minWidth: 90, background: 'var(--dsw-alias-bg-overlay,#1b2431)', border: '1px solid var(--dsw-alias-border-l2,#33455a)', borderRadius: 6, boxShadow: '0 6px 20px rgba(0,0,0,.4)', padding: 3 } },
      h('div', { className: 'yh-olap-citem', onClick: function () { pick(2) } }, 'impala 全量'),
      h('div', { className: 'yh-olap-citem', onClick: function () { pick(1) } }, 'hive 全量')) : null)
}

function HistoryView(props) {
  const { st, sid, bump } = props
  return h('div', { className: 'yh-olap-scroll' },
    h('div', { className: 'yh-olap-dlsearch' },
      h('span', { className: 'yh-olap-dlcount' }, st.historyRows.length + ' 条记录'),
      h('button', { className: 'yh-olap-mini', style: { marginLeft: 'auto', fontSize: 13 }, onClick: function () { loadHistory(st, sid, bump, true); showToast(st, '历史已刷新') }, title: '重新拉取历史' }, '⟳')),
    st.historyRows.length ? st.historyRows.map(function (row, i) {
      const ok = row.state === 2
      return h('div', { key: row.requestId || i, style: { padding: '6px 4px', borderBottom: '1px solid var(--dsw-alias-border-l1)' } },
        h('div', { style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 } },
          h('span', { style: { display: 'inline-flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, flex: '0 1 auto', minWidth: 0 } },
            h('span', { style: Object.assign({}, INFO_SPAN, { color: ok ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-error-primary)', flexShrink: 0 }) }, STATE_NAME[row.state] || ('state ' + row.state)),
            h('span', { style: Object.assign({}, INFO_SPAN, { flexShrink: 0 }) }, row.engine === 1 ? 'hive' : row.engine === 4 ? 'doris' : row.engine === 3 ? 'ck' : 'impala'),
            h('span', { style: INFO_SPAN }, shortT(row.startTime)),
            h('span', { style: INFO_SPAN }, (row.execCostTime || 0) + 'ms'),
            h('span', { style: INFO_SPAN, title: '执行 id ' + (row.requestId || '') }, 'id ' + (row.requestId || '-'))),
          h('div', { title: row.plainQueryText || '', style: { flex: '1 1 160px', minWidth: 0, fontFamily: 'monospace', fontSize: 11.5, color: 'var(--dsw-alias-label-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, String(row.plainQueryText || '').replace(/[\r\n\t]+/g, ' ')),
          h('span', { style: { display: 'inline-flex', gap: 4, alignItems: 'center', marginLeft: 'auto', flexShrink: 0 } },
            h('button', { className: 'yh-olap-mini', onClick: function () { const tab = activeTab(st); tab.sql = row.plainQueryText || ''; tab.finish = ''; bump(); showToast(st, '已插入到编辑区') }, title: '把这条 SQL 覆盖到当前编辑区' }, '插入'),
            h('button', { className: 'yh-olap-mini', onClick: function () { downloadBlob('olap.history.fast', { requestId: row.requestId, engine: row.engine }, function (msg) { showToast(st, msg) }) }, title: '快速下载（≤1000 条结果）' }, '快速下载'),
            h(HistoryDlBtn, { st: st, bump: bump, row: row }))))
    }) : h('div', { className: 'yh-olap-hint' }, '暂无历史'))
}

function DownloadView(props) {
  const { st, sid, bump } = props
  const openDetail = function (row) {
    showToast(st, '加载详情…')
    callHost('olap.download.detail', { approvalId: row.id }).then(function (r) {
      if (r && r.ok) { st.dlDetail = r.data; st.toast = ''; bump() }
      else showToast(st, '加载详情失败: ' + ((r && r.error) || '未知'))
    })
  }
  const kw = (st.dlSearch || '').toLowerCase().trim()
  const filtered = kw ? st.downloadRows.filter(function (row) {
    const sql = st.dlSqlCache[row.id] || ''
    const engName = row.engine === 4 ? 'doris' : row.engine === 3 ? 'ck' : row.engine === 1 ? 'hive' : 'impala'
    return (sql + ' ' + (row.committerName || '') + ' ' + (row.committer || '') + ' ' + (row.taskStateName || '') + ' ' + (row.stateName || '') + ' ' + engName + ' ' + (row.createTime || '') + ' ' + (row.finishTime || '')).toLowerCase().indexOf(kw) >= 0
  }) : st.downloadRows
  return h('div', { className: 'yh-olap-scroll' },
    h('div', { className: 'yh-olap-dlsearch' },
      h('input', { className: 'yh-olap-dlsearch-inp', placeholder: '搜索 SQL / 状态 / 引擎 / 时间…', value: st.dlSearch, onChange: function (e) { st.dlSearch = e.target.value; bump() } }),
      st.dlSearch ? h('button', { className: 'yh-olap-mini', onClick: function () { st.dlSearch = ''; bump() } }, '清除') : null,
      st.dlSearch ? h('span', { className: 'yh-olap-dlcount' }, '匹配 ' + filtered.length + ' 条') : null,
      h('button', { className: 'yh-olap-mini', style: { marginLeft: 'auto', fontSize: 13 }, onClick: function () { st.downloadLoaded = false; st.dlSqlCache = {}; loadDownloads(st, sid, bump, true); showToast(st, '已刷新') }, title: '刷新下载列表' }, '⟳')),
    filtered.length ? filtered.map(function (row, i) {
      const can = row.taskState === 2
      const failed = row.taskState === 3
      const engName = row.engine === 4 ? 'doris' : row.engine === 3 ? 'ck' : row.engine === 1 ? 'hive' : 'impala'
      const sql = st.dlSqlCache[row.id] || ''
      return h('div', { key: row.id || i, style: { padding: '6px 4px', borderBottom: '1px solid var(--dsw-alias-border-l1)' } },
        h('div', { style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 } },
          h('span', { style: { display: 'inline-flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, flex: '0 1 auto', minWidth: 0 } },
            h('span', { style: Object.assign({}, INFO_SPAN, { color: can ? 'var(--dsw-alias-state-success-primary)' : (failed ? 'var(--yh-ui-danger)' : 'var(--dsw-alias-state-warn-primary)'), fontWeight: 600, flexShrink: 0 }) }, row.taskStateName || ('taskState ' + row.taskState)),
            h('span', { style: Object.assign({}, INFO_SPAN, { flexShrink: 0 }) }, engName),
            h('span', { style: INFO_SPAN, title: row.createTime || row.startTime || '' }, '申请 ' + shortT(row.createTime || row.startTime)),
            h('span', { style: INFO_SPAN, title: row.finishTime || '' }, '完成 ' + shortT(row.finishTime)),
            h('span', { style: INFO_SPAN, title: '工单 id ' + (row.id || '') }, 'id ' + (row.id || '-'))),
          sql ? h('div', { title: sql, style: { flex: '1 1 160px', minWidth: 0, fontFamily: 'monospace', fontSize: 11.5, color: 'var(--dsw-alias-label-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, String(sql).replace(/[\r\n\t]+/g, ' ')) : null,
          h('span', { style: { display: 'inline-flex', gap: 4, alignItems: 'center', marginLeft: 'auto', flexShrink: 0 } },
            h('button', { className: 'yh-olap-mini', onClick: function () { openDetail(row) }, title: '查看 SQL/审批详情' }, '详情'),
            can ? h('button', { className: 'yh-olap-mini blue', onClick: function () { downloadBlob('olap.download.file', { id: row.id, engine: row.engine }, function (msg) { showToast(st, msg) }) }, title: '下载文件' }, '下载') : null,
            failed ? h('button', { className: 'yh-olap-mini red', onClick: function () { callHost('olap.download.refresh', { downloadId: row.downloadId || row.id }).then(function (r) { if (r && r.ok) { st.downloadLoaded = false; loadDownloads(st, sid, bump); showToast(st, '已重新生成') } else showToast(st, '重试失败') }) }, title: '失败重试' }, '重试') : null)))
    }) : h('div', { className: 'yh-olap-hint' }, '暂无下载工单'))
}

function DownloadDetailModal(props) {
  const { st, bump } = props
  const d = st.dlDetail
  if (!d) return null
  const engName = d.engine === 4 ? 'doris' : d.engine === 3 ? 'ck' : d.engine === 1 ? 'hive' : 'impala'
  const close = function () { st.dlDetail = null; bump() }
  const row = function (label, val) { return h('span', null, label + ': ', h('b', null, val || '-')) }
  return h('div', { className: 'yh-olap-mask', onClick: close },
    h('div', { className: 'yh-olap-modal yh-olap-dlmodal', onClick: function (e) { e.stopPropagation() } },
      h('h4', null, '下载工单详情 #' + d.id),
      h('div', { className: 'yh-olap-dlbody' },
        h('div', { className: 'yh-olap-dlmeta' },
          row('状态', d.taskStateName || d.stateName),
          row('引擎', engName),
          row('提交人', d.committerName || d.committer),
          row('审批人', d.confirmorName || d.confirmor),
          row('申请时间', shortT(d.createTime || d.startTime)),
          row('完成时间', shortT(d.finishTime))),
        h('div', { className: 'yh-olap-dlmeta' },
          row('审批说明', d.confirmNote),
          row('execId', d.execId),
          row('requestId', d.requestId),
          row('downLoadRequestId', d.downLoadRequestId)),
        h('div', { className: 'yh-olap-dlsql' }, d.querySql || '(无 SQL)'),
        d.errorMsg ? h('div', { className: 'yh-olap-dlerr' }, d.errorMsg) : null),
      h('div', { className: 'row yh-olap-dlfoot', style: { marginTop: 10 } },
        h('button', { className: 'pri', onClick: close }, '关闭'))))
}

// ===== WORKSTATION: 日志渲染 —— 错误行/错误信息标红 =====
const LOG_ERR_RE = /Error|Exception|Analysis|failed|Failed|失败|error|Exception|Could not|SQLException|Invalid|unknown/i
function renderLog(tab) {
  // 后端日志以 <br/> 分隔 → 先转 \n（fmtLog 同行为），再逐行渲染
  const log = fmtLog(tab && tab.log)
  const lines = log.split('\n')
  const nodes = []
  lines.forEach(function (line, i) {
    const isErr = LOG_ERR_RE.test(line)
    nodes.push(h('div', { key: i, className: 'yh-olap-log-line' + (isErr ? ' err' : '') }, line))
  })
  if (tab && tab.errMsg && log.indexOf('IMPALAERROR') === -1 && log.indexOf(tab.errMsg) === -1) {
    nodes.push(h('div', { key: 'err', className: 'yh-olap-log-line err' }, tab.errMsg))
  }
  if (!nodes.length) nodes.push(h('div', { key: 'empty', className: 'yh-olap-log-line' }, '(无日志)'))
  return nodes
}

export { ResultView, HistoryDlBtn, HistoryView, DownloadView, DownloadDetailModal, renderLog }
