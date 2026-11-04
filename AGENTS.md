# yh-olap-workstation 插件开发规范

本文件是本项目当前状态的唯一事实来源。改代码前先读它。

## 项目形态

- **不是独立 DSH 实例，也不再有自己的 profile。** 本项目是一个普通 DSH 插件包
  `dsh-yh-olap-workstation`，装进目标 profile（`desktop` / `web` 等）的
  `dsh.profile.bundles`。运行形态 = **主 profile 右侧栏里的一个工具 tab**（`kind='olap'`），
  按会话隔离。
- **不劫持 app 级行为**：不重排 AppFrame 三列、不覆盖 favicon/manifest、不改默认
  agent preset、不写 profile 级配置。`plugin/cordis.patch.yml` 只插入插件自身一行。
- **独立项目**：代码不引用、不依赖任何外部 yh-olap 仓库；源码内 `// ===== WORKSTATION: xxx =====`
  等注释只是历史区块标记，按区块阅读即可。
- 旧「独立工作站（三列布局 + 独立 profile + 5175 端口）」已废弃；历史与当时踩的坑见
  `docs/HISTORY.md`（本仓库是 1.0.0 重建后的干净历史，不再包含旧独立工作站时代的提交）。

## 目录与构建

```
plugin/
  package.json        main=src/host.js；exports["./client"]=dist/client.js；dsh.bundle.patch
  cordis.patch.yml    只 insert 插件 entry（无 preset、无 registry 覆盖）
  build.mjs          esbuild 把 src/client/index.js 打成 dist/client.js（committed）
  src/host.js        Host 半（plain ESM，Node）：RPC/认证/OLAP API 代理、olap 模型工具、
                     /olap 模式命令、per-session 工作区文件持久化
  src/client/        Client 半（ESM 源码，构建成单 bundle）：
    index.js         loader 入口；apply/inject；右侧栏 tab 两阶段注册；OLAP 模式 chip；@olap 引用源
    panel.js         右侧栏 tab 正文（SQL 标签条 / 工具栏 / 树 / 编辑器 / 结果区 / 弹窗）
    editor.js        CodeMirror 6 编辑器（引擎 dialect、补全、悬浮、查找、格式化、快捷键）
    store.js         per-session store + 工作区多文件持久化 + 面板状态上报
    resources.js     数据源/库/表/列懒加载 + 收藏 + 历史/下载列表
    run.js           执行/停止/轮询/下载
    results.js       结果表 / 日志 / 历史 / 下载视图
    tree.js          库表树 / 收藏树 / 右键菜单 / 保存收藏弹窗
    modals.js        参数、Session 参数、账号、通用对话框
    format.js        永辉风格 SQL 格式化（纯函数）
    refer.js         编辑器选区/标签引用插入聊天框
    rpc.js           POST /api/yh-olap/rpc（桌面 App 用 __DSH_TRANSPORT__.streamBaseUrl）
    runtime.js       apply 期注入的 client ctx 访问
    util.js          h()/toArray/剪贴板等
    styles.css       全部面板样式（.yh-olap-* 命名空间；主题变量只在面板根作用域）
  src/sql/
    engine-words.js  impala/hive 关键字、函数、类型（单一事实来源）
    completion-core.js 纯函数补全（上下文、别名、排序、候选）
  dist/client.js     构建产物（提交进 Git；linked 安装不依赖 node_modules）
  locale/*.json      插件管理器展示用 meta title/description
  icon.svg           插件图标 / 右侧栏 card 不用它（card 用内置 SVG）
```

**构建命令**（开发时）：
```bash
cd plugin && npm install && npm run build     # 产出 dist/client.js
npm run check                                 # host.js + dist/client.js 语法
npm test --prefix ..                          # 不对；单测在仓库根：
cd .. && node --test test/unit/*.test.mjs
```
`dist/client.js` 必须随源码提交；改 `src/client/**` 后要重新 build，否则线上仍是旧 bundle。

