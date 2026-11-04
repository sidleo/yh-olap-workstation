# 历史：独立工作站（已废弃）

1.0.0 重构之前本项目是一个**独立 DSH 实例**：

- `profile/` 模板 + `start.sh`/`stop.sh` 把插件安装到仓库隔离的 `$DSH_HOME`（默认 `.dsh-home/`），
  以 `dsh --profile yh-olap --port 5175` 运行；
- Client 半用 `!important` 把 AppFrame 重排成三列（sidebar | OLAP | 会话），并遮蔽
  DSH 官方 rightbar 内容；
- bundle patch 还会插入 `yh-data` agent preset、把默认 preset 改成它、覆盖 `/favicon.svg`
  与 `/manifest.webmanifest`；
- 编辑器是「透明 textarea + 自绘高亮覆盖层」，包含自写软换行测量、自绘选区、自写多光标、
  自写查找替换等大量补偿逻辑。

该形态的问题：与主 profile 割裂、需要维护独立实例/端口、劫持 app 级行为、编辑器上限明显。
2026-11 重构为「主 profile 右侧栏工具 + CodeMirror 6」，上述机制全部删除。旧设计的完整踩坑
记录（三列布局反查、软换行/选区错位、DSH 版本兼容、prompt 变量等）不再随仓库公开；
本仓库为 1.0.0 重建后的干净历史基线，如需查阅旧版请向维护者索取归档。
