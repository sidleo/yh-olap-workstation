// 弹窗/下拉菜单：SQL 参数、Session 参数、账号管理、账号选择、通用对话框。
// 弹窗本身不自己包 portal（面板层统一挂载），结构保持旧 `h('div', { className: 'yh-olap-mask' … })`。
import { useState, useEffect, useRef } from 'react'
import { h, toArray } from './util.js'
import { callHost } from './rpc.js'
import { showToast, activeTab, wsScheduleSave } from './store.js'
import { loadDatasources } from './resources.js'

// ===== WORKSTATION: SQL 参数弹窗（${} 占位符）=====
function ParamModal(props) {
  const { st, sid, bump } = props
  if (!st.paramModalFor) return null
  const tab = activeTab(st)
  const keys = []
  const re = /\$\{([^}]+)\}/g
  let m
  while ((m = re.exec(tab.sql || ''))) {
    const k = m[1].trim()
    if (k && keys.indexOf(k) < 0) keys.push(k)
  }
  Object.keys(tab.params || {}).forEach(function (k) { if (keys.indexOf(k) < 0) keys.push(k) })
  return h('div', { className: 'yh-olap-mask', onClick: function () { st.paramModalFor = false; bump() } },
    h('div', { className: 'yh-olap-modal', onClick: function (e) { e.stopPropagation() } },
      h('h4', null, 'SQL 参数（' + keys.length + ' 个）'),
      keys.length ? keys.map(function (k) {
        return h('div', { key: k, className: 'yh-olap-prow' },
          h('span', { className: 'yh-olap-plabel', title: '参数名' }, '${' + k + '}'),
          h('input', { defaultValue: (tab.params && tab.params[k] !== undefined) ? tab.params[k] : '', placeholder: '输入参数值', onBlur: function (e) { tab.params[k] = e.target.value; bump() } }))
      }) : h('div', { className: 'yh-olap-hint' }, 'SQL 中未发现 ${} 占位符'),
      h('div', { className: 'row', style: { marginTop: 8 } },
        h('button', { className: 'pri', onClick: function () { st.paramModalFor = false; bump(); wsScheduleSave(sid, 150) } }, '确定'))))
}

// ===== WORKSTATION: Session 参数弹窗（对照原版 olap「Session 参数」）=====
// 表格三列：勾选 / key / value；「添加」新增一行（默认不勾选）、「删除」移除勾选行；
// 「确定」要求每行 key/value 都非空（空列表放行），并把 selected 落进 tab.sessionConfigs
// → 随 params 文件持久化，刷新/切会话后勾选状态仍在。「取消」丢弃草稿（与原版一致）。
function SessionParamModal(props) {
  const { st, sid, bump } = props
  if (!st.sessionModalFor) return null
  const tab = activeTab(st)
  if (!tab) return null
  const rows = st.sessionDraft || []
  const close = function () { st.sessionModalFor = false; st.sessionDraft = null; bump() }
  const nextId = function () {
    let mx = 0
    rows.forEach(function (r) { if (r && typeof r.id === 'number' && r.id > mx) mx = r.id })
    return mx + 1
  }
  const addRow = function () {
    rows.push({ id: nextId(), key: '', value: '', selected: false })
    bump()
  }
  const delRows = function () {
    if (!rows.some(function (r) { return r && r.selected })) { showToast(st, '请先勾选要删除的行'); return }
    st.sessionDraft = rows.filter(function (r) { return !r.selected }).map(function (r, i) {
      return { id: i + 1, key: r.key, value: r.value, selected: false }
    })
    bump()
  }
  const submit = function () {
    const bad = rows.filter(function (r) { return !String((r && r.key) || '').trim() || !String((r && r.value) || '').trim() })
    if (bad.length) { showToast(st, '参数中 key、value 不能有空'); return }
    tab.sessionConfigs = rows.map(function (r, i) {
      return { id: i + 1, key: String(r.key).trim(), value: String(r.value), selected: !!r.selected }
    })
    st.sessionModalFor = false
    st.sessionDraft = null
    bump()
    wsScheduleSave(sid, 150)
  }
  return h('div', { className: 'yh-olap-mask', onClick: close },
    h('div', { className: 'yh-olap-modal yh-olap-smodal', onClick: function (e) { e.stopPropagation() } },
      h('h4', null, 'Session 参数'),
      h('div', { className: 'yh-olap-sbar' },
        h('button', { className: 'pri', onClick: addRow }, '添加'),
        h('button', { onClick: delRows }, '删除')),
      h('div', { className: 'yh-olap-stable' },
        h('div', { className: 'yh-olap-shd' },
          h('span', { className: 'yh-olap-sck' }),
          h('span', { className: 'yh-olap-sk' }, 'key'),
          h('span', { className: 'yh-olap-sv' }, 'value')),
        rows.length ? rows.map(function (r) {
          return h('div', { className: 'yh-olap-srow', key: r.id },
            h('input', {
              type: 'checkbox', className: 'yh-olap-sck', checked: !!r.selected,
              onChange: function (e) { r.selected = e.target.checked; bump() },
            }),
            h('input', {
              className: 'yh-olap-sk', value: (r.key === undefined || r.key === null) ? '' : String(r.key), placeholder: 'hive.xxx',
              onChange: function (e) { r.key = e.target.value; bump() },
            }),
            h('input', {
              className: 'yh-olap-sv', value: (r.value === undefined || r.value === null) ? '' : String(r.value), placeholder: 'value',
              onChange: function (e) { r.value = e.target.value; bump() },
            }))
        }) : h('div', { className: 'yh-olap-hint' }, '暂无数据，点「添加」新增；只有打勾的行才会随执行生效')),
      h('div', { className: 'row', style: { marginTop: 10 } },
        h('button', { onClick: close }, '取消'),
        h('button', { className: 'pri', onClick: submit }, '确定'))))
}