**构建约定**：esbuild `format=cjs` + banner/footer 包成
`window.__ModuleLoader__.load({ id:'dsh-yh-olap-workstation', factory:(require)=>{...} })`；
`react`/`react-dom` external（由 DSH 浏览器 seed 模块表提供）。client bundler 的 id 必须
等于 npm 包名，勿改。

## 关键契约

- **右侧栏 tab 两阶段注册**（照官方 files/terminal 插件）：
  1. `ctx.sidebarRightTabs.register({ id, kind:'olap', priority:'builtin', keepMounted:true,
     title:()=> 'OLAP', guide:[{ id:'open', order:40, title, description, icon }] })`
  2. `ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
     { name:'sidebar.right.pane.tab', key: ID }, Body))`；`key` 必须等于定义 `id`。
  - Body 从 slot standard props **直接拿 `sessionId`**（官方 files body 已验证）；
    不要再轮询 `sessions.current`。`useTabInfo()` 可拿 `tab.visible/fullscreen`。
  - `ctx.sidebarRight.openTab('olap')` 可切到本会话的 tab；`/olap` 模式 chip 用它自动打开。
- **Host RPC + 桌面 CORS**：`POST /api/yh-olap/rpc`（loopback-only）。桌面 App 页面
  origin 是 `dsh-app://app`，相对路径会 404，且跨源必须带 CORS：
  - client 侧 `rpc.js`：`window.__DSH_TRANSPORT__.streamBaseUrl + '/api/yh-olap/rpc'`；
  - host 侧：处理 `OPTIONS` 预检（204）+ 白名单 Origin 回显 ACAO
    （`dsh-app://app` 与 `http(s)://127.0.0.1|localhost|[::1]`，可带端口），
    所有响应带 CORS 头，`Vary: Origin`、`no-store`；非法 Origin 预检 403。
  - **不要再回退到相对路径**；也不要用 Typert/gateway 重写（40 个 handler 已有测试）。
- **会话身份**：面板/工作区/命令队列全部按 `sessionId`；`ws.workspace.*` 落在
  `~/.yh-olap/workspace/<sessionId>/{sql,params}/<id>.*`。文件格式与保留键
  `__name`/`__collectId`/`__sessionConfigs` 不变；测试用 `YH_OLAP_WORKSPACE_ROOT` 重定向。
- **面板在线判定**：client 每 1.5s `olap.panel.state` 心跳；host `lastState` 只认 6s 内更新；
  关闭右侧栏 tab 时 client 调 `olap.panel.offline` 清理状态与命令队列。模型 `write` 在离线时
  明确报错（不要再假 queued）。
- **模型工具/模式**：`olap` 工具（write/run/stop/state/refresh）与 `/olap` 命令、
  `systemPrompt` section 保留；`/olap` 模式 chip 在 `conversation.input.left`。preset/skill
  已删除，工程约定写进 `OLAP_MODE_GUIDE` 与工具 description。
- **`sidebarRight`/`sidebarRightTabs` 服务**放在 client 顶层 `inject` 里是刻意的：本插件
  离开右侧栏没有意义；服务缺失时整插件不激活，比静默半残好。`inputTriggers` 仍用
  `ctx.inject` 延迟订阅（服务晚到，不能阻塞 apply）。
- **引擎词表单一事实来源**：`src/sql/engine-words.js` 同时供 CodeMirror dialect（高亮）、
  completion-core（补全）、测试使用。**禁止**再在别处复制词表。
