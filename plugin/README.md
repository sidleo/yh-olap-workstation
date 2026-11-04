# dsh-yh-olap-workstation（插件包）

DSH 插件：右侧栏 OLAP 工具（SQL 编辑/执行/结果/历史/下载），Host 半为 `src/host.js`，
Client 半源码在 `src/client/`，构建产物 `dist/client.js`。

- 构建：`npm install && npm run build`
- 语法：`npm run check`
- 单测：`node --test ../test/unit/*.test.mjs`
- 安装：把本目录加入目标 profile 的 `dsh.profile.bundles`（`dsh plugin --profile <p> add link:<本目录>`），
  重启 DSH。

详见仓库根 `README.md` 与 `AGENTS.md`。