function AccountManageModal(props) {
  const { st, sid, bump } = props
  if (!st.accManage) return null
  const rows = toArray(st.accounts)
  const save = function (a, val) {
    callHost('olap.accounts.save', { username: a.username, alias: val, org: a.org || '' }).then(function (r) {
      if (r && r.ok) { a.alias = val; bump(); showToast(st, '已保存昵称') }
      else showToast(st, '保存失败: ' + (r && r.error ? r.error : '未知'))
    })
  }
  const remove = function (a) {
    st.dlg = { kind: 'confirm', title: '删除账号', message: '删除账号 ' + a.username + ' ？', okLabel: '删除', onOk: function () {
      callHost('olap.accounts.remove', { username: a.username }).then(function (r) {
        if (r && r.ok) { st.accounts = st.accounts.filter(function (x) { return x.username !== a.username }); if (st.currentAccount === a.username) st.currentAccount = st.accounts.length ? st.accounts[0].username : ''; bump(); showToast(st, '已删除账号') }
        else showToast(st, '删除失败')
      })
      return true
    } }
    bump()
  }
  // 添加账号表单：非受控 defaultValue + 提交时从 DOM 读值 + 清空
  const add = function () {
    const uin = document.querySelector('.yh-olap-accadd input[data-k="u"]')
    const pin = document.querySelector('.yh-olap-accadd input[data-k="p"]')
    const oin = document.querySelector('.yh-olap-accadd input[data-k="o"]')
    const u = (uin && uin.value || '').trim()
    if (!u) { showToast(st, '请输入用户名'); return }
    if (toArray(st.accounts).some(function (x) { return x.username === u })) { showToast(st, '账号已存在'); return }
    const pass = (pin && pin.value) || ''
    const otp = (oin && oin.value || '').trim()
    callHost('olap.accounts.save', { username: u, password: pass, otp_key: otp, makeCurrent: false }).then(function (r) {
      if (r && r.ok) {
        st.accounts.push({ username: u, alias: u, org: '' })
        if (uin) uin.value = ''; if (pin) pin.value = ''; if (oin) oin.value = ''
        bump(); showToast(st, '已添加账号 ' + u)
      }
      else showToast(st, '添加失败: ' + (r && r.error ? r.error : '未知'))
    })
  }
  return h('div', { className: 'yh-olap-mask', onClick: function () { st.accManage = false; bump() } },
    h('div', { className: 'yh-olap-modal yh-olap-accmodal', onClick: function (e) { e.stopPropagation() } },
      h('h4', null, '账号管理'),
      h('div', { className: 'yh-olap-accadd' },
        h('input', { placeholder: '用户名', 'data-k': 'u', defaultValue: '', style: { flex: '1 1 0', margin: 0, minWidth: 0, width: 'auto', boxSizing: 'border-box' } }),
        h('input', { placeholder: '密码', type: 'password', 'data-k': 'p', defaultValue: '', style: { flex: '1 1 0', margin: 0, minWidth: 0, width: 'auto', boxSizing: 'border-box' } }),
        h('input', { placeholder: 'OTP密钥(可选)', 'data-k': 'o', defaultValue: '', style: { flex: '1 1 0', margin: 0, minWidth: 0, width: 'auto', boxSizing: 'border-box' } }),
        h('button', { className: 'pri', onClick: add, style: { flex: '0 0 auto', width: 44 } }, '添加')),
      h('div', { style: { height: 10 } }),
      rows.map(function (a) {
        const nick = (a.alias && a.alias !== a.username) ? a.alias : a.username
        return h('div', { key: a.username, className: 'yh-olap-accrow', style: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 } },
          h('input', { defaultValue: nick, key: 'nick-' + a.username, className: 'yh-olap-accnickinp', style: { flex: '1 1 0', margin: 0, minWidth: 0, width: 'auto', boxSizing: 'border-box' }, onBlur: function (e) { if (e.target.value !== nick) save(a, e.target.value) }, placeholder: '昵称' }),
          h('span', { style: { color: 'var(--dsw-alias-label-secondary,#7a8ba0)', fontSize: 11, flex: '0 0 auto', minWidth: 60, textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 100 } }, a.username),
          h('button', { style: { flex: '0 0 auto', padding: '0 8px', width: 44, color: 'var(--dsw-alias-state-error-primary,var(--yh-ui-danger))' }, onClick: function () { remove(a) } }, '删除'))
      }),
      rows.length ? null : h('div', { className: 'yh-olap-hint' }, '暂无账号'),
      h('div', { className: 'row', style: { marginTop: 8 } },
        h('button', { className: 'pri', onClick: function () { st.accManage = false; bump() } }, '关闭'))))
}

