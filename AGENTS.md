# yh-olap 独立工作站 开发规范

本文件是本项目唯一事实来源。改代码前先读它。

## 项目形态

- **独立 DSH 实例**：`profile/` 是独立 profile 配置源，`start.sh` 安装到 `$DSH_HOME/profiles/yh-olap`（`$DSH_HOME` 默认 `<本项目>/.dsh-home`，真隔离）。`dsh --profile yh-olap --port <port>` 启动。
- **工作站插件**：`plugin/` 是 npm 包 `dsh-yh-olap-workstation`，`src/host.js`（Host）+ `src/client.js`（Client）纯 JS 静态 bundle，无构建。
- **上游同步**：`plugin/src/*.js` 以 `dsh-yh-olap` 的 `installable/src/*.js` 为基底 vendored；本项目增量都带 `// ===== WORKSTATION: xxx =====` 标记，上游更新后 `cp` 再逐个合并标记区。

## 架构与平台分工

- **Host**（`plugin/src/host.js`）：全部网络/认证/OLAP API/`olap` 模型工具/反向命令队列（来自 yh-olap）+ **WORKSTATION 增量**：workspace 多文件持久化 RPC、sqlkb 读取 RPC、sessions 列表 RPC。客户端 RPC 统一 `POST /api/yh-olap/rpc` `{method,args}`。
- **Client**（`plugin/src/client.js`）：`window.__ModuleLoader__.load({id:'dsh-yh-olap-workstation',...})` 导出 `{inject,apply}`；React 经 `require("react")`；RPC 用 fetch；CSS 挂 `<style>` dispose 移除。
- **工作站布局**：CSS `!important` 重排 AppFrame 网格为三列 —— sidebar（会话选择，默认收起 56px 展开条）最左、details(OLAP) 中、conversation 右；列宽 `--yh-ws-sidebar-w`（轮询 AppFrame inline 首段同步）+ `--yh-ws-cols`（OLAP/会话，2fr 默认、可拖分隔条持久化）；启动 `ctx.layout.openDetails()` 并默认 `toggleSidebar()` 收起一次。
- **本地持久化（多文件，per-session）**：`~/.yh-olap/workspace/<sessionId>/{sql,params,notes}/`，每 tab 三份文件（`<tabId>-<name>.sql` / `.json` / `.md`）；SQL 输入 debounce ~800ms 自动保存；**新会话没有历史文件 → 纯新状态（1 个空标签）**；切回旧会话恢复它自己的工作区。
- **会话独立性：面板跟随当前会话**：OSD 的 details slot 切换会话不更新 props.sessionId（实测），OlapPanel 自轮询 sessions 服务 `current`（800ms）切 store；`wsFollowNewSessions`（1s 轮询 ids）检测**新增会话 → 自动 open**（DSH「新会话」按钮只创建不切 current）。

## 关键契约

- 静态适配：package.json `dsh.bundle.patch=./cordis.patch.yml` + `dsh.client.inject=[runtime, ui-slots]`；`cordis.patch.yml` 的 `name` 用 npm 包名 `dsh-yh-olap-workstation`；client `load({id})` 的 id 必须等于 npm 包名。
- **client 插件 id 必须是包名**，勿改。
- sqlkb 数据目录 `~/.agents/sqlkb`（tables/ examples/ pitfalls/），WORKSTATION host 直接解析 front-matter 读；只读不写（写坑点走模型工具 sqlkb_create）。
- 认证/OLAP API/深色主题色板/多光标/补全等契约沿用 `dsh-yh-olap/AGENTS.md`（见上游仓库）。

## 验证流程

1. `node --check plugin/src/host.js`
2. `node -e "new Function(require('fs').readFileSync('plugin/src/client.js','utf8'))"`（client parse）
3. `./start.sh` 启动独立实例，浏览器 http://127.0.0.1:5175 人工验证：
   - 左 sidebar（默认收起 56px 展开条）/ 中 OLAP / 右会话；OLAP 面板自动展开；点 rail 可展开会话列表
   - 工作区 tab：编辑 SQL 自动落盘 `~/.yh-olap/workspace/<sessionId>/sql/*.sql`；重开新会话自动恢复；新会话默认 1 个空标签（无旧内容灌入）
   - 知识库 tab：能列出 表/示例/坑点 并打开明细
   - 会话列表在 sidebar（工作站最左列，默认收起 56px 展开条，点开可看会话/工作区）
   - 聊天里模型可用 `olap` 工具操控面板
4. `./stop.sh` 停止

## 更新历史

