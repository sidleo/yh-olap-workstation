---
name: yh-olap
description: 永辉 OLAP 工作站取数分析技能：用 olap 模型工具操控 yh-olap 面板写/执行 SQL，sqlkb 知识库先行，引擎选择、SQL 风格与常见坑点。做任何 SQL 相关工作时先看本技能。
---

# yh-olap 工作站 SQL 操作

## 面板与 olap 工具

左侧 yh-olap 面板 = 编辑器（多标签、SQL 补全/多光标/参数 ${} /便签）+ 执行日志/结果/历史/下载 + 左栏四 tab（库表 / 收藏 / 工作区 / 知识库）。
右会话区写中文指令，模型用 `olap` 模型工具操控面板：

- `olap {action: "state"}` — 读当前面板标签与 SQL/运行态
- `olap {action: "write", sql: "…"}` — 写 SQL 到活动标签（`newTab: true` 新建标签）
- `olap {action: "run", engine, dsId, params, lines, timeoutSec}` — 执行（默认引擎=活动标签，可显式指定）
- `olap {action: "stop"}` — 停止运行中的查询
- `sessionId` 可指定目标会话；面板需在页面打开（会话头部 OLAP 按钮呼出）

## 第一步：sqlkb 知识库（硬要求）

写任何 SQL 前先走一遍：`sqlkb_list`（全量清单）→ `sqlkb_search <指标/字段/表名>` → 命中后 `sqlkb_get` 读**示例**（口径/SQL 可复用）再读**表**（字段清单），并留意关联**坑点**。
不命中：探查（DESCRIBE + 抽样）后，坑点用 `sqlkb_create(kind=pitfall, tables=相关表)` 直接记录；新增表/示例需用户同意。

## 引擎选择

| 场景 | engine | 说明 |
|------|--------|------|
| 探查/预览/小表 | 2 impala（默认） | 快；不支持 DDL |
| 大表 JOIN / ETL / DDL | 1 hive | impala 不支持 DDL，一律 hive |
| 超大聚合 | 3 clickhouse | - |
| 其他 | 4 doris | - |

认证失败：先 refresh 确认登录态（账号缓存于 ~/.config/yh_bigdata/accounts.json，6h 有效期）。

## SQL 风格（遵守）

- 前置逗号：`,field2` 而非 `, field2`
- 关键字小写（select/from/where/group by）
- 4 空格缩进；聚合字段单独一行；字段清晰别名；日期变量 `${var}` 占位
- `from` 与表名同行；`inner join`/`left join` 与 `from` 顶格同级；`on` 条件同行可续行
- CTE 优先（impala download 不支持 CTE 时改子查询）
- 文件头模板：标题/日期/引擎/用途/参数 注释块

## 常见坑

- impala 不支持 DDL；CTE 在 download/部分引擎报错 → 改子查询
- 先 LIMIT/小样本预览再全量；写操作（DROP/DELETE/TRUNCATE）先问用户
- 数值异常（波动>±20%）主动排查，不直接报告