function AccountSel(props) {
  const { st, sid, bump } = props
  const [open, setOpen] = useState(false)
  const rootRef = useRef(null)
  useEffect(function () {
    if (!open) return
    const onDown = function (e) {
      const el = rootRef.current
      if (el && !el.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return function () { document.removeEventListener('mousedown', onDown) }
  }, [open])
  const cur = toArray(st.accounts).find(function (a) { return a.username === st.currentAccount })
  const curName = cur ? ((cur.alias && cur.alias !== cur.username) ? cur.alias : cur.username) : (st.currentAccount || '')
  const choose = function (u) {
    setOpen(false)
    if (u === '__manage__') { st.accManage = true; bump(); return }
    if (u && u !== st.currentAccount) switchAccount(st, sid, bump, u)
  }
  return h('div', { className: 'yh-olap-accwrap', ref: rootRef },
    h('button', { className: 'yh-olap-accbtn' + (open ? ' on' : ''), onClick: function () { setOpen(!open) }, title: '选择账号（切换后自动刷新库表）' }, curName + (open ? ' ▴' : ' ▾')),
    open ? h('div', { className: 'yh-olap-accmenu' },
      toArray(st.accounts).map(function (a) {
        return h('div', { key: a.username, className: 'yh-olap-accitem' + (a.username === st.currentAccount ? ' on' : ''), onMouseDown: function (e) { e.preventDefault() }, onClick: function () { choose(a.username) } },
          h('span', { className: 'yh-olap-accname' }, a.username),
          h('span', { className: 'yh-olap-accnick' }, (a.alias && a.alias !== a.username) ? a.alias : ''))
      }),
      h('div', { className: 'yh-olap-accitem mgr', onMouseDown: function (e) { e.preventDefault() }, onClick: function () { choose('__manage__') } }, '⚙ 账号管理'))
      : null)
}

// ===== WORKSTATION: 通用对话框（自绘 confirm/input，替代 window.confirm/prompt）=====
// 状态在 st.dlg：{ kind:'confirm'|'input', title, message, value?, okLabel?, onOk }
// onOk：confirm 收到 true（点确定）；input 收到输入值（可为空串）。返回 false 不关闭。
function DlgModal(props) {
  const { st, bump } = props
  const d = st.dlg
  const close = function () { st.dlg = null; bump() }
  const inputRef = useRef(null)
  // ===== hooks 必须在 early-return 之前（旧代码把下面两行放在 `if (!d) return null` 之后，
  // 对话框从关→开时 hook 数量 0→2，真 React 下会抛 Rendered more hooks…；此处上移，
  // 且 `if (!d) return` 保持「关闭时不挂 keydown 监听」的原行为）=====
  // 打开时自动聚焦输入框；Esc 关闭
  useEffect(function () {
    if (!d) return
    if (d.kind === 'input' && inputRef.current) { inputRef.current.focus(); inputRef.current.select() }
    const onKey = function (e) { if (e.key === 'Escape') { e.stopPropagation(); close() } }
    document.addEventListener('keydown', onKey, true)
    return function () { document.removeEventListener('keydown', onKey, true) }
  }, [d])
  if (!d) return null
  if (d.kind === 'input') {
    const ok = function () {
      const val = (inputRef.current && inputRef.current.value != null) ? inputRef.current.value : (d.value || '')
      if (d.onOk && d.onOk(val) === false) return // onOk 可返回 false 拦截（如空值校验）
      close()
    }
    return h('div', { className: 'yh-olap-mask', onMouseDown: function (e) { if (e.target === e.currentTarget) close() } },
      h('div', { className: 'yh-olap-modal', style: { width: 360 }, onMouseDown: function (e) { e.stopPropagation() } },
        d.title ? h('h4', null, d.title) : null,
        d.message ? h('div', { className: 'yh-olap-dlgmsg', style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary,#7a8ba0)', marginBottom: 8, whiteSpace: 'pre-wrap', wordBreak: 'break-all' } }, d.message) : null,
        h('input', { ref: inputRef, defaultValue: d.value || '', placeholder: d.placeholder || '', style: { marginBottom: 10 } }),
        h('div', { className: 'row' },
          h('button', { className: 'pri', onClick: ok }, d.okLabel || '确定'),
          h('button', { onClick: close }, '取消'))))
  }
  // confirm
  const ok = function () { if (d.onOk && d.onOk(true) === false) return; close() }
  return h('div', { className: 'yh-olap-mask', onMouseDown: function (e) { if (e.target === e.currentTarget) close() } },
    h('div', { className: 'yh-olap-modal', style: { width: 360 }, onMouseDown: function (e) { e.stopPropagation() } },
      d.title ? h('h4', null, d.title) : null,
      d.message ? h('div', { className: 'yh-olap-dlgmsg', style: { fontSize: 12, color: 'var(--dsw-alias-label-primary,#cdd7e0)', marginBottom: 10, whiteSpace: 'pre-wrap', wordBreak: 'break-all', lineHeight: 1.5 } }, d.message) : null,
      h('div', { className: 'row' },
        h('button', { className: 'pri', onClick: ok }, d.okLabel || '确定'),
        h('button', { onClick: close }, '取消'))))
}

function switchAccount(st, sid, bump, username) {
  if (!username) return
  callHost('olap.login', { username: username }).then(function (r) {
    if (r && r.ok) {
      st.currentAccount = r.username
      bump()
      loadDatasources(st, sid, bump, true)
    }
    else { showToast(st, '切换失败: ' + (r && r.error ? r.error : '未知错误')) }
  })
}

export { ParamModal, SessionParamModal, AccountManageModal, AccountSel, DlgModal, switchAccount }
