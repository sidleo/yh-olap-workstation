# yh-olap 独立工作站 · 全栈工程师代码评审

> 评审日期：2026-09（基于当时仓库快照）
> 评审对象：整个仓库（`plugin/`、`profile/`、`preset/`、`start.sh`/`stop.sh`、`AGENTS.md`、`README.md`）
> 一句话结论：**功能完成度远超"不懂代码的人"的平均水平，工程结构则处于"能跑但不可持续"的巨石状态** —— 该产品值得长期维护，但当前形态的重构成本会随功能累积而指数上升。

---

## 上篇 · 给产品负责人（你）

### 这个项目哪里做得好（值得你自豪）

1. **产品直觉很准**。README 里功能 3–20 的记录显示，你发现的问题（中文标签引用成不了块、结果表滚动时表头错位、历史会话永远"加载中"、新会话被灌旧数据）——**每一个都是真实用户才会撞上的体验 bug**，而且定位到了根因。多数初级工程师做不到这个深度。
2. **决策记录完整**。每一处"为什么这么做"（为什么不用 AppFrame 内建拖拽手柄、为什么 sticky 表头要 -8px）都有注释，后来的维护者能接得上。
3. **功能覆盖面专业**：SQL 编辑器（高亮/补全/多光标/参数/格式化/执行选区）＋ 结果预览 ＋ 历史/下载工单 ＋ 本地多文件持久化 ＋ 知识库集成 ＋ 与 AI 会话的标签引用联动 —— 这是一套完整的"数据工作站"，不是 demo。
4. **隔离意识好**：独立 DSH_HOME + 独立端口 + 独立 preset，不污染主实例，且自动播种默认工作区让首次打开即可用。

### 你必须知道的 3 个风险（按严重度）

1. **⚠️ `stop.sh` 可能误杀别的 dsh 进程**（详见下篇 §2.4）。如果哪天你机器上同时跑着主实例和其他 dsh，一条 `./stop.sh` 可能把别人的会话杀掉。**强烈建议先改成只匹配自己的 PID 文件 / 精确进程**。
2. **⚠️ RPC 端点只校验"本机"不校验身份**（详见下篇 §2.5）。单机自己用没问题，但如果你把它通过局域网/端口转发暴露出去（或公司电脑有别的本机进程），任何能访问 5175 的东西都能借它跑你账号下的 SQL。至少要确认这个端口没被外部访问。
3. **⚠️ 没有 git 版本管理**。整个仓库不在版本控制里，也没有备份。你 README 里那些"回退旧格式"的代码一旦改错，没有任何历史可以找回。**今天建 git 仓库并做首次提交，是成本最低收益最高的一件事。**

### 要不要"重做"？我的建议

**不要推倒重来。** 这套系统功能已经很多，重做的成本远高于收益。值得做的是**分阶段重构**（不是重写），优先级：

| 阶段 | 做什么 | 对你的价值 | 成本 |
|---|---|---|---|
| P0（今天） | git init + 首次提交；修 `stop.sh` 误杀 | 立刻止血，可回滚 | 半小时 |
| P1（1–2 周） | 把 3713 行的 `client.js` 拆成按职责分文件 | 以后改一个功能不再牵一发动全身 | 中 |
| P1（同时） | SQL 高亮/格式化换成熟开源库（下篇 §1.2） | 删掉约 40% 需要长期维护的手写 parser | 中 |
| P2 | UI 打磨：图标、原生对话框、样式 token | 观感从"能用"到"专业" | 中 |
| P3 | 结果表大数据量虚拟滚动 | 只有跑几万行结果才看得出 | 低优先 |

> 想长期用、还想继续往上加功能 → 按 P0→P1 走。只当个人工具且不常改 → 至少做 P0。

---

## 下篇 · 给工程师 / AI 读者

### §1 代码质量

#### 1.1 单文件巨石与手写状态管理（最核心问题）

- `plugin/src/client.js` **3713 行单文件**：20+ React 组件、SQL 词法高亮器、软换行光标像素坐标计算（等宽字体估算 + `mirror` div 两种方案并存，`cursorXY`/`visualRowsOf`/`posFromMouse` 三套近似算法）、SQL 格式化器（约 400 行手写 parser，`formatSql`/`formatMain`/`splitCodeTopAbs`/CTE 括号配对）、多光标 diff 引擎、自动补全、本地持久化、约 24KB 内联 CSS。
- **状态管理是自定义的"可变全局 store + 版本号重渲染"**：所有 tab/面板状态存在 `makeStore()` 返回的可变对象里，事件回调里直接 `st.tabs.push(...)` / `st.leftTab='x'` 原地改，再 `bump()`（`st.version++; emitStore`）触发订阅者重渲染。等同手写了一个跳过所有规范的 Redux：没有 reducer、没有不可变更新、没有选择器、没有 action 追溯。
  - 后果：AGENTS.md 自述的"无限重渲染卡死""订阅晚于 fetch resolve 的竞态"（README 功能 4、9）**就是该结构必然产生的病**。渲染函数体内任何一次 `bump()` 都可能死循环（修复手段是"加载一律进 useEffect"——靠纪律而非结构保证）。
