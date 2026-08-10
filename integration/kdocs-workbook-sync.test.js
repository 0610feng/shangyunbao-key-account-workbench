'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// 生产 AirScript 文件必须可直接粘贴到 WPS，因此不能包含会被 WPS 2.0
// 运行时误解析的 CommonJS `module` 分支。测试时仅在内存中替换最后的入口。
const productionSource = fs.readFileSync(path.join(__dirname, 'kdocs-workbook-sync.airscript.js'), 'utf8');
const testableSource = productionSource.replace(
  /return runAirScript\(\);\s*$/,
  'return { dateToExcelSerial: dateToExcelSerial, buildMainPlan: buildMainPlan, buildFollowPlan: buildFollowPlan, executeWorkbookSync: executeWorkbookSync };'
);
const {
  dateToExcelSerial,
  buildMainPlan,
  buildFollowPlan,
  executeWorkbookSync
} = Function(testableSource)();

function matrix(rows, columns, value = '') {
  return Array.from({ length: rows }, () => Array.from({ length: columns }, () => value));
}

function ticket(overrides = {}) {
  return {
    id: 'issue-1',
    ticketNo: '20260810001',
    createdAt: '2026-08-10T01:00:00.000Z',
    shopName: '测试门店',
    shopDesc: '测试问题',
    urgency: '紧急',
    assigneeName: '郑康',
    latestFollowUpStatus: '',
    deadline: '2026-08-12',
    completedAt: '',
    latestFollowUpContent: '',
    latestFollowUpAt: '',
    currentStatus: '未跟进',
    ...overrides
  };
}

function followUp(overrides = {}) {
  return {
    followUpId: 'follow-1',
    ticketId: 'issue-1',
    internalId: 'issue-1',
    ticketNo: '20260810001',
    followedAt: '2026-08-10T02:00:00.000Z',
    followerId: 'user-1',
    followerName: '郑康',
    content: '首次跟进',
    status: '跟进中',
    type: 'follow_up',
    fromProgress: '未开始',
    toProgress: '跟进中',
    ...overrides
  };
}

function blankMainSnapshot() {
  return { xy: matrix(1000, 2), cToF: matrix(1000, 4), h: matrix(1000, 1) };
}

function blankFollowSnapshot() {
  return { ab: matrix(2000, 2), dToF: matrix(2000, 3), map: matrix(2001, 14) };
}

// 1) row586 已有永久编号（含历史保留/tombstone）时，绝不能被视为新行。
{
  const snapshot = blankMainSnapshot();
  for (let index = 0; index <= 580; index += 1) {
    snapshot.xy[index] = [`20260801${String(index + 1).padStart(3, '0')}`, dateToExcelSerial('2026-08-01', true)];
  }
  snapshot.xy[580] = ['20260808025', dateToExcelSerial('2026-08-08', true)];
  const plan = buildMainPlan([ticket()], snapshot);
  assert.equal(plan[0].row, 587);
  assert.equal(plan[0].isNew, true);
}

// 2) 同一编号、同一内容重复执行必须保持幂等，不产生写操作。
{
  const snapshot = blankMainSnapshot();
  snapshot.xy[0] = ['20260810001', dateToExcelSerial('2026-08-10', true)];
  snapshot.cToF[0] = ['测试门店', '测试问题', '紧急', '郑康'];
  snapshot.h[0] = [dateToExcelSerial('2026-08-12', true)];
  const plan = buildMainPlan([ticket()], snapshot);
  assert.equal(plan[0].row, 6);
  assert.equal(plan[0].isNew, false);
  assert.equal(plan[0].writeCToF, false);
  assert.equal(plan[0].writeH, false);
}

// 3) 主表满额必须明确失败，不能覆盖历史行。
{
  const snapshot = blankMainSnapshot();
  snapshot.xy.forEach((row, index) => {
    row[0] = `20260101${String((index % 999) + 1).padStart(3, '0')}-${index}`;
    row[1] = dateToExcelSerial('2026-01-01', true);
  });
  assert.throws(() => buildMainPlan([ticket()], snapshot), /MAIN_SHEET_CAPACITY_EXCEEDED/);
}

// 4) 已有跟进ID和完全一致的每日跟进行必须跳过。
{
  const snapshot = blankFollowSnapshot();
  const item = followUp();
  snapshot.ab[0] = [item.ticketNo, dateToExcelSerial(item.followedAt, false)];
  snapshot.dToF[0] = [item.followerName, item.content, item.status];
  snapshot.map[0][2] = item.followUpId;
  snapshot.map[0][12] = 6;
  const plan = buildFollowPlan([item], snapshot);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].kind, 'unchanged');
}

// 5) 完结后再追加“跟进中”即为重开；物理行必须按时间递增，最后一行是重开状态。
{
  const snapshot = blankFollowSnapshot();
  const completed = followUp({ followUpId: 'follow-complete', followedAt: '2026-08-10T03:00:00.000Z', status: '已完结', content: '处理完成' });
  const reopened = followUp({ followUpId: 'follow-reopen', followedAt: '2026-08-10T04:00:00.000Z', status: '跟进中', content: '重新打开' });
  const plan = buildFollowPlan([reopened, completed], snapshot);
  assert.deepEqual(plan.map((item) => item.dailyRow), [6, 7]);
  assert.deepEqual(plan.map((item) => item.followUp.status), ['已完结', '跟进中']);
}

// 6) 早于现有最新行的新记录必须停止，避免 XLOOKUP(-1) 取到错误“最新状态”。
{
  const snapshot = blankFollowSnapshot();
  snapshot.ab[0] = ['20260810001', dateToExcelSerial('2026-08-10T06:00:00.000Z', false)];
  snapshot.dToF[0] = ['郑康', '较晚记录', '跟进中'];
  const earlier = followUp({ followedAt: '2026-08-10T05:00:00.000Z' });
  assert.throws(() => buildFollowPlan([earlier], snapshot), /BACKDATED_FOLLOWUP_REQUIRES_RECONCILIATION/);
}

