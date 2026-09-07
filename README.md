# yh-olap 独立工作站（Standalone OLAP Workstation）

> 一个「给人用的 OLAP 工作站」：**捆绑独立 DSH 实例（真隔离）**，无桌面壳 —— 独立端口 + 浏览器打开。
> 左边是完整的 yh-olap OLAP 工作页（库表/收藏/编辑器/历史/下载），右边是会话页（数据分析 Agent 聊天）。
> SQL / 便签 / 参数 **多文件本地持久化**，下次打开新会话自动恢复；sqlkb 知识库已集成到面板（知识库 tab）。

## 布局决策（来自前序会话 a/b/c）

| 决策点 | 结论 | 落地 |
|---|---|---|
| a. 壳 | **不包装** | 独立端口 + 浏览器（无 Electron/Tauri） |
| b. 隔离 | **捆绑独立 DSH 实例（真隔离）** | 独立 `DSH_HOME`（`.dsh-home/`）+ 独立端口 5175；与 3080 主实例互不干扰（会话/设置/预设隔离），仅共享本机资产（yh_bigdata 账号凭据、sqlkb 知识库） |
| c. 持久化 | **多文件** | `~/.yh-olap/workspace/` 下按 `sql/ params/ notes/` 多文件保存，跨会话恢复 |

## 一键启动

```bash
./start.sh            # 首次会自动：初始化独立 DSH_HOME、装 profile 依赖、装 preset、播种 settings.yaml/凭据/默认工作区
                      # 然后启动独立实例并打开浏览器 http://127.0.0.1:5175
./stop.sh             # 停止
```

> 首次打开即自动进入工作站：无需手动选工作区（start.sh 播种默认工作区，客户端自动 `connectWorkspace` 建绑定工作区的会话并打开）。若之后想换目录，可在 hero 的「选择工作区」菜单里加新工作区。

可配置环境变量：`YH_OLAP_PORT`（默认 5175）、`YH_OLAP_DSH_HOME`（覆盖数据目录，默认 `<本项目>/.dsh-home`）、`YH_OLAP_NO_OPEN=1`（不自动开浏览器）。
> 注意：start.sh **强制**使用独立 `DSH_HOME`（忽略外层继承的主实例 `DSH_HOME`），保证真隔离。

## 目录结构

```
yh-olap profile/
├── start.sh / stop.sh     # 启动/停止脚本（真隔离实例）
├── profile/               # 独立 profile 配置源（package.template.json + cordis.yml + cordis.patch.yml）
├── preset/yh-data/        # 「数据分析师 & 数据工程师」agent preset（含 OLAP 知识 skill）
├── plugin/                # dsh-yh-olap-workstation 插件（独立实现：OLAP 工作页 + 工作站布局 + 知识库/持久化）
│   └── src/{host.js,client.js}
└── .dsh-home/             # （运行时生成，gitignore）独立 DSH 数据根：profiles/ 会话/ 设置/ 预设
```

## 组件说明

- **profile（独立实例）**：`dsh.profile.bundles = @deepseek-ai/dsh-base + @deepseek-ai/dsh-web-app + @sidleo3/dsh-sqlkb + dsh-yh-olap-workstation`。只挂 SQL 相关插件，不挂 lark-* / 侧栏 / 办公插件 —— 工具空间干净，不被 web 内其它插件干扰。
- **工作站插件（dsh-yh-olap-workstation）**：独立实现，包含：
  - **OLAP 工作页**：库表/收藏/编辑器/历史/下载 —— 完整的数据查询工作台（左栏四 tab：库表/收藏/工作区/知识库）。
  - **布局**：三列 —— DSH 原生 sidebar（会话选择）最左、OLAP 面板（原 details 槽）中、会话（conversation 槽）右；sidebar **默认收起**（56px 展开条，点开看会话/工作区列表，与 dsh web 一致）；OLAP/会话之间自建分隔条可调宽，启动自动展开 OLAP。
  - **本地持久化（多文件）**：`~/.yh-olap/workspace/{sql,params,notes}/` 每个 tab 一份文件，SQL/参数/便签自动保存，新会话打开自动恢复。
  - **工作区 tab**：左树新增，浏览/打开/新建/重命名/删除本地 SQL 文件。
  - **知识库 tab**：左树新增，sqlkb 的 表/示例/坑点 浏览 + 搜索 + 明细。
  - **会话切换**：用 DSH 原生 sidebar（最左列，默认收起）——不需要额外的历史会话按钮。