- 模块级**可变全局作为跨组件通信通道**：`activePanelSid` 在 `OlapPanel` 渲染体里每次赋值（副作用放在渲染中）、`wsNonKeyInput`/`wsProgSqlSetAt`/`wsPasteAt` 时间戳窗口、`globalLexListeners` 全局 Set。这些让 React 的时序分析变成人工审计。

#### 1.2 手写 parser 堆栈（维护成本重灾区）

词法高亮 `tokenize`、关键字词表 `IMPALA_KEYS`/`HIVE_KEYS`/`IMPALA_FUNCS`/`HIVE_FUNCS`（手工维护、含"逐函数实测"注释）、SQL 格式化器、CTE 括号配对、字符串引用扫描——**业界成熟方案齐全**（高亮可用 shiki/prism，格式化可用 sql-formatter 的 impala/hive 方言；补全仍是自定义活，但词法可从库借力）。手写能覆盖当前引擎，但每换一个 SQL 方言都是全量返工，且肉眼维护极易漏。

#### 1.3 轮询驱动的架构

至少 7 处常驻 `setInterval`/递归轮询：
- `wsAutoOpenFirst` 1.2s、`wsFollowNewSessions` 1s、`wsApplyLayout` 补发 + 800ms、`WsDivider` 500ms 常驻同步 + 400ms 兜底观察、`OlapPanel` 800ms 会话跟随、`pollRun` 三路 500ms 并行轮询、`schedulePanelUpload` 上传节流。
- 注释承认用轮询对抗 AppFrame 时序（sidebar 展开只改 inline `gridTemplateColumns`，RO 不触发 → 只能轮询读 inline 首段）。这是真实约束下的务实解，但**7 个并行定时器在页面生命周期里没有统一管理**（dispose 里有清理，但分散在多个 effect/模块），属于高维护面。

#### 1.4 值得肯定的工程习惯

- 代码里大量"经验注释"标注了**为什么**（非 what），如 sticky 负 top、transform 滚动同步、divDragging ref 防闭包捕获旧值、newTab id 避开遗留文件——这些是代码考古价值最高的部分。
- `sqlMask`/`lowerKeywordsIn`/`findTopKeywords` 等工具做成了独立函数，命名清晰。
- host 端对面板命令做 `sessionId` 队列（`panelQueues`/`panelStates`），把"模型工具 → 页面 UI"的同步建模为命令队列，方向正确。

### §2 安全与健壮性

#### 2.1 `stop.sh` 误杀风险（⚠️ 需立刻处理）

```bash
PIDS="$(pgrep -f "dsh.*--profile yh-olap" 2>/dev/null || true)"
...
kill $PIDS
```
- `pgrep -f` 是全命令行子串匹配：机器上任何命令行包含 `dsh ... --profile yh-olap` 字样的进程（包括别人/别的项目/你自己的另一个实例）都会被杀。兜底 `lsof -ti tcp:$PORT` 是第二重误杀面（端口占用者不一定是你这个实例）。
- 建议：启动时写 PID 文件到 `.dsh-home/`，停止时只杀 PID 文件指向的进程；或至少 `pgrep -f` 结果里再校验 `--port $PORT` 与工作目录。

#### 2.2 start.sh 每次启动都 `pnpm install`

注释称幂等 ~200ms。规范做法是依赖不变时跳过（用 lockfile 或已安装标记），否则一次网络抖动/registry 故障会让整个启动失败。

#### 2.3 脚本健壮性细节

- `start.sh` 第 8–16 行 `SCRIPT_DIR` 用 `$(cd ... && pwd)` 展开，OK；但 bash 3.2 的 `set -u` 分支已处理过（README 有记录），其余 `EXTRA` 数组处理正确。
- 凭据播种 `cp "$HOME/.dsh/settings.yaml"` 与 `.credentials.yaml` 硬依赖主实例存在；若主实例从未初始化，只打 WARNING 不中断——可接受但应在 README 说明"首次需先跑过主实例"。

#### 2.4 host.js 凭据与访问控制

- 账号密码明文 JSON（`~/.config/yh_bigdata/accounts.json`，沿用上游 yhlogin 约定，非本项目引入，但本项目复制了它）。
- RPC 只做 loopback 校验 + 无 token：见上篇风险 2。对单机自用可接受；若未来做"局域网共享工作站"（多人浏览器访问 5175），这是第一道要补的墙。

#### 2.5 `wsSafeFile` 路径穿越防护存在但需注意

