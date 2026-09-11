// dsh-yh-olap-workstation 插件 Client 半（浏览器端，独立实现）。
// DSH client 插件契约：window.__ModuleLoader__.load({ id, factory })，导出 apply/inject。
// 注意：id 必须等于 npm 包名（clientModules 按包名匹配注册），勿随内部业务名改动。
// 实现要点：
//  ① React 经 require("react") 获取；services 经 ctx.get("slots"/"layout") 获取。
//  ② RPC：host.call(method,args) → callHost()，fetch POST /api/yh-olap/rpc（宿主半同路径分发）。
//  ③ 定时器：timer.timeout/interval 用原生 setTimeout/setInterval 实现（返回取消函数）。
//  ④ 样式：apply 内把 CSS 挂一个 <style> 标签，卸载时移除。
//
// ── 功能区段索引（本文件 ~3800 行，跳转定位用）────────────────────────────
//  L10-221   插件入口 apply()：CSS 注入 + 布局尽早生效
//  L222-341  引擎词表（IMPALA/HIVE 关键字与函数）+ tokenize/highlight
//  L343-364  makeStore()：per-session 可变全局 store 初始状态
//  L366-432  UI 杂项：toast / 填聊天框 / 复制 / 标签引用(referTab)
//  L433-628  编辑器键盘辅助 + 轻量多光标 + 软换行光标坐标（wrap 像素估算）+ 查找替换纯函数
//  L637-660  store 注册表（stores/listeners/useStore）
//  L661-913  本地工作区持久化（per-session 多文件）+ 布局跟随 + 新会话重置
//  L915-1019 下载 blob / 数据源/库/表/列懒加载
//  L1020-1323 收藏树 + 工作区树组件（WorkspaceTree）
//  L1324-1448 便签弹窗（NoteModal）
//  L1449-1592 WsDivider（对话区宽度分隔条）+ LeftArea（左栏两 tab）
//  L1594-1778 光标 mirror 定位 / schema·表·别名查找 / 补全排名
//  L1779-2272 Editor（大组件：补全/键盘/滚动/双击括号/行号）
//  L2273-2477 doRun/pollRun/killRun/downloadSimple（执行与结果轮询）
//  L2478-2582 SQL 格式化辅助（mask/lowerKeywords/splitCodeTop）
//  L2583-2898 formatSql/formatMain（手写 SQL 格式化器）
//  L2899-3014 FunctionBar（工具栏）+ 历史/下载加载 + 短格式工具
//  L3015-3165 ResultView（结果表）+ History/Download 视图
//  L3166-3493 底栏 / 账号选择 / 标签栏右键 / 各弹窗(参数/收藏/账号/便签)
//  L3494-3597 OlapPanel（主面板）+ applyCommands
//  L3598-3713 slots 注入 / @olap 引用源 / dispose
// ───────────────────────────────────────────────────────────────────────