// 7) 主表/每日跟进恢复保护后才保存；内部映射表必须保护并隐藏。
{
  const events = [];
  const mainSnapshot = blankMainSnapshot();
  mainSnapshot.xy[0] = ['20260810001', dateToExcelSerial('2026-08-10', true)];
  mainSnapshot.cToF[0] = ['测试门店', '测试问题', '紧急', '郑康'];
  mainSnapshot.h[0] = [dateToExcelSerial('2026-08-12', true)];
  const followSnapshot = blankFollowSnapshot();
  function makeSheet(name, protectedState, values) {
    let visibleState = true;
    return {
      ProtectContents: protectedState,
      Unprotect() { events.push(`unprotect:${name}`); },
      Protect() { events.push(`protect:${name}`); },
      get Visible() { return visibleState; },
      set Visible(next) { visibleState = next; events.push(`visible:${name}:${next}`); },
      Range(address) {
        const value = values[address];
        return {
          get Value2() { return value; },
          set Value2(next) { events.push(`write:${name}:${address}:${JSON.stringify(next)}`); },
          Formula: '=TEMPLATE()'
        };
      }
    };
  }
  const sheets = {
    '工单登记与跟进': makeSheet('main', true, {
      'X6:Y1005': mainSnapshot.xy,
      'C6:F1005': mainSnapshot.cToF,
      'H6:H1005': mainSnapshot.h
    }),
    '每日跟进': makeSheet('follow', true, {
      'A6:B2005': followSnapshot.ab,
      'D6:F2005': followSnapshot.dToF
    }),
    '工作台跟进映射': makeSheet('map', false, { 'A5:N2005': followSnapshot.map })
  };
  const application = {
    Worksheets: { Item(name) { return sheets[name]; } },
    ActiveWorkbook: { Save() { events.push('save'); return { result: 'ok' }; } }
  };
  executeWorkbookSync({ schemaVersion: 1, mode: 'incremental', requestId: 'test', tickets: [ticket()], followups: [] }, application);
  assert.equal(events.includes('protect:map'), true);
  assert.equal(events.includes('visible:map:false'), true);
  assert.ok(events.indexOf('save') > events.indexOf('protect:main'));
  assert.ok(events.indexOf('save') > events.indexOf('protect:follow'));
}

// 8) UTC跨日时间必须按北京时间落到正确登记日期，避免编号日期与B/Y列相差一天。
{
  assert.equal(
    dateToExcelSerial('2026-08-09T16:30:00.000Z', true),
    dateToExcelSerial('2026-08-10', true)
  );
}

// 9) 映射已写且 A:B 已写、D:F 尚空时，重试必须恢复同一行而不是冲突或追加。
{
  const snapshot = blankFollowSnapshot();
  const item = followUp();
  snapshot.ab[0] = [item.ticketNo, dateToExcelSerial(item.followedAt, false)];
  snapshot.map[0][2] = item.followUpId;
  snapshot.map[0][12] = 6;
  const plan = buildFollowPlan([item], snapshot);
  assert.equal(plan[0].kind, 'recover');
  assert.equal(plan[0].dailyRow, 6);
}

// 10) 映射已写且 D:F 已写、A:B 尚空时也必须原位恢复。
{
  const snapshot = blankFollowSnapshot();
  const item = followUp();
  snapshot.dToF[0] = [item.followerName, item.content, item.status];
  snapshot.map[0][2] = item.followUpId;
  snapshot.map[0][12] = 6;
  const plan = buildFollowPlan([item], snapshot);
  assert.equal(plan[0].kind, 'recover');
  assert.equal(plan[0].dailyRow, 6);
}

// 11) WPS 以返回值报告保存失败时，脚本必须失败，不能向 Edge 误报成功。
{
  const mainSnapshot = blankMainSnapshot();
  mainSnapshot.xy[0] = ['20260810001', dateToExcelSerial('2026-08-10', true)];
  mainSnapshot.cToF[0] = ['测试门店', '测试问题', '紧急', '郑康'];
  mainSnapshot.h[0] = [dateToExcelSerial('2026-08-12', true)];
  const followSnapshot = blankFollowSnapshot();
  function readOnlySheet(protectedState, values) {
    return {
      ProtectContents: protectedState,
      Unprotect() {}, Protect() {},
      set Visible(next) {},
      Range(address) {
        return { Value2: values[address], Formula: '=TEMPLATE()' };
      }
    };
  }
  const sheets = {
    '工单登记与跟进': readOnlySheet(true, {
      'X6:Y1005': mainSnapshot.xy, 'C6:F1005': mainSnapshot.cToF, 'H6:H1005': mainSnapshot.h
    }),
    '每日跟进': readOnlySheet(true, {
      'A6:B2005': followSnapshot.ab, 'D6:F2005': followSnapshot.dToF
    }),
    '工作台跟进映射': readOnlySheet(false, { 'A5:N2005': followSnapshot.map })
  };
  const application = {
    Worksheets: { Item(name) { return sheets[name]; } },
    ActiveWorkbook: { Save() { return { result: 'SpaceFull' }; } }
  };
  assert.throws(
    () => executeWorkbookSync({ schemaVersion: 1, mode: 'incremental', requestId: 'save-fail', tickets: [ticket()], followups: [] }, application),
    /WORKBOOK_SAVE_FAILED/
  );
}

console.log('kdocs-workbook-sync pure-function tests: 11 passed');
