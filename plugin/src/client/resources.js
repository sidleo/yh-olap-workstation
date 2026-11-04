// 数据资源加载：数据源 / 库 / 表 / 列（懒加载）+ 收藏树 + 历史 / 下载列表。
import { callHost } from './rpc.js'
import { toArray } from './util.js'
import { activeTab, showToast } from './store.js'

    function loadDatasources(st, sid, bump, force) {
      if (force) {
        st.datasources = []; st.schemas = {}; st.tables = {}; st.columns = {}
        st.expanded = {}; st.collectTree = []; st.collectDirs = []
      }
      callHost('olap.datasource').then(function (r) {
        if (!r || !r.ok) return
        const list = toArray(r.data)
        st.datasources = list.map(function (d) { return { id: d.id, engine: String(d.engine), name: d.name } })
        const has = !force && st.tabs.some(function (t) { return t.dsId !== undefined && t.dsId !== null && st.datasources.some(function (d) { return d.id === t.dsId }) })
        if ((force || !has) && list.length) {
          const imp = list.find(function (d) { return String(d.engine) === '2' }) || list[0]
          for (const t of st.tabs) { t.engine = String(imp.engine); t.dsId = imp.id; t.params = {} }
        }
        bump()
        loadSchemas(st, sid, bump)
        loadCollect(st, sid, bump)
      })
    }
    function loadSchemas(st, sid, bump) {
      const tab = activeTab(st)
      if (!tab || tab.dsId === undefined || tab.dsId === null) return
      const key = String(tab.dsId)
      if (st.schemas[key]) return
      callHost('olap.schemas', { dsId: tab.dsId, engine: tab.engine }).then(function (r) {
        if (!r || !r.ok) return
        st.schemas[key] = toArray(r.data)
        bump()
        // 补全依赖表名：库加载后即预取各库表名（列仍留给按需加载）
        st.schemas[key].forEach(function (s) { loadTables(st, sid, tab.dsId, tab.engine, s.id, bump) })
      })
    }
    function loadTables(st, sid, dsId, engine, schemaId, bump) {
      const key = dsId + '/' + schemaId
      if (st.tables[key]) return
      callHost('olap.tables', { schemaId: schemaId, engine: engine }).then(function (r) {
        if (!r || !r.ok) return
        st.tables[key] = { list: toArray(r.data && r.data.rows).map(function (t) { return { name: t.name, schemaId: t.schemaId, tableId: t.tableId } }) }
        bump()
      })
    }
    function loadColumns(st, sid, engine, schemaId, tableId, bump, then) {
      const key = schemaId + '/' + tableId
      if (st.columns[key]) { if (then) then(st.columns[key].columns); return }
      callHost('olap.columns', { schemaId: schemaId, tableId: tableId, engine: engine }).then(function (r) {
        if (!r || !r.ok) return
        st.columns[key] = { columns: toArray(r.data && r.data.columns), loaded: true }
        bump()
        if (then) then(st.columns[key].columns)
      })
    }
    function loadCollect(st, sid, bump) {
      callHost('olap.collect.tree').then(function (r) {
        if (!r || !r.ok) return
        const d = r.data
        if (d && Array.isArray(d.subNodeListVO)) st.collectTree = d.subNodeListVO
        else if (Array.isArray(d)) st.collectTree = d
        else st.collectTree = []
        bump()
      })
      callHost('olap.collect.dirs').then(function (r) {
        if (r && r.ok) { st.collectDirs = toArray(r.data); bump() }
      })
    }

    function collectRefresh(st, sid, bump) {
      st.collectTree = []; bump()
      loadCollect(st, sid, bump)
      showToast(st, '收藏已刷新')
    }
    function collectNewDir(st, bump, pid, pidName) {
      st.dlg = { kind: 'input', title: '新建子目录', message: '在「' + (pidName || '我的收藏') + '」下创建：', placeholder: '目录名称', value: '', onOk: function (v) {
        const n = String(v || '').trim()
        if (!n) { showToast(st, '目录名不能为空'); return false }
        callHost('olap.collect.create', { node: { nodeType: 2, pid: pid || 0, name: n } }).then(function (r) {
          if (r && r.ok) { collectRefresh(st, st.__id, bump); showToast(st, '目录已创建') }
          else showToast(st, '创建失败: ' + ((r && r.error) || '未知'))
        })
        return true
      } }
      bump()
    }
    function collectRename(st, bump, node) {
      st.dlg = { kind: 'input', title: '重命名', value: node.name || '', placeholder: '新名称', onOk: function (v) {
        const n = String(v || '').trim()
        if (!n) { showToast(st, '名称不能为空'); return false }
        callHost('olap.collect.rename', { id: node.id, newName: n }).then(function (r) {
          if (r && r.ok) { collectRefresh(st, st.__id, bump); showToast(st, '已重命名') }
          else showToast(st, '重命名失败: ' + ((r && r.error) || '未知'))
        })
        return true
      } }
      bump()
    }
    function collectDelete(st, bump, node) {
      st.dlg = { kind: 'confirm', title: '删除收藏', message: '删除「' + (node.name || '') + '」？\n（目录会连同子节点一并删除，不可恢复）', okLabel: '删除', onOk: function () {
        callHost('olap.collect.delete', { id: node.id }).then(function (r) {
          if (r && r.ok) { collectRefresh(st, st.__id, bump); showToast(st, '已删除') }
          else showToast(st, '删除失败: ' + ((r && r.error) || '未知'))
        })
        return true
      } }
      bump()
    }

    function loadHistory(st, sid, bump, force) {
      if (st.historyLoaded && !force) return
      if (force) st.historyRows = []
      callHost('olap.history', { pageSize: 50 }).then(function (r) {
        if (!r || !r.ok) return
        st.historyRows = toArray(r.data && r.data.rows)
        st.historyLoaded = true
        bump()
      })
    }
    function loadDownloads(st, sid, bump, force) {
      if (st.downloadLoaded && !force) return
      if (force) st.downloadRows = []
      callHost('olap.download.list', { pageSize: 50 }).then(function (r) {
        if (!r || !r.ok) return
        st.downloadRows = toArray(r.data && r.data.rows)
        st.downloadLoaded = true
        bump()
        // 懒拉取前 30 行详情填充 SQL 文本缓存（搜索可命中 SQL 内容）
        st.downloadRows.slice(0, 30).forEach(function (row) {
          if (st.dlSqlCache[row.id]) return
          callHost('olap.download.detail', { approvalId: row.id }).then(function (dr) {
            if (dr && dr.ok && dr.data) { st.dlSqlCache[row.id] = dr.data.querySql || ''; bump() }
          })
        })
      })
    }

    // 时间压缩：YYYY-MM-DD HH:mm:ss / M/D/YY h:mm AM → MM-DD HH:mm（窄容器省宽）

export {
  loadDatasources, loadSchemas, loadTables, loadColumns, loadCollect,
  collectRefresh, collectNewDir, collectRename, collectDelete,
  loadHistory, loadDownloads,
}