```js
const s = String(name || '').replace(/[\\/]/g, '_').replace(/\.\.+/g, '').trim()
```
把 `/`、`\` 换 `_` 并剥 `..`，已挡住目录穿越；但文件名仍可含 `:`（macOS OK，Windows 保留字符）、空格等。工作区文件在用户主目录下自用，风险可控，不阻塞。

### §3 UI / 交互评审

#### 3.1 优点

- **主题变量化**：颜色全部走 `var(--dsw-alias-*)` + 兜底 hex，深色自适应正确。
- **窄面板信息密度控制**：`shortT` 压缩时间、`shortId` 缩略 uuid、`INFO_SPAN` 收缩省略、表格单元格 `max-width:260px; text-overflow:ellipsis`——方向专业。
- 极少数细节达专业级：滚动同步用 transform、`th` 的 `top:-8px` 抵消容器 padding、结果表 `overscroll-behavior:contain`。

#### 3.2 问题（按影响排）

1. **CSS 是内联巨型字符串 + 全局类名**（约 24KB）。无 scoping、无 token 化，依赖 `yh-` 前缀避免冲突——当前可行，但任何一次 CSS 改动都要全文搜索前缀。且 `.yh-ws-frame>div:nth-child(n)` 依赖 AppFrame 子元素顺序，是**脆弱的 DOM 结构耦合**（DSH 升级换结构即碎）。
2. **图标全部用 emoji / 特殊字符**：`▶ 执行` `◀` `◉` `📄` `▾` `❯` `⚠` `⚙` `×` `●`。跨平台渲染不一致（Windows 下 emoji 是彩色位图、观感突兀），无矢量、无统一尺寸。
3. **原生对话框混用**：`window.prompt`/`window.confirm` 用于重命名/删除确认/新建目录——与深色 UI 风格断裂、不可定制、无键盘焦点管理。应自绘（项目里已有自绘 modal 先例，直接扩展）。
4. **无障碍缺失**：补全列表、右键菜单均无 `aria-*`、无焦点管理、无键盘可达；`div` 模拟菜单无 `role`。
5. **中文字号 12.5px 偏小**：非 retina / Windows 125% 缩放下发虚。工具类面板建议 ≥12.5–13px 并给 CJK 单独的 line-height。
6. **结果表无虚拟化**：`tbody` 全量渲染预览行；预览上限 200 行以内 OK，超过即 DOM 膨胀。若未来放开 pageSize 需虚拟滚动或分页。
7. 树的展开/收起状态存 `st.expanded` 键值（`'s'+id`/`'t'+tableId`/`'c'+nodeId`），键空间靠前缀区分——语义弱但当前够用。

### §4 排版 / 文档 / 工程卫生

1. **README 混入大量调试日志**：功能 3–20 的验证记录里，ego-browser 排障（僵尸标签页、Task space 未选中、`-300px → 1013→713`）与像素数据是**调试流水账**，对维护者有效信息密度约 20%。建议：把"决策原因"（为什么 -8px、为什么轮询、为什么不用内建手柄）保留在代码注释或单独 `docs/decisions.md`；把验证数据归档成 `docs/manual-test-log.md`；README 只留产品说明 + 快速启动。
2. **AGENTS.md 的"更新历史"一节已达 40+ 行追加式**：继续追加将不可读。应改为最近 N 条 + 指向 docs/。
3. **仓库卫生**：`.debug-scroll.png`（228KB）无引用残留于根目录，应删；仓库无 `.git`。
4. **plugin/README.md** 内容仅 3 行指向项目 README——npm 包发布视角下缺 standalone 说明（但这包只在本地 link 使用，可接受）。

### §5 架构层的更优解（若未来重构）

按收益排序：

1. **拆 client.js**：按职责分文件 —— `store.js`（状态/订阅）、`editor/`（highlight、completion、multi-cursor、wrap 坐标）、`sqlfmt/`（formatter）、`components/`（panel、tabs、tree、modals、view）、`ws/`（persistence、layout、follow）。DSH 是 cordis 体系：可评估用 bundler/模块加载（把 `factory` 拆成 import 模块）而非单文件 string。
2. **状态收敛到 React 真 state**：per-session store 用 `useReducer` 或 zustand 式不可变更新；**消灭"渲染体副作用"这一类 bug 的温床**（`activePanelSid` 赋值移出渲染）。AGENTS.md 里两条卡死/竞态教训可因此结构性消失。
3. **高亮/格式化外包**：shiki（或轻量 prism 带 impala/hive grammar）＋ sql-formatter（impala/hive 方言）。当前手写实现验证成本高、方言一换全废。
4. **轮询收敛**：会话跟随/新会话跟随/宽度同步，若能拿到 DSH 的事件源（session projection / AppFrame 变更回调）则替换为订阅；做不到也应收敛为一个节流器统一管理生命周期。
5. **UI 层**：SVG 图标（或 lucide 子集）、自绘确认框、样式抽 token 变量（--yh-* 统一管理）、结果表虚拟列表。

---

## 附：评审依据文件清单

| 文件 | 行数 | 备注 |
|---|---|---|
| plugin/src/client.js | 3713 | 单文件巨石，WORKSTATION 标记 91 处 |
| plugin/src/host.js | 1079 | vendored yh-olap + RPC/工具/队列 |
| start.sh / stop.sh | 101 / 19 | stop.sh 有误杀风险（§2.1） |
| profile/package.template.json | 18 | link: 依赖本地插件 |
| preset/yh-data/* | — | persona / preset / SKILL.md 质量较好 |
| AGENTS.md | 9608B | 规则全面、更新历史追加式膨胀 |
| README.md | 123 | 功能验证日志占大头 |

（本文件仅为评审记录，不改变任何运行代码。）
