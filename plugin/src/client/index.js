// dsh-yh-olap-workstation Client 半 —— 模块入口。
//
// 形态：右侧栏里的一个工具 tab（kind='olap'），按会话隔离；由
//   @deepseek-ai/dsh-client-ui-sidebar-right 的 sidebarRightTabs/sidebarRight 两阶段注册。
// 另有：输入框 OLAP 模式 chip（/olap 激活时显示并自动打开右侧栏工具）与 @olap 引用源。
//
// DSH client 插件契约：window.__ModuleLoader__.load({ id, factory })（由 build.mjs 包裹），
// 导出 apply/inject；id 必须等于 npm 包名。
import { useEffect, useState } from 'react'
import css from './styles.css'
import { h } from './util.js'
import { callHost } from './rpc.js'
import { setClientCtx, getService } from './runtime.js'
import { subscribeStore, globalLexListeners, getStore } from './store.js'
import { OlapPanel } from './panel.js'

const ID = 'dsh-yh-olap-workstation'
const KIND = 'olap'

// 右侧栏引导页卡片图标。
function OlapIcon() {
  return h('svg', { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
    h('ellipse', { cx: 8, cy: 3.5, rx: 5, ry: 2, stroke: 'currentColor', strokeWidth: 1.2 }),
    h('path', { d: 'M3 3.5v9c0 1.1 2.24 2 5 2s5-.9 5-2v-9', stroke: 'currentColor', strokeWidth: 1.2 }),
    h('path', { d: 'M3 8c0 1.1 2.24 2 5 2s5-.9 5-2', stroke: 'currentColor', strokeWidth: 1.2 }))
}

// 把右侧栏切到本会话的 OLAP tab（已打开则聚焦；没有会话在屏幕上时静默失败）。
export function ensureOlapTab(sid) {
  const svc = getService('sidebarRight')
  if (!svc || typeof svc.openTab !== 'function') return
  try {
    // openTab 在目标 pane 内会 reveal 已有同名页并展开右侧栏，重复调用是幂等的。
    svc.openTab(KIND)
  } catch (e) { /* 无会话表面/服务未就绪时忽略 */ }
}

// OLAP 模式 chip：/olap 激活时出现在输入框左侧；点击退出；激活时自动确保右侧栏工具打开。
function OlapChip(props) {
  const sessionId = props.sessionId || ''
  const [active, setActive] = useState(false)
  const [busy, setBusy] = useState(false)
  useEffect(function () {
    if (!sessionId) return
    let alive = true
    const poll = function () {
      callHost('olap.mode.get', { sessionId: sessionId }).then(function (r) {
        if (alive && r && r.ok) setActive(!!r.active)
      }).catch(function () {})
    }
    poll()
    const iv = setInterval(poll, 1500)
    return function () { alive = false; clearInterval(iv) }
  }, [sessionId])
  useEffect(function () {
    if (active && sessionId) ensureOlapTab(sessionId)
  }, [active, sessionId])
  if (!active) return null
  const off = function () {
    if (busy || !sessionId) return
    const remote = getService('remote')
    if (!remote || !remote.commands || typeof remote.commands.execute !== 'function') return
    setBusy(true)
    remote.commands.execute(sessionId, '/olap off', []).then(function () { setBusy(false) }, function () { setBusy(false) })
  }
  return h('span', { className: 'yh-olap-modechip-wrap' },
    h('button', { type: 'button', className: 'yh-olap-modechip', title: 'OLAP 模式已开启；点击退出', disabled: busy, onClick: off },
      'OLAP', h('span', { className: 'yh-olap-modechip-x' }, '×')))
}

// @olap 引用源：输入 @ 弹「OLAP 标签」候选；选中插入引用块（模型收到 @olapN / @olapN:Lx-y）。
function registerOlapRefSource(ctx) {
  let dispose = null
  const handle = ctx.inject(['inputTriggers'], function (sub) {
    const inputTriggers = sub.inputTriggers
    if (!inputTriggers || typeof inputTriggers.registerSource !== 'function') return
    try {
      dispose = inputTriggers.registerSource({
        trigger: '@',
        name: 'olap',
        order: 30,
        showGroupTitle: false,
        candidates: async function (session, req) {
          const sid = (session && session.sessionId) || ''
          const st = getStore(sid)
          const tabs = (st && st.tabs) || []
          const q = String((req && req.query) || '').trim().toLowerCase()
          return tabs.filter(function (t) {
            if (!q) return true
            return ((t.name || 'Tab' + t.id) + ' olap' + t.id).toLowerCase().indexOf(q) !== -1
          }).map(function (t) {
            return { name: t.name || ('Tab' + t.id), section: 'OLAP 标签', hint: (t.sql || '').slice(0, 80), value: String(t.id) }
          })
        },
        onPick: function (pick) {
          const tabId = Number(pick.candidate.value)
          const sid = (pick.session && pick.session.sessionId) || ''
          const st = getStore(sid)
          const tab = st && st.tabs.find(function (t) { return t.id === tabId })
          const nm = tab ? (tab.name || 'Tab' + tab.id) : ('Tab' + tabId)
          return { insert: { source: 'olap', ref: 'olap' + tabId, label: nm, clipboardText: '@olap' + tabId } }
        },
        lexicon: function (session) {
          const sid = (session && session.sessionId) || ''
          const st = getStore(sid)
          const tabs = (st && st.tabs) || []
          const out = []
          for (let i = 0; i < tabs.length; i++) {
            const t = tabs[i]
            out.push('olap' + t.id)
            const nm = t.name || ('Tab' + t.id)
            if (/^[\w-]+$/.test(nm)) out.push(nm)
          }
          return out
        },
        subscribeLexicon: function (session, listener) {
          const sid = (session && session.sessionId) || ''
          if (!sid) { globalLexListeners.add(listener); return function () { globalLexListeners.delete(listener) } }
          return subscribeStore(sid, listener)
        },
        codec: {
          clipboardText: function (ref) { return '@' + ref },
          serialize: function (ref) { return Promise.resolve('@' + ref) },
        },
      })
    } catch (e) { dispose = null }
  })
  return function () {
    if (dispose) { try { dispose() } catch (e) {} }
    if (handle && typeof handle.dispose === 'function') { try { handle.dispose() } catch (e) {} }
  }
}

export const inject = ['slots', 'sidebarRight', 'sidebarRightTabs', 'remote', 'remote.commands']

export function apply(ctx) {
  setClientCtx(ctx)
  const disposers = []
  ctx.effect(function () {
    const el = document.createElement('style')
    el.setAttribute('data-yh-olap-style', '1')
    el.textContent = css
    document.head.appendChild(el)
    return function () { el.remove() }
  }, 'olap.style')

  // 右侧栏 tab 类型（静态声明）：引导页卡片 + 每个会话可开一个 olap 页
  ctx.effect(function () {
    return ctx.sidebarRightTabs.register({
      id: ID,
      kind: KIND,
      priority: 'builtin',
      keepMounted: true,
      title: function () { return 'OLAP' },
      guide: [{
        id: 'open',
        order: 40,
        title: function () { return 'OLAP 查询' },
        description: function () { return 'SQL 编辑、执行与结果' },
        icon: OlapIcon,
      }],
    })
  }, 'olap.type')

  // 右侧栏 tab 正文
  ctx.effect(function () {
    return ctx.slots.inject('sidebar.right.pane.tab', function () {
      return ctx.slots.register({ name: 'sidebar.right.pane.tab', key: ID }, function (props) {
        return h(OlapPanel, { sessionId: props.sessionId, useTabInfo: props.useTabInfo })
      })
    })
  }, 'olap.body')

  // 输入框 OLAP 模式 chip
  ctx.effect(function () {
    return ctx.slots.inject('conversation.input.left', function () {
      return ctx.slots.register({ name: 'conversation.input.left', id: 'yh-olap-mode' }, function (props) {
        return h(OlapChip, props)
      })
    })
  }, 'olap.chip')

  // @olap 引用源
  disposers.push(registerOlapRefSource(ctx))

  return function dispose() {
    for (const d of disposers) { try { d() } catch (e) {} }
  }
}
