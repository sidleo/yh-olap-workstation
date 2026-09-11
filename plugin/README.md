# dsh-yh-olap-workstation

yh-olap 独立工作站插件（独立项目，不依赖任何外部 yh-olap 仓库）。

## 安装

```bash
dsh plugin --profile <name> add link:<本项目>/plugin
```

## 功能

- OLAP 工作页：库表树 / 收藏 / SQL 编辑器（高亮、补全、多光标、格式化、参数、便签）/ 执行 / 日志 / 结果 / 历史 / 下载
- 三列工作站布局（sidebar 会话选择 | OLAP | 会话），列宽可拖、持久化
- SQL/参数/便签多文件本地持久化（per-session，自动保存），新会话自动恢复
- 模型可用 `olap` 工具操控面板（write/run/stop/state），@olapN 引用标签

## 开发

见项目根 README 与 AGENTS.md。