- **preset（yh-data）**：数据工程师 & 数据分析师人设；SQL 安全红线、sqlkb 硬要求、优先用 `olap` 工具（插件自身 API）、永辉 OLAP 知识 skill。

## 开发说明

- 本项目是**独立项目**：不依赖任何外部 yh-olap 仓库或 installable 目录，删除外部副本后仍可完整运行（唯一外部依赖是永辉数据中台账号凭据 `~/.config/yh_bigdata/accounts.json`，属用户数据）。
- 插件源码内带 `// ===== WORKSTATION: xxx =====` 标记的区段是本地功能说明，供按区块阅读定位。
- OLAP 执行走 **插件自身 API**（`/api/yh-olap/rpc` + `olap` 模型工具），不直接调 `yh_bigdata` CLI。


## 验证流程（改 `plugin/src/*.js` 后）

```bash
node --check plugin/src/host.js
node -e "new Function(require('fs').readFileSync('plugin/src/client.js','utf8'))"
./start.sh   # 重启独立实例（Ctrl+C / stop.sh）
```

## 安全

- 凭据：yh_bigdata 账号只存本机 `~/.config/yh_bigdata/accounts.json`（独立实例共享）；模型 API key 首次启动从主实例播种 `.credentials.yaml` 到独立 `DSH_HOME`（仅首次，600 权限）。
- 仓库不含任何真实账号/密码/JSESSIONID/API key。

## 已验证明细（2026-08-28）

- 独立实例在 5175 启动成功：`dsh --profile yh-olap --port 5175`，根页面 200，真隔离 `DSH_HOME=.dsh-home`。
- 插件加载：浏览器无 “Failed to load plugins”；`/plugins/dsh-yh-olap-workstation/client.js` 正常下发。
- **开箱即用（不再需要手动选工作区）**：`start.sh` 首次播种默认工作区（仓库目录）到 `workspace.json`；客户端启动后若没有会话，自动 `workspaces.connectWorkspace` 新建一个**绑定工作区**的会话并打开 —— 首次打开直接进入工作站，composer 可用（占位符「描述你想要构建的内容」），无需点「选择工作区」。
- 布局重排已验证（计算样式，含**列高**）：`grid-template-columns: 1013px 699px`、`grid-template-rows: 885px`，侧栏 `display:none`，会话列在右、OLAP 列在左（details 列 `h:885px` 可见），overlay 跨列，拖动条隐藏。**OLAP 编辑器在视口内（y:74, h:499）。**
- OLAP 面板端到端实测：编辑器输入 `select 1 as a,2 as b,3 as c` → 点「执行」→ 结果 tab 显示「共 1 行 / a b c / 1 2 3」。
- RPC 全链路：`ws.workspace.{list,save,read,rename,remove}`（sql/params/notes 多文件往返）、`ws.sqlkb.{list,get}`、`ws.sessions.list` 均返回 `ok:true`。
- preset 生效：浏览器显示「OLAP」；API Key 提示消失（凭据已播种）。
- **端到端会话已实测**：在工作站里发消息，模型正常回复（「我是专为永辉数据中台 OLAP 工作站打造的取数分析助手…」），OLAP 面板在左、会话在右。

### 排障记录（2026-08-30）

