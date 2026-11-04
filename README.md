# dsh-yh-olap-workstation

永辉 OLAP 的 **DSH 右侧栏工具**：在 DeepSeek Harness 里以右侧栏 tab 的形态提供 SQL 编辑、
执行、结果、历史与下载，按会话自动保存。不再需要独立 profile 或单独端口。

## 形态

- 一个普通 DSH 插件包（Host + Client 两半）：
  - Host（`plugin/src/host.js`）：OLAP/认证代理、`olap` 模型工具、`/olap` 模式、per-session
    工作区文件持久化、`POST /api/yh-olap/rpc`（loopback + 桌面 CORS）；
  - Client（`plugin/src/client/**` → `plugin/dist/client.js`）：在右侧栏注册一个
    `kind='olap'` 的工具 tab + 引导页卡片，并提供输入框 OLAP 模式 chip、`@olap` 引用源。
- 不重排 AppFrame、不覆盖 favicon/manifest、不改默认 agent preset。

## 安装

需要 DSH 0.2.x（peer 区间 `^0.2.0-rc.1`；当前验证版本 0.2.1-rc.5）。

```bash
# 1) 装依赖（link 安装，无需发布）
dsh plugin --profile desktop add link:"$PWD/plugin"
# 2) 把 "dsh-yh-olap-workstation" 加进
#    ~/.dsh/profiles/desktop/package.json 的 dsh.profile.bundles（放在 dsh-web-app 之后）
# 3) 重启 DeepSeek Harness.app
```

`web` profile 同理（`dsh plugin --profile web add link:...`，然后重启 `dsh web`）。
当前 profile 也支持用插件管理器的「安装本地目录」入口安装。

安装后验证（只读，需要 App 以默认的 9222 调试端口运行）：

```bash
node test/desktop-check.mjs
```

## 使用

1. 打开会话后展开右侧栏（会话 header 右上角的侧栏按钮）。
2. 引导页点「**OLAP 查询**」→ 右侧栏出现 OLAP tab。
3. 工具栏：数据源（引擎）/ 执行（⌘/Ctrl+Enter，有选区只跑选区）/ 格式化 / 查找 / 参数 /
   Session 参数（切到 hive 引擎即可用）/ 保存到收藏 / 全量下载 / 库表树开关。
   库表/收藏树**默认隐藏**，点工具栏最左侧的树按钮展开；再点收起。
4. 编辑器：impala/hive 引擎词表与函数补全（**Tab 接受补全**）、行号/折叠/括号匹配/多光标、
   查找替换（⌘/Ctrl+F，面板已中文化）、`${var}` 参数高亮、悬浮字段注释、格式化（⌘/Ctrl+Alt+L）、注释切换（⌘/Ctrl+/）。
   Tab/Shift+Tab：有选区时整行缩进/反缩进；无选区时 Tab 只在光标处补空格、Shift+Tab 不整行动。
5. 底栏：日志 / 结果（行号、NULL 灰显、右键复制、加载更多）/ 历史 / 下载。
6. 面板按会话隔离：切换会话、刷新页面会自动恢复该会话的 SQL 标签与内容。
   `/olap` 模式激活时会自动打开当前会话的 OLAP tab。

工作区文件：`~/.yh-olap/workspace/<sessionId>/{sql,params}/<id>.*`
（可用环境变量 `YH_OLAP_WORKSPACE_ROOT` 重定向，测试/多实例时使用）。

## 开发

```bash
cd plugin
npm install
npm run build      # 产出 dist/client.js（必须提交）
npm run check      # host + dist 语法
cd ..
node --test test/unit/*.test.mjs
node test/tool-case-0.2.0.mjs       # olap 工具 schema/输出校验（隔离工作区）
bash test/verify.sh                 # 隔离实例：组合/CORS/boot/右侧栏/编辑器/落盘/恢复（需要 ego-browser）
bash test/model-turn-probe.sh       # 可选：真实模型一轮 /olap 冒烟（成本=一次模型调用）
```

架构、关键契约、CodeMirror/右侧栏 API 的坑见 `AGENTS.md`；重构前旧工作站设计与历史
见 `docs/HISTORY.md`。

## 安全

- RPC 只接受 loopback 连接，且对 `Origin` 做白名单（`dsh-app://app` / 本机 http origin）
  并回 CORS 头；不发送 credentials、不落 cookie。
- 账号凭据沿用本机 `~/.config/yh_bigdata/accounts.json` 与 `~/.config/yh_bigdata/session.json`，
  插件不额外保存密码。
- 模型工具与面板命令均按 `sessionId` 隔离；面板离线时 write 会明确报错，不会静默排队。

## 许可

MIT。客户端打包了 CodeMirror 6（MIT），见 `plugin/THIRD_PARTY_NOTICES.md`。
