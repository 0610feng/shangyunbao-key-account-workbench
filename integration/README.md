# 客户工作台 → 金山云文档直连

这套联动分成三层，任何密钥都不放在公开网页里：

1. 工作台保存业务数据后，调用 Supabase Edge Function `kdocs-workbook-sync`。
2. Edge Function 使用服务端密钥读取对应成员的完整工单，规范化全部 Excel 契约字段，再调用 WPS AirScript。
3. AirScript 只更新表格允许写入的来源列；公式、保护、驾驶舱、未完结和已完结动态表不改。

## 文件

- `supabase/migrations/202608100001_kdocs_direct_sync.sql`：原子编号、历史序号种子、持久 outbox、幂等同步任务与租约。
- `supabase/functions/kdocs-workbook-sync/index.ts`：鉴权、逐张编号归属核验、默认增量同步、安全补号、重试和错误记录。
- `integration/kdocs-workbook-sync.airscript.js`：粘贴到目标金山文档的 AirScript 编辑器。
- `integration/kdocs-workbook-sync.test.js`：不连接现网的纯函数回归测试。

## 触发格式

默认只同步刚保存的一张工单，速度最快：

```json
{
  "reason": "issue_saved",
  "requestId": "浏览器本次保存的幂等ID",
  "ownerUserId": "工单所属账号UUID",
  "issueId": "工作台内部工单ID"
}
```

缺少 `issueId` 或传入 `"fullSync":true` 时，只同步指定成员（默认当前登录成员）的数据。首次迁移或补漏时，管理员可显式传入 `{"mode":"full"}` 做团队全量 upsert。脚本不会因为工作台缺少记录而删除 Excel 现有行。

## 编号安全闸

编号格式固定为北京时间业务日期 `YYYYMMDD` + 当日三位永久序号。分配记录强制绑定 `ownerUserId + issueId + ticketNo`：浏览器只能用当前登录用户的 `auth.uid()` 分配，且只能分配北京时间当天编号；跨用户传入相同 issueId 不会复用编号。服务端补旧号必须调用显式 owner + issue 的内部 RPC。每位成员每天最多新分配 100 个编号，避免单账号误操作耗尽当日 999 个总容量。

迁移已经按验证备份隐藏 X 列写入 2026-06-04 至 2026-08-08 的历史最大序号，并显式把 2026-08-09、2026-08-10 seed 为 0。正式启用前必须再次核对云表格隐藏 X 列 8/9、8/10 的实际最大序号；若不是 0，先执行：

```sql
-- 下面的 0 必须替换为云表格中当天真实的最大三位序号
select public.seed_ticket_number_counter('2026-08-10', 0, 'verified-cloud-workbook-before-enable');
```

未 seed 的历史日期会明确报 `TICKET_COUNTER_NOT_SEEDED`，不会冒险分配。只有 2026-08-10 之后的新业务日由 RPC 原子创建 `0` 起始计数器。

旧工作台工单缺编号时，Edge Function 仅在 `KDOCS_ALLOW_TICKET_BACKFILL=true` 后，通过 service-role 专用 `allocate_ticket_no_for_owner(owner, issue, createdAt)` 幂等补号，再以数据库局部 JSON 修补写回；默认关闭。调用 WPS 前，Edge 会把每张规范化工单交给 `assert_ticket_number_allocations` 逐张核验；编号无 allocation 或归属错配都会拒绝写入。

## 持久 outbox

`workbench_data` 的工单或归档发生新增、修改、删除时，数据库触发器会自动在 `workbook_sync_outbox` 留下 `owner + issue + revision` 待办。outbox 不复制整包业务数据，也绝不存 WPS 令牌或任何服务端密钥。

- WPS 成功或确认内容未变化：只清除不晚于本次已同步 revision 的对应待办。
- WPS/校验失败：待办保留并记录错误码、时间和尝试次数，便于重试与排查。
- 同步期间如果用户又保存了更新：新 revision 大于本次 revision，不会被旧请求误清除。
- 工作台删除：Excel 历史不删除，但该删除事件会被明确消费并清除对应待办。

当前网页保存后仍会立即调用 Edge Function；outbox 是掉线、浏览器关闭或接口失败时的持久兜底标记。后续可由受控服务端定时任务扫描重试，不能从公开网页读取 outbox。

## 上线顺序（只在备份云文档验证）

1. 复制一份私有金山云文档，确认 10 个 Sheet 名称及公式保护仍在。
2. 在副本的 AirScript 编辑器粘贴脚本并手工测试；生成 Webhook 和脚本令牌。
3. 再次核对云表格 2026-08-09、2026-08-10 隐藏 X 列最大序号，修正 migration 中的 0；然后执行 SQL migration。
4. 把 `.env.example` 中的值作为 Supabase Edge Function Secrets 配置，部署函数。
5. 保持网页功能开关关闭，分别测试新增、重复提交、跟进、完结、重开、容量和异常提示。
6. 验证通过后再打开网页同步功能开关；正式云表格和原始 XLSX 不直接覆盖。

AirScript 写入范围严格限定为：主表 `C,D,E,F,H,X,Y`，每日跟进 `A,B,D,E,F`，以及用于跟进ID去重的 `工作台跟进映射 A:N`。新工单只选择 X/Y 同时为空且可写字段为空的行，因此 row586 等保留编号不会被复用。