- 2026-09 代码评审 + P0/P1-P3 优化（git 基线化）：①**git 版本管理**：仓库纳入 git，评审前可运行版打 tag `v1.0.0-baseline`，随时 `git checkout v1.0.0-baseline` 拉回；②**启停安全**：start.sh 后台启动写 PID 文件（`$DSH_HOME/yh-olap.pid`）+ 日志，重复启动检测带 <10s 宽限期；stop.sh 首选 PID 文件精确停止，命令行兜底需 dsh+profile+port 三条件齐备——**修复原 `pgrep -f` 模糊子串匹配误杀无关进程的风险**（曾实证误匹配到无关进程）；③bash3.2 `set -u` 下变量后跟全角字符被吞成 `PORT�` 的 UTF-8 词法 bug：所有 `$VAR` 插值改 `${VAR}`；④**渲染体副作用外移**：`activePanelSid` 赋值移入 `useEffect([sid])`（消费方均用户交互时触发，不晚于原渲染期）；⑤**结果表分页已回退**（git revert c8792d3）：曾实现「加载更多」服务端翻页，实测 `getSqlResult` 的 pageNo/pageSize 分页是**摆设**——服务端最高只返回 200 条，翻页取不到更多，功能无效故整体回退；**经验：OLAP `getSqlResult` 单次最多 200 条且不可翻页，取全量走「全量下载工单」而非分页**；⑥**自绘对话框**：新增 `DlgModal`（`st.dlg` 状态驱动 confirm/input，Esc/遮罩关闭、input 自动聚焦、onOk 可拦截空值），替换全部 7 处 `window.confirm/prompt`（收藏目录/重命名/删除、工作区重命名/删除、账号删除）；⑦**CSS token 收口**：`#4176e6/#e5484d/#fff/rgba-weak` 硬编码收敛为 `:root` 深浅两套 `--yh-ui-brand/-weak/--yh-ui-danger/-weak/--yh-ui-ondark`；⑧client.js 顶部加功能区段索引注释。**经验：react 渲染体禁止副作用；单文件巨石定位难 → 文件头留行号索引；改脚本前先查 bash3.2 对 `$VAR+全角字符` 的解析；依赖服务端 API 能力前先实测其真实行为（文档/猜测 ≠ 实际）。**
- 2026-09 **olap 工具 schema 修复（commandcode 网关 400）**：模型会话实测报 `Invalid schema for function 'olap': ... got 'type: null'`（provider=commandcode）。根因：host.js 里 `olap` 工具 `parameters` 用**裸字段简写**（属性平铺、顶层无 `type`），commandcode 等严格网关不认裸 schema → 400 拒绝整轮模型调用。修复=改成标准 JSON Schema（顶层 `{type:'object', properties:{...}, required:['action']}`，数组 `items` 补子属性），与 sqlkb 可用工具及**上游 dsh-yh-olap 已修复版**完全对齐（上游 installable/src/host.js 有同款注释"裸字段表根上无 type 会被 400 拒绝"）。**经验：模型工具 `parameters` 必须是标准 JSON Schema（根 type:'object'+properties+required），`required` 写在属性内（`required:true`）是无效简写；DSH 自有通道可能容错但 commandcode/OpenAI 兼容网关严格校验——定义工具一律用 defineTool 产出形态。改 host.js 后需重启实例（link: 加载进内存不热更）。**
- 2026-08-28 初始搭建：独立 profile + 工作站插件（vendored yh-olap v1.0.1）+ yh-data preset + 启动脚本。
- 2026-08-30 首启体验修复：preset `tool-todo` 补 `config.allowParallelInProgress`（缺失会导致 preset 挂载失败→建会话失败→卡 hero 页）；客户端无会话时自动 `workspaces.connectWorkspace` 建绑定工作区的会话；start.sh 播种默认工作区（含 workspace.json 不存在时）。**首次打开直接进入工作站（左 OLAP / 右会话），无需手动选工作区。**
- 2026-08-30 布局修复：AppFrame 网格只设 `grid-column` 时 details 被 auto-placement 压进隐含第二行（列高 0、OLAP 不可见）；center/details 补 `grid-row:1` 修复。**验证网格重排必须查列高 + 编辑器是否在视口内 + 实际跑一次 SQL，不能只看 innerText/列宽。**
- 2026-08-30 卡死修复：`SqlkbTree`/`WorkspaceTree` 在渲染函数体内调加载函数（内部 `bump()`→`emitStore()`→同步重渲染→条件仍成立→再调）造成**无限重渲染→浏览器卡死**；加载触发移进 `useEffect`（挂载时跑一次），渲染体只读状态。**规则：任何组件渲染体禁止调用会触发 store emit 的函数，加载一律走 useEffect。**
- 2026-08-30 对话区宽度可调：OLAP/会话区之间自建分隔条 `.yh-ws-divider`（挂 `shell.overlay` 层，该层覆盖全 frame 且子元素 pointer-events:auto）；网格列宽改 `grid-template-columns:var(--yh-ws-cols,默认)`，拖拽把 OLAP 写成像素宽、会话区吸走剩余，持久化 `localStorage['yh_ws_olap_w']`。**不要复用 AppFrame 内建 `[data-side]` 手柄：其 left 按原始列序定位，与重排后边界不符。** start.sh 顺带修 bash3.2 `set -u` 空数组展开报 `unbound variable`。
- 2026-08-30 标签引用中文名修复：右键「引用」原走「纯文本 `@TabN` + textRef 扫描装饰」，框架 textRef 正则只认 `[\w-]+`，中文名永远成不了块且被 lexicon 过滤（还回退成 `Tab4`）。修复：`referTab` 改走**真实 occurrence 块插入**（`conversation.input.for(actx).insertReference()`，label 用标签名任意文本，ref=`olap+id`，提交时 codec.serialize 展开成 `@olapN` 给模型），与 @olap 菜单 pick 同款 ReferenceInsert。**经验：输入框「块」有两种——textRef 扫描装饰（只认 ASCII word）和 occurrence chip（label 任意文本）；要让任意字符标签成块必须用后者。**
- 2026-08-30 OLAP 主页面精简+参数弹窗+表头修正：①删 OLAP 入口按钮（OlapToggle 组件+`.yh-olap-toggle` 样式）与标签栏最大化按钮（`⤢`+`.max` 样式），OLAP 是主页面无需入口/最大化；②参数弹窗参数名 `${xxx}` 作为独立标签放输入框外（`.yh-olap-plabel`），避免输完不知对应参数；③结果表 sticky 表头滚动错位：`.yh-olap-reswrap` padding 8px 使 `top:0` 表头锚错，滚动后 body 行露出在表头下方 8px——`thead th` 的 `top` 统一 `-8px` 抵消 padding，`thTop==wrapTop` 且 `rowAboveHeader==null` 为通过判据。**经验：CSS sticky 表头的 top 相对 padding-box 锚定，容器有 padding 时必须用负 top 抵消。**
- 2026-08-31 OLAP 默认列宽加宽 + 历史会话「加载中…」修复：①默认网格 `1.45fr` → `2fr`（OLAP 占 2/3，@1904 下 1280/640px），拖拽仍可自定义+持久化；②历史会话面板永远转圈根因=**订阅注册晚于 fetch resolve 的竞态**：按钮 onClick 先发 `ws.sessions.list`（本机 4ms 返回），overlay 的订阅 useEffect 首渲染后才注册 → lz 空 → `loading=false` 更新丢失 → 永远「加载中…」；修复=加载收敛进组件内部（useState + 挂载后 useEffect 发起，setState 必达），删 `wsReloadSessions`。**经验：本地 RPC 太快时禁止「全局对象+后注册订阅集合」推状态，加载必须放组件 useEffect（订阅建立之后）；面板状态一律收敛进组件 state。**
- 2026-08-31 sidebar 展开溢出修复 + 左栏 4 标签可见：①**溢出**：聊天区拖到最小 360 时展开 sidebar（56→280 让出 224px），`--yh-ws-cols` 固定像素不收缩 → 总宽 2124 > 1920、会话区被推出视口。修复=WsDivider 常驻轮询把 OLAP 目标宽钳到 `min(saved, frW−sidebar−360)`（展开自动压缩、收起回偏好、`divDragging` 时跳过）。**经验：固定像素列宽 + 侧栏展收 = 必然溢出点，目标宽必须随可用视口 clamp，且 clamp 与用户拖拽互相不可打扰。** ②**左栏默认 150→210px**：库表/收藏/工作区/知识库 4 个横排标签需约 196px（gap14×3+padding24）远超 150px，末标签被挤出；tabs2 gap 14→10、padding 12→10。**经验：flex 横排多标签容器，默认宽按「标签总宽+间距」算，别拍脑袋。**
- 2026-08-31 **工作区按会话隔离（per-session）+ 面板跟随会话**：①工作区原为全局一份（新会话被灌旧标签/SQL）→ 改 per-session：host `ws.workspace.*` 支持 `sessionId`（落到 `workspace/<sessionId>/{sql,params,notes}/`，不传回退全局兼容）；client 缓存改 `wsMetaBySid`，持久化/恢复/工作区树全带 sessionId；**新会话目录无文件 → 保持初始 1 空 Tab1（纯新）**。②DSH details slot 切会话不更新 props.sessionId（实测对话区已切、面板仍绑旧 store）→ OlapPanel 轮询 sessions `current`（800ms）切 store。③DSH「新会话」按钮只创建不切 current → `wsFollowNewSessions`（1s 轮询 ids）新增 id 自动 open。**经验：DSH details/侧栏 slot 是「挂载时绑定 sessionId」的，切会话要自己跟随；`let` 变量声明必须在赋值之前（TDZ），跨函数提升声明但赋值顺序决定生死——踩过一回插件整体加载失败。**
