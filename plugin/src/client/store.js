// per-session store + 本地工作区持久化 + 面板状态上报。
// 由旧 client.js 的闭包代码抽出为模块；行为保持不变，只去掉三列布局/会话跟随相关的全局状态。
import { useEffect, useState } from 'react'
import { callHost } from './rpc.js'


    function makeStore() {
      return {
        version: 0,
        tabs: [{ id: 1, name: 'Tab1', sql: '', engine: '2', dsId: 2, params: {}, autoSave: true, bottomTab: 'result', running: false, executeId: '', finish: '', log: '', errMsg: '', result: null, wsFile: '1' }],
        activeTab: 1,
        datasources: [], schemas: {}, tables: {}, columns: {}, expanded: {},
        collectTree: [], collectDirs: [], collectExpanded: {}, collectMenu: null,
        // ===== WORKSTATION: 库表清单右键菜单（复制库名/表名/字段名）=====
        schemaMenu: null,
        leftTab: 'schema', leftCollapsed: false, leftWidth: 210, editorRatio: 0.62, bottomTab: 'result',
        __wsKnownFiles: new Set(),
        historyRows: [], historyLoaded: false,
        downloadRows: [], downloadLoaded: false, dlSearch: '', dlSqlCache: {},
        accounts: [], currentAccount: '',
               paramModalFor: false, accManage: false, dlDetail: null, collectSaveFor: false,
        editingTab: null, editingName: '', toast: '',
        // ===== WORKSTATION: 通用对话框（自绘 confirm/input，替代 window.confirm/prompt）=====
        // { kind:'confirm'|'input', title, message, value?, okLabel?, onOk } —— onOk 收到输入值/true
        dlg: null,
        __colsLoading: false,
      }
    }

    const toastTimers = {}
    function showToast(st, msg) {
      st.toast = msg
      if (toastTimers[st.__id]) clearTimeout(toastTimers[st.__id])
      toastTimers[st.__id] = setTimeout(function () { st.toast = ''; emitStore(st.__id) }, 3000)
      emitStore(st.__id)
    }

    // ===== WORKSTATION: 引用插入的「插入位置」 —— 必须用官方 captureInsertion() =====
    // insertReference(ref, span) 内部做两道闸：phase ∈ {plain, claimed}，且 span.draftRev === 编辑器
    // 当前 rev。官方 InputActions.captureInsertion() 返回的正是「detect 坐标 + 当前 rev」。
    // 旧写法拿 state 快照的 draft 长度当坐标（那是 clipboard 投影，不是 detect 坐标）、draftRev 取自
    // 快照（可能滞后），两道闸都可能失败 → 静默降级到剪贴板。
    // 0.1.5 没有 actions.captureInsertion，故保留旧写法作为回退（向后兼容）。


    const stores = {}
    const listeners = {}
    const globalLexListeners = new Set()
    function getStore(sid) { if (!stores[sid]) { stores[sid] = makeStore(); stores[sid].__id = sid } return stores[sid] }
    function subscribeStore(sid, fn) { (listeners[sid] || (listeners[sid] = new Set())).add(fn); return function () { const s = listeners[sid]; if (s) s.delete(fn) } }
    function emitStore(sid) { const s = listeners[sid]; if (s) s.forEach(function (f) { f() }); if (globalLexListeners.size) globalLexListeners.forEach(function (f) { try { f() } catch (e) { /* noop */ } }) }
    function useStore(sid) {
      const [, setV] = useState(0)
      useEffect(function () { return subscribeStore(sid, function () { setV(function (x) { return x + 1 }) }) }, [sid])
      return getStore(sid)
    }
    function activeTab(st) { return st.tabs.find(function (t) { return t.id === st.activeTab }) || st.tabs[0] }

    // ===== WORKSTATION: Session 参数（hive 虚拟参数）=====
    // 原版 olap：按钮仅 hive 引擎 + 编辑器有 SQL 时可用；弹窗每行 {key,value} 带勾选，
    // **只有勾选行**生效 —— 运行时聚合成对象 {key:value} 作为 executeConfigs 提交 runSql。
    // 面板侧存 tab.sessionConfigs = [{id,key,value,selected}]（随 params 文件按标签持久化）。
    function sessionRows(tab) { return (tab && tab.sessionConfigs) || [] }
    function sessionConfigsMap(tab) {
      const out = {}
      let n = 0
      sessionRows(tab).forEach(function (r) {
        if (!r || !r.selected) return
        const k = String(r.key === undefined || r.key === null ? '' : r.key).trim()
        if (!k) return
        out[k] = (r.value === undefined || r.value === null) ? '' : String(r.value)
        n++
      })
      return n ? out : null
    }
    function sessionEnabledFor(tab) {
      return !!tab && String(tab.engine) === '1' && !!(tab.sql || '').trim()
    }


    const wsMetaBySid = {}
    // ===== WORKSTATION: 程序改 tab.sql 的抑制窗口 —— 程序插入/恢复 SQL 后 React 渲染可能触发
    // 非用户 input，导致补全自弹；打时间戳，onInput 在窗口内不弹补全 =====
    let wsProgSqlSetAt = 0
    // ===== WORKSTATION: 非键盘输入标记 —— 任何程序性内容插入（setTaValue/收藏插入/打开文件/补全应用等）
    // 置 true，onInput 消费一次后复位，保证「非键盘插入一律不弹补全」=====
    let wsNonKeyInput = false
    // ===== WORKSTATION: 粘贴/拖放窗口 —— 批量插入可能触发多次 input，800ms 窗口内一律不弹补全 =====
    let wsPasteAt = 0
    function markPaste() { wsPasteAt = Date.now(); wsNonKeyInput = true }
    function markProgSqlSet() { wsProgSqlSetAt = Date.now(); wsNonKeyInput = true }
    function isProgSqlWindow() { return Date.now() - wsProgSqlSetAt < 2000 }
    const wsTimers = {}
    let wsLayoutApplied = false
    let wsSidebarCollapsedDone = false
    function wsSafe(s) { return String(s == null ? '' : s).replace(/[\\/:*?"<>|]/g, '_').trim() || 'unnamed' }
    // ===== WORKSTATION: 文件名以 id 为准（不含名称，避免重命名残留/同 id 不同名冲突）=====
    function wsBaseOf(t) { return String(t.id || 1) }
    function wsMetaFor(sid) { return (wsMetaBySid[sid] = wsMetaBySid[sid] || { loaded: false, tabs: null }) }
    // ===== WORKSTATION: 下一个可用标签 id —— 避开工作区遗留文件 id（关闭 autoSave 标签后文件仍在，新建不得复用其 id）=====
    function wsNextTabId(st) {
      let m = 0
      if (st && st.tabs) m = Math.max.apply(null, st.tabs.map(function (x) { return x.id || 0 }))
      const known = st && st.__wsKnownFiles
      if (known && known.size) {
        known.forEach(function (x) { const n = Number(x); if (n > m) m = n })
      }
      return m + 1
    }
    // ===== WORKSTATION: 记录工作区已知文件 id（自动保存落盘/刷新树/新分配时维护，新建标签避开已占用 id）=====
    function wsNoteFile(st, name) {
      if (st && name && /^\d+$/.test(name)) { st.__wsKnownFiles = st.__wsKnownFiles || new Set(); st.__wsKnownFiles.add(name) }
    }
    function wsNoteAllFiles(st, sqlRows) {
      if (!st) return
      st.__wsKnownFiles = st.__wsKnownFiles || new Set()
      ;(sqlRows || []).forEach(function (f) { if (f && /^\d+$/.test(f.name || '')) st.__wsKnownFiles.add(String(f.name)) })
    }

    function wsScheduleSave(sid, delay) {
      // ===== WORKSTATION: 自动保存开关 —— 只有勾选「自动保存」的标签才自动落盘。
      // 判断按「是否存在 autoSave 标签」而非「活动标签」：wsPersistAll 会落所有
      // autoSave 标签（含非活动），若只查活动标签，模型 write 到非活动 autoSave
      // 标签时会被误拦不落盘 → 刷新丢失。=====
      const stT = getStore(sid)
      const anyAutoSave = stT && stT.tabs ? stT.tabs.some(function (x) { return x.autoSave === true }) : false
      if (!anyAutoSave) return
      if (wsTimers[sid]) clearTimeout(wsTimers[sid])
      wsTimers[sid] = setTimeout(function () { wsPersistAll(sid) }, delay === undefined ? 800 : delay)
    }
    function wsPersistAll(sid) {
      const st = getStore(sid)
      if (!st || !st.tabs || !st.tabs.length) return
      // ===== WORKSTATION: 只自动保存勾选「自动保存」的标签 =====
      const list = st.tabs.filter(function (t) { return t.autoSave === true }).map(function (t) {
        return { id: t.id, name: t.name || ('Tab' + t.id), sql: t.sql || '', params: t.params || {}, sessionConfigs: t.sessionConfigs || [], collectId: t.collectId }
      })
      wsMetaFor(sid).tabs = list
      for (let i = 0; i < list.length; i++) {
        const t = list[i]
        const base = wsBaseOf(t)
        wsNoteFile(st, base)
        callHost('ws.workspace.save', { sessionId: sid, kind: 'sql', name: base, content: t.sql })
        // ===== WORKSTATION: 标签名/收藏 id 存入 params（文件名只有 id，工作区树/恢复靠 __name 显示名、
        // __collectId 用于收藏标签去重——同一收藏刷新后也只会有一个标签）=====
        const paramsJson = Object.assign({}, t.params || {}, { __name: t.name || ('Tab' + t.id) })
        if (t.collectId) paramsJson.__collectId = t.collectId
        if (t.sessionConfigs && t.sessionConfigs.length) paramsJson.__sessionConfigs = t.sessionConfigs
        callHost('ws.workspace.save', { sessionId: sid, kind: 'params', name: base, content: JSON.stringify(paramsJson) })
      }
    }
    function wsLoad(cb, sid) {
      callHost('ws.workspace.list', { sessionId: sid }).then(function (r) {
        const wm = wsMetaFor(sid)
        if (!r || !r.ok) { wm.loaded = true; if (cb) cb(); return }
        const sqls = r.sql || []
        if (!sqls.length) { wm.loaded = true; wm.tabs = null; if (cb) cb(); return }
        const tabs = []
        // ===== WORKSTATION: 并行读取所有文件（原串行：每文件 3 个 RPC 依次等，
        // N 文件 = 3N 串行往返，刷新后标签恢复慢的元凶之一）。改为每文件 3 个 read
        // 并行 + 文件间并行，本地磁盘读取整体 <500ms。=====
        const valid = sqls.filter(function (f) {
          return /^\d+$/.test(f.name) // 旧格式 `<id>-<名>.sql` 不恢复（避免同 id 冲突）
        })
        const pAll = valid.map(function (f) {
          const id = Number(f.name)
          const nm = 'Tab' + id
          return Promise.all([
            callHost('ws.workspace.read', { sessionId: sid, kind: 'sql', name: f.name }),
            callHost('ws.workspace.read', { sessionId: sid, kind: 'params', name: f.name }),
          ]).then(function (rs) {
            const sr = rs[0], pr = rs[1]
            const t = { id: id, name: nm, sql: (sr && sr.ok) ? sr.content : '', params: {}, engine: '2', dsId: 2, wsFile: f.name }
            if (pr && pr.ok) { try { const p = JSON.parse(pr.content); if (p && typeof p === 'object') { t.params = p; if (p.__name) t.name = p.__name; delete t.params.__name; if (p.__collectId) t.collectId = p.__collectId; delete t.params.__collectId; if (Array.isArray(p.__sessionConfigs)) t.sessionConfigs = p.__sessionConfigs; delete t.params.__sessionConfigs } } catch (e) { /* ignore */ } }
            tabs.push(t)
          })
        })
        Promise.all(pAll).then(function () {
          wm.loaded = true
          wm.tabs = tabs
          if (cb) cb()
        })
      })
    }
    function wsApplyToStore(st, sid) {
      const wm = wsMetaFor(sid)
      if (wm.loaded && wm.tabs && wm.tabs.length && st.__wsRestored !== true) {
        markProgSqlSet()
        st.tabs = wm.tabs.map(function (t) {
          return { id: t.id, name: t.name, sql: t.sql, engine: t.engine || '2', dsId: t.dsId || 2, params: t.params || {}, sessionConfigs: t.sessionConfigs || [], autoSave: true, bottomTab: 'result', running: false, executeId: '', finish: '', log: '', errMsg: '', result: null, collectId: t.collectId, wsFile: t.id != null ? String(t.id) : undefined }
        })
        st.activeTab = st.tabs[0].id
        st.__wsRestored = true
        emitStore(sid)
        // ===== WORKSTATION: 恢复后必须上传 host —— 否则模型 olap state 读到的是恢复前
        // 的空快照（host lastState 未更新），报"SQL 为空"无法修改（会话 ab924be4 实测：
        // 用户刷新后引用 L13，模型 state 读空）。立即上传（绕过 1s 节流，模型可能马上
        // state 验证）。=====
        if (uploadPending) { clearTimeout(uploadPending.timer); uploadPending = null }
        uploadPanelState(st, sid)
      }
    }


    let uploadPending = null
    function uploadThrottle(fn) {
      if (uploadPending) { uploadPending.fn = fn; return }
      uploadPending = { fn: fn, timer: setTimeout(function () { const f = uploadPending.fn; uploadPending = null; f() }, 300) }
    }
    function uploadPanelState(st, sid) {
      const state = {
        activeTab: st.activeTab || 1,
        tabs: (st.tabs || []).map(function (t) {
          return { id: t.id, name: t.name, sql: t.sql, engine: t.engine, dsId: t.dsId, running: !!t.running, finish: t.finish || '', executeId: t.executeId || '', log: t.log || '', errMsg: t.errMsg || '', sessionConfigs: t.sessionConfigs || [] }
        }),
        currentAccount: st.currentAccount || '',
        dsList: st.dsList || [],
      }
      callHost('olap.panel.state', { sessionId: sid, state: state })
    }
    function schedulePanelUpload(st, sid) {
      uploadThrottle(function () { uploadPanelState(st, sid) })
    }

// ---- exports（供 panel / tree / results / modals 使用）----

export { makeStore, showToast, getStore, subscribeStore, emitStore, useStore, activeTab, sessionRows, sessionConfigsMap, sessionEnabledFor, wsMetaFor, wsBaseOf, wsNextTabId, wsNoteFile, wsNoteAllFiles, wsScheduleSave, wsPersistAll, wsLoad, wsApplyToStore, uploadPanelState, schedulePanelUpload }

export { globalLexListeners }