window.__ModuleLoader__.load({
  id: 'dsh-yh-olap-workstation',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var react = require('react')
    var h = react.createElement

    var inject = ['slots', 'layout', 'remote', 'remote.commands']

    var cssEl = null
    function injectCss(css) {
      if (cssEl || typeof document === 'undefined' || !document.head) return
      cssEl = document.createElement('style')
      cssEl.setAttribute('data-yh-olap-style', '1')
      cssEl.textContent = css
      document.head.appendChild(cssEl)
    }

    function callHost(method, args) {
      return fetch('/api/yh-olap/rpc', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ method: method, args: args === undefined ? {} : args }),
      }).then(function (r) { return r.json() })
    }

    function apply(ctx) {
    const slots = ctx.get('slots')
    if (!slots) return
    const layout = ctx.get('layout')
    const timer = {
      timeout(fn, ms) { const t = setTimeout(fn, ms); return function () { clearTimeout(t) } },
      interval(fn, ms) { const t = setInterval(fn, ms); return function () { clearInterval(t) } },
    }

    const CSS = `.yh-olap-panel{display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-base,#0f141a);color:var(--dsw-alias-label-primary,#cdd7e0);font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;font-size:12.5px;overflow:hidden}
.yh-olap-panel.full{position:fixed;inset:0;z-index:99999;background:var(--dsw-alias-bg-base,#0f141a)}

.yh-olap-head b{color:var(--dsw-alias-label-primary,#e8eef4);font-size:13px;flex:0 0 auto}
.yh-olap-accwrap{position:relative;flex:0 0 auto}
.yh-olap-accbtn{height:24px;padding:0 8px;font-size:12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,#33455a);background:var(--dsw-alias-bg-layer-2,#1d2633);color:var(--dsw-alias-label-primary,#bcd);cursor:pointer;display:inline-flex;align-items:center;gap:4px;max-width:150px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.yh-olap-accbtn.on{border-color:var(--yh-ui-brand);color:var(--yh-ui-brand)}
.yh-olap-accmenu{position:absolute;top:26px;right:0;min-width:150px;max-width:220px;background:var(--dsw-alias-bg-overlay,#1b2431);border:1px solid var(--dsw-alias-border-l2,#33455a);border-radius:8px;box-shadow:0 6px 20px rgba(0,0,0,.4);z-index:60;overflow:hidden}
.yh-olap-accitem{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:6px 10px;font-size:12.5px;color:var(--dsw-alias-label-primary,#d7e2ee);cursor:pointer}
.yh-olap-accitem:hover{background:var(--dsw-alias-bg-layer-2,#1d2633)}
.yh-olap-accitem.on{background:var(--yh-ui-brand);color:var(--yh-ui-ondark)}
.yh-olap-accitem .yh-olap-accnick{color:var(--dsw-alias-label-secondary,#7a8ba0);font-size:11px}
.yh-olap-accitem.on .yh-olap-accnick{color:rgba(255,255,255,.8)}
.yh-olap-accitem.mgr{border-top:1px solid var(--dsw-alias-border-l2,#33455a);justify-content:center;color:var(--dsw-alias-label-secondary,#7a8ba0)}
.yh-olap-body{flex:1;display:flex;min-height:0;overflow:hidden;position:relative}
.yh-olap-left{width:210px;flex:0 0 auto;display:flex;flex-direction:column;border-right:1px solid var(--dsw-alias-border-l1,#242d3a);background:var(--dsw-alias-bg-layer-2,#131a23);min-height:0;position:relative}
.yh-olap-main{flex:1;display:flex;flex-direction:column;min-width:0;min-height:0;position:relative}
.yh-olap-left .yh-olap-resizer{position:absolute;top:0;right:-3px;width:6px;height:100%;cursor:col-resize;z-index:6}
.yh-olap-left .yh-olap-resizer:hover{background:rgba(65,118,230,.3)}
.yh-olap-coltoggle{position:absolute;top:50%;transform:translateY(-50%);z-index:6;width:14px;height:52px;padding:0;border:1px solid var(--dsw-alias-border-l2,#33455a);background:var(--dsw-alias-bg-overlay,#1d2633);color:var(--dsw-alias-label-secondary,#7a8ba0);cursor:pointer;opacity:.4;font-size:10px;transition:opacity .12s;display:flex;align-items:center;justify-content:center}
.yh-olap-coltoggle:hover{opacity:1}
.yh-olap-coltoggle.collapse{left:auto;right:2px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2,#33455a)}
.yh-olap-coltoggle.expand{left:0;border-radius:0 8px 8px 0;border-left:none}
.yh-olap-func{flex:0 0 34px;display:flex;align-items:center;gap:5px;padding:0 6px;background:var(--dsw-alias-bg-layer-1,#171d26);border-bottom:1px solid var(--dsw-alias-border-l1,#242d3a)}
.yh-olap-func select{height:24px;background:var(--dsw-alias-bg-layer-2,#1d2633);color:var(--dsw-alias-label-primary,#cdd7e0);border:1px solid var(--dsw-alias-border-l2,#33455a);border-radius:8px;font-size:11.5px;max-width:118px;padding:0 6px}
.yh-olap-func button{height:24px;padding:0 8px;font-size:11.5px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,#33455a);background:var(--dsw-alias-bg-layer-2,#1d2633);color:var(--dsw-alias-label-primary,#cdd7e0);cursor:pointer;flex:0 0 auto}
.yh-olap-mini{height:20px;padding:0 8px;font-size:11px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2,#33455a);background:var(--dsw-alias-bg-layer-2,#1d2633);color:var(--dsw-alias-label-primary,#cdd7e0);cursor:pointer;flex:0 0 auto;line-height:1}
.yh-olap-mini:hover{background:var(--dsw-alias-bg-layer-1,#1a2230)}
.yh-olap-histdlmenu .yh-olap-citem{padding:5px 12px;font-size:12px}
.yh-olap-mini.blue{border-color:var(--yh-ui-brand);color:var(--yh-ui-brand);background:transparent}
.yh-olap-mini.blue:hover{background:var(--yh-ui-brand-weak)}
.yh-olap-mini.red{border-color:var(--yh-ui-danger);color:var(--yh-ui-danger);background:transparent}
.yh-olap-mini.red:hover{background:var(--yh-ui-danger-weak)}
.yh-olap-dlmodal{width:560px;max-width:92vw}
.yh-olap-dlmeta{display:flex;flex-wrap:wrap;gap:4px 14px;font-size:11.5px;color:var(--dsw-alias-label-secondary,#7a8ba0);margin-bottom:8px}
.yh-olap-dlmeta b{color:var(--dsw-alias-label-primary,#cdd7e0);font-weight:500}
.yh-olap-dlsql{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11.5px;color:var(--dsw-alias-label-primary,#b9c6d4);white-space:pre-wrap;background:var(--dsw-alias-bg-layer-2,#131a23);border:1px solid var(--dsw-alias-border-l1,#2a3646);border-radius:6px;padding:6px 8px;max-height:140px;overflow:auto;word-break:break-all}
.yh-olap-dlerr{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;color:var(--yh-ui-danger);white-space:pre-wrap;background:rgba(229,72,77,.08);border:1px solid rgba(229,72,77,.3);border-radius:6px;padding:6px 8px;max-height:120px;overflow:auto;word-break:break-all;margin-top:8px}
.yh-olap-dlsearch{display:flex;align-items:center;gap:6px;padding:4px 2px 8px}
.yh-olap-dlsearch-inp{flex:1;min-width:0;height:24px;padding:0 8px;font-size:12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,#33455a);background:var(--dsw-alias-bg-layer-2,#1d2633);color:var(--dsw-alias-label-primary,#bcd);box-sizing:border-box}
.yh-olap-dlcount{font-size:11px;color:var(--dsw-alias-label-secondary,#7a8ba0);flex:0 0 auto}
.yh-olap-cmenu{position:fixed;z-index:200;min-width:130px;background:var(--dsw-alias-bg-overlay,#1b2431);border:1px solid var(--dsw-alias-border-l2,#33455a);border-radius:8px;box-shadow:0 6px 20px rgba(0,0,0,.45);padding:4px;overflow:hidden}
.yh-olap-citem{padding:6px 12px;font-size:12.5px;color:var(--dsw-alias-label-primary,#d7e2ee);cursor:pointer;border-radius:6px;white-space:nowrap}
.yh-olap-citem:hover{background:var(--yh-ui-brand);color:var(--yh-ui-ondark)}
.yh-olap-tmenu{position:fixed;z-index:210;min-width:180px;background:var(--dsw-alias-bg-overlay,#1b2431);border:1px solid var(--dsw-alias-border-l2,#33455a);border-radius:8px;box-shadow:0 6px 20px rgba(0,0,0,.45);padding:4px;overflow:hidden}
.yh-olap-titem{padding:6px 12px;font-size:12.5px;color:var(--dsw-alias-label-primary,#d7e2ee);cursor:pointer;border-radius:6px;white-space:nowrap}
.yh-olap-titem:hover{background:var(--yh-ui-brand);color:var(--yh-ui-ondark)}
.yh-olap-titem.on{color:var(--yh-ui-brand)}
.yh-olap-func .run{background:transparent;border-color:var(--yh-ui-brand);color:var(--yh-ui-brand)}
.yh-olap-func .run:hover{background:var(--yh-ui-brand-weak)}
.yh-olap-func .stop{background:transparent;border-color:var(--yh-ui-danger);color:var(--yh-ui-danger)}
.yh-olap-func .stop:hover{background:var(--yh-ui-danger-weak)}
.yh-olap-split{flex:1;display:flex;flex-direction:column;min-height:0}
.yh-olap-editor{position:relative;overflow:hidden;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px;line-height:1.55}
.yh-olap-gutter{position:absolute;top:0;left:0;bottom:0;width:34px;margin:0;background:var(--yh-ui-gutter-bg,#f0f1f3);color:var(--dsw-alias-label-secondary,#4a5a6e);text-align:right;padding:4px 6px 10px 0;box-sizing:border-box;user-select:none;overflow:hidden;white-space:pre;font:inherit}
.yh-olap-code{position:absolute;top:0;left:34px;right:0;bottom:0}
:root{--yh-k:#9d4dd3;--yh-f:#00897b;--yh-s:#c2571a;--yh-p:#c0392b;--yh-n:#2e7d32;--yh-i:#1f2937;--yh-c:#6b7280;--yh-x:#4b5563}
html[style*="color-scheme: dark"]{--yh-k:#c586c0;--yh-f:#4ec9b0;--yh-s:#e6a86e;--yh-p:#d16969;--yh-n:#b5cea8;--yh-i:#d7dee6;--yh-c:#5f7f5f;--yh-x:#aab4c0}
/* ===== WORKSTATION: UI 语义 token（品牌色/危险色/链接态）。CSS 里硬编码的品牌
   色 #4176e6 / 危险色 #e5484d 统一收敛到这里，换肤/品牌调整只改一处。
   以 var(--yh-ui-*) 引用；深浅色两套与 --yh-* 高亮变量同规则。
   --yh-ui-gutter-bg：编辑器行号区（gutter）底色 —— 浅色下用浅灰与白色代码区
   区分，深色下沿用原层色（--dsw-alias-bg-layer-2）不变。===== */
:root{--yh-ui-brand:#4176e6;--yh-ui-brand-weak:rgba(65,118,230,.1);--yh-ui-danger:#e5484d;--yh-ui-danger-weak:rgba(229,72,77,.1);--yh-ui-ondark:#fff;--yh-ui-gutter-bg:#f0f1f3}
html[style*="color-scheme: dark"]{--yh-ui-brand:#4d8cff;--yh-ui-brand-weak:rgba(77,140,255,.14);--yh-ui-danger:#ff6b6b;--yh-ui-danger-weak:rgba(255,107,107,.12);--yh-ui-ondark:#fff;--yh-ui-gutter-bg:var(--dsw-alias-bg-layer-2,#10161d)}
.yh-olap-hl{position:absolute;inset:0;margin:0;padding:0;white-space:pre;overflow:hidden;pointer-events:none;color:var(--dsw-alias-label-primary,#d7dee6);font:13px/1.55 ui-monospace,Menlo,Consolas,monospace;box-sizing:border-box;letter-spacing:normal;word-spacing:0}
.yh-olap-hl-inner{padding:4px 4px 10px 4px;will-change:transform;display:block;position:relative;z-index:0;box-sizing:border-box;white-space:pre-wrap;word-break:normal;overflow-wrap:break-word;line-height:1.55}
/* 当前行背景：绝对定位子元素的包含块是父级 hl-inner 的 padding-box，而文字从 hl-inner/textarea
   的 4px 左 padding 之后才开始 —— 所以必须 left/right=4px 才能与文本区左右对齐（四边 padding
   一致，改 padding 必须同时改这里，否则色条会与文字错位）。
   原值 left/right:-12px 会让色条从文字左缘再往左伸 24px（用户实测"像多了一个空格"，误导缩进判断）。 */
.yh-olap-curline{position:absolute;left:4px;right:4px;height:20.15px;background:rgba(148,163,184,.13);pointer-events:none;z-index:-1;border-radius:2px}
.yh-olap-input{position:absolute;inset:0;margin:0;padding:4px 4px 10px 4px;background:transparent;color:transparent;caret-color:var(--dsw-alias-label-primary,#fff);border:0;outline:none;resize:none;white-space:pre-wrap;overflow-x:hidden;overflow-y:overlay;font:13px/1.55 ui-monospace,Menlo,Consolas,monospace;box-sizing:border-box;letter-spacing:normal;word-spacing:0;word-break:normal;overflow-wrap:break-word;line-height:1.55}
.yh-olap-input::-webkit-scrollbar,.yh-olap-input::-webkit-scrollbar-track,.yh-olap-input::-webkit-scrollbar-thumb,.yh-olap-input::-webkit-scrollbar-corner{cursor:default}
/* 自绘选区高亮：原生选区底色透明（仅在我们量到矩形时生效，量不到则回落原生高亮）*/
.yh-olap-input.yh-selown::selection{background:transparent}
.yh-olap-selhit{position:absolute;background:rgba(122,170,255,.30);pointer-events:none;z-index:-1;border-radius:2px}
.yh-olap-mcur{position:absolute;width:1px;height:13px;background:var(--yh-ui-brand);pointer-events:none;z-index:2}
/* ===== WORKSTATION: 查找替换小部件（编辑器右上角浮层，VSCode 风格）===== */
.yh-olap-findbox{position:absolute;top:6px;right:14px;z-index:30;background:var(--dsw-alias-bg-overlay,#1b2431);border:1px solid var(--dsw-alias-border-l2,#33455a);border-radius:8px;box-shadow:0 6px 20px rgba(0,0,0,.4);padding:6px;user-select:none}
.yh-olap-findrow{display:flex;align-items:center;gap:4px}
.yh-olap-findrow.rep{margin-top:5px}
.yh-olap-findgap{flex:0 0 22px}
.yh-olap-findinp{width:190px;height:24px;padding:0 6px;font-size:12px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2,#33455a);background:var(--dsw-alias-bg-layer-2,#1d2633);color:var(--dsw-alias-label-primary,#bcd);box-sizing:border-box;outline:none;user-select:text}
.yh-olap-findinp:focus{border-color:var(--yh-ui-brand)}
.yh-olap-findinp.err{border-color:var(--yh-ui-danger)}
.yh-olap-findbtn{height:22px;min-width:22px;padding:0 4px;font-size:11.5px;line-height:1;border-radius:6px;border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary,#8a9aae);cursor:pointer;flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center}
.yh-olap-findbtn:hover{background:var(--dsw-alias-bg-layer-2,#1d2633);color:var(--dsw-alias-label-primary,#cdd7e0)}
.yh-olap-findbtn.on{border-color:var(--yh-ui-brand);color:var(--yh-ui-brand);background:var(--yh-ui-brand-weak)}
.yh-olap-findbtn.act{border-color:var(--dsw-alias-border-l2,#33455a);padding:0 8px}
.yh-olap-findcnt{font-size:11px;color:var(--dsw-alias-label-secondary,#8a9aae);min-width:34px;text-align:center;flex:0 0 auto;white-space:nowrap}
.yh-olap-findcnt.none{color:var(--yh-ui-danger)}
.yh-olap-findhit{position:absolute;z-index:-1;background:rgba(65,118,230,.22);border-radius:2px;pointer-events:none}
.yh-olap-findhit.cur{background:rgba(65,118,230,.5);border:1px solid var(--yh-ui-brand);box-sizing:border-box}
html[style*="color-scheme: dark"] .yh-olap-findhit{background:rgba(77,140,255,.24)}
html[style*="color-scheme: dark"] .yh-olap-findhit.cur{background:rgba(77,140,255,.55)}
/* 查找替换按钮悬停提示气泡（fixed 定位，避免被 findbox overflow 裁剪） */
.yh-olap-findtip{position:fixed;z-index:400;max-width:260px;padding:4px 8px;font-size:11.5px;line-height:1.5;color:var(--dsw-alias-label-primary,#e8eef4);background:var(--dsw-alias-bg-overlay,#1b2431);border:1px solid var(--dsw-alias-border-l2,#33455a);border-radius:6px;box-shadow:0 4px 14px rgba(0,0,0,.4);pointer-events:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;animation:yhFindTipIn .1s ease-out}
@keyframes yhFindTipIn{from{opacity:0;transform:translateY(-2px)}to{opacity:1;transform:none}}
.yh-olap-resizer{flex:0 0 6px;cursor:row-resize;background:var(--dsw-alias-border-l1,#242d3a)}
.yh-olap-bot{flex:1;display:flex;flex-direction:column;min-height:0;overflow:hidden}
.yh-olap-tabs{flex:0 0 34px;display:flex;align-items:flex-end;gap:14px;padding:0 12px;border-bottom:1px solid var(--dsw-alias-border-l1,#242d3a);justify-content:flex-start}
.yh-olap-tabs .yh-olap-btab{flex:0 0 auto;font-size:13px;font-weight:500;padding:0 0 11px;color:var(--dsw-alias-label-secondary,#81858c);cursor:pointer;position:relative;line-height:1}
.yh-olap-tabs .yh-olap-btab.on{color:var(--yh-ui-brand)}
.yh-olap-tabs .yh-olap-btab.on::after{content:'';position:absolute;left:0;right:0;bottom:0;height:2px;background:var(--yh-ui-brand)}
.yh-olap-tabsbar{flex:0 0 38px;display:flex;align-items:center;padding:0 8px;background:var(--dsw-alias-bg-layer-1,#171d26);border-bottom:1px solid var(--dsw-alias-border-l1,#242d3a);gap:6px;min-width:0}
.yh-olap-tabs-wrap{display:flex;align-items:center;gap:2px;overflow:hidden;flex:1 1 auto;min-width:0}
.yh-olap-tabs-right{display:flex;align-items:center;gap:6px;flex:0 0 auto;margin-left:auto}
.yh-olap-tab{flex:0 0 auto;padding:4px 10px;font-size:12px;border-radius:8px;cursor:pointer;color:var(--dsw-alias-label-secondary,#7a8ba0);display:inline-flex;align-items:center;gap:2px;white-space:nowrap;border:1px solid var(--dsw-alias-border-l2,#33455a);background:transparent;box-sizing:border-box}
.yh-olap-tab:hover{border-color:var(--dsw-alias-label-secondary,#7a8ba0);color:var(--dsw-alias-label-primary,#cdd7e0)}
.yh-olap-tab.on{color:var(--yh-ui-ondark);background:var(--yh-ui-brand);border-color:var(--yh-ui-brand);font-weight:500}
.yh-olap-tab.on:hover{color:var(--yh-ui-ondark);border-color:var(--yh-ui-brand)}
.yh-olap-tab-add{flex:0 0 auto;height:24px;min-width:24px;padding:0 6px;font-size:12px;background:transparent;border:1px solid var(--dsw-alias-border-l2,#33455a);color:var(--dsw-alias-label-secondary,#7a8ba0);border-radius:8px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center}
.yh-olap-tab-add:hover{color:var(--dsw-alias-label-primary,#cdd7e0);background:var(--dsw-alias-bg-layer-2,#1d2633)}
.yh-olap-view{flex:1;overflow:hidden;min-height:0;overscroll-behavior:contain;position:relative}
.yh-olap-reswrap{position:absolute;inset:0;overflow:auto;padding:8px 10px;box-sizing:border-box}
.yh-olap-reswrap thead th{position:sticky;top:-8px;z-index:10;background:var(--dsw-alias-bg-layer-1,#1a2230)}
.yh-olap-scroll{position:absolute;inset:0;overflow:auto;padding:8px 10px;box-sizing:border-box}
.yh-olap-log{position:absolute;inset:0;overflow:auto;padding:8px 10px;box-sizing:border-box;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;color:var(--dsw-alias-label-primary,#b9c6d4);margin:0}
.yh-olap-log-line{white-space:pre-wrap;line-height:1.5;word-break:break-all}
.yh-olap-log-line.err{color:#ff6b6b}
.yh-olap-table{width:100%;border-collapse:separate;border-spacing:0;font-size:12px}
.yh-olap-table th,.yh-olap-table td{border-right:1px solid var(--dsw-alias-border-l1,#2a3646);border-bottom:1px solid var(--dsw-alias-border-l1,#2a3646);padding:4px 8px;text-align:left;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;line-height:18px}
.yh-olap-table thead th{background:var(--dsw-alias-bg-layer-1,#1a2230);color:var(--dsw-alias-label-primary,#d7e2ee);position:sticky;top:-8px;z-index:6;box-shadow:inset 0 -1px 0 var(--dsw-alias-border-l2,#3a4a60);border-bottom:1px solid var(--dsw-alias-border-l2,#3a4a60)}
.yh-olap-table thead th:last-child,.yh-olap-table tbody td:last-child{border-right:none}
.yh-olap-table tbody td{background:var(--dsw-alias-bg-base,#0f141a)}
.yh-olap-table tbody tr:nth-child(even) td{background:var(--dsw-alias-bg-layer-2,#131a23)}
.yh-olap-ltree{flex:1;overflow:auto;min-height:0;padding:4px 0}
.yh-olap-tabs2{flex:0 0 34px;display:flex;align-items:flex-end;gap:10px;padding:0 10px;border-bottom:1px solid var(--dsw-alias-border-l1,#242d3a)}
.yh-olap-tabs2 span{flex:0 0 auto;font-size:13px;font-weight:500;padding:0 0 11px;color:var(--dsw-alias-label-secondary,#81858c);cursor:pointer;position:relative;line-height:1}
.yh-olap-tabs2 span.on{color:var(--yh-ui-brand)}
.yh-olap-tabs2 span.on::after{content:'';position:absolute;left:0;right:0;bottom:0;height:2px;background:var(--yh-ui-brand)}
.yh-olap-node{display:flex;align-items:center;gap:4px;padding:1px 6px;line-height:17px;cursor:pointer;white-space:nowrap;color:var(--dsw-alias-label-primary,#b9c6d4)}
.yh-olap-node:hover{background:var(--dsw-alias-bg-layer-1,#1a2230)}
.yh-olap-node .tw{color:var(--dsw-alias-label-secondary,#557);display:inline-block;flex:0 0 14px;width:14px;text-align:center}
.yh-olap-node .yh-olap-ic{flex:0 0 auto;margin-right:2px;font-size:11px;color:var(--dsw-alias-label-secondary,#7a8ba0)}
.yh-olap-node .yh-olap-fname{color:var(--dsw-alias-label-primary,#e8eef5)}
.yh-olap-node .yh-olap-ftype{color:var(--dsw-alias-label-secondary,#7a8ba0);font-size:10.5px;margin-left:2px;flex:0 0 auto}
.yh-olap-node .yh-olap-fcmt{color:var(--dsw-alias-label-secondary,#5a6a7a);font-size:11px;margin-left:4px;overflow:hidden;text-overflow:ellipsis;flex:1 1 auto}
.yh-olap-complete{position:fixed;z-index:99999;background:var(--dsw-alias-bg-overlay,#1b2431);border:1px solid var(--dsw-alias-border-l2,#33455a);border-radius:6px;box-shadow:0 6px 20px rgba(0,0,0,.4);max-height:260px;overflow:auto;min-width:180px}
.yh-olap-complete div{padding:5px 10px;cursor:pointer;font-size:12.5px;color:var(--dsw-alias-label-primary,#d7e2ee);display:flex;justify-content:space-between;gap:14px}
.yh-olap-complete div.sel{background:var(--yh-ui-brand);color:var(--yh-ui-ondark)}
.yh-olap-complete div.sel .k,.yh-olap-complete div.sel .d{color:var(--yh-ui-ondark)}
.yh-olap-complete .k{color:var(--dsw-alias-label-primary,#e8eef5)}
.yh-olap-complete .d{color:var(--dsw-alias-label-secondary,#7a8ba0);font-size:11px}
.yh-olap-mask{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:99998;display:flex;align-items:center;justify-content:center}
.yh-olap-modal{width:340px;max-width:92vw;background:var(--dsw-alias-bg-overlay,#171d26);border:1px solid var(--dsw-alias-border-l2,#33455a);border-radius:8px;padding:14px;color:var(--dsw-alias-label-primary,#d7e2ee);box-shadow:0 10px 40px rgba(0,0,0,.5)}
.yh-olap-modal h4{margin:0 0 10px;font-size:13px}
.yh-olap-modal input{display:block;width:100%;box-sizing:border-box;height:26px;margin-bottom:6px;padding:0 6px;font-size:12px;border-radius:4px;border:1px solid var(--dsw-alias-border-l2,#33455a);background:var(--dsw-alias-bg-layer-2,#1d2633);color:var(--dsw-alias-label-primary,#cdd7e0);outline:none}
.yh-olap-prow{display:flex;align-items:center;gap:8px;margin-bottom:6px}
.yh-olap-prow .yh-olap-plabel{flex:0 0 96px;font-size:12px;font-family:ui-monospace,Menlo,Consolas,monospace;color:var(--dsw-alias-label-secondary,#7a8ba0);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.yh-olap-prow input{flex:1 1 auto;width:auto;margin-bottom:0}
.yh-olap-dirlabel{font-size:11px;color:var(--dsw-alias-label-secondary,#7a8ba0);margin:2px 0 4px}
.yh-olap-dirs{max-height:168px;overflow:auto;border:1px solid var(--dsw-alias-border-l2,#33455a);border-radius:6px;background:var(--dsw-alias-bg-layer-2,#1d2633);padding:3px 0}
.yh-olap-dirrow{display:flex;align-items:center;gap:2px;padding:2px 8px 2px 6px;cursor:pointer;font-size:12px;line-height:17px;color:var(--dsw-alias-label-primary,#d7e2ee);white-space:nowrap}
.yh-olap-dirrow:hover{background:var(--dsw-alias-bg-layer-1,#1a2230)}
.yh-olap-dirrow .tw{flex:0 0 14px;width:14px;text-align:center;color:var(--dsw-alias-label-secondary,#7a8ba0)}
.yh-olap-dirrow .nm{flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;min-width:0}
.yh-olap-dirrow.sel{background:var(--yh-ui-brand-weak)}
.yh-olap-dirrow.sel .nm,.yh-olap-dirrow.sel .ck{color:var(--yh-ui-brand)}
.yh-olap-dirrow .ck{flex:0 0 auto;color:var(--yh-ui-brand);font-weight:700;margin-left:4px}
.yh-olap-dirpath{font-size:11px;color:var(--dsw-alias-label-secondary,#7a8ba0);margin-top:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.yh-olap-modal button{flex:1;height:28px;border-radius:4px;border:1px solid var(--dsw-alias-border-l2,#33455a);background:var(--dsw-alias-bg-layer-2,#1d2633);color:var(--dsw-alias-label-primary,#d7e2ee);cursor:pointer;font-size:12.5px}
.yh-olap-modal button.pri{background:var(--yh-ui-brand);border-color:var(--yh-ui-brand);color:var(--yh-ui-ondark)}
.yh-olap-modal .row{display:flex;gap:8px}
.yh-olap-accmodal{width:480px}
.yh-olap-accadd{display:flex;gap:6px;align-items:center}
.yh-olap-accadd input{flex:1;min-width:0}
.yh-olap-hint{color:var(--dsw-alias-label-secondary,#7a8ba0);font-size:12px;padding:6px 10px}
.yh-olap-toast{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:rgba(24,34,48,.94);color:var(--yh-ui-ondark);padding:7px 16px;border-radius:8px;z-index:99999;font-size:12.5px;box-shadow:0 4px 16px rgba(0,0,0,.4);border:1px solid rgba(255,255,255,.12);animation:yhToastIn .18s ease-out}
@keyframes yhToastIn{from{opacity:0;transform:translateX(-50%) translateY(8px)}to{opacity:1;transform:translateX(-50%) translateY(0)}}
.yh-olap-tab .tabx{display:inline-block;margin-left:6px;padding:0 4px;color:var(--dsw-alias-label-secondary,#7a8ba0);border-radius:3px}
.yh-olap-tab .tabx:hover{color:var(--yh-ui-ondark);background:var(--yh-ui-danger)}
.yh-olap-tab-inp{height:20px;padding:0 6px;font-size:12px;background:var(--dsw-alias-bg-layer-2,#10161d);color:var(--dsw-alias-label-primary,#d7dee6);border:1px solid var(--yh-ui-brand);border-radius:3px;outline:none;min-width:60px}
.yh-olap-modechip-wrap{display:inline-flex;align-items:center}
.yh-olap-modechip{display:inline-flex;align-items:center;gap:4px;min-width:34px;padding:2px 8px;border:none;border-radius:999px;background:var(--dsw-alias-state-warn-tertiary,rgba(215,160,74,.15));color:var(--dsw-alias-state-warn-label,#d7a04a);font-size:13px;font-weight:500;line-height:20px;cursor:pointer;white-space:nowrap}
.yh-olap-modechip:hover:not(:disabled){color:var(--dsw-alias-state-warn-primary,#e6b35c)}
.yh-olap-modechip:disabled{opacity:.6;cursor:default}
.yh-olap-modechip-x{margin-left:2px;font-size:13px;line-height:1;display:inline-flex;align-items:center;color:currentColor}`

    // ===== WORKSTATION: 工作站布局 + 历史会话 组件样式 =====
    const WORKSTATION_CSS = `
/* 工作站布局：OLAP(rightbar) 中、会话(main) 右、默认侧栏隐藏、拖动条隐藏。
   .yh-ws-frame 由 wsApplyLayout() 动态加到 AppFrame 根元素（class 名被 css-module 哈希，用属性/结构选中）。
   新版 DSH 的 AppFrame 仍是三列（sidebarCol|centerCol(main)|rightbarCol），第 3 个子的
   rightbarCol 就是 OLAP 面板所在列，故下面的 nth-child 定位与旧 details 版完全一致。 */
.yh-ws-frame{grid-template-columns:var(--yh-ws-sidebar-w,0px) var(--yh-ws-cols,minmax(0,2fr) minmax(340px,1fr)) !important;transition:none !important}
.yh-ws-frame>div:nth-child(1){grid-column:1 !important;grid-row:1 !important}
.yh-ws-frame>div:nth-child(2){grid-column:3 !important;grid-row:1 !important}
.yh-ws-frame>div:nth-child(3){grid-column:2 !important;grid-row:1 !important;border-left:none !important;border-right:1px solid var(--dsw-alias-border-l1,#242d3a) !important}
.yh-ws-frame>div[data-shell-overlay]{grid-column:1/-1 !important}
.yh-ws-frame [data-side]{display:none !important}
/* 对话区宽度可调：分隔条挂在 shell.overlay 层（覆盖全 frame、pointer-events:auto），绝对定位在 OLAP/对话区边界 */
.yh-ws-divider{position:absolute;top:0;bottom:0;width:8px;margin-left:-4px;cursor:col-resize;z-index:30;background:transparent}
.yh-ws-divider::after{content:'';position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:6px;height:44px;border-radius:8px;background:var(--dsw-alias-border-l2,#33455a);opacity:0;transition:opacity .15s,background .15s;pointer-events:none}
.yh-ws-divider:hover::after,.yh-ws-divider.dragging::after{opacity:1;background:var(--yh-ui-brand)}
.yh-ws-ktools{display:flex;gap:6px;align-items:center;padding:6px 8px;flex-wrap:wrap}
.yh-ws-ktools input{flex:1;min-width:0;height:24px;padding:0 8px;font-size:12px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2,#33455a);background:var(--dsw-alias-bg-layer-2,#1d2633);color:var(--dsw-alias-label-primary,#cdd7e0);outline:none}
.yh-ws-ktools button{height:24px;padding:0 10px;font-size:12px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2,#33455a);background:var(--dsw-alias-bg-layer-2,#1d2633);color:var(--dsw-alias-label-primary,#cdd7e0);cursor:pointer}
.yh-ws-ktools button.pri{background:var(--yh-ui-brand);border-color:var(--yh-ui-brand);color:var(--yh-ui-ondark)}
.yh-ws-wsact{display:inline-flex;height:24px;padding:0 10px;font-size:12px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2,#33455a);background:var(--dsw-alias-bg-layer-2,#1d2633);color:var(--dsw-alias-label-primary,#cdd7e0);cursor:pointer}
.yh-ws-wsact.pri{background:var(--yh-ui-brand);border-color:var(--yh-ui-brand);color:var(--yh-ui-ondark)}
.yh-ws-cmenu{position:fixed;z-index:99999;min-width:130px;background:var(--dsw-alias-bg-overlay,#1b2431);border:1px solid var(--dsw-alias-border-l2,#33455a);border-radius:8px;box-shadow:0 6px 20px rgba(0,0,0,.4);overflow:hidden;font-size:12.5px;color:var(--dsw-alias-label-primary,#d7e2ee)}
.yh-ws-cmenu div{padding:6px 12px;cursor:pointer}
.yh-ws-cmenu div:hover{background:var(--dsw-alias-bg-layer-2,#1d2633)}
.yh-olap-modal textarea{display:block;width:100%;box-sizing:border-box;min-height:120px;margin-bottom:8px;padding:6px 8px;font-size:12px;border-radius:4px;border:1px solid var(--dsw-alias-border-l2,#33455a);background:var(--dsw-alias-bg-layer-2,#1d2633);color:var(--dsw-alias-label-primary,#cdd7e0);outline:none;font-family:ui-monospace,Menlo,Consolas,monospace;resize:vertical}
`

    injectCss(CSS + WORKSTATION_CSS)
    // ===== WORKSTATION: 布局尽早生效（AppFrame 挂载前后都试，OlapPanel 轮询也会补）=====
    wsApplyLayout()
    setTimeout(wsApplyLayout, 800)
    window.addEventListener('load', wsApplyLayout)

    const TYPE_DESC = { '库': 'db', '表': 'tbl', '字段': 'col', '关键字': 'kw', '函数': 'fn', '别名': 'alias' }
    function typeDesc(d) {
      if (!d) return ''
      return TYPE_DESC[d] || d
    }
    // ===== WORKSTATION: 按引擎词表（impala 3.4 实测 / hive 3.1 标准+抽样；其余引擎用通用 SQL）=====
    // 关键字：三套差异小，保留通用 + 补引擎特有；函数：impala 为实测清单，hive 为 Hive 3.1 标准清单（抽样验证）。
    const SQL_COMMON_KEYS = 'select from where group by order limit insert into values update set delete create table drop alter join inner left right full outer on as and or not in is null like between case when then else end union all distinct having partition over'
    const SQL_COMMON_FUNCS = 'count sum avg min max round coalesce cast substr substring concat concat_ws upper lower trim datediff date_add date_sub year month day now current_date to_date from_unixtime unix_timestamp nvl if'
// ===== WORKSTATION: 按引擎精确关键字（impala 3.4 / hive 3.1 官方 reserved+常用关键字；逗号分隔，支持多词关键字）=====
    const IMPALA_KEYS = (
      'select,from,where,group by,order by,having,limit,offset,union all,distinct,'
      + 'insert into,values,overwrite,update,delete,with,as,create table,alter,drop,'
      + 'truncate,describe,desc,show,use,set,join,inner join,left join,right join,'
      + 'full outer join,cross join,left semi join,left anti join,on,using,and,or,not,in,'
      + 'is,null,like,ilike,rlike,regexp,between,exists,case,when,'
      + 'then,else,end,cast,if,coalesce,nvl,nullif,partition by,over,'
      + 'rows,range,unbounded,preceding,following,current row,compute stats,refresh,invalidate metadata,kudu,'
      + 'explain,profile,grant,revoke,primary key,foreign key,unique,format,parquet,orc,'
      + 'avro,textfile,sequencefile,jsonfile,transaction,transactional,acid,restrict,cascade,comment,'
      + 'properties,serdeproperties,tblproperties,into path,load data,show databases,show schemas,show tables,show columns,show functions,'
      + 'analyze,insert,count,sum,avg,min,max,aggregate,'
      ).split(',')
    const HIVE_KEYS = (
      'select,from,where,group by,having,order by,limit,offset,cluster by,distribute by,'
      + 'sort by,union all,insert into,insert overwrite,table,values,create database,create schema,create table,create view,'
      + 'create index,create function,create macro,alter,drop,truncate,describe,desc,show,use,'
      + 'set,add jar,add file,add archive,join,inner join,left join,right join,full outer join,cross join,'
      + 'left semi join,on,using,and,or,not,in,is,null,like,'
      + 'rlike,regexp,between,exists,case,when,then,else,end,cast,'
      + 'partition by,clustered by,sorted by,into buckets,lateral view,explode,posexplode,inline,stack,stored as,'
      + 'orc,parquet,avro,textfile,sequencefile,rcfile,jsonfile,row format,serde,fields terminated by,'
      + 'lines terminated by,collection,map keys,location,comment,tblproperties,serdeproperties,if,coalesce,nvl,'
      + 'nullif,over,rows,range,unbounded,preceding,following,current row,with,as,'
      + 'export,import,msck repair,analyze,grant,revoke,transaction,transactional,distinct,all,'
      + 'date,timestamp,decimal,array,map,struct,load data,local,inpath,primary key,'
      + 'foreign key,'
      ).split(',')
// ===== WORKSTATION: impala 3.4 / hive 3.1 实测可用函数清单（2026-09-01 逐函数 olap.run 实测；页面清单仅参考，以实际执行为准）=====
    const IMPALA_FUNCS = (
          + 'abs acos add_months appx_median ascii asin atan avg bin bitand bitnot bitor bitxor cast'
          + 'ceil ceiling char_length character_length chr coalesce concat concat_ws conv cos count countset cume_dist current_date current_database'
          + 'current_timestamp current_user date_add date_sub date_trunc datediff day dayname dayofmonth dayofweek dayofyear degrees dense_rank e'
          + 'exp extract factorial find_in_set first_value floor from_unixtime from_utc_timestamp get_json_object greatest group_concat hex hour if'
          + 'initcap instr lag last_day last_value lcase lead least length levenshtein ln locate log log10'
          + 'log2 logged_in_user lower lpad ltrim mask mask_first_n mask_hash mask_last_n mask_show_first_n mask_show_last_n max min minute'
          + 'mod month months_between ndv negative now ntile nullif nvl parse_url percent_rank pi pmod positive'
          + 'pow power quarter radians rand rank round row_number second shiftleft shiftright sign sin split_part'
          + 'sqrt stddev_pop stddev_samp sum tan to_date to_utc_timestamp trunc unhex unix_timestamp uuid var_pop var_samp variance'
          + 'version weekofyear width_bucket year'
      ).split(' ')
    const HIVE_FUNCS = (
          + 'abs acos add_months adddate array array_contains ascii asin atan atan2 avg base64decode base64encode bin'
          + 'btrim cast ceil ceiling char_length character_length chr coalesce collect_list collect_set concat concat_ws conv corr'
          + 'cos cosh cot count crc32 cume_dist current_database current_date current_timestamp current_user date_add date_format date_part date_sub'
          + 'datediff day dayofmonth dayofweek days_add days_sub dceil decode degrees dense_rank dexp dfloor dlog1 dpow'
          + 'dround dsqrt dtrunc e exp explode extract factorial find_in_set first_value floor fmod fnv_hash fpow'
          + 'from_timestamp from_unixtime from_utc_timestamp get_json_object greatest hex hour hours_add hours_sub if initcap instr int_months_between is_inf'
          + 'is_nan isfalse isnotfalse isnottrue isnull istrue json_tuple lag last_day last_value lcase lead least length levenshtein'
          + 'ln locate log log10 log2 logged_in_user lower lpad ltrim map map_keys max max_bigint max_int'
          + 'max_smallint max_tinyint md5 microseconds_add min min_bigint min_int min_smallint min_tinyint minute minutes_add mod month months_add'
          + 'months_between murmur_hash named_struct negative next_day nonnullvalue ntile nullif nullvalue nvl parse_url percent_rank percentile pi'
          + 'pmod posexplode positive pow power precision printf quarter quotient radians rand rank regexp_extract regexp_replace'
          + 'repeat replace reverse round row_number rpad rtrim second seconds_add sentences shiftleft shiftright sha2 sign sin size'
          + 'sort_array soundex space split split_part sqrt stack stddev stddev_pop stddev_samp str_to_map substr substring substring_index'
          + 'sum tan to_date to_utc_timestamp translate trim trunc ucase unhex unix_timestamp upper user uuid var_pop'
          + 'var_samp variance variance_pop variance_samp version weekofyear width_bucket year years_add'
      ).split(' ')
    // 引擎 → 词表；'2'=impala、'1'=hive，其余回退通用
    // ===== WORKSTATION: 关键字集合展开 —— 多词关键字（group by 等）保留完整条目，同时展开单词供高亮逐词匹配 =====
    function expandKeys(list) {
      const set = new Set()
      list.forEach(function (k) {
        if (!k) return
        set.add(k)
        String(k).split(' ').forEach(function (w) { if (w) set.add(w) })
      })
      return set
    }
    const ENGINE_WORDS = {
      '2': { keys: expandKeys(IMPALA_KEYS), funcs: new Set(IMPALA_FUNCS) },
      '1': { keys: expandKeys(HIVE_KEYS), funcs: new Set(HIVE_FUNCS) },
      'default': { keys: new Set(SQL_COMMON_KEYS.split(' ')), funcs: new Set(SQL_COMMON_FUNCS.split(' ')) },
    }
    function engineWords(engine) { return ENGINE_WORDS[String(engine)] || ENGINE_WORDS.default }
    // 当前活动 tab 的引擎词表（高亮/补全共用）
    function activeEngineWords(st) {
      const t = activeTab(st)
      return engineWords(t && t.engine)
    }

    function toArray(x) { return Array.isArray(x) ? x : [] }
    function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') }
    function fmtLog(s) { return String(s == null ? '' : s).replace(/<br\s*\/?>/gi, '\n').replace(/&nbsp;/gi, ' ') }

    function tokenize(sql, engine) {
      const ew = engineWords(engine)
      const parts = []
      let i = 0
      const n = sql.length
      while (i < n) {
        const rest = sql.slice(i)
        let m
        if ((m = rest.match(/^--[^\n]*/))) { parts.push(['c', m[0]]); i += m[0].length; continue }
        if ((m = rest.match(/^'[^']*'|^"[^"]*"/))) { parts.push(['s', m[0]]); i += m[0].length; continue }
        if ((m = rest.match(/^\$\{[^}]*\}/))) { parts.push(['p', m[0]]); i += m[0].length; continue }
        if ((m = rest.match(/^\d+(\.\d+)?/))) { parts.push(['n', m[0]]); i += m[0].length; continue }
        if (/[A-Za-z_\u4e00-\u9fa5]/.test(rest[0])) {
          m = rest.match(/^[A-Za-z0-9_\u4e00-\u9fa5]+/)
          const w = m[0]
          const lower = w.toLowerCase()
          if (ew.keys.has(lower)) parts.push(['k', w])
          else if (ew.funcs.has(lower)) parts.push(['f', w])
          else parts.push(['i', w])
          i += w.length
          continue
        }
        parts.push(['x', rest[0]]); i += 1
      }
      return parts
    }
    function highlight(sql, engine, breaks) {
      const color = { k: 'var(--yh-k)', f: 'var(--yh-f)', s: 'var(--yh-s)', p: 'var(--yh-p)', n: 'var(--yh-n)', i: 'var(--yh-i)', c: 'var(--yh-c)', x: 'var(--yh-x)' }
      const parts = tokenize(sql, engine)
      const colorOf = function (kind) { return color[kind] || 'var(--yh-i)' }
      if (!breaks || !breaks.length) {
        return parts.map(function (tk, i) { return h('span', { key: i, style: { color: colorOf(tk[0]) } }, tk[1]) })
      }
      // 按实测断点切分 token 并插 <br>（<br> 不带文本 → textContent 不变，查找高亮的偏移映射不受影响）
      const out = []
      let off = 0, bi = 0
      for (let i = 0; i < parts.length; i++) {
        const kind = parts[i][0], text = parts[i][1]
        const end = off + text.length
        let s = 0
        while (bi < breaks.length && breaks[bi] <= end) {
          const cut = breaks[bi] - off
          if (cut > s && cut <= text.length) out.push(h('span', { key: 'k' + i + '_' + s, style: { color: colorOf(kind) } }, text.slice(s, cut)))
          out.push(h('br', { key: 'b' + bi }))
          s = cut
          bi++
        }
        if (s < text.length) out.push(h('span', { key: 'k' + i + '_' + s, style: { color: colorOf(kind) } }, text.slice(s)))
        off = end
      }
      return out
    }

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
        paramModalFor: false, accManage: false, dlDetail: null, collectSaveFor: false, fullscreen: false,
        editingTab: null, editingName: '', toast: '',
        mcursors: [],
        // ===== WORKSTATION: 查找替换小部件状态（VSCode 风格，per-session 隔离，换 tab 保留）=====
        // open=显示 findbox；showRep=展开替换行；q/rep=查找/替换文本；caseS/word/re=三开关；
        // pos=当前匹配锚点字符位（当前匹配=首个 start>=pos 的匹配，导航/替换时更新）；focusTick=请求聚焦输入框
        findBox: { open: false, showRep: false, q: '', rep: '', caseS: false, word: false, re: false, pos: 0, focusTick: 0 },
        // ===== WORKSTATION: 便签 状态 =====
        noteModalFor: false, noteText: '',
        // ===== WORKSTATION: 通用对话框（自绘 confirm/input，替代 window.confirm/prompt）=====
        // { kind:'confirm'|'input', title, message, value?, okLabel?, onOk } —— onOk 收到输入值/true
        dlg: null,
        __colsLoading: false,
        wsTree: null, wsTreeLoaded: false,
      }
    }

    const toastTimers = {}
    function showToast(st, msg) {
      st.toast = msg
      if (toastTimers[st.__id]) clearTimeout(toastTimers[st.__id])
      toastTimers[st.__id] = setTimeout(function () { st.toast = ''; emitStore(st.__id) }, 3000)
      emitStore(st.__id)
    }

    // 把文本追加到聊天输入框（React 受控 textarea：原生 value setter + input 事件）
    function fillComposer(text) {
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
    function copyToClipboard(text) {
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(text); return true }
        const ta = document.createElement('textarea')
        ta.value = text
        ta.style.position = 'fixed'; ta.style.opacity = '0'
        document.body.appendChild(ta); ta.select()
        const ok = document.execCommand('copy')
        document.body.removeChild(ta)
        return ok
      } catch (e) { return false }
    }
    // 引用编辑器选中片段：以「标签#id + 行区间」块形式插入聊天框。
    // 模型收到展开文本 @olapN:Lx-y 后，用 olap state {tabId, lines:[x,y]} 精确读该段。
    // label 用行号摘要（短小、不占上下文），完整 SQL 由模型按需读取（渐进披露）。
    function referSelection(tab, selStart, selEnd, st) {
      if (!tab || selStart === undefined || selEnd === undefined || selEnd <= selStart) return false
      const sid = activePanelSid || (st && st.__id) || null
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
      try {
        const conv = ctx.get('conversation')
        const sessionsSvc = ctx.get('sessions')
        if (conv && conv.input && sessionsSvc && sid && typeof sessionsSvc.scope === 'function') {
          const actx = sessionsSvc.scope(sid)
          const input = actx ? conv.input.for(actx) : undefined
          const snap = input && input.state ? input.state.getSnapshot() : undefined
          const draft = (snap && snap.draft) || ''
          const span = { start: draft.length, end: draft.length, draftRev: snap ? snap.draftRev : 0 }
          const reference = { source: 'olap', ref: rangeRef, label: label, clipboardText: '@' + rangeRef }
          if (input && typeof input.insertReference === 'function') {
            done = input.insertReference(reference, span) === true
          }
        }
      } catch (e) { done = false }
      if (done) { showToast(st, '已引用选中片段 ' + label + '（聊天框内显示为块）'); return true }
      // 兜底：纯文本引用
      const ref = '@' + rangeRef
      if (fillComposer(ref)) { showToast(st, '已添加选中片段引用 ' + ref); return true }
      else if (copyToClipboard(ref)) { showToast(st, '已复制 ' + ref + '，粘贴到聊天框即可（会显示为块）'); return true }
      return false
    }

    function referTab(t, st) {
      // ===== WORKSTATION: 引用插入真正的 occurrence 块（与 @olap 菜单 onPick 同款 ReferenceInsert）。
      // label 用标签名（任意文本，含中文/空格），块在 composer 中显示为 chip；
      // 提交时经 codec.serialize('olap'+id) 展开成 @olapN 给模型。
      // 不走旧的纯文本 + textRef 扫描路径：框架扫描正则只认 [\w-]+，中文名永远无法靠 lexicon 装饰成块。
      // =====
      const sid = activePanelSid || (st && st.__id) || null
      let done = false
      try {
        const conv = ctx.get('conversation')
        const sessionsSvc = ctx.get('sessions')
        if (conv && conv.input && sessionsSvc && sid && typeof sessionsSvc.scope === 'function') {
          const actx = sessionsSvc.scope(sid)
          const input = actx ? conv.input.for(actx) : undefined
          const snap = input && input.state ? input.state.getSnapshot() : undefined
          const draft = (snap && snap.draft) || ''
          const span = { start: draft.length, end: draft.length, draftRev: snap ? snap.draftRev : 0 }
          const reference = { source: 'olap', ref: 'olap' + t.id, label: t.name || ('Tab' + t.id), clipboardText: '@olap' + t.id }
          if (input && typeof input.insertReference === 'function') {
            done = input.insertReference(reference, span) === true
          }
        }
      } catch (e) { done = false }
      if (done) { showToast(st, '已添加标签引用 @' + (t.name || ('Tab' + t.id)) + '（聊天框内显示为块）'); return }
      // 兜底：拿不到输入 shell / 正在提交不可插入时，退回纯文本或复制
      const nm = /^[\w-]+$/.test(t.name || '') ? t.name : ('Tab' + t.id)
      const ref = '@' + nm
      if (fillComposer(ref)) showToast(st, '已添加标签引用 ' + ref + '（聊天框内显示为块）')
      else if (copyToClipboard(ref)) showToast(st, '已复制 ' + ref + '，粘贴到聊天框即可（会显示为块）')
      else showToast(st, '复制失败，请手动输入：' + ref)
    }

    // —— 编辑器键盘辅助（Tab 缩进 / Shift+Tab 减缩进 / Cmd+/(Ctrl+/) 注释）——
    // 受控 textarea：原生 value setter + input 事件，触发 React onInput → tab.sql 更新
    function setTaValue(ta, val, selStart, selEnd) {
      const proto = window.HTMLTextAreaElement && window.HTMLTextAreaElement.prototype
      const d = proto && Object.getOwnPropertyDescriptor(proto, 'value')
      if (d && d.set) d.set.call(ta, val); else ta.value = val
      if (selStart !== undefined) { ta.selectionStart = selStart; ta.selectionEnd = selEnd !== undefined ? selEnd : selStart }
      // ===== WORKSTATION: 程序性写入 textarea（缩进/注释/补全应用/多光标同步）→ 非键盘输入，不弹补全 =====
      wsNonKeyInput = true
      ta.dispatchEvent(new Event('input', { bubbles: true }))
    }
    // 缩进 4 空格：无选区时只在光标处插入 4 空格；选中多行时整行缩进
    function indentSel(ta) {
      const s = ta.selectionStart, e = ta.selectionEnd, val = ta.value
      if (s === e) {
        setTaValue(ta, val.slice(0, s) + '    ' + val.slice(e), s + 4, s + 4)
        return
      }
      const ls = val.lastIndexOf('\n', s - 1) + 1
      const le = val.indexOf('\n', e); const end = le === -1 ? val.length : le
      const seg = val.slice(ls, end)
      const out = seg.split('\n').map(function (l) { return '    ' + l }).join('\n')
      setTaValue(ta, val.slice(0, ls) + out + val.slice(end), ls, ls + out.length)
    }
    // 减缩进：无选区时删光标前 4 空格；选中多行时整行减一级
    function outdentSel(ta) {
      const s = ta.selectionStart, e = ta.selectionEnd, val = ta.value
      if (s === e) {
        if (val.slice(s - 4, s) === '    ') setTaValue(ta, val.slice(0, s - 4) + val.slice(e), s - 4, s - 4)
        return
      }
      const ls = val.lastIndexOf('\n', s - 1) + 1
      const le = val.indexOf('\n', e); const end = le === -1 ? val.length : le
      const seg = val.slice(ls, end)
      const out = seg.split('\n').map(function (l) { return l.indexOf('    ') === 0 ? l.slice(4) : l }).join('\n')
      setTaValue(ta, val.slice(0, ls) + out + val.slice(end), ls, ls + out.length)
    }
    // 单行注释（-- 前缀；SQL 风格），再按一次取消
    function toggleLineComment(ta) {
      const s = ta.selectionStart, e = ta.selectionEnd, val = ta.value
      const ls = val.lastIndexOf('\n', s - 1) + 1
      const le = val.indexOf('\n', e); const end = le === -1 ? val.length : le
      const lines = val.slice(ls, end).split('\n')
      const allCommented = lines.length > 0 && lines.every(function (l) { return /^\s*--/.test(l) })
      const out = lines.map(function (l) { return allCommented ? l.replace(/^(\s*)--\s?/, '$1') : '-- ' + l }).join('\n')
      setTaValue(ta, val.slice(0, ls) + out + val.slice(end), ls, ls + out.length)
    }
    // 多行块注释（/* ... */），选中内容时包裹/解除；无选中时插入 /**/ 光标居中
    function toggleBlockComment(ta) {
      const s = ta.selectionStart, e = ta.selectionEnd, val = ta.value
      const sel = val.slice(s, e)
      if (/^\s*\/\*[\s\S]*\*\/\s*$/.test(sel)) {
        const out = sel.replace(/^\s*\/\*\s?/, '').replace(/\s?\*\/\s*$/, '')
        setTaValue(ta, val.slice(0, s) + out + val.slice(e), s, s + out.length)
      } else if (sel) {
        setTaValue(ta, val.slice(0, s) + '/* ' + sel + ' */' + val.slice(e), s, s + sel.length + 6)
      } else {
        setTaValue(ta, val.slice(0, s) + '/**/' + val.slice(e), s + 2, s + 2)
      }
    }

    // ===== WORKSTATION: 编辑器查找替换（VSCode 风格）—— 纯函数部分 =====
    function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }
    function isWordChar(c) { return /[A-Za-z0-9_]/.test(c) }
    // 全字匹配边界：匹配串首尾字符外不能是 word char（首尾在文本边界视为边界）
    function isWordBoundary(sql, s, e) {
      if (s > 0 && isWordChar(sql[s - 1])) return false
      if (e < sql.length && isWordChar(sql[e])) return false
      return true
    }
    // 计算全部匹配：返回 [{start,end}]；正则非法返回 {error:true}
    function computeMatches(sql, q, opts) {
      const text = String(sql || '')
      if (!q) return []
      const out = []
      if (opts.re) {
        let re
        try { re = new RegExp(q, opts.caseS ? 'g' : 'gi') } catch (e) { return { error: true } }
        let guard = 0
        let m
        while ((m = re.exec(text))) {
          if (!opts.word || isWordBoundary(text, m.index, m.index + m[0].length)) out.push({ start: m.index, end: m.index + m[0].length })
          if (m[0].length === 0) re.lastIndex++ // 零宽匹配（如 a*）前进一位防死循环
          if (++guard > 20000 || out.length > 5000) break
        }
      } else {
        const hay = opts.caseS ? text : text.toLowerCase()
        const needle = opts.caseS ? q : q.toLowerCase()
        let i = 0
        while (out.length <= 5000) {
          i = hay.indexOf(needle, i)
          if (i === -1) break
          const end = i + q.length
          if (!opts.word || isWordBoundary(text, i, end)) out.push({ start: i, end: end })
          i = end // 非重叠推进（同 VSCode 字面量行为）
        }
      }
      return out
    }
    // 匹配区间 → 高亮矩形（支持软换行/跨行）：起点 cursorXY 锚定，之后逐字符增量推进，
    // 行宽超 usableW 折到下一视觉行；遇 \n 用 cursorXY 重新锚定下一逻辑行（防累计误差）。
    // 返回 [{left,top,width,height}]，坐标系与 curline/mcur 一致（hl-inner 内容盒）。
    function matchRects(sql, s, e, uw) {
      const rects = []
      if (!(e > s)) return rects
      let xy = cursorXY(sql, s, uw)
      let segLeft = xy.x, segTop = xy.y - 3, segW = 0
      let used = xy.x - ED_PAD_LEFT // 当前视觉行已占宽（从行首算）
      const flush = function () { if (segW > 0) rects.push({ left: segLeft, top: segTop, width: segW, height: ED_LINE_H }) }
      for (let p = s; p < e; p++) {
        const ch = sql[p]
        if (ch === '\n') {
          flush(); segW = 0
          xy = cursorXY(sql, p + 1, uw)
          segLeft = xy.x; segTop = xy.y - 3; used = 0
          continue
        }
        const cw = chWidth(ch)
        if (used + cw > uw && cw <= uw) { // 软换行：折到下一视觉行（与 cursorXY 折行判定一致）
          flush(); segW = 0
          segLeft = ED_PAD_LEFT; segTop += ED_LINE_H; used = 0
        }
        if (segW === 0) segLeft = ED_PAD_LEFT + used
        used += cw; segW += cw
      }
      flush()
      return rects
    }

    // ===== WORKSTATION: 实测文本矩形 —— 用 Range.getClientRects 按浏览器真实断行/字宽测量，
    // 取代按字符宽估算（CJK 字宽并非精确 2×ASCII、pre-wrap 断点规则复杂，估算必然漂移；
    // CDP 实测：6 个中文字符后即偏 16px，长行软换行直接错行）。inner 为 .yh-olap-hl-inner，
    // 返回 [{left,top,width,height,cur}]（hl-inner 内容坐标，随 transform 滚动自动跟随）。=====
    function measureRectsIn(inner, matches, curIdx) {
      const spans = []
      let off = 0
      const walker = document.createTreeWalker(inner, NodeFilter.SHOW_TEXT, null)
      while (walker.nextNode()) {
        const n = walker.currentNode
        const pc = n.parentNode
        // 跳过覆盖层自身（findhit/curline/mcur 均为空节点，防御性跳过）
        if (pc && pc.classList && (pc.classList.contains('yh-olap-findhit') || pc.classList.contains('yh-olap-curline') || pc.classList.contains('yh-olap-mcur'))) continue
        spans.push({ node: n, start: off })
        off += n.textContent.length
      }
      if (!spans.length) return null
      const iRect = inner.getBoundingClientRect()
      const out = []
      matches.forEach(function (m, mi) {
        const s = m.start, e = m.end
        let a = null, b = null
        for (let k = 0; k < spans.length; k++) {
          const t = spans[k]
          const tEnd = t.start + t.node.textContent.length
          if (a === null && s >= t.start && s < tEnd) a = t
          if (b === null && e > t.start && e <= tEnd) b = t
          if (a && b) break
        }
        if (!a || !b) return
        const r = document.createRange()
        r.setStart(a.node, s - a.start)
        r.setEnd(b.node, e - b.start)
        const rc = r.getClientRects()
        for (let i = 0; i < rc.length; i++) {
          const q = rc[i]
          out.push({ left: q.left - iRect.left, top: q.top - iRect.top, width: q.width, height: q.height, cur: mi === curIdx })
        }
        r.detach()
      })
      return out
    }

    // —— 轻量多光标（Cmd/Ctrl+点击 添加光标，输入/退格/回车/粘贴同步到所有光标）——
    // 编辑器是等宽字体：13px/1.55 ui-monospace；行高 = 13*1.55 = 20.15px；padding 4px 4px 10px 4px
    const ED_PAD_TOP = 4, ED_PAD_LEFT = 4, ED_PAD_RIGHT = 4, ED_PAD_BOTTOM = 10, ED_LINE_H = 20.15
    let _charW = 0
    function charW() {
      if (_charW > 0) return _charW
      try {
        const sp = document.createElement('span')
        sp.textContent = 'M'
        sp.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;font:13px/1.55 ui-monospace,Menlo,Consolas,monospace'
        document.body.appendChild(sp)
        _charW = sp.getBoundingClientRect().width || 7.8
        document.body.removeChild(sp)
      } catch (e) { _charW = 7.8 }
      return _charW
    }
    function chWidth(ch) {
      if (ch === '\t') return 8 * charW()
      if (ch === '\n' || ch === '\r') return 0
      const code = ch.codePointAt(0)
      const wide = (code >= 0x2e80 && code <= 0x9fff) || (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xff00 && code <= 0xffef)
      return wide ? 2 * charW() : charW()
    }
    // ===== WORKSTATION: 软换行(wrap)下的视觉行计算 —— 等宽累积，usableW 为行可用像素宽 =====
    function usableWidthOf(ta) {
      if (!ta) return 400
      return Math.max(60, (ta.clientWidth || 400) - ED_PAD_LEFT - ED_PAD_RIGHT)
    }
    // ===== WORKSTATION: textarea 真实软换行断点测量（治「选区/光标与所见文字错位」）=====
    // 根因：Chrome 的 textarea 软换行与普通块(div/pre)换行并非同一套算法——CJK/引号/空格贴着
    // 换行宽时两者会差 1~2 行（实测扫 101 档宽度有 6 档分叉），而选区/光标是 textarea 画的、
    // 文字是覆盖层画的 → 从分叉行起整段错位。这里用与 textarea 同字体同宽的隐藏镜像 textarea
    // 二分测出每个逻辑行的真实断点，覆盖层按断点插 <br> 强制同断行（<br> 不改变 textContent，
    // 故查找高亮/偏移映射不受影响）。按「宽度+行文本」缓存，编辑时只重算改动的那一行。
    let breakMirror = null
    let breakMirrorSig = ''
    const breakCache = new Map()
    const BREAK_CACHE_MAX = 6000
    const NO_BREAKS = []
    // 镜像必须与 textarea 同字体/同换行参数；参数一变（首次挂载时样式可能还没生效）就重建并清缓存，
    // 否则会一直用错的度量算出错的断点（表现为选区/文字仍然错位）。
    function mirrorEnsure(ta) {
      const cs = window.getComputedStyle(ta)
      const sig = cs.font + '|' + cs.lineHeight + '|' + cs.letterSpacing + '|' + cs.wordSpacing + '|' + cs.wordBreak + '|' + cs.overflowWrap
      if (breakMirror && breakMirror.isConnected && breakMirrorSig === sig) return breakMirror
      const m = (breakMirror && breakMirror.isConnected) ? breakMirror : document.createElement('textarea')
      m.setAttribute('aria-hidden', 'true')
      m.tabIndex = -1
      m.style.cssText = 'position:absolute;left:-99999px;top:0;height:0;padding:4px 4px 10px 4px;border:0;outline:none;resize:none;overflow:hidden;box-sizing:border-box;white-space:pre-wrap;'
        + 'word-break:' + cs.wordBreak + ';overflow-wrap:' + cs.overflowWrap + ';'
        + 'font:' + cs.font + ';letter-spacing:' + cs.letterSpacing + ';word-spacing:' + cs.wordSpacing + ';line-height:' + cs.lineHeight 
      if (!m.isConnected) document.body.appendChild(m)
      breakMirror = m
      breakMirrorSig = sig
      breakCache.clear()
      return m
    }
    // 镜像里该文本占几个视觉行（height:0 + overflow:hidden 时 scrollHeight 即内容高 + 上下 padding）
    function mirrorRows(m, text) {
      m.value = text
      return Math.max(1, Math.round((m.scrollHeight - ED_PAD_TOP - ED_PAD_BOTTOM) / ED_LINE_H))
    }
    // 单个逻辑行的段末偏移数组（最后一项 = text.length）。
    // 关键：每次都以「行首起的前缀」测量（不从中间切片）——切片测得的行数之和会小于整行行数
    // （实测 2.sql 逐段 177 行 vs 整段 218 行），前缀测量与整行/textarea 一致。
    function lineBreakOffsets(m, text) {
      const n = text.length
      if (!n) return [0]
      const rowsAt = function (k) { return mirrorRows(m, text.slice(0, k)) }
      const total = rowsAt(n)
      const out = []
      let prev = 0
      for (let r = 1; r < total; r++) {
        // 最小的 k 使「前 k 个字符」占 r+1 行 → 第 r 行实际结束于 k-1（k-1 是放到下一行的首个字符）
        let lo = prev + 1, hi = n, best = n
        while (lo <= hi) {
          const mid = (lo + hi) >> 1
          if (rowsAt(mid) >= r + 1) { best = mid; hi = mid - 1 } else lo = mid + 1
        }
        const end = Math.max(prev + 1, best - 1)
        out.push(end)
        prev = end
      }
      out.push(n)
      return out
    }
    // 全 SQL 的软换行断点（每个新视觉行的起始字符偏移，升序）
    function measureSoftBreaks(sql, ta) {
      const s = String(sql || '')
      if (!s || !ta || s.length > 300000) return NO_BREAKS
      const width = ta.clientWidth || 0
      if (!width) return NO_BREAKS
      const m = mirrorEnsure(ta)
      m.style.width = width + 'px'
      const breaks = []
      const lines = s.split('\n')
      let off = 0
      for (let i = 0; i < lines.length; i++) {
        const ln = lines[i]
        if (ln) {
          const key = width + '\u0000' + ln
          let segs = breakCache.get(key)
          if (!segs) {
            segs = lineBreakOffsets(m, ln)
            if (breakCache.size >= BREAK_CACHE_MAX) breakCache.clear()
            breakCache.set(key, segs)
          }
          for (let k = 0; k < segs.length - 1; k++) breaks.push(off + segs[k])
        }
        off += ln.length + 1
      }
      // SQL 以 \n 结尾时 textarea 会多显示一个空行（光标行），覆盖层补一个尾部 <br>（无文本，textContent 不变）
      if (s.length && s.charAt(s.length - 1) === '\n') breaks.push(s.length)
      return breaks.length ? breaks : NO_BREAKS
    }
    // 由断点推出每逻辑行的物理行信息（形状与 visualRowsOf 一致，供行号/光标行使用）
    // 判据用 `bks[bi] < end`（不是 `<=`）：断点是「本行内新视觉行的起始偏移」，行内折行的断点
    // 必然 < end；而 SQL 以 \n 结尾时 measureSoftBreaks 会补一个「s.length」的尾部断点（只为让
    // 覆盖层多出一个空行盒、与 textarea 等高），它的值恰好等于最后那个空行的 end —— 用 `<=` 会把它
    // 算成该空行的折行 → 该行多出一行、光标停在这一行时「当前行背景」整体向下偏一行。
    function rowsFromBreaks(sql, breaks) {
      const lines = String(sql || '').split('\n')
      const bks = breaks || NO_BREAKS
      const rows = []
      let phys = 0, bi = 0, off = 0
      for (let li = 0; li < lines.length; li++) {
        const ln = lines[li]
        const end = off + ln.length
        let segs = 1
        while (bi < bks.length && bks[bi] < end) { bi++; segs++ }
        rows.push({ lineIdx: li, physStart: phys, physLen: segs, text: ln })
        phys += segs
        off = end + 1
      }
      return { rows: rows, totalPhys: phys }
    }
    // 某字符偏移所在的物理行序号（0-based）
    // 同 rowsFromBreaks：`bks[bi] < end` —— 尾部补的空行断点（= 最后空行的 end）不参与折行计数，
    // 否则光标落在这个空行上时返回的物理行号会多 1 → 当前行背景比光标低一行。
    function physRowOfOffset(sql, breaks, pos) {
      const lines = String(sql || '').split('\n')
      const bks = breaks || NO_BREAKS
      let row = 0, off = 0, bi = 0
      for (let li = 0; li < lines.length; li++) {
        const end = off + lines[li].length
        const startBi = bi
        let segs = 1
        while (bi < bks.length && bks[bi] < end) { bi++; segs++ }
        if (pos <= end) {
          let inner = 0
          for (let k = startBi; k < bi; k++) if (bks[k] <= pos) inner++
          return row + inner
        }
        row += segs
        off = end + 1
      }
      return row
    }
    // 返回每逻辑行的物理行信息：{rows:[{lineIdx,physStart,physLen,text}], totalPhys}
    function visualRowsOf(sql, usableW) {
      const logical = String(sql || '').split('\n')
      const rows = []
      let phys = 0
      logical.forEach(function (ln, li) {
        let w = 0, segs = 1
        for (let k = 0; k < ln.length; k++) {
          const cw = chWidth(ln[k])
          if (w + cw > usableW && cw <= usableW) { segs++; w = cw }
          else w += cw
        }
        const len = Math.max(1, segs)
        rows.push({ lineIdx: li, physStart: phys, physLen: len, text: ln })
        phys += len
      })
      return { rows: rows, totalPhys: phys }
    }
    // 字符位置 → pre 内 x/y（等宽计算；含 padding）—— 支持软换行
    function cursorXY(sql, pos, usableW) {
      const uw = usableW || 400
      const upos = Math.max(0, Math.min(pos, String(sql).length))
      const before = sql.slice(0, upos)
      const lines = before.split('\n')
      const lineIdx = lines.length - 1
      const logical = String(sql).split('\n')
      // 该逻辑行在全局的物理起始行 = 前面逻辑行的物理行数
      let physRow = 0
      for (let li = 0; li < lineIdx; li++) {
        const lt = logical[li] || ''
        let w = 0, segs = 1
        for (let k = 0; k < lt.length; k++) {
          const cw = chWidth(lt[k])
          if (w + cw > uw && cw <= uw) { segs++; w = cw } else w += cw
        }
        physRow += Math.max(1, segs)
      }
      // 行内物理段 + 段内 x
      const curLine = (logical[lineIdx] || '')
      const inLine = upos - (before.length - lines[lineIdx].length)
      let w2 = 0, seg = 0, segBase = 0
      for (let k = 0; k < inLine; k++) {
        const cw = chWidth(curLine[k])
        if (w2 + cw > uw && cw <= uw) { seg++; w2 = cw; segBase = k } else w2 += cw
      }
      let x = 0
      for (let k = segBase; k < inLine; k++) x += chWidth(curLine[k])
      return { x: ED_PAD_LEFT + x, y: ED_PAD_TOP + (physRow + seg) * ED_LINE_H + 3 }
    }
    // 鼠标点击（textarea 内）→ 字符位置（支持软换行：按视觉行定位）
    function posFromMouse(ta, e) {
      const rect = ta.getBoundingClientRect()
      const x = e.clientX - rect.left + ta.scrollLeft
      const y = e.clientY - rect.top + ta.scrollTop
      const val = ta.value
      const usableW = usableWidthOf(ta)
      const vinfo = val ? visualRowsOf(val, usableW) : null
      const physRow = Math.max(0, Math.floor((y - ED_PAD_TOP) / ED_LINE_H))
      // 找 physRow 所在逻辑行
      let lineStart = 0
      let target = vinfo ? (vinfo.rows.find(function (r) { return physRow >= r.physStart && physRow < r.physStart + r.physLen }) || null) : null
      if (vinfo && target) {
        // 该逻辑行在 sql 中的起始偏移
        for (let li = 0; li < target.lineIdx; li++) lineStart = val.indexOf('\n', lineStart) + 1
        const segNo = physRow - target.physStart // 逻辑行内第几个物理段
        const lineText = target.text
        // 找第 segNo 物理段的起始字符 + 段内 x 定位
        let segIdx = 0, w = 0
        let s0 = 0
        for (let s = 0; s < segNo; s++) {
          let sw = 0
          while (segIdx < lineText.length) {
            const cw = chWidth(lineText[segIdx])
            if (sw + cw > usableW && cw <= usableW) break
            sw += cw; segIdx++
          }
          s0 = segIdx
        }
        // 段内定位（从 segIdx 起累积）
        let acc = ED_PAD_LEFT, col = segIdx
        for (let i = segIdx; i < lineText.length; i++) {
          const wch = chWidth(lineText[i])
          if (acc + wch / 2 > x) break
          acc += wch; col++
        }
        return lineStart + col
      }
      // 兜底：无视觉信息按原逻辑行
      const row = Math.max(0, Math.floor((y - ED_PAD_TOP) / ED_LINE_H))
      let ls = 0, r = 0
      while (r < row) {
        const nn = val.indexOf('\n', ls)
        if (nn === -1) return val.length
        ls = nn + 1; r++
      }
      let acc2 = ED_PAD_LEFT, col2 = 0
      const line2 = val.slice(ls)
      const le = line2.indexOf('\n')
      const lt = le === -1 ? line2 : line2.slice(0, le)
      for (let i = 0; i < lt.length; i++) {
        const w2 = chWidth(lt[i])
        if (acc2 + w2 / 2 > x) break
        acc2 += w2; col2++
      }
      return ls + col2
    }
    // 单点编辑 diff（主光标：旧值→新值）
    function diffEdit(oldV, newV) {
      let s = 0
      while (s < oldV.length && s < newV.length && oldV[s] === newV[s]) s++
      let e = oldV.length, f = newV.length
      while (e > s && f > s && oldV[e - 1] === newV[f - 1]) { e--; f-- }
      return { start: s, end: e, inserted: newV.slice(s, f) }
    }

    const stores = {}
    const listeners = {}
    const globalLexListeners = new Set()
    let activePanelSid = null // 面板当前显示会话（@olap 引用候选/lexicon 绑定它，避免 controller 传的 sessionId 对不上）
    function getStore(sid) { if (!stores[sid]) { stores[sid] = makeStore(); stores[sid].__id = sid } return stores[sid] }
    function subscribeStore(sid, fn) { (listeners[sid] || (listeners[sid] = new Set())).add(fn); return function () { const s = listeners[sid]; if (s) s.delete(fn) } }
    function emitStore(sid) { const s = listeners[sid]; if (s) s.forEach(function (f) { f() }); if (globalLexListeners.size) globalLexListeners.forEach(function (f) { try { f() } catch (e) { /* noop */ } }) }
    function useStore(sid) {
      const [, setV] = react.useState(0)
      react.useEffect(function () { return subscribeStore(sid, function () { setV(function (x) { return x + 1 }) }) }, [sid])
      return getStore(sid)
    }
    function activeTab(st) { return st.tabs.find(function (t) { return t.id === st.activeTab }) || st.tabs[0] }

    const olapUI = { open: false, lz: new Set() }
    const olapOpenBySession = {}
    try { const _raw = window.localStorage && window.localStorage.getItem('yh_olap_open'); if (_raw) { const _o = JSON.parse(_raw); for (const _k in _o) if (_o[_k] === true) olapOpenBySession[_k] = true } } catch (e) { /* ignore */ }
    function saveOlapOpenMem() { try { if (window.localStorage) window.localStorage.setItem('yh_olap_open', JSON.stringify(olapOpenBySession)) } catch (e) { /* ignore */ } }
    function getOlapOpen(sid) { return sid ? olapOpenBySession[sid] === true : false }
    function setOlapOpen(sid, v) {
      if (sid) { if (v) olapOpenBySession[sid] = true; else delete olapOpenBySession[sid]; saveOlapOpenMem() }
      const nv = getOlapOpen(sid)
      if (olapUI.open !== nv) { olapUI.open = nv; olapUI.lz.forEach(function (f) { f() }) }
    }

    // ===== WORKSTATION: 本地工作区（多文件）持久化 =====
    // 工作区按会话隔离：每个会话自己的工作区 ~/.yh-olap/workspace/<sessionId>/{sql,params,notes}/，
    // 每 tab 三份文件 <id>-<name>.<ext>；新会话没有历史文件 → 保持纯新状态（1 个空标签）。
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
      } else {
        const tree = st && st.wsTree
        if (tree && tree.sql) {
          tree.sql.forEach(function (f) {
            if (/^\d+$/.test(f.name)) { const n = Number(f.name); if (n > m) m = n }
          })
        }
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
        return { id: t.id, name: t.name || ('Tab' + t.id), sql: t.sql || '', params: t.params || {}, note: t.note || '', collectId: t.collectId }
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
        callHost('ws.workspace.save', { sessionId: sid, kind: 'params', name: base, content: JSON.stringify(paramsJson) })
        if (t.note) callHost('ws.workspace.save', { sessionId: sid, kind: 'note', name: base, content: t.note })
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
            callHost('ws.workspace.read', { sessionId: sid, kind: 'note', name: f.name }),
          ]).then(function (rs) {
            const sr = rs[0], pr = rs[1], nr = rs[2]
            const t = { id: id, name: nm, sql: (sr && sr.ok) ? sr.content : '', params: {}, note: '', engine: '2', dsId: 2, wsFile: f.name }
            if (pr && pr.ok) { try { const p = JSON.parse(pr.content); if (p && typeof p === 'object') { t.params = p; if (p.__name) t.name = p.__name; delete t.params.__name; if (p.__collectId) t.collectId = p.__collectId; delete t.params.__collectId } } catch (e) { /* ignore */ } }
            if (nr && nr.ok) t.note = nr.content
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
          return { id: t.id, name: t.name, sql: t.sql, engine: t.engine || '2', dsId: t.dsId || 2, params: t.params || {}, note: t.note || '', autoSave: true, bottomTab: 'result', running: false, executeId: '', finish: '', log: '', errMsg: '', result: null, collectId: t.collectId, wsFile: t.id != null ? String(t.id) : undefined }
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
    // ===== WORKSTATION: AppFrame 根元素定位（唯一入口，勿再各自 querySelector）=====
    // frame 的 class 带 css-module 哈希不可依赖；旧写法靠状态属性
    // [data-sidebar-collapsed]/[data-details-collapsed]/[data-dragging] 反查，但
    // **「侧栏展开 + 右列展开 + 未拖动」时三个属性全都不存在** → 找不到 frame →
    // .yh-ws-frame 打不上 → 三列重排与分隔条全失效（1680 宽视口实测复现：OLAP 面板
    // 落回最右列）。改为优先用结构稳定的 [data-shell-overlay]（overlay 层恒为 frame
    // 的直接子元素）反推父元素，属性查询只作最后兜底。
    function wsFrameEl() {
      let fr = document.querySelector('.yh-ws-frame')
      if (fr) return fr
      const ov = document.querySelector('[data-shell-overlay]')
      fr = (ov && ov.parentElement) || document.querySelector('[data-sidebar-collapsed],[data-rightbar-collapsed],[data-dragging]')
      if (fr && fr.classList && !fr.classList.contains('yh-ws-frame')) fr.classList.add('yh-ws-frame')
      return fr
    }
    function wsApplyLayout() {
      try {
        wsFrameEl()
        // 新版 DSH 把 details() 改名为 rightbar（API：openRightbar(track, fullscreen)），
        // 旧 openDetails 已不存在 —— 面板所在列需由占用者自己申报「已展开 + 占位」。
        if (layout && typeof layout.openRightbar === 'function') layout.openRightbar(true, false)
        // 工作站默认收起侧栏（保留 56px 展开条，点开可看会话列表，与 dsh web 一致）。
        // 只在检测到展开态时收起一次，用户手动展开后不再干预。
        if (!wsSidebarCollapsedDone && layout && typeof layout.toggleSidebar === 'function') {
          const f0 = wsFrameEl()
          if (f0 && !f0.hasAttribute('data-sidebar-collapsed') && !f0.hasAttribute('data-dragging')) {
            wsSidebarCollapsedDone = true
            try { layout.toggleSidebar() } catch (e2) { /* ignore */ }
          }
        }
        wsLayoutApplied = true
      } catch (e) { /* ignore */ }
    }
    // ===== WORKSTATION: 无当前会话时自动打开/新建会话（避免卡在 hero「选工作区」页）=====
    let wsAutoOpenDone = false
    let wsAutoOpenTimer = null
    let wsAutoStartIssued = false
    function wsAutoOpenFirst() {
      if (wsAutoOpenDone) return
      const sessionsSvc = ctx.get('sessions')
      if (!sessionsSvc || !sessionsSvc.list) return
      let st = null
      try { st = sessionsSvc.list.getSnapshot() } catch (e) { return }
      if (!st) return
      const ids = (st.ids || []).filter(function (x) { return x })
      const cur = st.current
      if (ids.length === 0) {
        // 一个会话都没有：通过 workspace 流程新建一个绑定工作区的会话（composer 才可用）
        if (wsAutoStartIssued) return
        const wsSvc = ctx.get('workspaces')
        if (!wsSvc) return
        let wst = null
        try { wst = wsSvc.list ? wsSvc.list.getSnapshot() : null } catch (e2) { /* ignore */ }
        const items = (wst && wst.items) || []
        if (items.length === 0) return // 工作区列表还没加载好，下轮再试
        // ===== WORKSTATION: 新版 DSH 把 connectWorkspace/startSession 从 workspaces 服务
        // 挪到了 uiWorkspace（UI 能力服务）；workspaces 只剩 create/rename/delete 等纯命令，
        // list 快照仍在。旧写法 wsSvc.connectWorkspace 会静默走不到，导致新会话建不出来。=====
        const uiWs = ctx.get('uiWorkspace')
        wsAutoStartIssued = true
        // connectWorkspace 返回绑定到工作区的会话 id（reuse 空白会话或新建）
        if (uiWs && typeof uiWs.connectWorkspace === 'function') {
          try {
            uiWs.connectWorkspace(items[0].workspaceId).then(function (sid) {
              if (sid && typeof sessionsSvc.open === 'function') {
                try { sessionsSvc.open(sid) } catch (e3) { /* ignore */ }
              }
              wsAutoOpenDone = true
              if (wsAutoOpenTimer) { clearInterval(wsAutoOpenTimer); wsAutoOpenTimer = null }
            }).catch(function () { wsAutoStartIssued = false })
          } catch (e) { wsAutoStartIssued = false }
        } else if (uiWs && typeof uiWs.startSession === 'function') {
          try { uiWs.startSession(items[0].workspaceId) } catch (e) { wsAutoStartIssued = false }
        }
        return
      }
      wsAutoOpenDone = true
      if (wsAutoOpenTimer) { clearInterval(wsAutoOpenTimer); wsAutoOpenTimer = null }
      if (!cur && typeof sessionsSvc.open === 'function') {
        try { sessionsSvc.open(ids[0]) } catch (e) { wsAutoOpenDone = false; /* 列表刚变，下轮再试 */ }
      }
    }
    wsAutoOpenTimer = setInterval(wsAutoOpenFirst, 500)
    // ===== WORKSTATION: 首次尽快确立会话（原 2.5s）—— 会话 current 确立越早，
    // OlapPanel sid 越早就绪 → 标签恢复越早。刷新后"几秒才出标签"一部分来自此延迟。=====
    setTimeout(wsAutoOpenFirst, 300)
    // 新建会话自动切换跟随（见 wsFollowNewSessions 注释）
    let wsLastSessionIds = null
    let wsFollowTimer = null
    function currentSessionId() {
      try {
        const svc = ctx.get('sessions')
        if (svc && svc.list) { const s = svc.list.getSnapshot(); if (s && s.current) return s.current }
      } catch (e) { /* ignore */ }
      return null
    }
    function wsFollowNewSessions() {
      try {
        const svc = ctx.get('sessions')
        if (!svc || !svc.list) return
        const s = svc.list.getSnapshot()
        const ids = (s && s.ids || []).filter(function (x) { return x })
        if (!ids.length) { wsLastSessionIds = ids; return }
        if (wsLastSessionIds === null) { wsLastSessionIds = ids.slice(); return } // 首次仅记录基线
        const fresh = ids.filter(function (x) { return wsLastSessionIds.indexOf(x) === -1 })
        if (fresh.length) {
          wsLastSessionIds = ids.slice()
          try { if (svc.open && typeof svc.open === 'function') svc.open(fresh[0]) } catch (e) { /* ignore */ }
          return
        }
        wsLastSessionIds = ids.slice()
      } catch (e) { /* ignore */ }
    }
    wsFollowTimer = setInterval(wsFollowNewSessions, 1000)

    // ===== WORKSTATION: DSH 侧栏「新会话」按钮补丁 =====
    // DSH 的「新会话」startSession() → connectWorkspace → 会**复用空白会话**（blank 且
    // cwd 匹配，实测总是复用 session-5c145422），不会新建 id；于是用户点「新会话」后
    // 打开的还是那个会话，面板恢复它 per-session 的工作区（旧标签/SQL）→ 看着「不是新的」。
    // 工作站补丁：捕获「新会话」按钮点击，把当前面板会话的工作区**重置为纯新状态**
    // （1 个空 Tab1 + 清 per-session 文件），无论 DSH 复用哪个会话，面板都是全新的。
    function wsPatchSidebarNewSession() {
      try {
        const frame = wsFrameEl()
        if (!frame) return
        frame.addEventListener('click', function (e) {
          const t = e.target
          const btn = t && t.closest ? t.closest('button') : null
          if (!btn) return
          const cls = (btn.className || '').toString()
          if (!cls.includes('newSession') || cls.includes('brand')) return
          setTimeout(function () { try { wsResetPanelForNewSession() } catch (e2) { /* ignore */ } }, 120)
        }, true)
      } catch (e) { /* ignore */ }
    }
    function wsResetPanelForNewSession() {
      const sid = activePanelSid
      if (!sid) return
      const st = getStore(sid)
      if (!st) return
      // 重置为纯新状态：单个空 Tab1
      st.tabs = [{ id: 1, name: 'Tab1', sql: '', engine: '2', dsId: 2, params: {}, note: '', autoSave: true, bottomTab: 'result', running: false, executeId: '', finish: '', log: '', errMsg: '', result: null, wsFile: '1' }]
      st.activeTab = 1
      st.__wsRestored = true // 阻止该会话恢复旧文件
      wsMetaFor(sid).tabs = null
      // 清 per-session 文件（sql/params；note 一并）
      for (const kind of ['sql', 'params', 'note']) {
        callHost('ws.workspace.list', { sessionId: sid }).then(function (r) {
          if (r && r.ok && r[kind === 'note' ? 'notes' : kind]) {
            ;(r[kind === 'note' ? 'notes' : kind] || []).forEach(function (f) {
              callHost('ws.workspace.remove', { sessionId: sid, kind: kind, name: f.name })
            })
          }
        })
      }
      emitStore(sid)
      // 新会话的干净 Tab1 立即落盘（全自动保存：保证刷新后稳定为 1 个空 Tab1）
      callHost('ws.workspace.save', { sessionId: sid, kind: 'sql', name: '1', content: '' })
      callHost('ws.workspace.save', { sessionId: sid, kind: 'params', name: '1', content: JSON.stringify({ __name: 'Tab1' }) })
    }
    setTimeout(wsPatchSidebarNewSession, 1500)

    function downloadBlob(method, args, onStatus) {
      callHost(method, args).then(function (r) {
        if (!r || !r.ok || !r.base64) {
          const msg = '下载失败: ' + (r && (r.error || r.httpError) ? (r.error || r.httpError) : '无文件内容')
          console.log('download failed', r)
          if (onStatus) onStatus(msg)
          return
        }
        try {
          const bin = atob(r.base64)
          const u = new Uint8Array(bin.length)
          for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i)
          const blob = new Blob([u], { type: 'application/octet-stream' })
          const fileName = (r && r.filename) || (args && args.fileName) || 'download.xlsx'
          if (URL && URL.createObjectURL) {
            const url = URL.createObjectURL(blob)
            const a = document.createElement('a')
            a.href = url
            a.download = fileName
            document.body.appendChild(a)
            a.click()
            timer.timeout(function () { URL.revokeObjectURL(url); a.remove() }, 2000)
          } else {
            const fr = new FileReader()
            fr.onload = function () {
              const a = document.createElement('a')
              a.href = fr.result
              a.download = fileName
              document.body.appendChild(a)
              a.click()
              timer.timeout(function () { a.remove() }, 2000)
            }
            fr.readAsDataURL(blob)
          }
          if (onStatus) onStatus('已开始下载 ' + fileName)
        } catch (e) {
          if (onStatus) onStatus('下载失败: ' + (e && e.message))
        }
      })
    }

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

    function CollectMenu(props) {
      const { st, sid, bump } = props
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
      // 菜单打开时监听 document 点击：点到菜单外即关闭（拾取焦点也关闭）
      react.useEffect(function () {
        const onDoc = function (e) {
          const el = document.querySelector('.yh-olap-cmenu')
          if (el && !el.contains(e.target)) { st.collectMenu = null; bump() }
        }
        document.addEventListener('mousedown', onDoc)
        return function () { document.removeEventListener('mousedown', onDoc) }
      }, [st.collectMenu])
      return h('div', { className: 'yh-olap-cmenu', style: { left: px, top: py }, onMouseDown: function (e) { e.stopPropagation() }, onContextMenu: function (e) { e.preventDefault(); e.stopPropagation() } },
        items.map(function (it) {
          return h('div', { key: it.label, className: 'yh-olap-citem', onClick: function () { act(it.fn) } }, it.label)
        }))
    }

    // ===== WORKSTATION: 库表清单右键菜单 —— 复制库名/表名/字段名 =====
    function SchemaMenu(props) {
      const { st, bump } = props
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
      // 菜单打开时监听 document 点击：点到菜单外即关闭
      react.useEffect(function () {
        const onDoc = function (e) {
          const el = document.querySelector('.yh-olap-cmenu')
          if (el && !el.contains(e.target)) { st.schemaMenu = null; bump() }
        }
        document.addEventListener('mousedown', onDoc)
        return function () { document.removeEventListener('mousedown', onDoc) }
      }, [st.schemaMenu])
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
        // 全自动保存模型：收藏标签也本地落盘一份（wsFile 关联），关标签删本地副本不影响服务端收藏。=====
        // ===== WORKSTATION: 同一收藏只允许一个标签 —— 已打开则直接激活，不重复新建
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

    // ===== WORKSTATION: 工作区 tab（本地多文件：sql/params/notes）=====
    function wsRefreshTree(st, sid, bump) {
      st.wsTreeLoaded = false
      bump()
      callHost('ws.workspace.list', { sessionId: sid }).then(function (r) {
        if (r && r.ok) { st.wsTree = r; st.wsTreeLoaded = true; wsNoteAllFiles(st, r.sql); bump() }
      })
    }
    function wsOpenSqlFile(st, sid, bump, name) {
      callHost('ws.workspace.read', { sessionId: sid, kind: 'sql', name: name }).then(function (sr) {
        callHost('ws.workspace.read', { sessionId: sid, kind: 'params', name: name }).then(function (pr) {
          callHost('ws.workspace.read', { sessionId: sid, kind: 'note', name: name }).then(function (nr) {
            const params = {}
            let dispName = ''
            if (pr && pr.ok) { try { const p = JSON.parse(pr.content); if (p && typeof p === 'object') { if (p.__name) dispName = String(p.__name); delete p.__name; Object.assign(params, p) } } catch (e) { /* ignore */ } }
            // ===== WORKSTATION: 已在标签栏打开的同源工作区文件 → 激活该标签（不重复新建）=====
            const existing = st.tabs.find(function (t) { return t.wsFile === name })
            if (existing) {
              existing.autoSave = true
              existing.sql = (sr && sr.ok) ? sr.content : ''
              existing.params = params
              existing.note = (nr && nr.ok) ? nr.content : ''
              st.activeTab = existing.id
              bump()
              showToast(st, '已切换到 ' + (dispName || existing.name || name))
              return
            }
            const nid = wsNextTabId(st)
            const nm = dispName || (sr && sr.ok && name ? name.replace(/^\d+-/, '') : ('Tab' + nid))
            markProgSqlSet()
            st.tabs.push({ id: nid, name: nm, sql: (sr && sr.ok) ? sr.content : '', engine: '2', dsId: 2, params: params, note: (nr && nr.ok) ? nr.content : '', autoSave: true, bottomTab: 'result', running: false, executeId: '', finish: '', log: '', errMsg: '', result: null, wsFile: name })
            st.activeTab = nid
            bump()
            showToast(st, '已打开 ' + nm)
          })
        })
      })
    }
    // ===== WORKSTATION: ＋新建 → 直接新建一个 autoSave 标签（立即成为工作区文件，标签名即工作区显示名，双击标签可改名）=====
    function wsNewSqlFile(st, sid, bump) {
      const nid = wsNextTabId(st)
      const nm = 'Tab' + nid
      st.tabs.push({ id: nid, name: nm, sql: '', engine: '2', dsId: 2, params: {}, note: '', autoSave: true, bottomTab: 'result', running: false, executeId: '', finish: '', log: '', errMsg: '', result: null, wsFile: String(nid) })
      wsNoteFile(st, String(nid))
      st.activeTab = nid
      bump()
      wsScheduleSave(sid, 200)
      showToast(st, '已新建 ' + nm + '（自动保存）')
    }
    function WorkspaceTree(props) {
      const { st, sid, bump } = props
      const tree = st.wsTree
      // ===== WORKSTATION: 加载必须放 effect（渲染期调用会触发无限重渲染 → 浏览器卡死）=====
      react.useEffect(function () { if (!st.wsTreeLoaded && !tree) wsRefreshTree(st, sid, bump) }, [])
      // ===== WORKSTATION: 工作区右键菜单 —— 点击菜单外/失去焦点即关闭 =====
      react.useEffect(function () {
        if (!st.wsMenu) return
        const onDoc = function (e) {
          const el = document.querySelector('.yh-ws-cmenu')
          if (el && !el.contains(e.target)) { st.wsMenu = null; bump() }
        }
        document.addEventListener('mousedown', onDoc)
        return function () { document.removeEventListener('mousedown', onDoc) }
      }, [st.wsMenu])
      const mtime = function (ms) {
        if (!ms) return ''
        const d = new Date(ms)
        const pad = function (n) { return (n < 10 ? '0' : '') + n }
        return (d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
      }
      const menu = { node: null, x: 0, y: 0 }
      // ===== WORKSTATION: 便签按文件名映射，SQL 项悬停 title 显示便签 =====
      const noteMap = {}
      ;(tree && tree.notes || []).forEach(function (n) { noteMap[n.name] = n.content || '' })
      const group = function (label, items, onClick) {
        return [
          h('div', { className: 'yh-olap-node', style: { fontWeight: 600, color: 'var(--dsw-alias-label-secondary,#7a8ba0)', cursor: 'default' } },
            h('span', { className: 'tw' }, ''), h('span', { className: 'yh-olap-fname' }, label + ' (' + ((items && items.length) || 0) + ')')),
          (items || []).length ? items.map(function (it) {
            const noteTxt = label === 'SQL' ? (noteMap[it.name] || '') : ''
            return h('div', {
              key: label + '/' + it.name, className: 'yh-olap-node',
              title: noteTxt ? it.name + '\n\n📝 ' + noteTxt : it.name,
              onClick: function () { onClick(it) },
              onContextMenu: function (e) { e.preventDefault(); e.stopPropagation(); st.wsMenu = { node: it, label: label, x: e.clientX, y: e.clientY }; bump() },
            },
              h('span', { className: 'tw' }, ''), h('span', { className: 'yh-olap-ic' }, '⌘'),
              h('span', { className: 'yh-olap-fname' }, it.displayName || it.name),
              h('span', { className: 'yh-olap-fcmt' }, mtime(it.mtime)))
          }) : null,
        ]
      }
      if (!st.wsTreeLoaded && !tree) {
        return h('div', { className: 'yh-olap-ltree' }, h('div', { className: 'yh-olap-hint' }, '加载中…'))
      }
      const menuBox = st.wsMenu ? (function () {
        const m = st.wsMenu
        const act = function (fn) { st.wsMenu = null; bump(); fn() }
        const menuRows = [
          { label: '打开到编辑器', fn: function () { m.label === 'SQL' ? wsOpenSqlFile(st, sid, bump, m.node.name) : null } },
          { label: '重命名', fn: function () {
            // ===== WORKSTATION: SQL 纯 id 文件重命名 = 改显示名 __name（文件名保持 id，避免改成非数字后树过滤消失）=====
            if (m.label === 'SQL' && /^\d+$/.test(m.node.name)) {
              const curNm = m.node.displayName || (function () { const tx = st.tabs.find(function (x) { return x.wsFile === m.node.name }); return tx ? tx.name : '' })()
              st.dlg = { kind: 'input', title: '重命名标签显示名', value: curNm || m.node.name, placeholder: '新显示名（文件仍按 id 保存）', onOk: function (v) {
                const newNm = String(v || '').trim()
                if (!newNm) { showToast(st, '名称不能为空'); return false }
                if (newNm === curNm) return true
                callHost('ws.workspace.read', { sessionId: sid, kind: 'params', name: m.node.name }).then(function (pr) {
                  let pj = {}
                  if (pr && pr.ok) { try { const j = JSON.parse(pr.content); if (j && typeof j === 'object') pj = j } catch (e) { /* ignore */ } }
                  delete pj.__name
                  const merged = Object.assign({}, pj, { __name: newNm })
                  callHost('ws.workspace.save', { sessionId: sid, kind: 'params', name: m.node.name, content: JSON.stringify(merged) }).then(function () {
                    st.tabs.forEach(function (t) { if (t.wsFile === m.node.name) t.name = newNm })
                    bump()
                    showToast(st, '已重命名为 ' + newNm)
                    wsRefreshTree(st, sid, bump)
                  })
                })
                return true
              } }
              bump()
              return
            }
            st.dlg = { kind: 'input', title: '重命名', value: m.node.name, placeholder: '新名称', onOk: function (v) {
              const n = String(v || '').trim()
              if (!n) { showToast(st, '名称不能为空'); return false }
              if (n === m.node.name) return true
              callHost('ws.workspace.rename', { sessionId: sid, kind: m.label === 'SQL' ? 'sql' : (m.label === '便签' ? 'note' : 'params'), from: m.node.name, to: n }).then(function (r) {
                if (r && r.ok) {
                  if (m.label === 'SQL') { st.tabs.forEach(function (t) { if (t.wsFile === m.node.name) t.wsFile = n }) }
                  showToast(st, '已重命名'); wsRefreshTree(st, sid, bump)
                } else showToast(st, '重命名失败')
              })
              return true
            } }
            bump()
          } },
          { label: '删除', fn: function () {
            st.dlg = { kind: 'confirm', title: '删除工作区项', message: '删除 ' + (m.node.displayName || m.node.name) + ' ？（不可恢复）', okLabel: '删除', onOk: function () {
              const kinds = m.label === 'SQL' ? ['sql', 'params', 'note'] : [m.label === '便签' ? 'note' : 'params']
              // ===== WORKSTATION: 等待所有 remove 完成再刷新树（避免 list 读到删除前的旧快照 → 残留行）=====
              const rmJobs = kinds.map(function (k) { return callHost('ws.workspace.remove', { sessionId: sid, kind: k, name: m.node.name }) })
              Promise.all(rmJobs).then(function () { wsRefreshTree(st, sid, bump) })
              // ===== WORKSTATION: 删除工作区文件后，同步取消对应打开标签的自动保存状态（文件已删，不再落盘/标记）=====
              if (m.label === 'SQL') {
                st.tabs.forEach(function (t) {
                  if (t.wsFile === m.node.name) { t.autoSave = false; t.wsFile = undefined; t.collectId = undefined }
                })
                if (st.__wsKnownFiles) st.__wsKnownFiles.delete(String(m.node.name))
              }
              bump()
              return true
            } }
            bump()
          } },
        ]
        return h('div', { className: 'yh-ws-cmenu', style: { left: Math.min(m.x, window.innerWidth - 150), top: Math.min(m.y, window.innerHeight - 120) } },
          menuRows.map(function (r) { return h('div', { onClick: function () { act(r.fn) } }, r.label) }))
      })() : null
      return h('div', { className: 'yh-olap-ltree', onClick: function () { if (st.wsMenu) { st.wsMenu = null; bump() } } },
        h('div', { className: 'yh-ws-ktools' },
          h('button', { className: 'pri', onClick: function () { wsNewSqlFile(st, sid, bump) } }, '＋新建'),
          h('button', { onClick: function () { wsRefreshTree(st, sid, bump) } }, '刷新')),
        group('SQL', tree ? tree.sql.filter(function (it) { return /^\d+$/.test(it.name) }) : null, function (it) { wsOpenSqlFile(st, sid, bump, it.name) }),
        menuBox)
    }

    // ===== WORKSTATION: 通用对话框（自绘 confirm/input，替代 window.confirm/prompt）=====
    // 状态在 st.dlg：{ kind:'confirm'|'input', title, message, value?, okLabel?, onOk }
    // onOk：confirm 收到 true（点确定）；input 收到输入值（可为空串）。返回 false 不关闭。
    function DlgModal(props) {
      const { st, bump } = props
      const d = st.dlg
      if (!d) return null
      const close = function () { st.dlg = null; bump() }
      const inputRef = react.useRef(null)
      // 打开时自动聚焦输入框；Esc 关闭
      react.useEffect(function () {
        if (d && d.kind === 'input' && inputRef.current) { inputRef.current.focus(); inputRef.current.select() }
        if (!d) return
        const onKey = function (e) { if (e.key === 'Escape') { e.stopPropagation(); close() } }
        document.addEventListener('keydown', onKey, true)
        return function () { document.removeEventListener('keydown', onKey, true) }
      }, [d])
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

    function NoteModal(props) {
      const { st, sid, bump } = props
      if (!st.noteModalFor) return null
      const tab = activeTab(st)
      return h('div', { className: 'yh-olap-mask', onClick: function () { st.noteModalFor = false; bump() } },
        h('div', { className: 'yh-olap-modal', onClick: function (e) { e.stopPropagation() } },
          h('h4', null, '便签 · ' + (tab.name || 'Tab' + tab.id)),
          h('textarea', { defaultValue: st.noteText === undefined ? (tab.note || '') : st.noteText, placeholder: '记录这个 SQL 的说明/口径/注意点…（自动保存到 ~/.yh-olap/workspace/notes/）', onChange: function (e) { st.noteText = e.target.value } }),
          h('div', { className: 'row', style: { marginTop: 8 } },
            h('button', { className: 'pri', onClick: function () { tab.note = st.noteText || ''; st.noteModalFor = false; bump(); wsScheduleSave(sid, 150) } }, '保存'))))
    }

    // ===== WORKSTATION: 对话区宽度可调分隔条 =====
    // AppFrame 内建手柄定位依赖原始列序（sidebar|center|rightbar），与工作站
    // 重排后的视觉边界（OLAP 中 / 会话右）不对应，故自建分隔条挂到 shell.overlay
    // 层（覆盖全 frame、子元素 pointer-events:auto）。拖拽时把 --yh-ws-cols
    // 从默认 fr 比例写成 OLAP 像素宽，会话区自动吸走剩余空间；宽度持久化到 localStorage。
    // 三列布局下 sidebar 列宽由 AppFrame inline grid-template-columns 首段驱动
    // （收起 56px / 展开 280px+），同步进 --yh-ws-sidebar-w 供 CSS 使用。
    function WsDivider() {
      const ref = react.useRef(null)
      // ===== WORKSTATION: 拖拽标志用 ref（effect 闭包只捕获首次渲染的 let 值，拖拽判断会失效）=====
      const dragRef = react.useRef(false)
      react.useEffect(function () {
        const el = ref.current
        if (!el) return
        const sidebarW = function (fr) {
          const inline = fr.style.getPropertyValue('grid-template-columns') || ''
          const m = /^\s*(\d+(?:\.\d+)?)px/.exec(inline)
          const w = m ? parseFloat(m[1]) : 0
          fr.style.setProperty('--yh-ws-sidebar-w', w + 'px')
          return w
        }
        const sync = function () {
          const fr = wsFrameEl()
          if (!fr || !el) return false
          const sw = sidebarW(fr)
          // sidebar 展开时抢占横向空间：把 OLAP 固定宽（用户拖出的偏好）钳到
          // frW - sidebar - 会话最小宽，避免聊天区被推出视口（2124 > 1920 溢出修正）；
          // 收拢后 maxO 还原，自动回到用户偏好。拖拽中不干预。
          if (!dragRef.current) {
            let saved = 0
            try { saved = Number(localStorage.getItem('yh_ws_olap_w') || '') } catch (e) { /* ignore */ }
            if (saved > 300) {
              const frW = fr.getBoundingClientRect().width
              const maxO = frW - sw - 360
              const target = Math.min(saved, maxO)
              const cur = parseFloat(fr.style.getPropertyValue('--yh-ws-cols'))
              if (target > 0 && Math.abs((cur || 0) - target) > 1) {
                fr.style.setProperty('--yh-ws-cols', target + 'px minmax(340px,1fr)')
              }
            }
          }
          const col = fr.children[2]
          if (!col) return false
          const r = col.getBoundingClientRect()
          if (r.width > 0) { el.style.left = r.right + 'px'; return true }
          return false
        }
        const applySaved = function () {
          let saved = 0
          try { saved = Number(localStorage.getItem('yh_ws_olap_w') || '') } catch (e) { /* ignore */ }
          const fr = wsFrameEl()
          if (saved > 300 && fr) fr.style.setProperty('--yh-ws-cols', saved + 'px minmax(340px,1fr)')
        }
        applySaved()
        sync()
        // 常驻轮询：sidebar 展开/收起只改 AppFrame inline 列宽，fr 自身尺寸不变
        // （RO/MO 可能错过时序），周期读 inline 首段 → --yh-ws-sidebar-w。
        const iv = setInterval(function () {
          // ===== WORKSTATION: 拖拽中不做任何偏好回写（applySaved/sync 的 clamp 都会把宽度弹回旧值）=====
          if (!dragRef.current) {
            applySaved()
            sync()
          }
        }, 500)
        const ro = new ResizeObserver(function () {
          const fr = wsFrameEl()
          if (fr) sync()
        })
        const fr0 = wsFrameEl()
        if (fr0) ro.observe(fr0)
        else {
          const iv2 = setInterval(function () {
            const fr = wsFrameEl()
            if (fr) { ro.observe(fr); clearInterval(iv2) }
          }, 400)
          setTimeout(function () { clearInterval(iv2) }, 40000)
        }
        // sidebar 展开/收起只改 AppFrame 的 inline 列宽，fr 自身尺寸不变 → RO 不触发；
        // 用 MutationObserver 监听 data-sidebar-collapsed 变化补一次同步。
        let mo = null
        const moTarget = wsFrameEl()
        if (moTarget && typeof MutationObserver === 'function') {
          mo = new MutationObserver(function () { sync() })
          mo.observe(moTarget, { attributes: true, attributeFilter: ['data-sidebar-collapsed'] })
        }
        window.addEventListener('resize', function () { sync() })
        return function () { ro.disconnect(); if (mo) mo.disconnect() }
      }, [])
      const onDown = function (e) {
        e.preventDefault()
        const fr = wsFrameEl()
        const el = ref.current
        if (!fr || !el) return
        const frR = fr.getBoundingClientRect()
        const sidebarW = parseFloat(fr.style.getPropertyValue('--yh-ws-sidebar-w')) || 0
        const startX = e.clientX
        dragRef.current = true
        const cur = Number.parseFloat(fr.style.getPropertyValue('--yh-ws-cols'))
        const startW = cur > 300 ? cur : (fr.children[2] ? fr.children[2].getBoundingClientRect().width : frR.width * 0.45)
        const move = function (ev) {
          let w = startW + (ev.clientX - startX)
          const maxW = frR.width - sidebarW - 360
          w = Math.max(320, Math.min(maxW, w))
          fr.style.setProperty('--yh-ws-cols', w + 'px minmax(340px,1fr)')
          el.style.left = (sidebarW + w) + 'px'
        }
        const up = function () {
          dragRef.current = false
          const w = Number.parseFloat(fr.style.getPropertyValue('--yh-ws-cols'))
          try { localStorage.setItem('yh_ws_olap_w', String(Math.round(w || 0))) } catch (e2) { /* ignore */ }
          window.removeEventListener('mousemove', move)
          window.removeEventListener('mouseup', up)
        }
        window.addEventListener('mousemove', move)
        window.addEventListener('mouseup', up)
      }
      return h('div', { ref: ref, className: 'yh-ws-divider', onMouseDown: onDown })
    }

    function LeftArea(props) {
      const { st, sid, bump } = props
      if (st.leftCollapsed) return null
      const startDrag = function (e) {
        e.preventDefault()
        const startX = e.clientX
        const startW = st.leftWidth || 210
        const move = function (ev) {
          const w = Math.max(100, Math.min(420, startW + (ev.clientX - startX)))
          st.leftWidth = w
          bump()
        }
        const up = function () {
          window.removeEventListener('mousemove', move)
          window.removeEventListener('mouseup', up)
        }
        window.addEventListener('mousemove', move)
        window.addEventListener('mouseup', up)
      }
      return h('div', { className: 'yh-olap-left', style: { width: (st.leftWidth || 210) + 'px' } },
        h('div', { className: 'yh-olap-tabs2' },
          h('span', { className: st.leftTab === 'schema' ? 'on' : '', onClick: function () { st.leftTab = 'schema'; bump() } }, '库表'),
          h('span', { className: st.leftTab === 'collect' ? 'on' : '', onClick: function () { st.leftTab = 'collect'; loadCollect(st, sid, bump) } }, '收藏')),
        st.leftTab === 'schema' ? h(SchemaTree, { st: st, sid: sid, bump: bump })
          : h(CollectTree, { st: st, sid: sid, bump: bump }),
        h('button', { className: 'yh-olap-coltoggle collapse', onClick: function () { st.leftCollapsed = true; bump() }, title: '收起左栏' }, '◀'),
        h('div', { className: 'yh-olap-resizer', onMouseDown: startDrag, title: '拖动调整宽度' }))
    }

    // mirror-based caret coordinates (robust, no computed-style dependency)
    function caretPos(ta) {
      const before = ta.value.slice(0, ta.selectionStart)
      const mirror = document.createElement('div')
      mirror.style.cssText = 'position:absolute;visibility:hidden;white-space:pre-wrap;word-break:break-all;overflow:hidden;font:inherit;top:0;left:0;padding:4px 4px 10px 4px;box-sizing:border-box;'
      mirror.style.width = (ta.clientWidth || 400) + 'px'
      mirror.textContent = before
      const marker = document.createElement('span')
      marker.textContent = '\u200b'
      mirror.appendChild(marker)
      ta.parentNode.appendChild(mirror)
      const tr = ta.getBoundingClientRect()
      const mx = marker.offsetLeft
      const my = marker.offsetTop
      const mh = marker.offsetHeight || 20
      ta.parentNode.removeChild(mirror)
      return { x: tr.left + mx - ta.scrollLeft, y: tr.top + my + mh - ta.scrollTop }
    }

    function findSchema(st, name) {
      const tab = activeTab(st)
      const schemas = st.schemas[String(tab && tab.dsId)] || []
      const nl = String(name).toLowerCase()
      for (let i = 0; i < schemas.length; i++) if (String(schemas[i].name).toLowerCase() === nl) return schemas[i]
      return null
    }
    function tableListOfSchema(st, schemaId) {
      const tab = activeTab(st)
      const r = st.tables[String(tab && tab.dsId) + '/' + schemaId]
      return (r && r.list) || []
    }
    function findTable(st, name, schemaId) {
      const nl = String(name).toLowerCase()
      if (schemaId !== undefined && schemaId !== null) {
        const list = tableListOfSchema(st, schemaId)
        for (let i = 0; i < list.length; i++) if (String(list[i].name).toLowerCase() === nl) return list[i]
        return null
      }
      const tab = activeTab(st)
      const schemas = st.schemas[String(tab && tab.dsId)] || []
      for (let i = 0; i < schemas.length; i++) {
        const list = tableListOfSchema(st, schemas[i].id)
        for (let j = 0; j < list.length; j++) if (String(list[j].name).toLowerCase() === nl) return list[j]
      }
      return null
    }
    // ===== WORKSTATION: 解析 SQL 中 from/join 的表别名 → 真实表（补全字段用）=====
    // 支持 `from dim_shop s`、`from dim.dim_shop as s`、`join dws.t s` 等常见写法。
    function aliasTableMap(st, sql) {
      const out = {}
      const tab = activeTab(st)
      const schemas = st.schemas[String(tab && tab.dsId)] || []
      const text = String(sql || '')
      // 逐段找 from/join 后面的 表名 [as] 别名
      const re = /\b(from|join|inner\s+join|left\s+join|right\s+join|full\s+join|cross\s+join)\s+([A-Za-z0-9_.\u4e00-\u9fa5]+)(?:\s+(?:as\s+)?([A-Za-z0-9_\u4e00-\u9fa5]+))?/gi
      let m
      while ((m = re.exec(text))) {
        const tbl = m[2]
        const alias = m[3]
        // 拆 库.表 或 表
        const parts = tbl.split('.')
        const tname = parts[parts.length - 1]
        const sname = parts.length > 1 ? parts[parts.length - 2] : ''
        // 定位真实表（带库名优先）
        let found = null
        if (sname) {
          const s = schemas.find(function (x) { return String(x.name).toLowerCase() === sname.toLowerCase() })
          if (s) found = findTable(st, tname, s.id)
        } else {
          found = findTable(st, tname)
        }
        if (found) {
          const key = String(alias || tname).toLowerCase()
          out[key] = { table: found, schemaId: found.schemaId, tableId: found.tableId }
          // 无别名时表名自身也映射（`from dim_shop` 后输 `dim_shop.`）
          if (!alias) out[String(tname).toLowerCase()] = { table: found, schemaId: found.schemaId, tableId: found.tableId }
        }
      }
      return out
    }
    // 当前正在输入的分段链：如 "dim"、"dim.dim_"、"dim.dim_goods."（含结尾是否有 .）
    function inputChain(before) {
      const m = before.match(/[A-Za-z0-9_\u4e00-\u9fa5.]+$/)
      if (!m) return { parts: [], endedWithDot: false }
      const raw = m[0]
      const parts = raw.split('.').map(function (p) { return p.trim() })
      return { parts: parts, endedWithDot: raw.charAt(raw.length - 1) === '.' }
    }
    // 匹配优先级：精确命中 > 以输入开头 > 中间包含；同优先级按类型/长度/名称排序
    // preferOrder（可选）：上下文期望的类型（如 ['sch','tbl'] 在 from 后、['k','col','f'] 在 select 后）
    // 这些类型提到最前（依次 rank 0..），其余按 kindRank 接后。无 prefer 时默认：关键字 > 函数 > 库 > 表 > 字段
    function rankMatches(items, w, preferOrder) {
      const lw = String(w || '').toLowerCase()
      const score = function (text) {
        const lt = String(text || '').toLowerCase()
        if (lt === lw) return 0
        if (lt.indexOf(lw) === 0) return 1
        if (lt.indexOf(lw) > 0) return 2
        return 3
      }
      const kindRank = { k: 0, f: 1, sch: 2, tbl: 3, col: 4, w: 5 }
      const pref = (preferOrder || []).filter(function (x) { return x })
      const rankOf = function (kind) {
        const pi = pref.indexOf(kind)
        if (pi !== -1) return pi // 偏好类型排最前
        // 其余类型排在偏好之后：基础 rank 加上偏好数量偏移，保持相对顺序
        const base = kindRank[kind] !== undefined ? kindRank[kind] : 6
        return base + pref.length
      }
      return items
        .map(function (it) { return { it: it, sc: score(it.text), kr: rankOf(it.kind) } })
        // 过滤：已完整输入的候选(sc=0)不再补全；未匹配(3)不展示
        .filter(function (x) { return x.sc > 0 && x.sc < 3 })
        // ===== WORKSTATION: 排序 = 匹配度 > 类型优先级 > 长度 > 名称 =====
        // 原为「类型 > 匹配度」：一旦关键字被提到最前，前缀 1 个字符时海量「包含命中(sc=2)」
        // 的关键字会把 40 条窗口占满，把「前缀命中(sc=1)」的字段挤出可见区。改匹配度优先后：
        // 同一档次内仍按类型排（select 语境 = 关键字 > 字段 > 函数），跨档次则强匹配永远在前。
        .sort(function (a, b) {
          return a.sc - b.sc
            || a.kr - b.kr
            || a.it.text.length - b.it.text.length
            || String(a.it.text).localeCompare(String(b.it.text))
        })
        .map(function (x) { return x.it })
    }

    // ===== WORKSTATION: 根据光标前 SQL 语法位置推断期望补全类型 =====
    // from/join/into/update 后 → 库/表；select/where/on/having/group by/order by 后 → 关键字/字段/函数
    // ===== WORKSTATION: 关键字恒在字段之前（用户要求）=====
    // 默认 kindRank 本就是 关键字(0) < 字段(4)，但「字段上下文」的偏好列表原为 ['col','f']，
    // 把字段提到最前后关键字反被压到字段之下（实测 select 后输 "s"：字段 #0、关键字 #7）。
    // 故把 'k' 放进偏好列表首位：关键字 > 字段 > 函数，其余类型相对顺序不变。
    function complPrefer(sql) {
      const m = String(sql || '')
      // 去掉末尾正在输入的词与尾部空白，分析到「输入词前」的语法位置
      const trimmed = m.replace(/[\s]*[A-Za-z0-9_\u4e00-\u9fa5.]*$/, '')
      const re = /\b(select|from|join|left join|right join|inner join|full join|cross join|outer join|on|where|having|group by|order by|set|into|values|update)\b/gi
      const ms = []
      let mm
      while ((mm = re.exec(trimmed)) !== null) ms.push(mm)
      if (!ms.length) return null
      const kw = String(ms[ms.length - 1][0]).trim().toLowerCase()
      if (kw === 'from' || kw.indexOf('join') !== -1 || kw === 'into' || kw === 'update' || kw === 'values') return ['sch', 'tbl']
      return ['k', 'col', 'f'] // select/where/on/having/group by/order by/set 等
    }

    // onlyKeys：可选的「限定表集合」（Set<"schemaId/tableId">）。
    // 有 from/join 时只收集这些表的字段（避免全库误补）；为空(undefined/null)才收集全部已加载表列。
    function rootCandidates(st, word, onlyKeys, preferOrder) {
      const w = String(word || '').toLowerCase()
      // ===== WORKSTATION: 关键字/函数按当前 tab 引擎词表（impala/hive 精确，其余通用）=====
      const ewords = activeEngineWords(st)
      const keys = []
      ewords.keys.forEach(function (k) { keys.push({ text: k, kind: 'k' }) })
      const funcs = []
      ewords.funcs.forEach(function (k) { funcs.push({ text: k, kind: 'f' }) })
      const tab = activeTab(st)
      const schemas = st.schemas[String(tab && tab.dsId)] || []
      const sch = schemas.map(function (s) { return { text: s.name, kind: 'sch', desc: '库' } })
      const tables = []
      schemas.forEach(function (s) {
        tableListOfSchema(st, s.id).forEach(function (t) { tables.push({ text: t.name, kind: 'tbl', desc: '表' }) })
      })
      // 字段名候选：遍历已加载的列结构（未输入过的字段也能补全）
      // 去重按「字段名 + 字段注释」：同名同注释只留一个；同名不同注释（不同表的同名字段）保留，靠注释区分
      // onlyKeys 限定表时只收集这些表的列（有 from/join 场景），否则收集全部已加载表列（无 from 全库场景）
      const cols = []
      const colSeen = {}
      Object.keys(st.columns).forEach(function (k) {
        if (onlyKeys && !onlyKeys.has(k)) return
        const cs = st.columns[k]
        if (!cs || !cs.columns) return
        cs.columns.forEach(function (c) {
          if (!c.name) return
          const desc = c.cnName || c.comment || '字段'
          const key = c.name.toLowerCase() + '\u0000' + String(desc).trim()
          if (colSeen[key]) return
          colSeen[key] = true
          cols.push({ text: c.name, kind: 'col', desc: desc })
        })
      })
      const ws = []
      st.tabs.forEach(function (t) {
        if (!t.sql) return
        tokenize(t.sql, t.engine).forEach(function (tk) {
          if (tk[0] === 'i' && ws.indexOf(tk[1]) < 0) ws.push(tk[1])
        })
      })
      const list = rankMatches(keys.concat(funcs, sch, tables, cols, ws.map(function (x) { return { text: x, kind: 'w' } })), w, preferOrder)
      return list.slice(0, 40)
    }

    function Editor(props) {
      const { st, sid, bump } = props
      const taRef = react.useRef(null)
      const hlRef = react.useRef(null)
      const hlInnerRef = react.useRef(null)
      const gutterRef = react.useRef(null)
      const [compl, setCompl] = react.useState(null)
      // ===== WORKSTATION: 光标位置（渲染当前行浅灰背景）=====
      const [caret, setCaret] = react.useState(0)
      const syncCaret = function () {
        const t = taRef.current
        if (!t) return
        setCaret(t.selectionStart)
        const s2 = t.selectionStart, e2 = t.selectionEnd
        setSelRange(function (p) { return (p.s === s2 && p.e === e2) ? p : { s: s2, e: e2 } })
      }
      const composingRef = react.useRef(false) // 输入法 composition 进行中（中文输入法打英文时 Enter 是确认候选，不应用补全）
      // ===== WORKSTATION: 补全列表防残留 —— 弹出后 3 秒无交互自动关闭（无输入时不会自己一直挂着）=====
      const complTimer = react.useRef(null)
      const closeComplAfter = function () {
        if (complTimer.current) clearTimeout(complTimer.current)
        complTimer.current = setTimeout(function () { setCompl(null) }, 3000)
      }
      // ===== WORKSTATION: 编辑器右键菜单（选中 SQL 片段 → 引用到聊天框）=====
      const [selMenu, setSelMenu] = react.useState(null) // { x, y, selStart, selEnd }
      // ===== WORKSTATION: 查找高亮实测定位 —— 渲染后由 useLayoutEffect 按 DOM Range 实测，
      // 存这里驱动高亮 div（取代按字符宽估算的 matchRects，CJK/软换行精确对齐）=====
      const [findRects, setFindRects] = react.useState(null)
      const [resizeTick, setResizeTick] = react.useState(0)
      // ===== WORKSTATION: textarea 真实软换行断点（见 measureSoftBreaks）。覆盖层按它插 <br>，
      // 保证「所见文字」= textarea 的真实排版 → 原生选区/光标与文字不再错位。=====
      const [softBreaks, setSoftBreaks] = react.useState(NO_BREAKS)
      // ===== WORKSTATION: 自绘选区矩形。原生选区由 textarea 画，而 div 覆盖层在边界行可能与
      // textarea 折行差一行（亚像素差异，双向都会出现）→ 改为按覆盖层实测矩形自己画高亮，
      // 保证「高亮永远贴着你看得见的字」。仅在量到矩形时把原生选区底色设透明，量不到回落原生。=====
      const [selRange, setSelRange] = react.useState({ s: 0, e: 0 })
      const [selRects, setSelRects] = react.useState(null)
      // ===== WORKSTATION: 查找替换按钮悬停提示（原生 title 延迟久且样式不统一，自绘即时气泡）=====
      const [tip, setTip] = react.useState(null) // { x, y, text }（fixed 坐标）
      const tipOn = function (e, text) {
        if (!text) return
        const r = e.currentTarget.getBoundingClientRect()
        // 优先放按钮下方；视口放不下（编辑器矮靠底）则翻到上方
        const below = r.bottom + 7
        const up = r.top - 7
        const placeUp = below + 34 > window.innerHeight && up - 34 > 0
        const y = placeUp ? up : below
        // 横向防溢出：以按钮中心为锚，超出视口右缘则左移
        let x = r.left
        const tw = Math.min(260, window.innerWidth - 16)
        x = Math.max(4, Math.min(x, window.innerWidth - tw - 4))
        setTip({ x: x, y: y, text: text, above: placeUp })
      }
      const tipOff = function () { setTip(null) }
      // 悬停提示只在 findbox 打开期间显示；小部件关闭/卸载时清理
      react.useEffect(function () {
        if (!(st.findBox && st.findBox.open)) setTip(null)
      }, [st.findBox && st.findBox.open])
      // 点击菜单外关闭
      react.useEffect(function () {
        if (!selMenu) return
        const onDoc = function (e) {
          const el = document.querySelector('.yh-selmenu')
          if (el && !el.contains(e.target)) setSelMenu(null)
        }
        document.addEventListener('mousedown', onDoc)
        return function () { document.removeEventListener('mousedown', onDoc) }
      }, [selMenu])
      const onEdContextMenu = function (e) {
        e.preventDefault()
        const ta = taRef.current
        if (!ta) return
        const s = ta.selectionStart, en = ta.selectionEnd
        // 有非空选区才给「引用选中」；无选区给出空态提示（不弹菜单，让默认菜单走）
        if (s !== undefined && en !== undefined && s !== en && (en - s) > 0) {
          setCompl(null)
          setSelMenu({ x: e.clientX, y: e.clientY, selStart: s, selEnd: en })
        }
      }

      const tab = activeTab(st)
      const sql = tab ? tab.sql : ''
      // ===== WORKSTATION: 行号按视觉行（软换行时续行空位占一行，行号只在逻辑行首）。
      // 用实测断点（softBreaks）而非字符宽估算，保证行号与覆盖层/textarea 的真实换行一致。=====
      const vinfo = sql ? rowsFromBreaks(sql, softBreaks) : null
      let gutterText = ''
      if (vinfo) {
        const nr = String(vinfo.totalPhys).length
        for (let p = 0; p < vinfo.totalPhys; p++) {
          const hit = vinfo.rows.find(function (r) { return r.physStart === p })
          gutterText += (hit ? String(hit.lineIdx + 1).padStart(nr) : ' '.repeat(nr)) + (p < vinfo.totalPhys - 1 ? '\n' : '')
        }
      } else if (sql) {
        gutterText = sql.split('\n').map(function (_, i) { return String(i + 1) }).join('\n')
      }

      // ===== WORKSTATION: 滚动同步 —— hl 用 transform 偏移（不用 scrollTop，避免 React 重渲染重置导致错位）=====
      const syncHl = function () {
        const ta = taRef.current, hi = hlInnerRef.current, gu = gutterRef.current
        if (!ta) return
        const st2 = ta.scrollTop, sl2 = ta.scrollLeft
        if (hi) {
          // ===== WORKSTATION: 覆盖层宽度 = textarea clientWidth + 几像素余量。=====
          // 原因：镜像里量出来「刚好放得下」的分段，在覆盖层里可能因亚像素取整再折一行
          // （实测用户 DPR=2 下 brs=7、镜像 85 行、覆盖层 86 行），多折的那一行会让其下所有
          // 文字与选区整段错位。断点已由 <br> 固定，多一点宽度只影响「行尾能画到哪」，不会再折行。=====
          const tw = ta.clientWidth || 0
          if (tw) hi.style.width = tw + 'px' // 无条件设置（确保生效）
          hi.style.transform = 'translate(' + (-sl2) + 'px,' + (-st2) + 'px)'
        }
        if (gu) gu.scrollTop = st2
      }
      const onScroll = function () { syncHl() }

      react.useEffect(function () {
        syncHl()
      })

      // ===== WORKSTATION: 监听 textarea 尺寸变化（滚动条出现/消失 → 内容宽跳变）即时对齐 hl 宽度，
      // 并触发查找高亮重测（宽度变化 → 换行点变化 → 高亮矩形需重算）=====
      react.useEffect(function () {
        const ta = taRef.current
        if (!ta || typeof ResizeObserver === 'undefined') return
        const ro = new ResizeObserver(function () { syncHl(); setResizeTick(function (t) { return t + 1 }) })
        ro.observe(ta)
        return function () { try { ro.disconnect() } catch (e) { /* ignore */ } }
      }, [])

      // ===== WORKSTATION: 测量 textarea 的真实软换行断点（SQL 变化/宽度变化时重算；按行缓存，
      // 编辑时只有改动的那一行会重新二分）。放在 useLayoutEffect：必须等 textarea 拿到最终宽度。
      // 结果与上次相同则不改 state，避免多余重渲染。=====
      // ===== WORKSTATION: 按覆盖层实测选区矩形（坐标相对 hl-inner，随内容滚动，无需 scroll 依赖）。
      // 折叠选区（光标）直接跳过，零开销。
      // 关键：getClientRects 返回小数坐标，直接绝对定位会把半透明底色的边缘抗锯齿成毛边；
      // 这里把 left/top/right/bottom 各自吸附到设备像素（dpr 分之一），并把相邻行的上下边
      // 用同一套吸附值（bottom 与下一行 top 同值）→ 边缘干净、行间无缝。=====
      react.useLayoutEffect(function () {
        const inner = hlInnerRef.current, ta = taRef.current
        const s2 = Math.min(selRange.s, selRange.e), e2 = Math.max(selRange.s, selRange.e)
        if (!inner || !ta || e2 <= s2) { setSelRects(null); return }
        const rects = measureRectsIn(inner, [{ start: s2, end: e2 }], -1)
        if (!rects || !rects.length) { setSelRects(null); return }
        // Range 的矩形是按 span 分段返回的（实测 4252 字 → 3652 个矩形），且高度只有字形高
        // （15px < 行高 20.15px）→ 逐段画会有行内接缝与行间条纹（用户看到「锯齿感」）。
        // 这里按物理行合并成「一行一个矩形」，上下边取整行盒（行盒相邻 → 无缝），
        // 并把 left/right/top/bottom 吸附到设备像素（半透明底色在小数坐标会被抗锯齿成毛边）。
        const byRow = new Map()
        for (let i = 0; i < rects.length; i++) {
          const r = rects[i]
          const row = Math.round((r.top - ED_PAD_TOP) / ED_LINE_H)
          const hit = byRow.get(row)
          if (!hit) byRow.set(row, { l: r.left, r: r.left + r.width })
          else { if (r.left < hit.l) hit.l = r.left; if (r.left + r.width > hit.r) hit.r = r.left + r.width }
        }
        const dpr = window.devicePixelRatio || 1
        const q = function (v) { return Math.round(v * dpr) / dpr }
        const snapped = []
        byRow.forEach(function (v, row) {
          const y1 = q(ED_PAD_TOP + row * ED_LINE_H), y2 = q(ED_PAD_TOP + (row + 1) * ED_LINE_H)
          const x1 = q(v.l), x2 = q(v.r)
          snapped.push({ left: x1, top: y1, width: Math.max(1, x2 - x1), height: Math.max(1, y2 - y1) })
        })
        setSelRects(snapped)
      }, [selRange.s, selRange.e, sql, resizeTick])

      react.useLayoutEffect(function () {
        const b = measureSoftBreaks(sql, taRef.current)
        setSoftBreaks(function (prev) {
          if (prev === b) return prev
          if (prev.length === b.length) {
            let same = true
            for (let i = 0; i < b.length; i++) { if (prev[i] !== b[i]) { same = false; break } }
            if (same) return prev
          }
          return b
        })
      }, [sql, resizeTick])

      // ===== WORKSTATION: 选区跟踪兜底 —— React 的 onSelect 是合成事件（只由 mousedown/keyup 等触发），
      // 程序化选区与**拖选过程中的 selectionchange** 不会走它；这里直接监听 document 的
      // selectionchange（聚焦在编辑器时），保证拖选时自绘高亮实时跟随。=====
      react.useEffect(function () {
        const onSel = function () {
          const t = taRef.current
          if (!t || document.activeElement !== t) return
          syncCaret()
        }
        document.addEventListener('selectionchange', onSel)
        return function () { try { document.removeEventListener('selectionchange', onSel) } catch (e) { /* ignore */ } }
      }, [])

      const applyCompletion = function (item) {
        const ta = taRef.current
        if (!ta || !item || !compl) return
        const s = ta.selectionStart
        const val = ta.value
        const start = compl.replaceStart !== undefined ? compl.replaceStart : s
        let suffix = ''
        if (item.kind === 'f') suffix = '()'
        const ins = item.text + suffix
        wsNonKeyInput = true
        tab.sql = val.slice(0, start) + ins + val.slice(s)
        bump()
        setCompl(null)
        timer.timeout(function () {
          const t = taRef.current
          if (t) { t.focus(); const p = start + ins.length; t.setSelectionRange(p, p) }
        }, 0)
      }

      const refreshCompl = function () {
        const ta = taRef.current
        if (!ta) return
        const s = ta.selectionStart
        const val = ta.value
        const before = val.slice(0, s)
        const chain = inputChain(before)
        const tab2 = activeTab(st)
        const present = function (list, replaceStart) {
          if (list && list.length) {
            const c = caretPos(ta)
            setCompl({ list: list.slice(0, 40), sel: 0, x: c.x, y: c.y, replaceStart: replaceStart })
            closeComplAfter()
          } else if (compl) setCompl(null)
        }
        const backToSegStart = function (last) {
          let idx = s, walked = 0
          while (idx > 0 && walked < last.length && /[A-Za-z0-9_\u4e00-\u9fa5]/.test(val[idx - 1])) { idx--; walked++ }
          return idx
        }
        const filterBy = function (items, key, prefix) {
          const p = String(prefix || '').toLowerCase()
          return items.filter(function (it) { return String(it[key]).toLowerCase().indexOf(p) === 0 })
        }

        if (chain.parts.length >= 2) {
          const segs = chain.parts
          const last = segs[segs.length - 1] || ''
          const replaceStart = chain.endedWithDot ? s : backToSegStart(last)
          if (segs.length === 2) {
            const head = segs[0]
            const sch = findSchema(st, head)
            if (sch) {
              present(rankMatches(tableListOfSchema(st, sch.id).map(function (t) { return { text: t.name, kind: 'tbl', desc: '表' } }), last), replaceStart)
            } else {
              let tbl = findTable(st, head)
              // ===== WORKSTATION: 别名/无前缀表名 → 真实表补字段 =====
              if (!tbl) {
                const amap = aliasTableMap(st, tab2.sql)
                const hit = amap[String(head).toLowerCase()]
                if (hit) tbl = hit.table
              }
              if (tbl) {
                loadColumns(st, sid, tab2.engine, tbl.schemaId, tbl.tableId, bump, function (cols) {
                  present(rankMatches(toArray(cols).map(function (c) { return { text: c.name, kind: 'col', desc: c.cnName || c.comment } }), last), replaceStart)
                })
              } else if (compl) setCompl(null)
            }
          } else if (segs.length === 3) {
            const sch = findSchema(st, segs[0])
            const tbl = findTable(st, segs[1], sch ? sch.id : undefined)
            if (sch && tbl) {
              loadColumns(st, sid, tab2.engine, tbl.schemaId, tbl.tableId, bump, function (cols) {
                present(rankMatches(toArray(cols).map(function (c) { return { text: c.name, kind: 'col', desc: c.cnName || c.comment } }), last), replaceStart)
              })
            } else if (compl) setCompl(null)
          } else if (compl) setCompl(null)
          return
        }

        const last = chain.parts[0] || ''
        if (!last) { if (compl) setCompl(null); return }
        // ===== WORKSTATION: 裸字段补全 =====
        // 有 from/join → 只匹配这些表的字段（onlyKeys 限定，避免全库误补）；
        // 无 from/join → 全库表列预加载做候选。
        // 上下文类型偏好：from/join 后库表优先，select/where/on 后字段函数优先
        const pref = complPrefer(before)
        const amap = aliasTableMap(st, tab2.sql)
        const onlyKeys = Object.keys(amap).length ? new Set() : null
        if (onlyKeys) {
          Object.keys(amap).forEach(function (k) {
            const hit = amap[k]
            onlyKeys.add(hit.schemaId + '/' + hit.tableId)
          })
        }
        // 确保限定的表列已加载
        const needCols = []
        if (onlyKeys) {
          Object.keys(amap).forEach(function (k) {
            const hit = amap[k]
            const ck = hit.schemaId + '/' + hit.tableId
            if (!st.columns[ck]) needCols.push(hit)
          })
        }
        if (needCols.length) {
          let done = 0
          needCols.forEach(function (hit) {
            loadColumns(st, sid, tab2.engine, hit.schemaId, hit.tableId, bump, function () {
              done++
              if (done >= needCols.length) {
                // ===== WORKSTATION: 列加载完成时若光标前已无词（用户输入空格/标点收尾）→ 不弹补全 =====
                const ta2 = taRef.current
                const curLast = ta2 ? (inputChain(ta2.value.slice(0, ta2.selectionStart)).parts[0] || '') : last
                if (curLast) present(rootCandidates(st, curLast, onlyKeys, pref), backToSegStart(curLast))
              }
            })
          })
          return
        }
        // ===== WORKSTATION: 无 from/join 时（如刚输入 select）→ 全库表列预加载做裸字段候选 =====
        // 遍历当前数据源全部 schema 的表，列未加载的按需加载（限流并发 6、上限 300 表），
        // 完成后按「字段名+注释」去重的全库字段即进入候选。
        if (!Object.keys(amap).length) {
          const tabDs = activeTab(st)
          const schemasAll = st.schemas[String(tabDs && tabDs.dsId)] || []
          const todo = []
          schemasAll.forEach(function (s) {
            tableListOfSchema(st, s.id).forEach(function (t) {
              if (!st.columns[s.id + '/' + t.tableId]) todo.push({ schemaId: s.id, tableId: t.tableId })
            })
          })
          if (todo.length && !st.__colsLoading) {
            st.__colsLoading = true
            const limited = todo.slice(0, 300)
            let qi = 0, qdone = 0
            const pump = function () {
              if (qi >= limited.length) {
                if (qdone >= limited.length) {
                  st.__colsLoading = false
                  // ===== WORKSTATION: 预加载完成时若光标前已无词（输入空格/标点收尾）→ 不弹补全；
                  // 只完成列缓存供下次真实输入用 =====
                  const ta2 = taRef.current
                  const curLast = ta2 ? (inputChain(ta2.value.slice(0, ta2.selectionStart)).parts[0] || '') : last
                  if (curLast) present(rootCandidates(st, curLast, null, pref), backToSegStart(curLast))
                }
                return
              }
              const hit = limited[qi++]
              loadColumns(st, sid, tab2.engine, hit.schemaId, hit.tableId, bump, function () {
                qdone++
                pump()
              })
            }
            for (let w = 0; w < 6; w++) pump()
            return
          }
        }
        present(rootCandidates(st, last, onlyKeys, pref), backToSegStart(last))
      }

      const onKeyDown = function (e) {
        // ===== WORKSTATION: Cmd+Enter / Ctrl+Enter 执行（有选区执行选区，无选区整段）=====
        if ((/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '') ? e.metaKey : e.ctrlKey) && (e.key === 'Enter' || e.code === 'Enter')) {
          e.preventDefault()
          const ta0 = taRef.current
          if (ta0) { const t0 = activeTab(st); if (t0 && t0.running) killRun(st, sid, bump); else doRun(st, sid, bump) }
          return
        }
        // ===== WORKSTATION: Cmd/Ctrl+F 查找、Cmd/Ctrl+Alt+F（Win 为 Ctrl+H）查找替换、Esc 关闭 =====
        const modF = modKeyOf(e)
        if (modF && !e.altKey && (e.key === 'f' || e.key === 'F')) { e.preventDefault(); openFind(false); return }
        if ((modF && e.altKey && (e.key === 'f' || e.key === 'F')) || (!/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '') && modF && (e.key === 'h' || e.key === 'H'))) { e.preventDefault(); openFind(true); return }
        if (e.key === 'Escape' && st.findBox && st.findBox.open) { e.preventDefault(); closeFind(); return }
        if (compl) {
          if (e.key === 'Tab') { e.preventDefault(); applyCompletion(compl.list[compl.sel]); return }
          if (e.key === 'ArrowDown') { e.preventDefault(); setCompl(Object.assign({}, compl, { sel: Math.min(compl.sel + 1, compl.list.length - 1) })); return }
          if (e.key === 'ArrowUp') { e.preventDefault(); setCompl(Object.assign({}, compl, { sel: Math.max(compl.sel - 1, 0) })); return }
          if (e.key === 'Escape') { setCompl(null); return }
          if (e.key === 'Enter') {
            // ===== WORKSTATION: 输入法 composition 中 Enter 是确认输入，不应用补全 =====
            if (composingRef.current) return
            e.preventDefault(); applyCompletion(compl.list[compl.sel]); return
          }
          // ===== WORKSTATION: 移动光标的键（左右/行首行尾/翻页）→ 立即隐藏补全 =====
          if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End' || e.key === 'PageUp' || e.key === 'PageDown') { setCompl(null); return }
        }
        const ta = taRef.current
        if (!ta) return
        // ===== WORKSTATION: Enter 换行自动带当前行缩进（单光标；多光标时仅主光标所在行应用）=====
        if (e.key === 'Enter') {
          // ===== WORKSTATION: 输入法 composition 中 Enter 是确认候选，不做换行/缩进 =====
          if (composingRef.current) return
          const s = ta.selectionStart, en = ta.selectionEnd
          const val = ta.value
          if (s === en && !e.shiftKey) {
            // 取当前行行首到光标前的缩进（空格/制表）
            const lineStart = val.lastIndexOf('\n', s - 1) + 1
            const indent = (val.slice(lineStart, s).match(/^[ \t]*/) || [''])[0]
            e.preventDefault()
            const ins = '\n' + indent
            setTaValue(ta, val.slice(0, s) + ins + val.slice(en), s + ins.length, s + ins.length)
            return
          }
          // 有选区/Shift+Enter：保持默认换行（不额外处理）
          return
        }
        // Tab：有补全时已在上面处理；无补全时缩进 4 空格；Shift+Tab 减少一级缩进
        if (e.key === 'Tab') {
          e.preventDefault()
          if (e.shiftKey) outdentSel(ta); else indentSel(ta)
          return
        }
        // Cmd+/（Windows 为 Ctrl+/）单行注释，Shift+Cmd+/ 多行块注释
        const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '')
        const mod = isMac ? e.metaKey : e.ctrlKey
        if (mod && (e.key === '/' || e.code === 'Slash')) {
          e.preventDefault()
          if (e.shiftKey) toggleBlockComment(ta); else toggleLineComment(ta)
          return
        }
      }

      let mcSyncing = false
      const lastDelDirRef = react.useRef('backward') // 最近一次删除方向（beforeinput 判定）
      const onBeforeInput = function (e) {
        const t = e.inputType || ''
        if (t.indexOf('deleteContentBackward') === 0 || t.indexOf('deleteWordBackward') === 0 || t.indexOf('deleteHardLineBackward') === 0) lastDelDirRef.current = 'backward'
        else if (t.indexOf('deleteContentForward') === 0 || t.indexOf('deleteWordForward') === 0 || t.indexOf('deleteSoftLineForward') === 0) lastDelDirRef.current = 'forward'
        // ===== WORKSTATION: 粘贴/拖放/自动填充等批量插入 → 非键盘输入，不弹补全 =====
        if (t.indexOf('insertFromPaste') === 0 || t.indexOf('insertFromDrop') === 0 || t.indexOf('insertFromYank') === 0 || t.indexOf('insertReplacementText') === 0) {
          markPaste()
        }
      }
      const onInput = function (e) {
        const nv = e.target.value
        if (mcSyncing) { tab.sql = nv; bump(); setCompl(null); wsScheduleSave(sid); return }
        const ov = tab.sql
        // ===== WORKSTATION: 粘贴/拖放窗口内（多次 input 也拦截）→ 只同步 value，不弹补全 =====
        if (Date.now() - wsPasteAt < 800) {
          wsNonKeyInput = false
          if (nv !== ov) { tab.sql = nv; wsScheduleSave(sid); bump() }
          if (compl) setCompl(null)
          return
        }
        // ===== WORKSTATION: 非键盘插入（程序 setTaValue/收藏插入/打开文件/补全应用等标记）→
        // 只同步 value、关闭补全，一律不弹 =====
        if (wsNonKeyInput) {
          wsNonKeyInput = false
          if (nv !== ov) { tab.sql = nv; wsScheduleSave(sid); bump() }
          if (compl) setCompl(null)
          return
        }
        // ===== WORKSTATION: 程序改 sql 后的抑制窗口内（收藏插入/恢复/write 后 React 渲染触发的
        // input）→ 只同步 value，不弹补全 =====
        if (isProgSqlWindow()) {
          if (nv !== ov) { tab.sql = nv; wsScheduleSave(sid); bump() }
          if (compl) setCompl(null)
          return
        }
        // ===== WORKSTATION: 非用户 input（isTrusted=false）→ 只同步 value，不弹补全 =====
        if (e && e.isTrusted === false) {
          if (nv !== ov) { tab.sql = nv; wsScheduleSave(sid); bump() }
          if (compl) setCompl(null)
          return
        }
        // ===== WORKSTATION: value 未变的 input（React 恢复触发/程序 dispatch）→ 不弹补全 =====
        if (nv === ov) { if (compl) setCompl(null); return }
        tab.sql = nv
        wsScheduleSave(sid)
        const mc = st.mcursors || []
        const ta = taRef.current
        if (!mc.length || !ta) { syncCaret(); bump(); refreshCompl(); return }
        // 多光标编辑：不弹补全（关闭已有补全，避免干扰多光标）
        setCompl(null)
        // 多光标：diff 出主光标编辑，同步到所有额外光标
        const ed = diffEdit(ov, nv)
        const delLen = ed.end - ed.start, insLen = ed.inserted.length
        if (delLen === 0 && insLen === 0) { bump(); return }
        const mainPos = ta.selectionStart
        // 删除方向：beforeinput 判定 Backspace（删光标前）或 Delete（删光标后）
        const backspace = lastDelDirRef.current !== 'forward'
        // 收集额外光标（转 nv 坐标，跳过删除区/主插入点同位）
        const list = []
        for (let i = 0; i < mc.length; i++) {
          const p = mc[i]
          if ((p >= ed.start && p < ed.end) || (delLen === 0 && p === ed.start)) continue
          let q = p
          if (p >= ed.end) q = p + insLen - delLen
          list.push(q)
        }
        // 升序处理：逐个应用编辑并实时更新后续光标位置（降序会导致 keep 被后续插入推后而错位）
        list.sort(function (a, b) { return a - b })
        let cur = nv
        const keep = [], applied = []
        const net = insLen - delLen
        for (let i = 0; i < list.length; i++) {
          const q = list[i]
          let delStart, newPos
          if (insLen > 0) { delStart = q; newPos = q + insLen }
          else if (backspace) { delStart = Math.max(0, q - delLen); newPos = delStart }
          else { delStart = q; newPos = q }
          cur = cur.slice(0, delStart) + ed.inserted + cur.slice(delStart + delLen)
          applied.push({ delStart: delStart, net: net })
          keep.push(newPos)
          // 后续（更靠后）的光标位置随本次编辑整体平移
          for (let j = i + 1; j < list.length; j++) {
            if (list[j] > q) list[j] += net
          }
        }
        st.mcursors = keep.sort(function (a, b) { return a - b })
        if (cur !== nv) {
          let shift = 0
          for (let i = 0; i < applied.length; i++) if (applied[i].delStart <= mainPos) shift += applied[i].net
          const newMain = Math.max(0, mainPos + shift)
          mcSyncing = true
          setTaValue(ta, cur, newMain, newMain) // 触发 onInput(mcSyncing) → tab.sql=cur + bump + setCompl(null)
          mcSyncing = false
        } else {
          bump() // 多光标编辑：不刷新补全
        }
      }

      // ===== WORKSTATION: 在 ( 右侧 / ) 左侧双击 → 自动选中括号内全部字符（支持嵌套多对括号）=====
      const onDblClickParen = function (e) {
        const ta = taRef.current
        if (!ta) return
        const val = ta.value
        if (!val) return
        const p = posFromMouse(ta, e) // 双击点的字符位
        let selStart = -1, selEnd = -1
        // 情形1：点在某个 '(' 的右侧（紧贴或落在其上）→ 向右找配对的 ')'（depth 从 1 计层）
        if (p > 0 && (val[p - 1] === '(' || val[p] === '(')) {
          const open = (val[p - 1] === '(') ? p - 1 : p
          let depth = 1 // 起点 '(' 记 1 层
          for (let i = open + 1; i < val.length; i++) {
            const c = val[i]
            if (c === '(') depth++
            else if (c === ')') { depth--; if (depth === 0) { selStart = open + 1; selEnd = i; break } }
          }
        } else if (p > 0 && (val[p] === ')' || val[p - 1] === ')' || (val[p + 1] === ')' && val[p] !== '('))) {
          // 情形2：点在某个 ')' 的左侧/其上（含 posFromMouse 偏差导致的紧左字符位）→ 向左找配对的 '('
          const close = (val[p] === ')') ? p : (val[p - 1] === ')' ? p - 1 : p + 1)
          let depth = 1 // 起点 ')' 记 1 层
          for (let i = close - 1; i >= 0; i--) {
            const c = val[i]
            if (c === ')') depth++
            else if (c === '(') { depth--; if (depth === 0) { selStart = i + 1; selEnd = close; break } }
          }
        }
        if (selStart !== -1 && selEnd !== -1 && selEnd > selStart) {
          e.preventDefault()
          if (st.mcursors && st.mcursors.length) { st.mcursors = []; bump() }
          ta.setSelectionRange(selStart, selEnd)
          setCompl(null)
        }
        // 不满足括号边界条件 → 不阻止默认（浏览器原生双击选词）
      }

      const onMouseDown = function (e) {
        const ta = taRef.current
        if (!ta) return
        const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '')
        const mod = isMac ? e.metaKey : e.ctrlKey
        if (mod && e.button === 0) {
          // Cmd/Ctrl+点击：主光标保留原位，点击处添加额外光标（VS Code 语义，点 N 次 = 1 主 + N 额外）；
          // 点击已存在的额外位置则取消；点击主光标位置无操作
          e.preventDefault()
          const pos = posFromMouse(ta, e)
          const mc = st.mcursors || (st.mcursors = [])
          const cur = ta.selectionStart
          const idx = mc.indexOf(pos)
          if (idx !== -1) { mc.splice(idx, 1); mc.sort(function (a, b) { return a - b }); setCompl(null); bump(); return }
          if (pos === cur) { setCompl(null); bump(); return }
          mc.push(pos)
          mc.sort(function (a, b) { return a - b })
          setCompl(null)
          bump()
          return
        }
        // 普通点击：清除多光标；移动光标 → 立即隐藏补全
        if (st.mcursors && st.mcursors.length) { st.mcursors = []; bump() }
        if (compl) setCompl(null)
      }

      // ===== WORKSTATION: 点击行号（gutter）选中该逻辑行 =====
      const onGutterClick = function (e) {
        const ta = taRef.current, gu = gutterRef.current
        if (!ta || !gu) return
        const rect = gu.getBoundingClientRect()
        const y = e.clientY - rect.top + gu.scrollTop
        const physRow = Math.max(0, Math.floor((y - ED_PAD_TOP) / ED_LINE_H))
        const curSql = ta.value
        const uw = usableWidthOf(ta)
        const vinfo = curSql ? visualRowsOf(curSql, uw) : null
        if (!vinfo || physRow >= vinfo.totalPhys) { e.preventDefault(); return }
        const hit = vinfo.rows.find(function (r) { return r.physStart === physRow })
        if (!hit) { e.preventDefault(); return } // 续行（软换行折行处）无行号，不选中
        e.preventDefault()
        // 该逻辑行在 sql 中的字符起止
        let lineStart = 0
        for (let li = 0; li < hit.lineIdx; li++) lineStart = curSql.indexOf('\n', lineStart) + 1
        const nl = curSql.indexOf('\n', lineStart)
        const lineEnd = nl === -1 ? curSql.length : nl
        ta.focus()
        ta.setSelectionRange(lineStart, lineEnd)
        if (st.mcursors && st.mcursors.length) { st.mcursors = []; bump() }
        if (compl) setCompl(null)
      }

      // ===== WORKSTATION: 查找替换（VSCode 风格）—— 小部件状态在 st.findBox（per-session）=====
      const fb = st.findBox
      const findInputRef = react.useRef(null)
      const replaceInputRef = react.useRef(null)
      const fbFocusRef = react.useRef('find') // 替换操作后焦点还原到最近使用的输入框
      // focusTick 变化（每次 openFind）→ 聚焦并全选查找输入框；普通 bump 重渲染不重复聚焦
      react.useEffect(function () {
        if (fb && fb.open && findInputRef.current) { findInputRef.current.focus(); findInputRef.current.select() }
      }, [fb && fb.open, fb && fb.focusTick])
      const modKeyOf = function (e) {
        return /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '') ? e.metaKey : e.ctrlKey
      }
      const openFind = function (withRep) {
        const ta = taRef.current
        const f = st.findBox = Object.assign({ open: false, showRep: false, q: '', rep: '', caseS: false, word: false, re: false, pos: 0, focusTick: 0 }, st.findBox || {})
        f.open = true
        if (withRep) f.showRep = true
        f.pos = ta ? ta.selectionStart : 0
        // VSCode 行为：查找框为空时预填编辑器选中文本
        if (ta && ta.selectionStart !== ta.selectionEnd && !f.q) f.q = ta.value.slice(ta.selectionStart, ta.selectionEnd)
        f.focusTick = (f.focusTick || 0) + 1
        setCompl(null)
        bump()
      }
      const closeFind = function () {
        st.findBox.open = false
        bump()
        const ta = taRef.current
        if (ta) ta.focus()
      }
      // 匹配派生（渲染体纯计算，不 emit）：matches + 当前索引（首个 start>=pos，无则回绕 0）
      const findData = (function () {
        if (!fb || !fb.open) return null
        const q = fb.q || ''
        if (!q) return { matches: [], cur: -1, error: false }
        const res = computeMatches(sql, q, { caseS: fb.caseS, word: fb.word, re: fb.re })
        if (res && res.error) return { matches: [], cur: -1, error: true }
        let cur = -1
        for (let i = 0; i < res.length; i++) { if (res[i].start >= fb.pos) { cur = i; break } }
        if (cur === -1 && res.length) cur = 0
        return { matches: res, cur: cur, error: false }
      })()
      // 把字符位置滚动到编辑器可视区（垂直；textarea 无横向滚动）
      // ===== WORKSTATION: 优先用实测矩形定位（CJK/软换行精确），实测不到再回退 cursorXY 估算 =====
      const scrollPosIntoView = function (text, pos) {
        const ta = taRef.current
        if (!ta) return
        let top = null
        const inner = hlInnerRef.current
        if (inner && findData && findData.matches.length) {
          const m = findData.matches.find(function (mm) { return pos >= mm.start && pos < mm.end })
          if (m) {
            const rs = measureRectsIn(inner, [m], -1)
            if (rs && rs.length) top = rs[0].top
          }
        }
        if (top === null) { const xy = cursorXY(text, pos, usableWidthOf(ta)); top = xy.y - 3 }
        if (top < ta.scrollTop + 10) ta.scrollTop = Math.max(0, top - ED_LINE_H - 10)
        else if (top + ED_LINE_H > ta.scrollTop + ta.clientHeight - 10) ta.scrollTop = top + ED_LINE_H + 10 - ta.clientHeight
        syncHl()
      }
      const gotoMatch = function (dir) {
        if (!findData || !findData.matches.length || findData.cur < 0) return
        const ms = findData.matches
        const curM = ms[findData.cur]
        let target = null
        if (dir > 0) {
          for (let i = 0; i < ms.length; i++) if (ms[i].start >= curM.end) { target = i; break }
          if (target === null) target = 0 // 回绕
        } else {
          for (let i = ms.length - 1; i >= 0; i--) if (ms[i].start < curM.start) { target = i; break }
          if (target === null) target = ms.length - 1 // 回绕
        }
        fb.pos = ms[target].start
        scrollPosIntoView(sql, ms[target].start)
        bump()
      }
      // 程序性替换写入：优先 execCommand('insertText')（进浏览器 undo 栈可 Cmd+Z），失败回退 setTaValue
      const writeReplaced = function (expected, selStart, selEnd, rep) {
        const ta = taRef.current
        if (!ta) return
        ta.focus()
        ta.setSelectionRange(selStart, selEnd)
        wsNonKeyInput = true
        let ok = false
        try { ok = document.execCommand('insertText', false, rep) } catch (e) { ok = false }
        if (!ok || ta.value !== expected) setTaValue(ta, expected, selStart + rep.length, selStart + rep.length)
      }
      const replacementFor = function (matched) {
        let rep = fb.rep || ''
        if (fb.re) {
          try { rep = matched.replace(new RegExp(fb.q, fb.caseS ? '' : 'i'), fb.rep || '') } catch (e) { rep = fb.rep || '' }
        }
        return rep
      }
      const replaceCurrent = function () {
        if (!findData || !findData.matches.length || findData.cur < 0) return
        const ta = taRef.current
        if (!ta || !tab || ta.value !== sql) return // 编辑器内容与渲染态不一致（模型刚写入）→ 放弃本次，等重渲染
        const m = findData.matches[findData.cur]
        const rep = replacementFor(sql.slice(m.start, m.end))
        const expected = sql.slice(0, m.start) + rep + sql.slice(m.end)
        if (st.mcursors && st.mcursors.length) st.mcursors = []
        writeReplaced(expected, m.start, m.end, rep)
        fb.pos = m.start + rep.length
        // 下一个匹配滚入视区（按写入后的新文本计算）
        const res2 = computeMatches(expected, fb.q, { caseS: fb.caseS, word: fb.word, re: fb.re })
        if (res2 && !res2.error && res2.length) {
          let tgt = -1
          for (let i = 0; i < res2.length; i++) if (res2[i].start >= fb.pos) { tgt = i; break }
          if (tgt === -1) tgt = 0
          scrollPosIntoView(expected, res2[tgt].start)
        }
        bump()
        const fr = fbFocusRef.current === 'rep' ? replaceInputRef : findInputRef
        if (fr.current) fr.current.focus()
      }
      const replaceAllMatches = function () {
        if (!findData || !findData.matches.length) return
        const ta = taRef.current
        if (!ta || !tab || ta.value !== sql) return // 同上：防模型并发写入被旧内容覆盖
        const ms = findData.matches
        let out = '', last = 0, count = 0
        for (let i = 0; i < ms.length; i++) {
          const m = ms[i]
          out += sql.slice(last, m.start) + replacementFor(sql.slice(m.start, m.end))
          last = m.end
          count++
        }
        out += sql.slice(last)
        if (out === sql) { showToast(st, '替换后与原文相同，无变化'); return } // 如 find/replace 相同文本
        if (st.mcursors && st.mcursors.length) st.mcursors = []
        writeReplaced(out, 0, ta.value.length, out)
        fb.pos = 0
        bump()
        wsScheduleSave(sid) // onInput 已排存，兜底幂等再排一次
        showToast(st, '已替换 ' + count + ' 处')
        const fr = fbFocusRef.current === 'rep' ? replaceInputRef : findInputRef
        if (fr.current) fr.current.focus()
      }
      // 输入框内的全局快捷键：Cmd/Ctrl+F 重新聚焦查找框、Cmd/Ctrl+Alt+F 展开替换行
      const focusFindFromKeys = function (e) {
        const mf = modKeyOf(e)
        if (mf && !e.altKey && (e.key === 'f' || e.key === 'F')) {
          e.preventDefault()
          const inp = findInputRef.current
          if (inp) { inp.focus(); inp.select() }
          return true
        }
        if (mf && e.altKey && (e.key === 'f' || e.key === 'F')) {
          e.preventDefault()
          if (!fb.showRep) { fb.showRep = true }
          bump()
          const inp = findInputRef.current
          if (inp) { inp.focus(); inp.select() }
          return true
        }
        return false
      }
      const onFindInputKeyDown = function (e) {
        if (e.nativeEvent && e.nativeEvent.isComposing) return // 输入法组词中 Enter 是确认候选
        if (focusFindFromKeys(e)) return
        if (e.key === 'Enter') { e.preventDefault(); gotoMatch(e.shiftKey ? -1 : 1); return }
        if (e.key === 'Escape') { e.preventDefault(); closeFind() }
      }
      const onReplaceInputKeyDown = function (e) {
        if (e.nativeEvent && e.nativeEvent.isComposing) return
        if (focusFindFromKeys(e)) return
        if (e.key === 'Enter') { e.preventDefault(); if (modKeyOf(e)) replaceAllMatches(); else replaceCurrent(); return }
        if (e.key === 'Escape') { e.preventDefault(); closeFind() }
      }
      // ===== WORKSTATION: 匹配高亮矩形直接由 findRects（useLayoutEffect 实测）驱动渲染，
      // 见下方 JSX（hl-inner 内 z-index:-1 叠文字下；上限 500 个防大 SQL 卡顿）=====
      const findCountText = findData ? (fb.q ? (findData.error ? '无效正则' : (findData.matches.length ? (findData.cur + 1) + '/' + findData.matches.length : '无结果')) : '') : ''

      // ===== WORKSTATION: 查找高亮实测定位 —— 渲染后按浏览器真实布局测量匹配矩形。
      // deps 覆盖：查询词/开关变化、SQL 变化、输入框打开、宽度变化（resizeTick）。
      // 测量后 setState 触发一次重渲染；deps 不变 → 该 effect 不会重入（无死循环）。
      // 实测失败（DOM 异常/空文本）→ 回退按字符宽估算（matchRects），保证高亮不消失。=====
      react.useLayoutEffect(function () {
        const ta = taRef.current
        const inner = hlInnerRef.current
        if (ta) {
          const tw = ta.clientWidth
          if (tw && inner) inner.style.width = tw + 'px' // 与 syncHl 同步宽度，确保按当前换行宽测量
        }
        if (!fb.open || !findData || !findData.matches.length || !inner || !sql) { setFindRects(null); return }
        const list = findData.matches.slice(0, 500)
        const rects = measureRectsIn(inner, list, findData.cur)
        if (rects && rects.length) { setFindRects(rects); return }
        const uw = usableWidthOf(ta)
        const out = []
        for (let i = 0; i < list.length; i++) {
          const rs = matchRects(sql, list[i].start, list[i].end, uw)
          for (let j = 0; j < rs.length; j++) out.push({ left: rs[j].left, top: rs[j].top, width: rs[j].width, height: rs[j].height, cur: i === findData.cur })
        }
        setFindRects(out.length ? out : null)
      }, [fb.open, fb.q, fb.caseS, fb.word, fb.re, fb.pos, sql, resizeTick])

      // ===== WORKSTATION: 当前光标所在物理行浅灰背景 top（用实测断点行号，与文字排版一致）=====
      const curTop = sql ? (function () {
        const pos = Math.max(0, Math.min(caret, sql.length))
        return ED_PAD_TOP + physRowOfOffset(sql, softBreaks, pos) * ED_LINE_H
      })() : 0

      const mcurMarkers = (st.mcursors || []).map(function (p) {
        if (p < 0 || p > sql.length) return null
        const xy = cursorXY(sql, p, usableWidthOf(taRef.current))
        return h('span', { key: 'mc' + p + '_' + xy.x + '_' + xy.y, className: 'yh-olap-mcur', style: { left: xy.x, top: xy.y } })
      })

      return h(react.Fragment, null,
        h('pre', { className: 'yh-olap-gutter', ref: gutterRef, onMouseDown: onGutterClick, title: '点击行号选中该行' }, gutterText),
        h('div', { className: 'yh-olap-code' },
          h('pre', { className: 'yh-olap-hl', ref: hlRef, 'aria-hidden': 'true' },
            h('div', { className: 'yh-olap-hl-inner', ref: hlInnerRef },
              curTop !== 0 ? h('div', { className: 'yh-olap-curline', style: { top: curTop + 'px' } }) : null,
              (findRects && findRects.length) ? findRects.map(function (x, i) {
                return h('div', { key: 'fh' + i, className: 'yh-olap-findhit' + (x.cur ? ' cur' : ''), style: { left: x.left + 'px', top: x.top + 'px', width: x.width + 'px', height: x.height + 'px' } })
              }) : null,
              (selRects && selRects.length) ? selRects.map(function (x, i) {
                return h('div', { key: 'sh' + i, className: 'yh-olap-selhit', style: { left: x.left + 'px', top: x.top + 'px', width: x.width + 'px', height: x.height + 'px' } })
              }) : null,
              highlight(sql, tab && tab.engine, softBreaks), ...mcurMarkers)),
          h('textarea', { className: 'yh-olap-input' + (selRects && selRects.length ? ' yh-selown' : ''), ref: taRef, value: sql, spellCheck: false, wrap: 'soft', onSelect: function () { syncCaret() }, onScroll: onScroll, onKeyDown: onKeyDown, onBeforeInput: onBeforeInput, onInput: onInput, onMouseDown: onMouseDown, onDoubleClick: onDblClickParen, onKeyUp: function () { syncCaret() }, onMouseUp: function () { syncCaret() }, onPaste: function () { markPaste() }, onContextMenu: onEdContextMenu, onCompositionStart: function () { composingRef.current = true }, onCompositionEnd: function () { composingRef.current = false }, onBlur: function () { if (st.mcursors && st.mcursors.length) { st.mcursors = []; bump() } timer.timeout(function () { setCompl(null); bump() }, 120) } })),
        compl ? h('div', { className: 'yh-olap-complete', style: { left: compl.x, top: compl.y } },
          compl.list.map(function (it, i) {
            return h('div', { key: it.kind + it.text + i, className: i === compl.sel ? 'sel' : '', onMouseDown: function (e) { e.preventDefault(); applyCompletion(it) } },
              h('span', { className: 'k' }, it.text),
              h('span', { className: 'd' }, typeDesc(it.desc || it.kind)))
          })) : null,
        // ===== WORKSTATION: 编辑器右键菜单（引用选中 SQL 片段）=====
        selMenu ? h('div', { className: 'yh-olap-cmenu yh-selmenu', style: { left: Math.min(selMenu.x, window.innerWidth - 240), top: Math.min(selMenu.y, window.innerHeight - 160) }, onMouseDown: function (e) { e.stopPropagation() }, onContextMenu: function (e) { e.preventDefault(); e.stopPropagation() } },
          h('div', { className: 'yh-olap-citem', onClick: function () {
            const m = selMenu
            setSelMenu(null)
            if (referSelection(tab, m.selStart, m.selEnd, st)) { /* toast 已在函数内 */ }
          }, title: '把选中的 SQL 片段以「标签#id + 行区间」块加入聊天框，模型可据此精确读取该段' }, '引用选中 SQL（添加到聊天框）'),
          h('div', { className: 'yh-olap-citem', onClick: function () {
            const m = selMenu
            setSelMenu(null)
            const ta = taRef.current
            if (ta) {
              const sel = ta.value.slice(m.selStart, m.selEnd)
              if (copyToClipboard(sel)) showToast(st, '已复制选中 SQL')
              else showToast(st, '复制失败')
            }
          }, title: '复制选中的 SQL 原文' }, '复制选中 SQL'))
           : null,
        // ===== WORKSTATION: 查找替换小部件（VSCode 风格，编辑器右上角浮层）=====
        fb && fb.open ? h('div', { className: 'yh-olap-findbox', onMouseDown: function (e) { e.stopPropagation() } },
          h('div', { className: 'yh-olap-findrow' },
            h('button', { className: 'yh-olap-findbtn tog' + (fb.showRep ? ' on' : ''), onMouseDown: function (e) { e.preventDefault() }, onClick: function () { fb.showRep = !fb.showRep; bump() }, onMouseEnter: function (e) { tipOn(e, fb.showRep ? '收起替换框' : '展开替换框（Cmd/Ctrl+Alt+F）') }, onMouseLeave: tipOff }, fb.showRep ? '▾' : '▸'),
            h('input', { className: 'yh-olap-findinp' + (findData && findData.error ? ' err' : ''), ref: findInputRef, value: fb.q, placeholder: '查找', spellCheck: false,
              onChange: function (e) { fb.q = e.target.value; fb.pos = taRef.current ? taRef.current.selectionStart : 0; bump() },
              onFocus: function () { fbFocusRef.current = 'find' },
              onKeyDown: onFindInputKeyDown }),
            h('button', { className: 'yh-olap-findbtn opt' + (fb.caseS ? ' on' : ''), onMouseDown: function (e) { e.preventDefault() }, onClick: function () { fb.caseS = !fb.caseS; bump() }, onMouseEnter: function (e) { tipOn(e, '区分大小写：on=' + (fb.caseS ? '已开启' : '关闭') + '，点击切换') }, onMouseLeave: tipOff }, 'Aa'),
            h('button', { className: 'yh-olap-findbtn opt' + (fb.word ? ' on' : ''), onMouseDown: function (e) { e.preventDefault() }, onClick: function () { fb.word = !fb.word; bump() }, onMouseEnter: function (e) { tipOn(e, '全字匹配：on=' + (fb.word ? '已开启' : '关闭') + '，只匹配完整单词') }, onMouseLeave: tipOff }, 'ab'),
            h('button', { className: 'yh-olap-findbtn opt' + (fb.re ? ' on' : ''), onMouseDown: function (e) { e.preventDefault() }, onClick: function () { fb.re = !fb.re; bump() }, onMouseEnter: function (e) { tipOn(e, '正则表达式：on=' + (fb.re ? '已开启' : '关闭') + '，查找/替换支持 $1 分组') }, onMouseLeave: tipOff }, '.*'),
            h('span', { className: 'yh-olap-findcnt' + (findData && (findData.error || !findData.matches.length) ? ' none' : '') }, findCountText),
            h('button', { className: 'yh-olap-findbtn', onMouseDown: function (e) { e.preventDefault() }, onClick: function () { gotoMatch(-1) }, onMouseEnter: function (e) { tipOn(e, '上一个匹配（Shift+Enter）') }, onMouseLeave: tipOff }, '↑'),
            h('button', { className: 'yh-olap-findbtn', onMouseDown: function (e) { e.preventDefault() }, onClick: function () { gotoMatch(1) }, onMouseEnter: function (e) { tipOn(e, '下一个匹配（Enter）') }, onMouseLeave: tipOff }, '↓'),
            h('button', { className: 'yh-olap-findbtn', onMouseDown: function (e) { e.preventDefault() }, onClick: function () { closeFind() }, onMouseEnter: function (e) { tipOn(e, '关闭查找（Esc）') }, onMouseLeave: tipOff }, '×')),
          fb.showRep ? h('div', { className: 'yh-olap-findrow rep' },
            h('span', { className: 'yh-olap-findgap' }),
            h('input', { className: 'yh-olap-findinp', ref: replaceInputRef, value: fb.rep, placeholder: '替换（正则可用 $1 引用分组）', spellCheck: false,
              onChange: function (e) { fb.rep = e.target.value; bump() },
              onFocus: function () { fbFocusRef.current = 'rep' },
              onKeyDown: onReplaceInputKeyDown }),
            h('button', { className: 'yh-olap-findbtn act', onMouseDown: function (e) { e.preventDefault() }, onClick: function () { replaceCurrent() }, onMouseEnter: function (e) { tipOn(e, '替换当前匹配（Enter）') }, onMouseLeave: tipOff }, '替换'),
            h('button', { className: 'yh-olap-findbtn act', onMouseDown: function (e) { e.preventDefault() }, onClick: function () { replaceAllMatches() }, onMouseEnter: function (e) { tipOn(e, '全部替换（Cmd/Ctrl+Enter）') }, onMouseLeave: tipOff }, '全部')) : null,
        // ===== WORKSTATION: 悬停提示气泡（fixed 定位，findbox 内按钮悬停显示）=====
        tip ? h('div', { className: 'yh-olap-findtip', style: { left: tip.x + 'px', top: tip.y + 'px' } }, tip.text) : null) : null)
    }

    function doRun(st, sid, bump, onlyLines) {
      const tab = activeTab(st)
      if (!tab) return
      let sql = tab.sql
      if (onlyLines && onlyLines.length === 2) {
        const lines = sql.split('\n')
        sql = lines.slice(onlyLines[0] - 1, onlyLines[1]).join('\n')
      } else {
        // ===== WORKSTATION: 无 onlyLines 时 —— 编辑器有非空选区 → 只执行选区；无选区 → 整段 =====
        const ta = document.querySelector('.yh-olap-input')
        if (ta && ta.value != null) {
          const s = ta.selectionStart, en = ta.selectionEnd
          if (s != null && en != null && s !== en) {
            const sel = ta.value.slice(s, en)
            if (sel.trim()) sql = sel
          }
        }
      }
      if (!sql.trim()) { tab.log = '无 SQL'; tab.finish = 'error'; bump(); return }
      const paramsArr = Object.keys(tab.params || {}).map(function (k) { return { key: k, value: tab.params[k] } })
      const payload = { sql: sql, engine: tab.engine, dsId: tab.dsId, params: paramsArr }
      tab.running = true; tab.finish = 'run'; tab.log = ''; tab.errMsg = ''; tab.result = null; tab.executeId = ''
      tab.bottomTab = 'log'
      bump()
      callHost('olap.submit', { payload: payload }).then(function (r) {
        if (!r || !r.ok) {
          tab.running = false; tab.finish = 'error'; tab.errMsg = (r && r.error) || '提交失败'; tab.log = tab.errMsg
          bump(); return
        }
        const eid = r.data && r.data.executeId
        if (!eid) {
          // ===== WORKSTATION: 提交响应缺 executeId 也必须失败收尾（否则 running 永真 → 按钮卡「停止」）=====
          tab.running = false; tab.finish = 'error'; tab.errMsg = '提交响应缺少 executeId'; tab.log = tab.errMsg
          bump(); return
        }
        tab.executeId = eid
        pollRun(st, sid, bump, tab)
      })
    }

    // ===== WORKSTATION: 执行状态/结果轮询。=====
    // 本轮重构（2026-09-07，CDP 实测复现并修复「有结果但按钮卡停止」）：
    // ① runTab 绑定：原实现对每个循环/看门狗实时取 activeTab(st)，用户中途切到其他标签
    //    → alive()=false → 三个循环全部退出、看门狗也放弃 → 该运行永久卡在「停止」
    //    （实测：切走 45s+ 再切回，按钮永不复位，即使查询已出结果）。现在把运行绑定
    //    到发起时的 tab 对象，切标签不再影响轮询收尾。
    // ② 成功 = checkState finish==='ok'（后端完成信号，errMsg='请查看结果'）：原实现
    //    要求 result.list.length>0 才收尾，0 行结果永远走不到成功分支，只能等 40s 兜底
    //    （RPC 慢时远不止 40s）。0 行也是成功，收尾即切结果页。
    // ③ 看门狗改停滞检测：原实现在 45s 固定强杀，且日志关键词含「稍后」——实测日志
    //    「sql执行中,请稍后....」命中 → 仍在执行/慢但成功的查询被误标「执行超时或失败」。
    //    现在任一轮询 RPC 成功即续命，只有全部循环持续 >20s 无成功响应（RPC 全挂）
    //    才先做最终 checkState 再判定。长查询不再被误杀。
    // ④ 结果补拉：settle 成功但结果仍在物化（isReady='run'）→ fillResult 继续拉，
    //    就绪后补进结果页（原实现 resLoop 只拉 30s 就死，晚到的结果被吞成 0 行）。
    function pollRun(st, sid, bump, runTab) {
      const tab = runTab || activeTab(st)
      const rid = tab.executeId
      if (!rid) return
      const alive = function () {
        return tab && tab.running && tab.executeId === rid && st.tabs.indexOf(tab) !== -1
      }
      let gotResult = false
      let gotError = false
      let gotRealResult = false // 是否已拿到真实 result 响应（区别于 settle 的空默认值）
      let sawOkAt = 0           // checkState 首次 finish='ok' 的时刻
      let lastTick = Date.now() // 任一循环最近一次成功 RPC 的时刻（看门狗停滞判定）
      // 结果补拉：settle 成功后结果晚到（物化慢）时把 rows 补进结果页
      const fillResult = function (attempt) {
        if (tab.executeId !== rid) return
        callHost('olap.result', { requestId: rid, pageNo: 1, pageSize: 200 }).then(function (rr) {
          if (tab.executeId !== rid) return
          const rd = rr && rr.ok ? rr.data : null
          if (rd && rd.isReady === 'ok') {
            if (tab.result !== rd) { tab.result = rd; bump() }
            return
          }
          if (attempt < 120) timer.timeout(function () { fillResult(attempt + 1) }, 1000)
        }).catch(function () {
          if (attempt < 120) timer.timeout(function () { fillResult(attempt + 1) }, 1000)
        })
      }
      // 统一收尾：无论哪条路径判定失败/成功都走这里，保证 running 一定复位。
      const settle = function (asError, msg) {
        if (gotResult) return
        gotResult = true
        if (!alive()) return
        if (asError) {
          gotError = true
          tab.finish = 'error'
          tab.errMsg = msg || tab.errMsg || '执行失败'
          const sErrOne = String(tab.errMsg).replace(/\n+/g, ' ').trim()
          if (tab.log.indexOf('IMPALAERROR') === -1 && tab.log.indexOf(sErrOne) === -1) {
            tab.log = (tab.log || '') + (tab.log ? '\n' : '') + 'IMPALAERROR: [' + sErrOne + ']'
          }
          tab.bottomTab = 'log'
        } else {
          tab.finish = 'ok'
          tab.errMsg = ''
          tab.result = tab.result || { isReady: 'ok', list: [], columnNameList: [] }
          tab.bottomTab = 'result'
          if (!gotRealResult || !tab.result.isReady || tab.result.isReady !== 'ok') fillResult(0)
        }
        tab.running = false
        bump()
      }
      // 看门狗（停滞检测）：循环健康时不断续命；只有所有循环持续停滞（RPC 全挂）才
      // 做最终 checkState 并按结果收尾，杜绝按钮永久停在「停止」，也不误杀长查询。
      const watchdog = function () {
        if (!alive()) return
        if (Date.now() - lastTick <= 20000) { timer.timeout(watchdog, 30000); return }
        callHost('olap.state', { requestId: rid }).then(function (sr) {
          if (!alive()) return
          const sd = sr && sr.ok ? sr.data : null
          if (sd && sd.finish === 'ok') { settle(false); return }
          if (sd && sd.finish === 'error') { settle(true, String(sd.errMsg || '')); return }
          if (sd) { lastTick = Date.now(); timer.timeout(watchdog, 30000); return } // 还在执行 → 续命
          settle(true, '状态轮询中断，请重试')
        }).catch(function () {
          settle(true, '状态轮询中断，请重试')
        })
      }
      timer.timeout(watchdog, 45000)

      // 循环 1：getLogResult —— 累积日志；error 字段非空（非 '0'）即失败收尾
      const logLoop = function () {
        if (gotResult || !alive()) return
        callHost('olap.log', { requestId: rid }).then(function (lg) {
          if (gotResult || !alive()) return
          lastTick = Date.now()
          if (lg && lg.ok && lg.data) {
            const d = lg.data
            const txt = (d.data === undefined || d.data === null) ? '' : String(d.data)
            const errTxt = (d.error === undefined || d.error === null) ? '' : String(d.error)
            if (txt !== '' && txt !== '0') {
              if (tab.log && txt.indexOf(tab.log) === 0) tab.log = txt
              else if (tab.log && tab.log.indexOf(txt) !== -1) { /* 已包含，不重复追加 */ }
              else if (tab.log) tab.log = tab.log + '\n' + txt
              else tab.log = txt
            } else if (errTxt !== '' && errTxt !== '0') {
              // 后端把错误放 error 字段 → 追加一次并判定失败收尾（错误日志=执行已失败）
              if (!(tab.log || '').split('\n').some(function (l) { return l.indexOf(errTxt) !== -1 })) {
                tab.log = (tab.log || '') + (tab.log ? '\n' : '') + errTxt
              }
              settle(true, errTxt)
              return
            }
          }
          bump()
          timer.timeout(logLoop, 500)
        }).catch(function () {
          // RPC 异常：续排一次（不能静默死亡；收尾由 stateLoop/看门狗兜底）
          if (!gotResult && alive()) timer.timeout(logLoop, 500)
        })
      }

      // 循环 2：getSqlResult —— 拉到 isReady='ok' 或行数据即存入（成功/失败收尾归 stateLoop）
      const resLoop = function () {
        if (gotResult || !alive()) return
        callHost('olap.result', { requestId: rid, pageNo: 1, pageSize: 200 }).then(function (rr) {
          if (gotResult || !alive()) return
          lastTick = Date.now()
          const rd = rr && rr.ok ? rr.data : null
          if (rd && (rd.isReady === 'ok' || (rd.list && rd.list.length))) {
            gotRealResult = true
            tab.result = rd
            bump()
          }
          if (!gotResult && alive()) timer.timeout(resLoop, 500)
        }).catch(function () {
          if (!gotResult && alive()) timer.timeout(resLoop, 500)
        })
      }

      // 循环 3：checkState —— 完成/错误的权威信号；成功收尾带 ≤10s 结果物化宽限
      const stateLoop = function () {
        if (gotResult || !alive()) return
        callHost('olap.state', { requestId: rid }).then(function (sr) {
          if (gotResult || !alive()) return
          lastTick = Date.now()
          const sd = sr && sr.ok ? sr.data : null
          if (sd) {
            const sErr = String(sd.errMsg || '')
            const sFinish = sd.finish
            // 英文错误特征（任意 finish，含 finish=ok 但 errMsg 异常的反常返回）→ 失败
            if (/Error|Exception|Analysis|failed|Failed|Could not|SQLException|Invalid|unknown/i.test(sErr)) {
              settle(true, sErr)
              return
            }
            if (sFinish === 'error') {
              settle(true, sErr || '执行失败')
              return
            }
            if (sFinish === 'ok') {
              // 后端完成信号：0 行也是成功。结果已就绪立即收尾；仍在物化则最多等 10s，
              // 到点按成功收尾（结果由 fillResult 补拉，晚到也会补进结果页）。
              if (!sawOkAt) sawOkAt = Date.now()
              const rd = tab.result
              if (gotRealResult && rd && rd.isReady === 'ok') { settle(false); return }
              if (Date.now() - sawOkAt > 10000) { settle(false); return }
            }
          }
          timer.timeout(stateLoop, 500)
        }).catch(function () {
          if (!gotResult && alive()) timer.timeout(stateLoop, 500)
        })
      }

      logLoop()
      resLoop()
      stateLoop()
    }

    function killRun(st, sid, bump) {
      const tab = activeTab(st)
      if (tab && tab.executeId) {
        const rid = tab.executeId
        tab.running = false; tab.finish = 'cancel'; tab.log = (tab.log || '') + '\n已请求终止'
        tab.bottomTab = 'log'
        showToast(st, '正在终止任务…')
        bump()
        callHost('olap.kill', { requestId: rid, engine: tab.engine, dsId: tab.dsId }).then(function (r) {
          showToast(st, (r && r.ok) ? '任务已终止' : ('终止失败: ' + (r && r.error || '未知')))
        }).catch(function () { showToast(st, '终止请求发送失败') })
      }
    }

    function downloadSimple(st, sid, bump) {
      const tab = activeTab(st)
      if (!tab.executeId) {
        showToast(st, '请先执行 SQL 再发起全量下载')
        return
      }
      if (!(st.accounts || []).length) { showToast(st, '请先配置账号'); return }
      showToast(st, '正在创建下载工单…')
      callHost('olap.download.create', { kind: 'skip', requestId: tab.executeId, engine: tab.engine }).then(function (r) {
        if (r && r.ok) {
          tab.log = (tab.log || '') + '\n[下载] 已创建下载工单'
          st.downloadLoaded = false
          bump()
          loadDownloads(st, sid, bump)
          showToast(st, '下载工单已创建，可在下载中心查看')
        } else {
          tab.log = (tab.log || '') + '\n[下载] ' + ((r && r.error) || '创建失败')
          bump()
          showToast(st, '创建下载工单失败: ' + ((r && r.error) || '未知错误'))
        }
      }).catch(function () {
        showToast(st, '创建下载工单失败（网络错误）')
      })
    }

    // ===== WORKSTATION: SQL 格式化（永辉风格：关键字小写、逗号前置、字段按原分组、别名/聚合字段单独一行）=====
    // 跳过字符串字面量/行注释/块注释，把 sql 里位置 → 是否「代码区」映射（字符串内关键字不误判）
    function sqlMask(sql) {
      const mask = new Array(sql.length).fill(0) // 0=代码 1=字符串 2=注释
      let i = 0, n = sql.length
      while (i < n) {
        const c = sql[i]
        if (c === "'") {
          mask[i] = 1; i++
          while (i < n && sql[i] !== "'") { mask[i] = 1; i++ }
          if (i < n) { mask[i] = 1; i++ }
        } else if (c === '-' && sql[i + 1] === '-') {
          while (i < n && sql[i] !== '\n') { mask[i] = 2; i++ }
        } else if (c === '/' && sql[i + 1] === '*') {
          mask[i] = 2; mask[i + 1] = 2; i += 2
          while (i + 1 < n && !(sql[i] === '*' && sql[i + 1] === '/')) { mask[i] = 2; i++ }
          if (i + 1 < n) { mask[i] = 2; mask[i + 1] = 2; i += 2 }
        } else { i++ }
      }
      return mask
    }
    // 括号感知：在代码区按 sep(默认逗号) 分割，返回 [{start,end,text}]（text 为原文，不含外围空白）
    function splitCodeTop(sql, mask, sep) {
      const out = []
      let depth = 0, cur = -1, i = 0
      while (i < sql.length) {
        const c = sql[i]
        if (mask[i] === 0) {
          if (c === '(') depth++
          else if (c === ')') { if (depth > 0) depth-- }
          else if (depth === 0 && c === sep) {
            if (cur !== -1) out.push({ start: cur, end: i })
            cur = -1
          } else if (cur === -1 && c !== ' ' && c !== '\t' && c !== '\n' && c !== '\r') cur = i
        }
        i++
      }
      if (cur !== -1) out.push({ start: cur, end: sql.length })
      return out
    }
    // 找子句关键字出现位置（代码区，词边界，跳过括号内不算顶层——顶层扫描用）
    function findTopKeywords(sql, mask) {
      // 返回按位置排序的 {kw, idx, end}
      const list = []
      const kws = ['select', 'from', 'where', 'group by', 'order by', 'having', 'limit', 'union all', 'union', 'inner join', 'left join', 'right join', 'full join', 'cross join', 'join', 'on', 'and', 'or', 'offset']
      // 词边界扫描
      let depth = 0
      for (let i = 0; i < sql.length; i++) {
        if (mask[i] !== 0) continue
        const c = sql[i]
        if (c === '(') depth++
        else if (c === ')') { if (depth > 0) depth--; continue }
        if (depth === 0 && /[A-Za-z]/.test(c)) {
          // 匹配关键字
          for (let k = 0; k < kws.length; k++) {
            const w = kws[k]
            const m = sql.slice(i, i + w.length).toLowerCase()
            if (m === w && !/[A-Za-z0-9_]/.test(sql[i - 1] || '') && !/[A-Za-z0-9_]/.test(sql[i + w.length] || '')) {
              list.push({ kw: w, idx: i, end: i + w.length })
              i = i + w.length - 1
              break
            }
          }
        }
      }
      return list
    }
    // 判断字段项是否有别名：末尾 "as x" 或 " x"（x 非保留字、非 ) 结尾的表达式边界情况）
    function fieldAliasInfo(fieldText) {
      const t = String(fieldText || '').trim()
      const m = /\s+as\s+([A-Za-z_][A-Za-z0-9_]*)\s*$/i.exec(t)
      if (m) return { has: true, alias: m[1], isFunc: /\)\s*$/i.test(t.slice(0, t.length - m[0].length).trim()) || /[a-z_][a-z0-9_]*\s*$/i.test(t.slice(0, t.length - m[0].length).trim()) }
      // 无 as 的别名：x 结尾且前面不是操作符/函数（简判：末尾单词前有空白）
      const m2 = /\s+([A-Za-z_][A-Za-z0-9_]*)\s*$/i.exec(t)
      if (m2) {
        const pre = t.slice(0, t.length - m2[0].length).trim()
        const lastCh = pre.charAt(pre.length - 1)
        if (lastCh !== ',' && lastCh !== '(' && !/[+\-*/=<>]/.test(lastCh) && !/\b(from|where|join|on|group|order|having|and|or|case|when|then|else|end|in|between|like|is|not|as|union|limit)\s*$/i.test(pre)) {
          return { has: true, alias: m2[1], bare: true }
        }
      }
      return { has: false }
    }
    // 小写 SQL 保留字（仅代码区、词边界）
    function lowerKeywordsIn(sql, mask) {
      const out = sql.split('')
      const kws = ['union all', 'select', 'from', 'where', 'group by', 'order by', 'having', 'limit', 'inner join', 'left join', 'right join', 'full join', 'cross join', 'join', 'on', 'and', 'or', 'not', 'in', 'is', 'null', 'like', 'between', 'case', 'when', 'then', 'else', 'end', 'as', 'by', 'asc', 'desc', 'distinct', 'offset', 'over', 'partition by', 'rows', 'range', 'unbounded', 'preceding', 'following', 'current', 'if', 'then', 'exists', 'cast']
      for (let i = 0; i < sql.length; i++) {
        if (mask[i] !== 0) continue
        for (let k = 0; k < kws.length; k++) {
          const w = kws[k]
          const lw = w.toLowerCase()
          if (sql.slice(i, i + w.length).toLowerCase() === lw && !/[A-Za-z0-9_]/.test(sql[i - 1] || '') && !/[A-Za-z0-9_]/.test(sql[i + w.length] || '')) {
            for (let j = 0; j < w.length; j++) out[i + j] = lw[j]
            i += w.length - 1
            break
          }
        }
      }
      return out.join('')
    }

    // 格式化 SQL：处理 select 字段列表（分组/别名）、from/join/where 布局
    function indentBlock(t) { return String(t || '').split('\n').map(function (l) { return l ? '    ' + l : l }).join('\n') }

    function formatSql(sql) {
      if (!sql || !sql.trim()) return sql
      const mask = sqlMask(sql)
      const lower0 = lowerKeywordsIn(sql, mask)
      // ===== WORKSTATION: 先提取文件头注释/说明行（-- 或 # 开头），再在 body 上检测 with/主查询 =====
      const lines0 = lower0.split('\n')
      const head = []
      let body0 = lower0
      while (lines0.length && /^\s*(--|#)/.test(lines0[0])) { head.push(lines0.shift()); body0 = lines0.join('\n') }
      const headPre = head.length ? head.join('\n') + '\n' : ''
      // ===== WORKSTATION: with CTE 前缀解析（括号配对提取 CTE，保留 with 结构、递归格式化内部）=====
      const bw = body0
      if (/^\s*with\b/i.test(bw)) {
        const collectCte = function (fromK) {
          let d = 0, j = fromK, str = false
          let asIdx = -1
          for (let q = j; q < bw.length; q++) {
            const c = bw[q]
            if (c === "'") { str = !str; continue }
            if (str) continue
            if (d === 0 && /\bas\b/i.test(bw.slice(q, q + 2)) && !/[A-Za-z0-9_]/.test(bw[q - 1] || '') && !/[A-Za-z0-9_]/.test(bw[q + 2] || '')) { asIdx = q; break }
            if (c === '(') d++
            else if (c === ')') { if (d > 0) d-- }
          }
          if (asIdx === -1) return null
          let pd = 0, p1 = -1, p2 = -1, ps = false
          for (let q = asIdx + 2; q < bw.length; q++) {
            const c = bw[q]
            if (c === "'") { ps = !ps; continue }
            if (ps) continue
            if (c === '(') { pd++; if (p1 === -1) p1 = q }
            else if (c === ')') { pd--; if (pd === 0) { p2 = q; break } }
          }
          if (p1 === -1 || p2 === -1) return null
          const nameSeg = bw.slice(fromK, asIdx).trim()
          const inner = bw.slice(p1 + 1, p2)
          return { nameSeg: nameSeg, inner: inner, tailStart: p2 + 1 }
        }
        const ctes = []
        let pos = bw.search(/\bwith\b/i) + 4
        let tailPart = null
        while (true) {
          while (pos < bw.length && /[\s,]/.test(bw[pos])) pos++
          const r = collectCte(pos)
          if (!r) { tailPart = bw.slice(pos); break }
          ctes.push({ nameSeg: r.nameSeg, inner: r.inner })
          let tp = r.tailStart
          while (tp < bw.length && /\s/.test(bw[tp])) tp++
          if (bw[tp] === ',') { pos = tp + 1; continue }
          tailPart = bw.slice(tp)
          break
        }
        if (ctes.length) {
          const blocks = ctes.map(function (c, i2) {
            return (i2 === 0 ? '' : ',\n') + c.nameSeg + ' as (\n' + indentBlock(formatSql(c.inner.trim())) + '\n)'
          })
          return (headPre + 'with\n' + blocks.join('') + '\n' + formatSql(tailPart ? tailPart.trim() : '')).trim()
        }
      }
      // 无 with：body 继续（head 已提出）
      const lower = body0
      let body = lower
      // 扫描 (select 开头的括号对，递归格式化括号内容（保持嵌套顺序：先替换内层由外层循环处理）
      const outChars = []
      let i = 0
      while (i < body.length) {
        if (body[i] === '(') {
          const rest = body.slice(i + 1)
          if (/^\s*select/i.test(rest)) {
            // 找配对 )
            let depth = 1, j = i + 1, inStr = false
            for (; j < body.length; j++) {
              const c = body[j]
              if (c === "'") { inStr = !inStr; continue }
              if (inStr) continue
              if (c === '(') depth++
              else if (c === ')') { depth--; if (depth === 0) break }
            }
            if (j < body.length) {
              const inner = body.slice(i + 1, j)
              outChars.push('(' + formatSql(inner) + ')')
              i = j + 1
              continue
            }
          }
        }
        outChars.push(body[i])
        i++
      }
      body = outChars.join('')
      const out = formatMain(body.trim())
      const tail = (head.length ? head.join('\n') + '\n' : '') + out
      return tail
    }

    // 主查询格式化（单条：select...from... 或 union 多条）
    function formatMain(sql) {
      // ===== WORKSTATION: 非 select 开头语句（insert/create/show/describe/use/set/drop/alter/grant 等）
      // 不重排字段（避免吃掉 create table ... as 之类前缀），只小写关键字 + 压缩多余空白 =====
      if (!/^\s*select\b/i.test(sql)) {
        return sql.trim().replace(/[ \t]{2,}/g, ' ').replace(/ *([,;]) */g, '$1 ').replace(/ *\n */g, '\n')
      }
      // 处理 union 拆分
      const m0 = sql.match(/\bunion all\b|\bunion\b/i)
      if (m0 && !/union\s+select/i.test(sql.slice(0, m0.index))) {
        // union 分割
        const parts = sql.split(/\bunion all\b|\bunion\b/i).map(function (x) { return x.trim() })
        return parts.map(function (p, i) { return (i === 0 ? '' : '\nunion all\n') + formatMain(p) }).join('')
      }
      const mask = sqlMask(sql)
      const kws = findTopKeywords(sql, mask)
      // 定位 select 与 from
      const idxSel = kws.find(function (k) { return k.kw === 'select' })
      if (!idxSel) {
        // 非 select 语句（create/insert/show 等）→ 仅小写关键字 + 简单整理
        return sql.replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').trim()
      }
      const idxFrom = kws.find(function (k) { return k.kw === 'from' && k.idx > idxSel.idx })
      const selEnd = idxFrom ? idxFrom.idx : (function () {
        // 无 from：到语句结束（可能含 where? 无 from 无 where）→ select 到末尾
        return sql.length
      })()
      // select 区 = select 关键字后到 from/结束
      const selRegion = sql.slice(idxSel.end, selEnd)
      // 记录 select 区在原输入中的行分布（分组依据）
      const selLines = selRegion.split('\n').map(function (l) { return l.trim() })
      // 判断「原分组」：select 字段区是否多行
      const multi = selLines.filter(function (l) { return l.length }).length > 1
      // 字段项：括号感知按逗号分割 select 区（把 select 后首个字段起点也算上）
      const fieldRaw = splitCodeTop(selRegion, mask.slice(idxSel.end, selEnd).map(function (x, j) { return x }), ',')
      // splitCodeTop 拿绝对索引：重建
      // —— 上面 mask slice 后索引偏移，改为传绝对 mask
      const fields = splitCodeTopAbs(sql, mask, idxSel.end, selEnd, ',')
      if (!fields.length) return sql // 解析失败原样返回
      // 每字段所在原行号（分组依据）：计算 selRegion 起点行号
      const baseLine = sql.slice(0, idxSel.end).split('\n').length - 1
      const grouped = [] // [{start,end,text,line}]
      fields.forEach(function (f) {
        const line = sql.slice(0, f.start).split('\n').length - 1
        grouped.push({ start: f.start, end: f.end, text: f.text, line: line })
      })
      // 输出 select 字段块
      const IND = '    '
      // 组装 select 行
      const fieldLinesOut = []
      // 按原分组（连续同行且同组）：multi && 非别名强制 → 组内保持同行
      let i = 0
      while (i < grouped.length) {
        const f = grouped[i]
        const al = fieldAliasInfo(f.text)
        // 别名/聚合? —— 别名强制单独一行；聚合(sum等)不强分（组内可能含 sum? 用户例子里 sum 单独一行——按原分组保留）
        const forceSingle = al.has
        // 分组：收集从 i 起 原行号相同 且 非 forceSingle 的连续字段
        if (multi && !forceSingle) {
          let j = i + 1
          while (j < grouped.length && grouped[j].line === f.line && !fieldAliasInfo(grouped[j].text).has) j++
          const group = grouped.slice(i, j)
          const oneLine = group.map(function (g) { return g.text.trim() }).join(', ')
          fieldLinesOut.push({ text: oneLine, first: group[0] })
          i = j
        } else {
          fieldLinesOut.push({ text: f.text.trim(), first: f })
          i++
        }
      }
      // 若原本单行(无分组) → 每个字段一行（上面的分支 multi=false 已每字段 push）
      // 生成字段行字符串（每行 4 空格缩进，逗号前置到后续行行首）
      let fieldBlock = ''
      for (let k = 0; k < fieldLinesOut.length; k++) {
        const fl = fieldLinesOut[k]
        fieldBlock += IND + (k === 0 ? '' : ',') + fl.text + '\n'
      }
      // 拼 select 头部
      let res = 'select\n' + fieldBlock.trimEnd()
      // from 及之后
      if (idxFrom) {
        // ===== WORKSTATION: from 后布局 —— join/where/group by/order by/having/limit 前换行（若同行），
        // join 与 from 同级顶格；on 条件短时与 join 同行、长时换行缩进一级 =====
        const rest = sql.slice(idxFrom.idx)
        const restMask = sqlMask(rest)
        const clauseKws = ['inner join', 'left join', 'right join', 'full join', 'cross join', 'join', 'where', 'group by', 'order by', 'having', 'limit', 'union all', 'union']
        // 找 rest 里顶层子句位置
        const marks = []
        const reKw = new RegExp('\\\\b(' + clauseKws.join('|') + ')\\\\b', 'gi')
        let mm
        const re = /(\binner join\b|\bleft join\b|\bright join\b|\bfull join\b|\bcross join\b|\bjoin\b|\bwhere\b|\bgroup by\b|\border by\b|\bhaving\b|\blimit\b|\bunion all\b|\bunion\b)/gi
        while ((mm = re.exec(rest)) !== null) {
          if (restMask[mm.index] === 0) marks.push({ idx: mm.index, end: mm.index + mm[0].length, kw: mm[1].toLowerCase() })
        }
        // ===== WORKSTATION: 只保留括号外（顶层）子句 —— 子查询内的 where/group by 等不拆行 =====
        {
          const marks2 = []
          let d = 0
          for (let ri = 0; ri <= rest.length; ri++) {
            if (ri < rest.length) {
              const c = rest[ri]
              if (restMask[ri] === 0) {
                if (c === '(') d++
                else if (c === ')') { if (d > 0) d-- }
              }
            }
            while (marks.length && marks[0].idx <= ri) {
              if (d === 0) marks2.push(marks[0])
              marks.shift()
            }
          }
          while (marks.length) { marks2.push(marks.shift()) }
          marks.length = 0
          Array.prototype.push.apply(marks, marks2)
        }
        // 组装 from 块：from 行 + 各子句
        const lines = []
        let cursor = 0
        for (let mi = 0; mi < marks.length; mi++) {
          const mk = marks[mi]
          if (mk.idx > cursor) {
            const chunk = rest.slice(cursor, mk.idx).trim()
            if (chunk) lines.push(chunk)
          }
          // 找到子句内容结束（下一个 mark 或末尾）；内容从关键字后开始
          const nextIdx = mi + 1 < marks.length ? marks[mi + 1].idx : rest.length
          const content = rest.slice(mk.end, nextIdx).trim().replace(/[ \t]{2,}/g, ' ')
          // ===== WORKSTATION: where 内 and/or 拆行；group by 字段逗号拆行（与 select 风格一致）=====
          if (mk.kw === 'where') {
            const conds = splitTopAndOr(content)
            if (conds.length > 1) {
              lines.push('where')
              conds.forEach(function (cd, ci) { lines.push(IND + (ci === 0 ? '' : cd[0] + ' ') + cd[1].trim()) })
            } else {
              lines.push('where ' + content)
            }
          } else if (mk.kw === 'group by' || mk.kw === 'order by') {
            const items = content.split(',').map(function (x) { return x.trim() }).filter(Boolean)
            if (items.length > 1 && mk.kw === 'group by') {
              lines.push(mk.kw)
              items.forEach(function (it, ii) { lines.push(IND + (ii === 0 ? '' : ',') + it) })
            } else {
              lines.push(mk.kw + (content ? ' ' + content : ''))
            }
          } else {
            lines.push(mk.kw + (content ? ' ' + content : ''))
          }
          cursor = nextIdx
        }
        if (cursor < rest.length) {
          const tailC = rest.slice(cursor).trim()
          if (tailC) lines.push(tailC)
        }
        res += '\n' + lines.join('\n')
      }
      // 无 from：select 字段区即全文（已在 res 重组），不再附加
      return res.replace(/[ \t]+\n/g, '\n')
    }
    // 绝对索引的括号感知分割（区间 [a,b) 内按逗号）
    function splitCodeTopAbs(sql, mask, a, b, sep) {
      const out = []
      let depth = 0, cur = -1
      for (let i = a; i < b; i++) {
        const c = sql[i]
        const code = mask[i] === 0
        // 字符串/注释内容视为普通字段字符（不切分），仅代码区处理括号与分隔符
        if (code) {
          if (c === '(') depth++
          else if (c === ')') { if (depth > 0) depth-- }
          else if (depth === 0 && c === sep) {
            if (cur !== -1) out.push({ start: cur, end: i, text: sql.slice(cur, i) })
            cur = -1
          }
        }
        if (cur === -1 && c !== ' ' && c !== '\t' && c !== '\n' && c !== '\r' && !(code && (c === sep || c === '(' || c === ')'))) cur = i
      }
      if (cur !== -1) out.push({ start: cur, end: b, text: sql.slice(cur, b) })
      return out
    }
    // 括号感知按顶层 and/or 拆分（where 条件）：返回 [[op, text], ...]，首段 op=''，其余 op='and'/'or'
    function splitTopAndOr(content) {
      const mask = sqlMask(content)
      const spots = []
      const re2 = /\b(and|or)\b/gi
      let m4
      while ((m4 = re2.exec(content)) !== null) {
        if (mask[m4.index] !== 0) continue
        let d2 = 0
        for (let q = 0; q < m4.index; q++) {
          const cq = content[q]
          if (mask[q] !== 0) continue
          if (cq === '(') d2++
          else if (cq === ')') { if (d2 > 0) d2-- }
        }
        if (d2 === 0 && !/[A-Za-z0-9_]/.test(content[m4.index - 1] || '')) {
          // ===== WORKSTATION: between x and y 的 and 不拆（往前找最近 between/and/or 判断归属）=====
          if (m4[1].toLowerCase() === 'and') {
            let skip = false
            const backRe = /\b(between|and|or)\b/gi
            let bm, lastKw = null, lastIdx = -1
            while ((bm = backRe.exec(content.slice(0, m4.index))) !== null) { lastKw = bm[1].toLowerCase(); lastIdx = bm.index }
            if (lastKw === 'between') skip = true
            if (!skip) spots.push({ idx: m4.index, op: 'and' })
          } else {
            spots.push({ idx: m4.index, op: m4[1].toLowerCase() })
          }
        }
      }
      const res = []
      let prev = 0, prevOp = ''
      spots.forEach(function (sp) {
        const segTxt = content.slice(prev, sp.idx).trim()
        if (segTxt) res.push([prevOp, segTxt])
        prev = sp.idx + sp.op.length
        prevOp = sp.op
      })
      const lastTxt = content.slice(prev).trim()
      if (lastTxt) res.push([prevOp, lastTxt])
      return res
    }

    function FunctionBar(props) {
      const { st, sid, bump } = props
      const tab = activeTab(st)
      const engName = { '1': 'hive', '2': 'impala', '3': 'ck', '4': 'doris' }
      const dsOptions = st.datasources.map(function (d) {
        return h('option', { value: String(d.id), key: d.id }, d.name + ' (' + (engName[d.engine] || d.engine) + ')')
      })
      return h('div', { className: 'yh-olap-func' },
        h('select', {
          value: String(tab.dsId),
          onChange: function (e) {
            const ds = st.datasources.find(function (d) { return String(d.id) === e.target.value })
            tab.dsId = Number(e.target.value)
            tab.engine = ds ? ds.engine : tab.engine
            bump()
            loadSchemas(st, sid, bump)
          },
        }, dsOptions),
        h('button', { className: tab.running ? 'stop' : 'run', onClick: function () { tab.running ? killRun(st, sid, bump) : doRun(st, sid, bump) } }, tab.running ? '■ 停止' : '▶ 执行'),
        h('button', { onClick: function () { st.paramModalFor = true; bump() }, title: '设置 ${} 参数' }, '参数'),
        h('button', { onClick: function () { st.noteText = (activeTab(st).note || ''); st.noteModalFor = true; bump() }, title: '当前 SQL 的便签（本地保存）' }, '便签'),
        h('button', { onClick: function () { downloadSimple(st, sid, bump) } }, '全量下载'),
        // ===== WORKSTATION: 保存 —— 来自收藏的标签直接更新该收藏；否则弹目录/名称对话框 =====
        h('button', { onClick: function () {
          const stab = activeTab(st)
          if (!stab) return
          const sql = stab.sql || ''
          if (!sql.trim()) { showToast(st, '当前无 SQL 可保存'); return }
          const paramsArr = Object.keys(stab.params || {}).map(function (k) { return { key: k, value: stab.params[k] } })
          if (stab.collectId) {
            // 收藏标签 → 更新收藏内容（querySql 与 createNode 同字段名，updateNode 按 id 更新）
            callHost('olap.collect.update', { patch: { id: stab.collectId, querySql: sql } }).then(function (r) {
              if (r && r.ok) { showToast(st, '已更新收藏「' + (stab.name || '') + '」'); collectRefresh(st, sid, bump) }
              else showToast(st, '更新失败: ' + ((r && r.error) || '未知'))
            })
          } else {
            // 普通标签 → 弹保存对话框（默认名称 = 标签名）
            st.collectSaveName = stab.name || ''
            st.collectSaveFor = true
            bump()
          }
        }, title: '保存到收藏：收藏标签更新原收藏，普通标签存入新收藏' }, '保存'),
        h('button', { onClick: function () {
          const ftab = activeTab(st)
          if (!ftab || !ftab.sql) return
          const after = formatSql(ftab.sql)
          if (after !== ftab.sql) {
            // ===== WORKSTATION: execCommand('insertText') 全选替换 → 进浏览器 undo 栈，可 Ctrl+Z 撤销 =====
            let applied = false
            try {
              const ta = document.querySelector('.yh-olap-input')
              if (ta && ta.value === ftab.sql) {
                ta.focus()
                ta.setSelectionRange(0, ta.value.length)
                wsNonKeyInput = true
                applied = document.execCommand('insertText', false, after)
              }
            } catch (e) { applied = false }
            if (!applied) {
              wsNonKeyInput = true
              ftab.sql = after
              bump()
            }
            wsScheduleSave(sid, 200)
            showToast(st, '已格式化')
          } else { showToast(st, 'SQL 无需调整或暂不支持解析') }
        }, title: '按永辉 SQL 风格格式化（关键字小写/逗号前置/字段分组）' }, '格式化'),
        // ===== WORKSTATION: 查找替换入口（也可 Cmd/Ctrl+F / Cmd/Ctrl+Alt+F）=====
        h('button', { onClick: function () {
          if (!st.findBox) st.findBox = { open: false, showRep: false, q: '', rep: '', caseS: false, word: false, re: false, pos: 0, focusTick: 0 }
          st.findBox.open = true
          st.findBox.focusTick = (st.findBox.focusTick || 0) + 1
          bump()
        }, title: '查找替换（Cmd/Ctrl+F 查找，Cmd/Ctrl+Alt+F 替换）' }, '查找'))
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

    const STATE_NAME = { 1: '执行中', 2: '执行成功', 3: '数据生成失败', 4: 'kerberos失败', 5: 'hive错误', 6: 'consul失败', 7: '自动取消', 8: '执行取消' }
    // 时间压缩：YYYY-MM-DD HH:mm:ss / M/D/YY h:mm AM → MM-DD HH:mm（窄容器省宽）
    function shortT(t) {
      if (!t) return '-'
      const str = String(t).trim()
      const m = str.match(/^(\d{4})-(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{1,2})(?::\d{1,2})?/)
      if (m) return m[2] + '-' + m[3] + ' ' + m[4] + ':' + m[5]
      const m2 = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})\s+(\d{1,2}):(\d{1,2})\s*(AM|PM)?/i)
      if (m2) return m2[1] + '/' + m2[2] + ' ' + m2[4] + ':' + m2[5]
      return str.length > 14 ? str.slice(0, 14) : str
    }
    // 长 id 缩略：uuid 显示前 8 位 + …
    function shortId(id) {
      const str = String(id == null ? '' : id)
      return str.length > 12 ? str.slice(0, 8) + '…' : str
    }
    // 清单行信息 span 的公共样式（窄容器下可收缩省略）
    const INFO_SPAN = { color: 'var(--dsw-alias-label-secondary)', fontSize: 11, flexShrink: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }

    function ResultView(props) {
      const { st } = props
      const tab = activeTab(st)
      const r = tab.result
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
      return h('div', { className: 'yh-olap-reswrap' },
        h('div', { className: 'yh-olap-hint' }, '共 ' + total + ' 行（预览前 ' + rows.length + ' 行）'),
        h('table', { className: 'yh-olap-table' },
          h('thead', null, h('tr', null, cols.map(function (c) { return h('th', { key: c.key }, c.name) }))),
          h('tbody', null, rows.map(function (row, ri) {
            return h('tr', { key: ri }, cols.map(function (c) {
              const v = cellOf(row, c)
              return h('td', { key: c.key }, v === null || v === undefined ? '' : String(v))
            }))
          }))))
    }

    function HistoryDlBtn(props) {
      const { st, bump, row } = props
      const [open, setOpen] = react.useState(false)
      const [eng, setEng] = react.useState(row.engine === 1 ? 1 : 2)
      const ref = react.useRef(null)
      const submit = function () {
        callHost('olap.history.order', { requestId: row.requestId, engine: eng }).then(function (r) {
          if (r && r.ok && (r.data || r.id)) showToast(st, '全量下载工单已提交，请到「下载」页下载')
          else showToast(st, '工单提交失败: ' + ((r && r.error) || (r && r.message) || '未知'))
        })
      }
      // 打开时点击外部关闭
      react.useEffect(function () {
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
                h('span', { style: Object.assign({}, INFO_SPAN, { color: ok ? '#4ec9b0' : '#d16969', flexShrink: 0 }) }, STATE_NAME[row.state] || ('state ' + row.state)),
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
                h('span', { style: Object.assign({}, INFO_SPAN, { color: can ? '#4ec9b0' : (failed ? 'var(--yh-ui-danger)' : '#d7a04a'), fontWeight: 600, flexShrink: 0 }) }, row.taskStateName || ('taskState ' + row.taskState)),
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
          h('div', { className: 'yh-olap-dlmeta' },
            row('状态', d.taskStateName || d.stateName),
            row('引擎', engName),
            row('提交人', d.committerName || d.committer),
            row('审批人', d.confirmorName || d.confirmor),
            row('申请时间', d.createTime || d.startTime),
            row('完成时间', d.finishTime)),
          h('div', { className: 'yh-olap-dlmeta' },
            row('审批说明', d.confirmNote),
            row('execId', d.execId),
            row('requestId', d.requestId),
            row('downLoadRequestId', d.downLoadRequestId)),
          h('div', { className: 'yh-olap-dlsql' }, d.querySql || '(无 SQL)'),
          d.errorMsg ? h('div', { className: 'yh-olap-dlerr' }, d.errorMsg) : null,
          h('div', { className: 'row', style: { marginTop: 10 } },
            h('button', { className: 'pri', onClick: close }, '关闭'))))
    }

    // ===== WORKSTATION: 日志渲染 —— 错误行/错误信息标红 =====
    const LOG_ERR_RE = /Error|Exception|Analysis|failed|Failed|失败|error|Exception|Could not|SQLException|Invalid|unknown/i
    function renderLog(tab) {
      // 后端日志以 <br/> 分隔 → 先转 \n（与 fmtLog 行为一致），再逐行渲染
      const log = String((tab && tab.log) || '').replace(/<br\s*\/?>/gi, '\n').replace(/&nbsp;/gi, ' ')
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
    function BottomBar(props) {
      const { st, sid, bump } = props
      const tabs = [['log', '日志'], ['result', '结果'], ['history', '历史'], ['download', '下载']]
      // ===== WORKSTATION: 底栏状态 per-tab（每个标签保留自己的 日志/结果/历史/下载 页）=====
      const curTab = activeTab(st)
      const bt = (curTab && curTab.bottomTab) || 'result'
      return h('div', { className: 'yh-olap-bot' },
        h('div', { className: 'yh-olap-tabs', style: { background: 'var(--dsw-alias-bg-layer-1)', padding: '0 8px', justifyContent: 'flex-start' } },
          tabs.map(function (tb) {
            return h('span', { key: tb[0], className: 'yh-olap-btab' + (bt === tb[0] ? ' on' : ''), onClick: function () { const t = activeTab(st); if (t) { t.bottomTab = tb[0]; if (tb[0] === 'history') loadHistory(st, sid, bump); if (tb[0] === 'download') loadDownloads(st, sid, bump); bump() } } }, tb[1])
          })),
        h('div', { className: 'yh-olap-view' },
          bt === 'log' ? h('div', { className: 'yh-olap-log' }, renderLog(curTab)) :
            bt === 'result' ? h(ResultView, { st: st }) :
              bt === 'history' ? h(HistoryView, { st: st, sid: sid, bump: bump }) :
                h(DownloadView, { st: st, sid: sid, bump: bump })))
    }

    function AccountSel(props) {
      const { st, sid, bump } = props
      const [open, setOpen] = react.useState(false)
      const rootRef = react.useRef(null)
      react.useEffect(function () {
        if (!open) return
        const onDown = function (e) {
          const el = rootRef.current
          if (el && !el.contains(e.target)) setOpen(false)
        }
        document.addEventListener('mousedown', onDown)
        return function () { document.removeEventListener('mousedown', onDown) }
      }, [open])
      const cur = (st.accounts || []).find(function (a) { return a.username === st.currentAccount })
      const curName = cur ? ((cur.alias && cur.alias !== cur.username) ? cur.alias : cur.username) : (st.currentAccount || '')
      const choose = function (u) {
        setOpen(false)
        if (u === '__manage__') { st.accManage = true; bump(); return }
        if (u && u !== st.currentAccount) switchAccount(st, sid, bump, u)
      }
      return h('div', { className: 'yh-olap-accwrap', ref: rootRef },
        h('button', { className: 'yh-olap-accbtn' + (open ? ' on' : ''), onClick: function () { setOpen(!open) }, title: '选择账号（切换后自动刷新库表）' }, curName + (open ? ' ▴' : ' ▾')),
        open ? h('div', { className: 'yh-olap-accmenu' },
          (st.accounts || []).map(function (a) {
            return h('div', { key: a.username, className: 'yh-olap-accitem' + (a.username === st.currentAccount ? ' on' : ''), onMouseDown: function (e) { e.preventDefault() }, onClick: function () { choose(a.username) } },
              h('span', { className: 'yh-olap-accname' }, a.username),
              h('span', { className: 'yh-olap-accnick' }, (a.alias && a.alias !== a.username) ? a.alias : ''))
          }),
          h('div', { className: 'yh-olap-accitem mgr', onMouseDown: function (e) { e.preventDefault() }, onClick: function () { choose('__manage__') } }, '⚙ 账号管理'))
          : null)
    }

    function TabMenu(props) {
      const { st, bump, onRename, onRemove } = props
      const m = st.tabMenu
      if (!m) return null
      const tab = st.tabs.find(function (x) { return x.id === m.tabId })
      const px = Math.min(m.x, window.innerWidth - 200)
      const py = Math.min(m.y, window.innerHeight - 130)
      react.useEffect(function () {
        const onDoc = function (e) {
          const el = document.querySelector('.yh-olap-tmenu')
          if (el && !el.contains(e.target)) { st.tabMenu = null; bump() }
        }
        document.addEventListener('mousedown', onDoc)
        return function () { document.removeEventListener('mousedown', onDoc) }
      }, [st.tabMenu])
      const act = function (fn) { st.tabMenu = null; bump(); fn() }
      return h('div', { className: 'yh-olap-tmenu', style: { left: px, top: py }, onMouseDown: function (e) { e.stopPropagation() }, onContextMenu: function (e) { e.preventDefault(); e.stopPropagation() } },
        h('div', { className: 'yh-olap-titem', title: '把标签引用（如 [OLAP 标签 #3 SQL3]）添加到聊天输入框，模型据此用 tabId 指定该标签', onClick: function () { act(function () { if (tab) referTab(tab, st) }) } }, '引用（添加到聊天输入框）'),
        h('div', { className: 'yh-olap-titem', onClick: function () { act(function () { if (tab) onRename(tab) }) } }, '重命名'),
        h('div', { className: 'yh-olap-titem', title: '删除标签并移除本地保存（不可恢复）', onClick: function () { act(function () { if (tab) onRemove(tab) }) } }, '删除标签'))
    }

    function TabsBar(props) {
      const { st, sid, bump } = props
      const addTab = function () {
        const base = activeTab(st)
        const nid = wsNextTabId(st)
        st.tabs.push({ id: nid, name: 'Tab' + nid, sql: '', engine: base.engine, dsId: base.dsId, params: {}, autoSave: true, bottomTab: 'result', running: false, executeId: '', finish: '', log: '', errMsg: '', result: null, wsFile: String(nid) })
        st.activeTab = nid
        wsNoteFile(st, String(nid))
        // 全自动保存：新标签立即落盘（空内容也建文件，刷新后恢复该标签）
        callHost('ws.workspace.save', { sessionId: sid, kind: 'sql', name: String(nid), content: '' })
        callHost('ws.workspace.save', { sessionId: sid, kind: 'params', name: String(nid), content: JSON.stringify({ __name: 'Tab' + nid }) })
        bump()
      }
      const removeTab = function (t) {
        // ===== WORKSTATION: 全自动保存模型 —— 关标签即删除本地文件（不确认）。
        // 收藏标签（collectId）只删本地副本，不影响服务端收藏本体。=====
        const removeFiles = function () {
          if (t.wsFile || /^\d+$/.test(String(t.id))) {
            const base = String(t.wsFile !== undefined && t.wsFile !== null ? t.wsFile : t.id)
            ;['sql', 'params', 'note'].forEach(function (k) {
              callHost('ws.workspace.remove', { sessionId: st.__id || sid, kind: k, name: base })
            })
            if (st.__wsKnownFiles) st.__wsKnownFiles.delete(base)
          }
        }
        if (st.tabs.length <= 1) {
          // 关闭最后一个标签 → 删其文件，新建纯净空白 Tab1（全自动保存）
          removeFiles()
          const keepEngine = t.engine, keepDs = t.dsId
          st.tabs = []
          const nid = 1 // 最后标签关闭后总是从 Tab1 重新开始
          wsNoteFile(st, String(nid))
          st.tabs.push({ id: nid, name: 'Tab1', sql: '', engine: keepEngine || '2', dsId: keepDs || 2, params: {}, note: '', autoSave: true, bottomTab: 'result', running: false, executeId: '', finish: '', log: '', errMsg: '', result: null, wsFile: String(nid) })
          st.activeTab = nid
          bump()
          // 空 Tab1 也立即落盘（保证刷新后有干净起点）
          callHost('ws.workspace.save', { sessionId: st.__id || sid, kind: 'sql', name: '1', content: '' })
          callHost('ws.workspace.save', { sessionId: st.__id || sid, kind: 'params', name: '1', content: JSON.stringify({ __name: 'Tab1' }) })
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
                onKeyDown: function (e) { if (e.key === 'Enter') commitRename(t); else if (e.key === 'Escape') { st.editingTab = null; bump() } },
              })
            }
            return h('span', {
              key: t.id, className: 'yh-olap-tab' + (t.id === st.activeTab ? ' on' : ''),
              onClick: function () { st.activeTab = t.id; bump() },
              onDoubleClick: function () { startRename(t) },
              onContextMenu: function (e) { e.preventDefault(); e.stopPropagation(); st.tabMenu = { tabId: t.id, x: e.clientX, y: e.clientY }; bump() },
              title: '内容自动保存，刷新/重开会话自动恢复；双击重命名，右键更多操作（删除标签会移除本地保存）',
            }, t.name + (t.running ? ' ●' : ''),
              h('span', { className: 'tabx', onClick: function (e) { e.stopPropagation(); removeTab(t) }, title: '删除标签' }, '×'))
          }),
          h('button', { className: 'yh-olap-tab-add', onClick: addTab, title: '新建标签' }, '+')),
        h('div', { className: 'yh-olap-tabs-right' },
          h(AccountSel, { st: st, sid: sid, bump: bump })),
        h(TabMenu, { st: st, bump: bump, onRename: startRename, onRemove: removeTab }))
    }

    // ===== WORKSTATION: 收藏目录树（仅目录，nodeType 2）路径查找，供保存弹窗树状选择 =====
    function collectFindPath(nodes, id, chain) {
      const list = Array.isArray(nodes) ? nodes : []
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
      const [sel, setSel] = react.useState('0')
      const [exp, setExp] = react.useState(null)
      const openedRef = react.useRef(false)
      react.useEffect(function () {
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
        ;(Array.isArray(list) ? list : []).forEach(function (n) {
          if (!n || n.nodeType !== 2) return
          o.push({ id: String(n.id), name: n.name || ('目录' + n.id), depth: depth, kids: (n.subNodeListVO || []).filter(function (k) { return k && k.nodeType === 2 }).length })
          if (expMap[n.id] === true) o = o.concat(walk(n.subNodeListVO, depth + 1))
        })
        return o
      }
      const rows = (function () {
        const rootKids = (st.collectTree || []).filter(function (n) { return n && n.nodeType === 2 }).length
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

    function AccountManageModal(props) {
      const { st, sid, bump } = props
      if (!st.accManage) return null
      const rows = st.accounts || []
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
        if ((st.accounts || []).some(function (x) { return x.username === u })) { showToast(st, '账号已存在'); return }
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

    // ---- 面板状态上报（debounce 300ms，让模型 olap state 看得见）----
    // ===== WORKSTATION: 延迟从 1s 降到 300ms —— 用户输入/操作后若立即让模型
    // state 读面板，1s 延迟内 host lastState 还是旧值 → 模型读到空/旧 SQL 误判
    // （会话 f5bdf152 实测：模型反复 state 读空、被迫 grep/bash 找 SQL，体验不顺畅）。
    // 300ms 既够防抖（输入不频繁上传），又让模型快速 state 能读到最新。=====
    let uploadPending = null
    function uploadThrottle(fn) {
      if (uploadPending) { uploadPending.fn = fn; return }
      uploadPending = { fn: fn, timer: setTimeout(function () { const f = uploadPending.fn; uploadPending = null; f() }, 300) }
    }
    function uploadPanelState(st, sid) {
      const state = {
        activeTab: st.activeTab || 1,
        tabs: (st.tabs || []).map(function (t) {
          return { id: t.id, name: t.name, sql: t.sql, engine: t.engine, dsId: t.dsId, running: !!t.running, finish: t.finish || '', executeId: t.executeId || '', log: t.log || '', errMsg: t.errMsg || '' }
        }),
        currentAccount: st.currentAccount || '',
        dsList: st.dsList || [],
      }
      callHost('olap.panel.state', { sessionId: sid, state: state })
    }
    function schedulePanelUpload(st, sid) {
      uploadThrottle(function () { uploadPanelState(st, sid) })
    }

    // ---- OLAP 模式标签（输入框区域，读 host 'olap' 投影，点击退出）----
    function OlapChip(props) {
      // ===== WORKSTATION: 模式状态改从 host 内存轮询（olap.mode.get），不再依赖
      // sessionProjections —— 投影只能由 session 事件驱动，而 olap/mode 事件已停写
      // （避免污染日志致历史会话加载报错）。保留投影值作首帧，轮询校正。=====
      const up = props.useProjection
      const proj = up ? up('olap') : undefined
      const [active, setActive] = react.useState(!!(proj && proj.active))
      const [busy, setBusy] = react.useState(false)
      const sidFor = props.sessionId || currentSessionId() || ''
      react.useEffect(function () {
        if (!sidFor) return
        let alive = true
        const poll = function () {
          callHost('olap.mode.get', { sessionId: sidFor }).then(function (r) {
            if (alive && r && r.ok) setActive(!!r.active)
          }).catch(function () { /* ignore */ })
        }
        poll()
        const iv = setInterval(poll, 1500)
        return function () { alive = false; clearInterval(iv) }
      }, [sidFor])
      if (!active) return null
      const off = function () {
        if (busy || !ctx.remote || !ctx.remote.commands || !props.sessionId) return
        setBusy(true)
        ctx.remote.commands.execute(props.sessionId, '/olap off', []).then(
          function () { setBusy(false) },
          function () { setBusy(false) })
      }
      return h('span', { className: 'yh-olap-modechip-wrap' },
        h('button', { type: 'button', className: 'yh-olap-modechip', title: 'OLAP 模式已开启；点击退出', disabled: busy, onClick: off },
          'OLAP',
          h('span', { className: 'yh-olap-modechip-x' }, '×')))
    }

    function OlapPanel(props) {
      const propSid = props.sessionId || ''
      // 面板跟随当前会话：DSH 的 rightbar slot（旧 details）是 root 作用域，不传 sessionId，
      // 切换会话时 props 不更新（实测对话区已切新会话、面板仍绑旧 store），用轮询
      // sessions 服务 current 兜底——新会话 = 面板新状态（它的工作区也按 per-session 恢复为空）。
      const [sid, setSid] = react.useState(propSid || currentSessionId() || '')
      react.useEffect(function () {
        const sync = function () {
          const c = currentSessionId()
          setSid(function (prev) { return c && c !== prev ? c : prev })
        }
        sync()
        const iv = setInterval(sync, 800)
        return function () { clearInterval(iv) }
      }, [propSid])
      // ===== WORKSTATION: activePanelSid 是模块级全局（@olap 引用候选/lexicon 读它），
      // 副作用必须在 effect 里同步，不能在渲染体赋值（React 渲染应纯，含副作用的
      // 渲染在并发/StrictMode 下会重复执行造成状态错乱）。同 effect 兼顾首次挂载。=====
      react.useEffect(function () {
        activePanelSid = sid
      }, [sid])
      const st = useStore(sid)
      const bump = function () { st.version++; emitStore(sid); schedulePanelUpload(st, sid) }

      react.useEffect(function () {
        // ===== WORKSTATION: sid 未就绪（整页刷新后 sessions 服务还没加载完，
        // currentSessionId() 返回空）时不启动恢复 —— 否则 wsLoad('') 查全局空目录
        // 白跑一次 + 等 sid 轮询切换才恢复，造成"刷新后几秒标签才出现"（用户实测）。
        // sid 就绪后 effect 因 [sid] 变化自动重跑并正常恢复。=====
        if (!sid) return
        uploadPanelState(getStore(sid), sid)
        // ===== WORKSTATION: 工作站布局 —— OLAP 常驻中列，始终展开 rightbar =====
        wsApplyLayout()
        if (getOlapOpen(sid)) {
          if (layout && typeof layout.openRightbar === 'function') layout.openRightbar(true, false)
        } else {
          setOlapOpen(sid, true)
          if (layout && typeof layout.openRightbar === 'function') layout.openRightbar(true, false)
        }
        // ===== WORKSTATION: 从该会话自己的工作区恢复 tabs（多文件，per-session）=====
        const wm = wsMetaFor(sid)
        if (!wm.loaded) {
          wsLoad(function () { wsApplyToStore(getStore(sid), sid) }, sid)
        } else {
          wsApplyToStore(getStore(sid), sid)
        }
        const sid2 = sid
        callHost('olap.accounts.list').then(function (r) {
          if (r && r.ok) { st.accounts = r.accounts; st.currentAccount = r.current; emitStore(sid2) }
        })
        loadDatasources(st, sid, bump)
        loadCollect(st, sid, bump)
        const stop = timer.interval(function () {
          wsApplyLayout()
          // ===== WORKSTATION: 每次 poll 顺带上传面板状态 —— 保证 host lastState 常新
          // （≤1.5s 滞后）。即使 debounce 上传被高频操作推迟/丢失，模型 olap state 也
          // 能读到最新 SQL；否则用户刚编辑完就让模型改，模型会读到旧/空（f5bdf152 实测）。=====
          uploadPanelState(getStore(sid), sid)
          callHost('olap.panel.poll', { sessionId: sid }).then(function (r) {
            if (!r || !r.ok || !r.commands || !r.commands.length) return
            applyCommands(getStore(sid), sid, r.commands)
          })
        }, 1500)
        return function () { stop() }
      }, [sid])

      const editorRatio = Math.max(0.12, Math.min(0.92, st.editorRatio))

      const startResize = function (downEv) {
        downEv.preventDefault()
        const splitEl = downEv.currentTarget.parentNode
        const move = function (ev) {
          const rect = splitEl.getBoundingClientRect()
          if (rect.height <= 0) return
          const ratio = (ev.clientY - rect.top) / rect.height
          st.editorRatio = Math.max(0.12, Math.min(0.92, ratio))
          emitStore(sid)
        }
        const up = function () {
          window.removeEventListener('mousemove', move)
          window.removeEventListener('mouseup', up)
        }
        window.addEventListener('mousemove', move)
        window.addEventListener('mouseup', up)
      }

      return h('div', { className: 'yh-olap-panel' + (st.fullscreen ? ' full' : '') },
        h(TabsBar, { st: st, sid: sid, bump: bump }),
        h('div', { className: 'yh-olap-body' },
          h(LeftArea, { st: st, sid: sid, bump: bump }),
          h('div', { className: 'yh-olap-main' },
            st.leftCollapsed ? h('button', { className: 'yh-olap-coltoggle expand', onClick: function () { st.leftCollapsed = false; bump() }, title: '展开左栏' }, '▶') : null,
            h(FunctionBar, { st: st, sid: sid, bump: bump }),
            h('div', { className: 'yh-olap-split' },
              h('div', { className: 'yh-olap-editor', style: { flex: editorRatio * 10, minHeight: 60 } }, h(Editor, { st: st, sid: sid, bump: bump })),
              h('div', { className: 'yh-olap-resizer', onMouseDown: startResize }),
              h('div', { className: 'yh-olap-bot', style: { flex: (1 - editorRatio) * 10 } }, h(BottomBar, { st: st, sid: sid, bump: bump }))))),
        h(CollectSaveModal, { st: st, bump: bump }),
        h(ParamModal, { st: st, sid: sid, bump: bump }),
        h(NoteModal, { st: st, sid: sid, bump: bump }),
        h(AccountManageModal, { st: st, sid: sid, bump: bump }),
        h(DownloadDetailModal, { st: st, bump: bump }),
        h(DlgModal, { st: st, bump: bump }),
        h(CollectMenu, { st: st, sid: sid, bump: bump }),
        h(SchemaMenu, { st: st, bump: bump }),
        st.toast ? h('div', { className: 'yh-olap-toast' }, st.toast) : null)
    }

    function applyCommands(st, sid, cmds) {
      // ===== WORKSTATION: bump 必须同时上传面板状态 —— 命令 apply（write/reflect/stop）
      // 改变了面板状态，若不上传 host 的 lastState 停留旧快照，模型 olap state 读到
      // 陈旧内容（SQL 已写入但 state 仍空）→ 误判"未写入"反复重试。
      // 关键命令用立即上传（绕过 1s 节流）：模型 write 后马上 state 验证，节流延迟
      // 会让 state 读到上传前的旧值。与 OlapPanel bump 的节流路径区分。=====
      let needsFlush = false
      const bump = function () { st.version++; emitStore(sid); needsFlush = true }
      for (const c of cmds) {
        if (c.type === 'write') {
          let tab = null
          if (c.newTab) {
            const base = activeTab(st)
            const nid = wsNextTabId(st)
            tab = { id: nid, name: 'Tab' + nid, sql: '', engine: base.engine, dsId: base.dsId, params: {}, autoSave: true, bottomTab: 'result', running: false, executeId: '', finish: '', log: '', errMsg: '', result: null, wsFile: String(nid) }
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
              // ===== WORKSTATION: lines 区间语义 = 用 c.sql 替换 [start,end] 行，而非裁剪。
              // 原实现 s = 编辑器.slice(start-1,end) 丢弃 c.sql、且把整个 tab.sql 替换成
              // 裁剪结果 → 引用 L13 改一行，结果整个编辑器变成那一行（会话 4a7e5825 实测）。
              // 正确：把 tab.sql 的 [start,end] 行替换成 c.sql（模型给的新内容，可多行）。=====
              const arr = (tab.sql || '').split('\n')
              const a = Math.max(1, Math.floor(c.lines[0]))
              const b = Math.min(arr.length, Math.floor(c.lines[1]))
              const head = arr.slice(0, a - 1)
              const tail = arr.slice(b) // b 为闭区间末行(1-based) → slice(b) 取 b 之后的行
              const rep = String(c.sql === undefined || c.sql === null ? '' : c.sql).split('\n')
              s = head.concat(rep, tail).join('\n')
            }
            if (s !== undefined && s !== null) {
              markProgSqlSet(); tab.sql = s
              // ===== WORKSTATION: 模型 write 的 SQL 也要走自动保存（与手动输入一致）。
              // 只改 tab.sql 不 wsScheduleSave → 刷新即丢（用户实测：开启自动保存的标签，
              // 对话写入的 SQL 刷新网页后消失）。write 后立即落盘（不走 800ms 延迟，
              // 防用户在落盘前就刷新）。=====
              wsScheduleSave(sid, 200)
            }
            bump()
          }
        } else if (c.type === 'reflect') {
          const tab = c.tabId ? st.tabs.find(function (t) { return t.id === c.tabId }) : activeTab(st)
          if (tab) {
            tab.finish = 'done'
            tab.executeId = c.executeId
            if (c.log) tab.log = c.log
            tab.result = c.result || null
            bump()
          }
        } else if (c.type === 'stop') {
          const tab = c.tabId ? st.tabs.find(function (t) { return t.id === c.tabId }) : activeTab(st)
          if (tab && tab.running) { tab.running = false; tab.finish = 'cancel'; tab.log = '已请求终止'; if (tab.executeId) callHost('olap.kill', { requestId: tab.executeId, engine: tab.engine, dsId: tab.dsId }); bump() }
        }
      }
      // 命令处理后立即上传面板状态（不走 1s 节流）：模型 write/run 后随即 state
      // 验证，只有 host 拿到最新状态才能判"已写入"。延迟上传会让模型读到旧快照。
      if (needsFlush) {
        const upload = function () { uploadPanelState(getStore(sid), sid) }
        if (uploadPending) { clearTimeout(uploadPending.timer); uploadPending = null }
        upload()
      }
    }

    // ===== WORKSTATION: OLAP 常驻中列，不提供入口按钮/最大化按钮 =====
    // 历史会话按钮已移除：会话切换改走 DSH 原生 sidebar（工作站最左列，默认收起）。
    // 新版 DSH 删掉了 details slot，右列（工作站重排后 = 中列）现在叫 rightbar，
    // 被 dsh-client-ui-sidebar-right 的 dock 占用；priority:-1 比占用者（0）靠前，
    // 按 SlotCore 的「priority 升序取首个 → 低者胜」语义遮蔽它，与旧 details 同款做法。
    slots.inject('rightbar', function () {
      return slots.register({ name: 'rightbar', priority: -1 }, function (props) { return h(OlapPanel, props) })
    })
    slots.inject('shell.overlay', function () {
      return slots.register({ name: 'shell.overlay', id: 'yh-ws-divider' }, function (props) { return h(WsDivider, props) })
    })
    slots.inject('conversation.input.left', function () {
      return slots.register({ name: 'conversation.input.left', id: 'yh-olap-mode' }, function (props) { return h(OlapChip, props) })
    })

    // @olap 引用 source：输入框输入 @olap 弹标签候选，选中后插入真正的"块"（occurrence chip），
    // 显示为标签块、Backspace 一键删整个块；提交时经 codec.serialize 展开成 @olapN 给模型。
    // 同时在输入框 lexicon 装饰：直接粘贴/插入的 @olapN 文本也显示为块样式。
    let srcDispose = null
    const inputTriggers = ctx.get('inputTriggers')
    if (inputTriggers && typeof inputTriggers.registerSource === 'function') {
      try {
        srcDispose = inputTriggers.registerSource({
          trigger: '@',
          name: 'olap',
          order: 30,
          showGroupTitle: false,
          candidates: function (session, req) {
            const sid = activePanelSid || session.sessionId
            const st = getStore(sid)
            const tabs = (st && st.tabs) || []
            const q = (req.query || '').trim().toLowerCase()
            return tabs.filter(function (t) {
              if (!q) return true
              return ((t.name || 'Tab' + t.id) + ' olap' + t.id).toLowerCase().indexOf(q) !== -1
            }).map(function (t) {
              return { name: t.name || ('Tab' + t.id), section: 'OLAP 标签', hint: (t.sql || '').slice(0, 80), value: String(t.id) }
            })
          },
          onPick: function (pick) {
            const tabId = Number(pick.candidate.value)
            const sid = activePanelSid || pick.session.sessionId
            const st = getStore(sid)
            const tab = st && st.tabs.find(function (t) { return t.id === tabId })
            const nm = tab ? (tab.name || 'Tab' + tab.id) : ('Tab' + tabId)
            return { insert: { source: 'olap', ref: 'olap' + tabId, label: nm, clipboardText: '@olap' + tabId } }
          },
          lexicon: function (session) {
            // 返回面板当前会话标签的引用名：标签名（TabN，可作 textRef 块显示标签名）+ 旧格式 olapN 兼容
            const sid = activePanelSid || session.sessionId
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
            // 全局监听：任何会话面板状态变化都触发 lexicon 刷新（controller 传的 sessionId 可能对不上面板）
            globalLexListeners.add(listener)
            return function () { globalLexListeners.delete(listener) }
          },
          codec: {
            clipboardText: function (ref) { return '@' + ref },
            serialize: function (ref) { return Promise.resolve('@' + ref) },
          },
        })
      } catch (e) { srcDispose = null }
    }

      return function dispose() {
        if (cssEl && cssEl.parentNode) { cssEl.parentNode.removeChild(cssEl); cssEl = null }
        if (srcDispose) { try { srcDispose() } catch (e) { /* noop */ } }
        // ===== WORKSTATION: 清理全局监听 =====
        window.removeEventListener('load', wsApplyLayout)
        if (wsAutoOpenTimer) { clearInterval(wsAutoOpenTimer); wsAutoOpenTimer = null }
        if (wsFollowTimer) { clearInterval(wsFollowTimer); wsFollowTimer = null }
        Object.keys(wsTimers).forEach(function (k) { if (wsTimers[k]) { clearTimeout(wsTimers[k]); wsTimers[k] = null } })
      }
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