- **根因 1（致命）：`preset/yh-data/agent.cordis.yml` 的 `tool-todo` 行缺 `config.allowParallelInProgress: true`** → preset 挂载失败（`agent-preset-invalid`）→ 建会话失败 → hero 页卡住、composer 锁定、无 OLAP 面板。已补齐该配置。改 preset 后重启即可。
- 根因 2：客户端原只 `sessions.open` 首个会话，但首个会话若未绑定工作区则 composer 锁定 → 改为 `workspaces.connectWorkspace` 建**绑定工作区**的会话。
- 陷阱：host 侧 `sessions.create` 建的会话 cwd 用 homedir 会「不属于任何工作区」（composer 锁）；要用 workspace 流程建会话才能绑定。
- **根因 3（用户反馈「OLAP 完全不显示」）：AppFrame 网格 auto-placement**。只设 `grid-column` 时，center 排进 row1/col2 后光标越过 col2，details 不回退 row1/col1，被压进隐含第二行（`grid-template-rows: 885px 0px`），details 列高 0、内容溢出视口外 → 面板「看着在但看不见」。修复：center/details 都补 `grid-row:1 !important`（`grid-template-rows` 恢复单行 `885px`）。
- **验证教训**：这类网格重排 bug 只查 innerText/列宽会误报「面板已渲染」；必须查**列高**（`getBoundingClientRect().height`）与编辑器是否在视口内（`y < innerHeight`），且要实际点「执行」跑一次 SQL 确认功能可用，不能只靠文字探针。
- **根因 4（用户反馈「点收藏/知识库后浏览器卡死」）**：`SqlkbTree` 和 `WorkspaceTree` 在 **React 渲染函数体内**调用加载函数（`loadList` / `wsRefreshTree`），而这两个函数第一行就 `bump()` → `emitStore()` → 触发所有 `useStore` 订阅者同步重渲染 → 重渲染后「未加载」条件仍成立 → 又调加载函数 → **无限重渲染 → 浏览器主线程卡死**（edge/chrome 都复现）。
- **修复 4**：把加载触发移进 `useEffect`（组件挂载时只跑一次），渲染体只读状态；`WorkspaceTree`（915 行附近）和 `SqlkbTree`（982 行附近）各加一处 `react.useEffect(...)`。
- **验证 4（ego 实测）**：修复前点「知识库」页瞬间卡死（Runtime.evaluate 超时）；修复后 知识库（表/示例/坑点 24 条）/收藏（我的收藏）/工作区（＋新建）全部正常渲染，20 次快速 tab 切换全响应，20 秒空闲稳定（事件循环无阻塞）。
- **排障工具提醒**：ego-browser 连续多任务空间会产生僵尸标签页，污染 CDP 导致 `js()` 假超时（页面事件循环其实正常）——遇到「全 -1」先 `pkill -9 -f "ego lite"` 并清 `~/Library/Application Support/Citro Labs/ego lite/Default/Workspaces` 再复测；判定页面卡死以页内 setInterval 心跳（maxGap）为准，不要只看 Runtime.evaluate 超时。
- **排障工具提醒 2（ego 任务空间选中）**：清空 Workspaces 重建空间后，`useOrCreateTaskSpace` 只创建不选中，tab 类 helper（`listTabs`/`js`/`createTab`）会**静默挂起**（无报错）直到先 `takeOverTaskSpace(id)`/`switchTaskSpace(id)` 选中空间——报「Task space not selected」才是没选中的明确信号；单条 heredoc 末尾加 `cliLog` 进度 + 对 `js()` 包 Promise.race 超时守卫（8s），避免一个挂点吃掉整段验证。
- **功能 5（对话区宽度可调）**：OLAP/会话区之间加自建分隔条 `.yh-ws-divider`（挂在 `shell.overlay` 层），网格列宽改由 CSS 变量 `--yh-ws-cols` 驱动（默认 `1.45fr + minmax(340px,1fr)`，拖拽后写成 OLAP 像素宽，会话区自动吸走剩余空间）；宽度持久化到 `localStorage['yh_ws_olap_w']`，刷新恢复。**为什么不用 AppFrame 内建手柄**：其 `left` 定位基于原始列序（sidebar|center|details），与工作站重排后的视觉边界不对应。
- **验证 5（ego 实测）**：分隔条定位到边界（left 1009 ≈ OLAP 边界 1013 − 半宽 4）；CDP 真实拖拽 −300px → OLAP 1013→713 / 会话 699→999，+400px → 1113/599；左拖钳制 OLAP 最小 320、右拖钳制会话最小 360；`localStorage` 写 320 后刷新页面恢复 OLAP 320；清掉持久化后回默认 1.45fr（1013/699）；空闲 12s 稳定无卡死。
- **start.sh 修复（本次顺带）**：bash 3.2 下 `set -u` + 空数组 `"${EXTRA[@]}"` 报 `unbound variable`（此前一直带 `--no-open` 未暴露），改为 `[ "${#EXTRA[@]}" -gt 0 ]` 分支判断。
- **功能 6（标签重命名后引用支持中文名成块）**：右键标签「引用」原实现是 `referTab` 拼纯文本 `@TabN` + 依赖输入框 textRef 扫描装饰成块。两处框架限制叠加导致中文名失效：①`referTab` 用 `/^[\w-]+$/` 判定名字，「哈喽」不匹配 → 回退成 `Tab4` → 填入 `@Tab4`；②即便填 `@哈喽`，textRef 装饰正则 `TEXT_REF_RE = /(^|\s)([/@])([\w-]+)/g` 只认 ASCII word 字符，中文名永远扫描不出块（且 lexicon 也按 `\w` 过滤）。修复：`referTab` 改为走与 @olap 菜单 pick **同款的真实 occurrence 块插入**——经 `conversation.input.for(actx).insertReference()` 提交 `ReferenceInsert { source:'olap', ref:'olap'+id, label:标签名, clipboardText:'@olap'+id }`；label 任意文本（含中文）直接渲染成 chip，提交时由同一 codec.serialize 展开成 `@olapN` 给模型。拿不到输入 shell 时兜底回旧文本/复制逻辑。
- **验证 6（ego 实测）**：标签「哈喽」右键 → 引用 → composer textarea `value="@哈喽 "`（不再是 @Tab4）且渲染 `data-decoration="chip"`（文本 `@哈喽`、occurrence=1）；发送后用户消息为 ref chip `title="@olap4"` —— 证明中文 label 块成功序列化为 `@olapN` 供模型识别。新会话同样通过。**结论：标签重命名成任意文本（含中文/空格）后，「引用」都能以真实块格式插入并正确序列化。**
- **功能 7（OLAP 主页面精简 + 参数弹窗 + 结果表表头修正）**：①OLAP 是主页面，删除顶部「OLAP」入口按钮（OlapToggle 组件 + 渲染引用 + `.yh-olap-toggle` 样式全部移除）与标签栏「最大化」按钮（`⤢` + `.max` 样式移除）——会话头部只留 @olap4/Session log/对话/轨迹；②参数弹窗改版：参数名 `${xxx}` 作为独立标签放在输入框**外**（`.yh-olap-plabel`），输入框只留 placeholder「输入参数值」，输完不再不知道对应哪个参数；③结果表滚动错位修复：`.yh-olap-reswrap` 有 `padding:8px 10px` 导致 sticky 表头 `top:0` 相对 padding-box 锚定、滚动后表头下方 8px 露出 body 行 → 表头/表格 `thead th` 的 `top` 统一改为 `-8px`（负值抵消 padding），滚动后表头贴住 wrap 顶且无记录行窜到列名上方。
- **验证 7（ego 实测）**：①`olapToggleCount=0`、`maxBtnCount=0`，面板仍正常渲染（`hasOlapPanel=true`），头部工具仅剩 @olap4/Session log/对话/轨迹；②参数弹窗（3 个 `${}`）label 与 input 分离（`labelRight=782, inputLeft=790, gap=8`，`labelOutsideLeft=true`）；③跑 200 行查询、`scrollTop=2200` 后：`thTop=wrapTop`（表头 flush 顶部）、`rowAboveHeader=null`（表头上方无记录行）、首行在表头下方（`y=641`）——错位消失。
- **功能 8（OLAP 默认列宽加宽）**：默认网格从 `minmax(0,1.45fr) minmax(340px,1fr)` 改为 `minmax(0,2fr) minmax(340px,1fr)`（OLAP 占 2/3）。ego 实测 `gridTemplateColumns=1280px 640px`（@1904 视口，此前 1013/699）。拖拽分隔条仍可自定义并持久化 `localStorage['yh_ws_olap_w']`。
- **功能 9（历史会话「加载中…」永不消失修复）**：根因是**订阅注册晚于 fetch resolve 的竞态**——按钮 onClick 里发起 `ws.sessions.list`（本机 ~4ms 返回），而 HistoryOverlay 的订阅 `useEffect`（`hisUI.lz.add`）要到首次渲染后才注册；fetch resolve 时 lz 还是空的 → `forEach` 空转 → `loading=false` 的更新无组件接收 → 面板永远停在「加载中…」。之前未暴露是因为 host 首次扫描会话存储慢、fetch 没那么快。修复：加载收敛进 HistoryOverlay 组件内部（`useState rows/loading` + 挂载后 `useEffect` 里 `callHost('ws.sessions.list')`，`.then` 内 `setRows/setLoading` 必达），按钮 onClick 不再预加载；删除废弃的 `wsReloadSessions`。**经验：本地 RPC 太快时，千万不要用「全局对象 + 渲染后注册的订阅集合」推状态——加载发起点必须晚于订阅建立，即放进组件 useEffect。**
- **验证 9（ego 实测）**：修复前每次打开历史会话面板都是「加载中…」（fetch 200 但 UI 不更新）；修复后打开显示 2 个会话（`@olap4`、`session-0dcf…`），`loading=false`，关闭再开第二次同样正常。顺带确认模型选择功能正常：模型按钮为两级菜单，点「选择模型」→ 菜单（模型/推理等级）→ 点「模型」展开 17 个模型（DeepSeek-V4-Flash/Pro/Vision-Exp、commandcode、GLM-5.3/MiMo 等），真鼠标全流程切到 DeepSeek-V4-Pro 成功。
- **功能 10（sidebar 恢复最左 + 默认收起 + 删历史会话按钮）**：会话切换改走 DSH 原生 sidebar。①布局改三列：`.yh-ws-frame` 网格恢复 `[sidebar] [OLAP] [conversation]`（`--yh-ws-sidebar-w` 首列 + `--yh-ws-cols` 后两列），sidebar 不再 `display:none`，OLAP 移到第 2 列、会话第 3 列；②默认收起：`wsApplyLayout` 启动时若 sidebar 处于展开态则调 `layout.toggleSidebar()` 收起一次（`wsSidebarCollapsedDone` 防反复），收起后是 56px 展开条（DSH 原生 rail，含「打开侧边栏」按钮），点开 280px 显示会话/工作区列表，与 dsh web 一致；③历史会话按钮 + 面板整体移除（`HistoryBtn`/`HistoryOverlay`/`hisUI`/`useHis`/slots 注册/样式全删），会话切换交给 sidebar。
- **验证 10（ego 实测）**：初始 `grid=56px 1242.66px 621.328px`（sidebar 收起 rail）、头部无历史会话按钮；点「打开侧边栏」→ `280px 1093.33px 546.672px`，sidebar 显示会话列表（@olap4 / 测试 / yh-olap 工作站）；再点「收起侧边栏」→ 回 56px、OLAP 自动吸宽 1243px；分隔条拖拽 −200px → OLAP 1243→1043 且 `localStorage['yh_ws_olap_w']=1043` 持久化、分隔条对齐 OLAP 右缘（差 4px=自身半宽）。**经验：sidebar 展开/收起只改 AppFrame 的 inline `gridTemplateColumns`，fr 自身尺寸不变 → ResizeObserver 不触发；我们的列宽变量 `--yh-ws-sidebar-w` 需常驻轮询（500ms）读 inline 首段同步，MutationObserver 监听 `data-sidebar-collapsed` 会因同 commit 时序读到旧值而不可靠。**
- **功能 11（sidebar 展开时的聊天区溢出 + 左栏 4 标签可见）**：①**展开溢出修复**：聊天区被拖到最小 360 时展开 sidebar（56→280px 让出 224px），`--yh-ws-cols` 固定像素（用户拖宽的偏好）不收缩 → 总宽 280+1504+340=2124 > 1920，会话区被推出视口 204px（`overflowX:true`）。修复：WsDivider 常驻轮询里在 `saved>300` 时把 OLAP 目标宽钳到 `min(saved, frW - sidebar - 360)`——展开时自动压缩、收起后自动回到用户偏好；拖拽中（`divDragging`）跳过钳制防回跳。②**左栏默认加宽**：OLAP 面板左栏（库表/收藏/工作区/知识库 4 个横排标签）默认 150px 放不下（4 标签约需 196px，gap14×3+padding24），`知识库` 被挤出；默认宽改为 210px（`leftWidth` 初始化/拖拽起算/渲染兜底三处 + CSS），tabs2 `gap:14→10、padding:12→10`。
- **验证 11（ego 实测）**：聊天区拖到最小 360（OLAP 1504）→ 展开 sidebar：`grid=280px 1280px 360px`（1280=1920−280−360 自动压缩）、聊天区仍 360 不被挤出、`overflowX:false`；收起回 `56px 1504px 360px`（恢复用户偏好）。左栏 210px：4 标签全部可见（库表 x66-92 / 收藏 102-128 / 工作区 138-177 / 知识库 187-226，均 `vis:true`），展开态同样可见。
- **功能 12（工作区按会话隔离 + 面板跟随会话 + 「新会话」重置为纯新）**：之前工作区是**全局一份**（新会话自动被灌入旧标签/旧 SQL）。改为 **per-session**：①host `ws.workspace.*` 五方法支持 `sessionId`，文件落到 `~/.yh-olap/workspace/<sessionId>/{sql,params,notes}/`（不传回退全局旧目录，兼容）；②client 持久化/恢复缓存改 `wsMetaBySid`（每会话自己的 tabs），`wsPersistAll`/`wsLoad`/`wsApplyToStore`/工作区树全部带 `sessionId`；③**新会话目录无文件 → 保持初始 1 个空 Tab1**；④**面板跟随会话**：DSH 的 details slot 在切换会话时不更新 props.sessionId（实测对话区已切、面板仍绑旧 store），OlapPanel 改为轮询 sessions 服务 `current`（800ms），变化即 `setSid` 切 store；⑤**「新会话」按钮补丁**：实测 DSH 的 startSession()→connectWorkspace 会**复用空白会话**（blank 且 cwd 匹配，本环境恒复用 session-5c145422）而不新建 id，用户点「新会话」打开的仍是那个会话 → 面板恢复它的旧工作区，看着「不是新的」。工作站捕获侧栏「新会话」按钮点击，把当前面板会话工作区**重置为纯新**（1 空 Tab1 + 清 per-session 文件 + `__wsRestored` 防旧内容恢复）——无论 DSH 复用哪个会话，面板都是全新的；`wsFollowNewSessions`（1s 轮询 ids）负责 DSH 真新建（非 blank 场景）时自动 open。
- **验证 12（ego 实测）**：①per-session 落盘：SQL 写后出现在 `workspace/<sessionId>/sql/1-Tab1.sql`；②面板跟随：`open(新会话 id)` → current 切新、面板 `tabs:["Tab1"] sql:""`；`open(旧会话 id)` → 恢复原工作区；③打开工作站首屏 = 1 空 Tab1（全局旧数据不再灌入）；④「新会话」重置：面板写入 `select 111` 后点侧栏「新会话」→ 面板回到 `tabs:["Tab1"] sql:""`，per-session 目录文件清空（0 个）。**注意**：DSH 的「新会话」复用空白会话是框架行为（connectWorkspace 找 blank+同 cwd），工作站不做对抗，用「点击即重置面板」达成「新会话=全新」的用户预期。
- **功能 13（SQL 补全支持表字段 + 别名 + 裸字段 + 全库列预加载）**：补全原只有关键字/函数/库名/表名，字段候选依赖 `st.columns`（仅展开过的表才加载）→ 输字段补不出。修复：①**别名补全**：新增 `aliasTableMap` 解析 `from dim_shop s` / `from dim.dim_shop as s` / `join dws.t x` 等，`s.`/`dim_shop.` 输入时经别名映射到真实表 → `loadColumns` 补字段；②**裸字段补全**：`select shop_`（字段在 from 前）先把 from/join 表列按需加载进候选；③**无 from 全库预加载**：只输入 `select` 还没写 from 时，自动遍历当前数据源全部 schema 的表按需加载列（限流并发 6、上限 300 表、`__colsLoading` 防重入），全库字段进入候选；④**去重按「字段名+字段注释」**：同名同注释只留一个，同名不同注释（不同表同名字段）都保留靠注释区分；⑤**场景化限定**：`rootCandidates` 支持 `onlyKeys`（表键集合）——有 from/join 时裸字段只匹配 SQL 中出现表的字段（避免全库误补、输错字段），无 from 时才用全库字段。
- **验证 13（ego 实测）**：`select s. from dim.dim_shop s where s.` → 补出 is_dc/city_id/shop_id 等；`select shop_ from dim.dim_shop` → 补出 shop_id 门店编码/shop_name 门店名称/shop_sts 门店状态…；`select shop_`（无 from）→ 同样补出（列来自本会话已加载缓存）。**局限**：全新会话且从未加载任何表列时裸字段无候选——需先 from 一张表或展开库表树，避免全库扫列的性能代价。
- **功能 14（按引擎精确词表：impala 3.4 / hive 3.1）**：高亮/补全关键字与函数改为**按当前 tab 引擎**选词表（`ENGINE_WORDS`：'2'=impala、'1'=hive、其余回退通用 SQL）。函数清单**以永辉 OLAP 页面（bigdata.yonghui.cn/#/olap/main）右侧函数面板「以实际为准」的完整分类清单为准**（ego 登录后逐个抓取 Aggregate/Analytic/Collection/Complex Type/Conditional/Date/Mathematical/Misc/String/Data Masking/Table Generating/Type Conversion 全部分类）：impala 185 个（含 md5/sha/sha2/date_format/corr/regr_*/mask_*、**无 group_concat**——impala 用 collect_list/collect_set）、hive 216 个（含 appx_median/ndv/group_concat/bitand/nvl2/regexp_like/split_part、**无 corr**）。引擎差异显著：hive 有 Bit 分类（bitand/bitor…）与 appx_median/ndv/nvl2，impala 有 Collection/Data Masking/Table Generating 分类与回归函数。
- **验证 14（ego 实测）**：impala tab 输 `cor` → 补出 `corr`（函数标记 f）、输 `md` → 补出 `md5`；impala 输 `group_` 无 group_concat（仅字段/表名）；hive 词表含 ndv/bitand/nvl2 且无 corr。词表计数与页面清单一致（185/216）。
- **功能 15（函数清单全部实测校验 + 函数优先级高于字段）**：用户指出「页面函数列表也不一定可用」——对 **impala 页面清单 185 个 / hive 页面清单 216 个逐函数 olap.run 实测**（分引擎、聚合带 from、精确签名）。结果证实页面清单大量不可用：impala 的 corr/covar_*/regr_*/percentile/md5/sha/sha2/crc32/xpath/array/map/struct/explode/posexplode/stack/collect_list/collect_set/date_format/current_date/next_day 等 **53+ 实测不可用**（复杂类型/表生成/加密/回归类被环境禁用）；hive 的 appx_median/group_concat/ndv/now/date_trunc/bitand/bitor/bitxor/left/right/nvl2/typeof/sleep/pid 等**实测不可用**（页面 Bit 分类全不可用）。同时发现**页面清单没有但实测可用**需补入：impala group_concat/appx_median/ndv/now/uuid/mod/date_trunc/bitand 系列/dayofweek 系列/current_user 等；hive md5/sha2/crc32/array/explode/posexplode/get_json_object/corr/percentile/collect_list/collect_set/split/substring_index/str_to_map 等。**最终词表：impala 130、hive 205，全部经实测验证**。**函数补全优先级高于字段**：rankMatches 排序加类型权重（k/f 关键字函数 > sch 库 > tbl 表 > col 字段 > w 工作区词），函数不会被字段挤出候选前列。
- **验证 15（实测证据）**：impala `select md5('abc')` → `AnalysisException: default.md5() unknown… db has 13 functions`（确认不可用）；impala 精确签名 `select md5('abc')` N、`select get_json_object('{\"a\":1}','$.a')` Y（转义修正后可用）；hive `select group_concat('a') from dim.dim_date limit 1` N（页面有但不可用）、`select explode(array(1,2))` Y（页面无但可用）。词表最终校验：impala 含 group_concat/uuid 无 md5/date_format；hive 含 md5/explode/sha2 无 group_concat/bitand。
- **功能 16（不可用函数二次复查：区分「用法错误」与「真实不可用」）**：对全部「确认不可用」函数用多签名 + 真实列 + 错误信息复查，发现 4 个是使用方式问题导致的误判（实际可用，已补回词表）：impala `current_date`（无括号形式 `select current_date`，加括号的 `current_date()` 才报错）；hive `isnull(a,b)`（两参形式，一参 `isnull(null)` 才错）、`shiftleft(a,b)`/`shiftright(a,b)`（标准两参）。其余确认真实不可用（多种正确签名都报错）：impala 53 个（corr/covar_*/regr_*/percentile/md5/sha/sha2/crc32/xpath*/array/map/struct/explode/posexplode/stack/collect_list/collect_set/date_format/next_day/elt/field/format_number/octet_length/bround/cbft/binary/assert_true/in_file/encode/decode/reflect/java_method/hash/context_ngrams/ngrams/isnotnull/isnull/parse_url_tuple/json_tuple/inline/create_union/array_contains/map_keys/map_values/size/sort_array/named_struct/shiftrightunsigned/base64），hive 27 个（appx_median/group_concat/ndv/now/date_trunc/bitand/bitor/bitxor/bitnot/countset/getbit/setbit/rotateleft/rotateright/dayname/dayofyear/coordinator/effective_user/pid/sleep/ifnull/left/right/nullifzero/nvl2/typeof/zeroifnull）。
- **验证 16（实测证据）**：impala `select current_date`（无括号）Y、`select current_date()` N——括号形式才是问题；hive `select isnull(null,1)`（两参）Y、`select isnull(null)` N；hive `select shiftleft(1,2)` Y、`select shiftright(8,1)` Y；impala `select md5('abc')` 仍 N（多签名复查真实不可用）。词表最终：impala 133（含 current_date）、hive 209（含 isnull/shiftleft/shiftright）。
- **功能 17（标签「自动保存」开关，默认关闭）**：每个标签增加「自动保存」选项（右键菜单勾选，默认关闭）。只有勾选的标签才自动落盘到工作区（`~/.yh-olap/workspace/<sessionId>/sql|params|notes/<id>-<名>.*`，debounce 800ms，SQL/参数/便签一起）；未勾选的标签不自动写盘（重开会话不恢复，内容只存内存）。开启时立即保存一次；关闭标签不删工作区文件（删除由工作区手动操作，删除 SQL 会连带删参数/便签）；重开会话恢复的标签自动保持「自动保存」开启。手动「保存当前」/「＋新建」不受开关限制。性能：默认不写盘，IO 比全量自动保存更省。
- **功能 18（文件以 id 为准 + 取消自动保存删文件）**：①工作区文件名由 `<id>-<名称>.sql` 改为**纯 id**（`<id>.sql/.json/.md`），标签名存进 params 的 `__name` 字段，工作区树显示名从 `__name` 读——**彻底消除「同 id 不同名」冲突**（旧逻辑重命名/打开文件会产生 `10-Tab8.sql` 与 `10-Tab10.sql` 同 id 不同名）；②取消勾选「自动保存」时**直接删除该标签的工作区文件**（sql/params/note 三件套）；③恢复/工作区树只认纯 id 文件，旧格式 `<id>-<名>` 文件不再恢复/显示（历史残留保留在磁盘，不影响）；④「保存当前」同步写 `__name` 保证显示名。
- **功能 19（右键菜单失去焦点关闭修复）**：排查所有右键弹出菜单——标签（tabMenu）/收藏（collectMenu）/工作区树（wsMenu）——发现**工作区树右键菜单（wsMenu）缺 document mousedown 关闭监听**（只有树内 onClick 关闭），点击树外/失去焦点时菜单残留。修复：WorkspaceTree 加 useEffect（依赖 st.wsMenu）监听 document mousedown，点击 `.yh-ws-cmenu` 外即关闭。其余菜单（tabMenu/collectMenu/下载引擎下拉）均已有关闭机制，逐一确认无遗漏。


- **功能 20（按引擎精确关键字清单）**：关键字（补全+高亮）由「一份通用 + 各补几个」改为**按引擎精确清单**——impala 3.4（108 条，含 `compute stats/refresh/invalidate metadata/kudu/left semi join/ilike/show databases` 等引擎特有）、hive 3.1（121 条，含 `lateral view/insert overwrite/stored as/msck repair/cluster by/serde/add jar` 等引擎特有）；其余引擎回退通用清单。**多词关键字**（group by/order by/lateral view 等）用逗号分隔定义保留为完整候选；高亮用 `expandKeys` 把多词展开成单词（`group by`→`group`+`by`）逐词匹配。补全候选同时含完整多词条目与单词。