- **CodeMirror 关键点**：
  - `highlightSelectionMatches` 来自 `@codemirror/search`（不是 view）；
  - `HighlightStyle` 里只能用真实存在的 tags：`tags.quotedIdentifier` 不存在（用
    `tags.special(tags.string)`），否则 factory 一加载就抛 `reading 'id'`；
  - 自定义快捷键（Mod-Enter/Mod-Alt-l/Mod-/）必须单独用
    `Prec.highest(keymap.of([...]))` 作为扩展，**不能**塞进外层 `keymap.of([...])` 的数组里；
  - 全局 `dispatch` 不用重写；doc 变更用 `EditorView.updateListener`；
  - `tooltips({ parent: document.body })` 避免被面板 overflow 裁剪；但注意 CM 会往 `body`
    追加一个 **tooltip 容器 div**，它的 class 就是 `view.themeClasses` —— 所以
    `EditorView.theme` 的 `&` 规则**不能写任何尺寸**（尤其 `height:100%`），否则该容器被撑成
    整屏高、插在 `#root` 之后，页面 `scrollHeight` 翻倍 → 整个 DSH 出现异常滚动
    （2026-11 已修；`test/verify.sh` 有 scrollH/innerH/scrollTop 回归断言）。编辑器尺寸用
    `styles.css` 的 `.yh-olap-cm-host .cm-editor{height:100%}` 负责；
  - **补全/悬浮弹层的深浅色**：`tooltips({parent})` 的容器必须用 `editor.js` 自建的
    `.yh-olap-cm-tooltip-host`（带 `data-yh-theme`，随面板主题同步），颜色由 `styles.css`
    里该宿主的两套 `--yh-tip-*` 变量 + `!important` 显式给出。**不要**用
    `var(--dsw-alias-brand-primary)` 当选中行背景再配 `#fff` 文字（深色主题下
    brand-primary 接近白色 → 白字白底），也不要把配色交给 CM 的 `&light/&dark` 类
    （主题热切换后 tooltip 容器类可能滞后，深色下弹层仍白底）。verify.sh 有深色模式断言
    （弹层背景亮度 < 0.35、选中/普通行对比度 ≥ 3）。
    补全列表右侧的「函数/表/字段」类型列用 theme 里 `.cm-completionDetail{margin-left:auto}`
    右对齐（tooltip 挂 body 时靠 theme 类命中，别改成全局 CSS）。
  - **Tab / Shift-Tab 策略**（`Prec.highest` 自定义 keymap，verify.sh 有 5 条浏览器断言）：
    ① 补全弹层打开 → Tab 接受当前项并插入（函数自动 `name()`）；
    ② 有选区 → Tab / Shift-Tab 对选中行整行缩进 / 反缩进（`indentMore`/`indentLess`，
    `indentUnit.of('    ')` 统一 4 空格）；
    ③ 无选区 → Tab 只在光标处插入软缩进（补到下一个 4 空格制表位），**不整行缩进**；
    Shift-Tab 不触发整行反缩进（no-op）。**不要**在普通 keymap 里再绑 Tab / `indentWithTab`，
    否则会盖掉这套策略；
  - tab.sql 是唯一事实源：docChanged → 立即写 tab.sql、800ms 自动落盘；外部写入由 props
    `sql` 变化触发一次 dispatch 同步。
- **面板/样式**：容器查询 `container-type:inline-size`；<720px 默认收起左树（首次测量决策，
  之后尊重用户手动切换）；<620px 左树变抽屉。所有颜色走 `--dsw-alias-*` / 面板内 `--yh-*`，
  不写死浅/深色（`data-yh-theme` 在面板根）。
- **弹窗/菜单**：面板层统一 `createPortal(..., document.body)`，避免右侧栏裁剪/层叠。

## 安装 / 卸载

```bash
# 装进某个 profile（以 desktop 为例；web 同理）
dsh plugin --profile desktop add link:/绝对路径/plugin
# 再把 "dsh-yh-olap-workstation" 加进 ~/.dsh/profiles/<profile>/package.json 的
# dsh.profile.bundles（顺序放在 @deepseek-ai/dsh-web-app 之后），然后重启 App / dsh web。

# 或（当前 profile，需要权限）用 plugin_manager install_bundle target=<plugin 绝对路径>

# 卸载
dsh plugin --profile desktop remove dsh-yh-olap-workstation
# 并从 dsh.profile.bundles 删掉该行，重启
```
Host 改动需重启 App 生效；只改 client 时刷新页面 + 重启也可（0.2.1 有 client release gate）。
安装后用 `node test/desktop-check.mjs` 验证桌面 CORS/挂载。

## 验证流程（改代码后）

1. `cd plugin && npm run build && npm run check`。
2. `cd .. && node --test test/unit/*.test.mjs`（引擎词表/补全 29 条）。
3. `node test/tool-case-0.2.0.mjs`（`olap` 工具 schema/输出对真实 dsh-tools 校验器）——
   脚本内部已把工作区重定向到 /tmp，不碰用户数据。
4. `bash test/verify.sh`：隔离 DSH_HOME + 临时 profile + 隔离工作区起 5275 实例，
   断言 profile 组合 / CORS / boot graph / 右侧栏卡片 / CM 挂载 / 自动保存 / 刷新恢复 /
   引擎补全；浏览器段需要 ego-browser（`REQUIRE_BROWSER=0` 可跳过）。
5. `bash test/model-turn-probe.sh`（可选，一次真实模型调用）：打开右侧栏工具后发 `/olap`，
   断言无「处理失败/unknown prompt variable」、本轮完成、工具结果 `tabs=` 回显。
6. `node test/desktop-check.mjs`：桌面 App 重启后，CDP 只读验证 `dsh-app://app` 下 RPC
   真的可用（CORS 证据）与面板/CM 挂载。

**红线**：
- 不要用 headless/CDP 直接驱动**真实用户实例**的编辑器（会自动落盘覆盖标签）。需要驱动
  编辑器时用隔离实例 + `YH_OLAP_WORKSPACE_ROOT`。
- `test/verify.sh` / `model-turn-probe.sh` 只碰 `/tmp` 下的 home/workspace；不要在真实
  `~/.yh-olap/workspace` 上做写入测试。
- 改 shell 脚本时 `$VAR` 后紧跟中文必须写 `${VAR}`（macOS bash 3.2 + UTF-8 会把中文首字节
  当成变量名一部分 → `set -u` 报 unbound variable）。

## 更新历史（要点，详细见 git log / docs/HISTORY.md）

- **2026-11 重构：独立工作站 → 主 profile 右侧栏工具 + CodeMirror 6**
  - 删除独立 profile / start.sh / stop.sh / 三列布局 CSS / favicon+manifest 劫持 / yh-data
    preset；插件只注册右侧栏 tab 与 guide card。
  - 桌面 App RPC 修复：相对路径 fetch 在 `dsh-app://app` 下 404、跨源无 CORS →
    client 用 `__DSH_TRANSPORT__.streamBaseUrl`，host 加 CORS 预检/回显。
  - 面板会话身份改由 `sidebar.right.pane.tab` standard props 的 `sessionId` 直取；
    删除 sessions.current 轮询、新会话跟随补丁、布局反查等全部 hack。
  - 编辑器重写为 CodeMirror 6；引擎词表抽到 `src/sql/engine-words.js` 并修掉旧词表的
    `NaN`/粘连 bug（旧 `IMPALA_FUNCS[0]==='NaNceil'`，首行函数与多字符合并丢失）；
    补全逻辑抽到 `src/sql/completion-core.js` 并补齐 Node 单测。
  - 面板在线判定改心跳 + offline；模型 write 不再假 queued。
  - 构建链：esbuild + 提交 `dist/client.js`；`react`/`react-dom` 走 DSH seed 模块。
  - 结果表加行号/NULL 灰显/右键复制/加载更多；工具栏图标化 + 容器查询响应式。
  - 清理无效 UI：去掉数据源旁重复的引擎徽标、移除无实际用途的「便签」功能（含 host 端
    note 工作区类型）；数据源名已含引擎名时下拉项不再重复后缀。
