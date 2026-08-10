/*
 * 金山文档 AirScript：把 Supabase Edge Function 传入的增量/全量数据安全写入工单表。
 * 只写：
 *   工单登记与跟进 C,D,E,F,H,X,Y
 *   每日跟进 A,B,D,E,F
 *   工作台跟进映射 A:N（仅作为跟进ID幂等索引）
 *   删除同步时，按工单号清空上述业务区域以及工作台工单/归档映射的对应内容。
 * 删除从不删整行，不写入公式列，不改格式、验证或锁定属性。
 * 绝不写驾驶舱、公式列、当前未完结、已完结等动态结果表。
 */

var CONTRACT = {
  mainSheet: '工单登记与跟进',
  followSheet: '每日跟进',
  followMapSheet: '工作台跟进映射',
  ticketMapSheet: '工作台工单映射',
  archiveMapSheet: '工作台归档映射',
  mainFirstRow: 6,
  mainLastRow: 1005,
  followFirstRow: 6,
  followLastRow: 2005,
  mapFirstRow: 5,
  mapLastRow: 2005,
  businessMapFirstRow: 5,
  businessMapLastRow: 1005,
  urgencies: ['紧急', '高', '普通', '低'],
  followStatuses: ['跟进中', '已完结'],
  requiredTicketFields: [
    'id', 'ticketNo', 'createdAt', 'shopName', 'shopDesc', 'urgency', 'assigneeName',
    'latestFollowUpStatus', 'deadline', 'completedAt', 'latestFollowUpContent',
    'latestFollowUpAt', 'currentStatus'
  ],
  requiredFollowFields: [
    'followUpId', 'ticketId', 'ticketNo', 'followedAt', 'followerId',
    'followerName', 'content', 'status'
  ],
  requiredDeletionFields: [
    'issueId', 'ticketNo', 'ownerUserId', 'deletedAt'
  ]
};

function syncError(code, message) {
  var error = new Error(code + ': ' + message);
  error.code = code;
  return error;
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object || {}, key);
}

function asText(value) {
  return value === null || value === undefined ? '' : String(value);
}

function isBlank(value) {
  return value === null || value === undefined || asText(value).trim() === '';
}

function normalizeMatrix(value, expectedRows, expectedColumns) {
  var source = Array.isArray(value) ? value : [];
  var result = [];
  for (var rowIndex = 0; rowIndex < expectedRows; rowIndex += 1) {
    var sourceRow = Array.isArray(source[rowIndex]) ? source[rowIndex] : [];
    var row = [];
    for (var columnIndex = 0; columnIndex < expectedColumns; columnIndex += 1) {
      row.push(sourceRow[columnIndex] === undefined ? '' : sourceRow[columnIndex]);
    }
    result.push(row);
  }
  return result;
}

function includes(list, value) {
  return list.indexOf(value) >= 0;
}

function validatePayload(payload) {
  if (!payload || typeof payload !== 'object') throw syncError('INVALID_PAYLOAD', '同步参数为空');
  if (payload.schemaVersion !== 1 && payload.schemaVersion !== 2) {
    throw syncError('UNSUPPORTED_SCHEMA_VERSION', '仅支持 schemaVersion=1 或 2');
  }
  if (!Array.isArray(payload.tickets) || !Array.isArray(payload.followups)) {
    throw syncError('INVALID_PAYLOAD_COLLECTIONS', 'tickets 和 followups 必须为数组');
  }
  if (payload.schemaVersion === 2 && !Array.isArray(payload.deletions)) {
    throw syncError('INVALID_PAYLOAD_COLLECTIONS', 'schemaVersion=2 时 deletions 必须为数组');
  }
  if (payload.schemaVersion === 1) {
    if (Array.isArray(payload.deletions) && payload.deletions.length) {
      throw syncError('UNSUPPORTED_DELETION_SCHEMA', '删除同步必须使用 schemaVersion=2');
    }
    payload.deletions = [];
  }
  var ticketNumbers = {};
  var ticketIds = {};
  payload.tickets.forEach(function (ticket) {
    if (!ticket || typeof ticket !== 'object') throw syncError('INVALID_TICKET', '工单记录不是对象');
    CONTRACT.requiredTicketFields.forEach(function (field) {
      if (!hasOwn(ticket, field)) throw syncError('MISSING_TICKET_FIELD', '工单缺少字段 ' + field);
    });
    var ticketNo = asText(ticket.ticketNo).trim();
    var id = asText(ticket.id).trim();
    if (!/^\d{11}$/.test(ticketNo) || ticketNo.slice(-3) === '000') {
      throw syncError('INVALID_TICKET_NO', '工单编号必须是有效的11位编号：' + ticketNo);
    }
    if (!id) throw syncError('MISSING_TICKET_ID', '工单内部ID为空');
    if (ticketNumbers[ticketNo]) throw syncError('DUPLICATE_TICKET_NO', '同步参数含重复工单编号：' + ticketNo);
    ticketNumbers[ticketNo] = true;
    ticketIds[id] = ticketNo;
    if (!asText(ticket.shopName).trim() || !asText(ticket.shopDesc).trim()) {
      throw syncError('MISSING_REQUIRED_TICKET_VALUE', '工单 ' + ticketNo + ' 的门店名称或问题为空');
    }
    if (!includes(CONTRACT.urgencies, asText(ticket.urgency).trim())) {
      throw syncError('INVALID_URGENCY', '工单 ' + ticketNo + ' 的紧急程度不匹配表格');
    }
    if (ticket.deadline && !isFinite(dateToExcelSerial(ticket.deadline, true))) {
      throw syncError('INVALID_DEADLINE', '工单 ' + ticketNo + ' 的计划完成日期无效');
    }
    if (!isFinite(dateToExcelSerial(ticket.createdAt, true))) {
      throw syncError('INVALID_CREATED_AT', '工单 ' + ticketNo + ' 的登记日期无效');
    }
  });

  var followIds = {};
  payload.followups.forEach(function (followUp) {
    if (!followUp || typeof followUp !== 'object') throw syncError('INVALID_FOLLOWUP', '跟进记录不是对象');
    CONTRACT.requiredFollowFields.forEach(function (field) {
      if (!hasOwn(followUp, field)) throw syncError('MISSING_FOLLOWUP_FIELD', '跟进记录缺少字段 ' + field);
    });
    var followUpId = asText(followUp.followUpId).trim();
    var ticketNo = asText(followUp.ticketNo).trim();
    if (!followUpId) throw syncError('MISSING_FOLLOWUP_ID', '跟进ID为空');
    if (followIds[followUpId]) throw syncError('DUPLICATE_FOLLOWUP_ID', '同步参数含重复跟进ID：' + followUpId);
    followIds[followUpId] = true;
    if (!ticketNumbers[ticketNo]) throw syncError('FOLLOWUP_TICKET_NOT_IN_PAYLOAD', '跟进记录关联的工单不在本次参数中：' + ticketNo);
    if (!includes(CONTRACT.followStatuses, asText(followUp.status).trim())) {
      throw syncError('INVALID_FOLLOWUP_STATUS', '跟进状态只能是“跟进中”或“已完结”');
    }
    if (!asText(followUp.followerName).trim() || !asText(followUp.content).trim()) {
      throw syncError('MISSING_FOLLOWUP_VALUE', '跟进人或跟进内容为空');
    }
    if (!isFinite(dateToExcelSerial(followUp.followedAt, false))) {
      throw syncError('INVALID_FOLLOWED_AT', '跟进时间无效：' + followUpId);
    }
    if (hasOwn(followUp, 'sourceDailyRow') && !isBlank(followUp.sourceDailyRow)) {
      var sourceDailyRow = Number(followUp.sourceDailyRow);
      if (!isFinite(sourceDailyRow) || Math.floor(sourceDailyRow) !== sourceDailyRow ||
          sourceDailyRow < CONTRACT.followFirstRow || sourceDailyRow > CONTRACT.followLastRow) {
        throw syncError('INVALID_SOURCE_DAILY_ROW', '历史跟进行号必须在 6-2005 之间：' + followUpId);
      }
    }
  });

  var deletionNumbers = {};
  var deletionIds = {};
  payload.deletions.forEach(function (deletion) {
    if (!deletion || typeof deletion !== 'object') throw syncError('INVALID_DELETION', '删除记录不是对象');
    CONTRACT.requiredDeletionFields.forEach(function (field) {
      if (!hasOwn(deletion, field)) throw syncError('MISSING_DELETION_FIELD', '删除记录缺少字段 ' + field);
    });
    var ticketNo = asText(deletion.ticketNo).trim();
    var issueId = asText(deletion.issueId).trim();
    if (!/^\d{11}$/.test(ticketNo) || ticketNo.slice(-3) === '000') {
      throw syncError('INVALID_TICKET_NO', '删除记录的工单编号无效：' + ticketNo);
    }
    if (!issueId || !asText(deletion.ownerUserId).trim()) {
      throw syncError('MISSING_DELETION_IDENTITY', '删除记录缺少 issueId 或 ownerUserId：' + ticketNo);
    }
    if (!isFinite(dateToExcelSerial(deletion.deletedAt, false))) {
      throw syncError('INVALID_DELETED_AT', '删除时间无效：' + ticketNo);
    }
    if (deletionNumbers[ticketNo] || ticketNumbers[ticketNo]) {
      throw syncError('DUPLICATE_TICKET_NO', '同步参数含重复或同时删除与写入的工单编号：' + ticketNo);
    }
    if (deletionIds[issueId]) throw syncError('DUPLICATE_DELETION_ID', '同步参数含重复删除工单ID：' + issueId);
    deletionNumbers[ticketNo] = true;
    deletionIds[issueId] = true;
  });
  return payload;
}

function dateToExcelSerial(value, dateOnlyMode) {
  if (typeof value === 'number') return isFinite(value) ? value : NaN;
  var input = asText(value).trim();
  if (!input) return NaN;
  var dateMatch = input.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?/);
  if (!dateMatch) return NaN;
  var year = Number(dateMatch[1]);
  var month = Number(dateMatch[2]) - 1;
  var day = Number(dateMatch[3]);
  var hour = Number(dateMatch[4] || 0);
  var minute = Number(dateMatch[5] || 0);
  var second = Number(dateMatch[6] || 0);
  var fraction = dateMatch[7] || '0';
  while (fraction.length < 3) fraction += '0';
  var millis = Number(fraction.slice(0, 3));
  var utcMillis;
  var hasExplicitZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(input);
  if (hasExplicitZone) {
    var parsed = Date.parse(input);
    if (!isFinite(parsed)) return NaN;
    // Excel 单元格不保存时区；统一按北京时间解释。登记日期只保留北京时间日期。
    var shanghaiMillis = parsed + 8 * 60 * 60 * 1000;
    if (dateOnlyMode) {
      var shanghaiDate = new Date(shanghaiMillis);
      utcMillis = Date.UTC(shanghaiDate.getUTCFullYear(), shanghaiDate.getUTCMonth(), shanghaiDate.getUTCDate());
    } else {
      utcMillis = shanghaiMillis;
    }
  } else {
    // 无时区字符串按北京时间“墙上时间”写入，不让脚本服务器时区改变结果。
    utcMillis = Date.UTC(year, month, day, dateOnlyMode ? 0 : hour, dateOnlyMode ? 0 : minute, dateOnlyMode ? 0 : second, dateOnlyMode ? 0 : millis);
  }
  var check = new Date(Date.UTC(year, month, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month || check.getUTCDate() !== day) return NaN;
  return utcMillis / 86400000 + 25569;
}

function valuesEqual(left, right) {
  if (isBlank(left) && isBlank(right)) return true;
  if (typeof left === 'number' || typeof right === 'number') {
    var leftNumber = Number(left);
    var rightNumber = Number(right);
    if (isFinite(leftNumber) && isFinite(rightNumber)) return Math.abs(leftNumber - rightNumber) < 0.000001;
  }
  return asText(left) === asText(right);
}

function rowValuesEqual(current, desired) {
  if (!Array.isArray(current) || current.length !== desired.length) return false;
  for (var index = 0; index < desired.length; index += 1) {
    if (!valuesEqual(current[index], desired[index])) return false;
  }
  return true;
}

function rowIsBlank(row) {
  return (Array.isArray(row) ? row : []).every(isBlank);
}

function addUniqueRow(rows, rowNumber) {
  if (rows.indexOf(rowNumber) < 0) rows.push(rowNumber);
}

function buildDeletionPlan(deletions, snapshot) {
  var mainCount = CONTRACT.mainLastRow - CONTRACT.mainFirstRow + 1;
  var followCount = CONTRACT.followLastRow - CONTRACT.followFirstRow + 1;
  var followMapCount = CONTRACT.mapLastRow - CONTRACT.mapFirstRow + 1;
  var businessMapCount = CONTRACT.businessMapLastRow - CONTRACT.businessMapFirstRow + 1;
  var xy = normalizeMatrix(snapshot.main.xy, mainCount, 2);
  var cToF = normalizeMatrix(snapshot.main.cToF, mainCount, 4);
  var h = normalizeMatrix(snapshot.main.h, mainCount, 1);
  var ab = normalizeMatrix(snapshot.follow.ab, followCount, 2);
  var dToF = normalizeMatrix(snapshot.follow.dToF, followCount, 3);
  var followMap = normalizeMatrix(snapshot.follow.map, followMapCount, 14);
  var ticketMap = normalizeMatrix(snapshot.ticketMap, businessMapCount, 16);
  var archiveMap = normalizeMatrix(snapshot.archiveMap, businessMapCount, 13);
  var mainRowsByTicket = {};

  for (var mainIndex = 0; mainIndex < mainCount; mainIndex += 1) {
    var permanentNo = asText(xy[mainIndex][0]).trim();
    if (!permanentNo) continue;
    if (mainRowsByTicket[permanentNo]) {
      throw syncError('DUPLICATE_WORKBOOK_TICKET_NO', '表格隐藏X列存在重复编号：' + permanentNo);
    }
    mainRowsByTicket[permanentNo] = CONTRACT.mainFirstRow + mainIndex;
  }

  return deletions.map(function (deletion) {
    var ticketNo = asText(deletion.ticketNo).trim();
    var mainRow = mainRowsByTicket[ticketNo] || 0;
    var dailyRows = [];
    var followMapRows = [];
    var ticketMapRows = [];
    var archiveMapRows = [];

    for (var followIndex = 0; followIndex < followCount; followIndex += 1) {
      if (valuesEqual(ab[followIndex][0], ticketNo)) {
        addUniqueRow(dailyRows, CONTRACT.followFirstRow + followIndex);
      }
    }
    for (var mapIndex = 0; mapIndex < followMapCount; mapIndex += 1) {
      if (!valuesEqual(followMap[mapIndex][4], ticketNo)) continue; // E列=工单号
      var mapRowNumber = CONTRACT.mapFirstRow + mapIndex;
      addUniqueRow(followMapRows, mapRowNumber);
      var mappedDailyRow = Number(followMap[mapIndex][12]); // M列=每日跟进行号
      if (isFinite(mappedDailyRow) && mappedDailyRow >= CONTRACT.followFirstRow && mappedDailyRow <= CONTRACT.followLastRow) {
        var mappedDailyTicketNo = asText(ab[mappedDailyRow - CONTRACT.followFirstRow][0]).trim();
        if (mappedDailyTicketNo && mappedDailyTicketNo !== ticketNo) {
          throw syncError('DELETE_FOLLOWUP_MAPPING_CONFLICT', '工单 ' + ticketNo + ' 的跟进映射指向了其他工单行：' + mappedDailyTicketNo);
        }
        addUniqueRow(dailyRows, mappedDailyRow);
      }
    }
    for (var ticketMapIndex = 0; ticketMapIndex < businessMapCount; ticketMapIndex += 1) {
      if (valuesEqual(ticketMap[ticketMapIndex][3], ticketNo)) { // D列=工单号
        addUniqueRow(ticketMapRows, CONTRACT.businessMapFirstRow + ticketMapIndex);
      }
      if (valuesEqual(archiveMap[ticketMapIndex][4], ticketNo)) { // E列=工单号
        addUniqueRow(archiveMapRows, CONTRACT.businessMapFirstRow + ticketMapIndex);
      }
    }
    if (ticketMapRows.length > 1) {
      throw syncError('DUPLICATE_WORKBOOK_TICKET_MAPPING', '工作台工单映射存在重复编号：' + ticketNo);
    }
    if (archiveMapRows.length > 1) {
      throw syncError('DUPLICATE_WORKBOOK_ARCHIVE_MAPPING', '工作台归档映射存在重复编号：' + ticketNo);
    }

    var mainNeedsClear = false;
    if (mainRow) {
      var mainOffset = mainRow - CONTRACT.mainFirstRow;
      mainNeedsClear = !rowIsBlank(xy[mainOffset]) || !rowIsBlank(cToF[mainOffset]) || !isBlank(h[mainOffset][0]);
    }
    var dailyNeedsClear = dailyRows.some(function (rowNumber) {
      var offset = rowNumber - CONTRACT.followFirstRow;
      return !rowIsBlank(ab[offset]) || !rowIsBlank(dToF[offset]);
    });
    var followMapNeedsClear = followMapRows.some(function (rowNumber) {
      return !rowIsBlank(followMap[rowNumber - CONTRACT.mapFirstRow]);
    });
    var ticketMapNeedsClear = ticketMapRows.some(function (rowNumber) {
      return !rowIsBlank(ticketMap[rowNumber - CONTRACT.businessMapFirstRow]);
    });
    var archiveMapNeedsClear = archiveMapRows.some(function (rowNumber) {
      return !rowIsBlank(archiveMap[rowNumber - CONTRACT.businessMapFirstRow]);
    });

    return {
      deletion: deletion,
      ticketNo: ticketNo,
      mainRow: mainRow,
      dailyRows: dailyRows.sort(function (a, b) { return a - b; }),
      followMapRows: followMapRows.sort(function (a, b) { return a - b; }),
      ticketMapRows: ticketMapRows,
      archiveMapRows: archiveMapRows,
      mainNeedsClear: mainNeedsClear,
      dailyNeedsClear: dailyNeedsClear,
      followMapNeedsClear: followMapNeedsClear,
      ticketMapNeedsClear: ticketMapNeedsClear,
      archiveMapNeedsClear: archiveMapNeedsClear,
      willClear: mainNeedsClear || dailyNeedsClear || followMapNeedsClear || ticketMapNeedsClear || archiveMapNeedsClear
    };
  });
}

function blankMatrixRow(matrix, offset) {
  if (!matrix || !matrix[offset]) return;
  for (var index = 0; index < matrix[offset].length; index += 1) matrix[offset][index] = '';
}

function applyDeletionPlanToSnapshot(deletePlan, snapshot) {
  deletePlan.forEach(function (operation) {
    if (operation.mainRow) {
      var mainOffset = operation.mainRow - CONTRACT.mainFirstRow;
      blankMatrixRow(snapshot.main.xy, mainOffset);
      blankMatrixRow(snapshot.main.cToF, mainOffset);
      blankMatrixRow(snapshot.main.h, mainOffset);
    }
    operation.dailyRows.forEach(function (rowNumber) {
      var followOffset = rowNumber - CONTRACT.followFirstRow;
      blankMatrixRow(snapshot.follow.ab, followOffset);
      blankMatrixRow(snapshot.follow.dToF, followOffset);
    });
    operation.followMapRows.forEach(function (rowNumber) {
      blankMatrixRow(snapshot.follow.map, rowNumber - CONTRACT.mapFirstRow);
    });
    operation.ticketMapRows.forEach(function (rowNumber) {
      blankMatrixRow(snapshot.ticketMap, rowNumber - CONTRACT.businessMapFirstRow);
    });
    operation.archiveMapRows.forEach(function (rowNumber) {
      blankMatrixRow(snapshot.archiveMap, rowNumber - CONTRACT.businessMapFirstRow);
    });
  });
  return snapshot;
}

function buildMainPlan(tickets, snapshot) {
  var first = CONTRACT.mainFirstRow;
  var count = CONTRACT.mainLastRow - first + 1;
  var xy = normalizeMatrix(snapshot.xy, count, 2);
  var cToF = normalizeMatrix(snapshot.cToF, count, 4);
  var h = normalizeMatrix(snapshot.h, count, 1);
  var ticketRows = {};
  var freeRows = [];

  for (var index = 0; index < count; index += 1) {
    var rowNumber = first + index;
    var permanentNo = asText(xy[index][0]).trim();
    var permanentDate = xy[index][1];
    if (permanentNo) {
      if (ticketRows[permanentNo]) throw syncError('DUPLICATE_WORKBOOK_TICKET_NO', '表格隐藏X列存在重复编号：' + permanentNo);
      ticketRows[permanentNo] = rowNumber;
      continue;
    }
    // X/Y 同时为空是新行的必要条件；再确认可写字段也为空，避免覆盖人工未完成录入。
    var editableBlank = cToF[index].every(isBlank) && isBlank(h[index][0]);
    if (isBlank(permanentDate) && editableBlank) freeRows.push(rowNumber);
  }

  var operations = [];
  var sortedTickets = tickets.slice().sort(function (a, b) {
    return asText(a.ticketNo).localeCompare(asText(b.ticketNo));
  });
  sortedTickets.forEach(function (ticket) {
    var ticketNo = asText(ticket.ticketNo).trim();
    var rowNumber = ticketRows[ticketNo];
    var isNew = !rowNumber;
    if (!rowNumber) {
      if (!freeRows.length) throw syncError('MAIN_SHEET_CAPACITY_EXCEEDED', '工单登记与跟进已无可用行（6-1005）');
      rowNumber = freeRows.shift();
      ticketRows[ticketNo] = rowNumber;
    }
    var offset = rowNumber - first;
    var desiredCToF = [ticket.shopName, ticket.shopDesc, ticket.urgency, ticket.assigneeName];
    var desiredH = ticket.deadline ? dateToExcelSerial(ticket.deadline, true) : '';
    operations.push({
      row: rowNumber,
      ticket: ticket,
      isNew: isNew,
      writePermanent: isNew,
      permanentValues: [ticketNo, dateToExcelSerial(ticket.createdAt, true)],
      writeCToF: isNew || !rowValuesEqual(cToF[offset], desiredCToF),
      cToFValues: desiredCToF,
      writeH: isNew || !valuesEqual(h[offset][0], desiredH),
      hValue: desiredH
    });
  });
  return operations;
}

function dailyRowBlank(row) {
  return isBlank(row.a) && isBlank(row.b) && isBlank(row.d) && isBlank(row.e) && isBlank(row.f);
}

function dailyRowMatches(row, followUp) {
  return valuesEqual(row.a, followUp.ticketNo) &&
    valuesEqual(row.b, dateToExcelSerial(followUp.followedAt, false)) &&
    valuesEqual(row.d, followUp.followerName) &&
    valuesEqual(row.e, followUp.content) &&
    valuesEqual(row.f, followUp.status);
}

function dailyRowMatchesHistoricalSource(row, followUp) {
  var sourceStatusWasBlank = hasOwn(followUp, 'sourceFollowUpStatus') &&
    isBlank(followUp.sourceFollowUpStatus) && followUp.status === '跟进中';
  return valuesEqual(row.a, followUp.ticketNo) &&
    valuesEqual(row.b, dateToExcelSerial(followUp.followedAt, false)) &&
    valuesEqual(row.d, followUp.followerName) &&
    valuesEqual(row.e, followUp.content) &&
    (valuesEqual(row.f, followUp.status) || (sourceStatusWasBlank && isBlank(row.f)));
}

function isOfflinePreviewMappingRow(row, dailyRow) {
  return asText(row[0]).trim() === '待确认' &&
    /^MIG-FU-\d+$/.test(asText(row[2]).trim()) &&
    /^MIG-/.test(asText(row[3]).trim()) &&
    Number(row[12]) === Number(dailyRow) &&
    asText(row[13]).trim() === '通过';
}

function dailyRowCompatiblePartial(row, followUp) {
  var expected = {
    a: followUp.ticketNo,
    b: dateToExcelSerial(followUp.followedAt, false),
    d: followUp.followerName,
    e: followUp.content,
    f: followUp.status
  };
  return ['a', 'b', 'd', 'e', 'f'].every(function (key) {
    return isBlank(row[key]) || valuesEqual(row[key], expected[key]);
  });
}

function buildFollowPlan(followups, snapshot) {
  var followCount = CONTRACT.followLastRow - CONTRACT.followFirstRow + 1;
  var mapCount = CONTRACT.mapLastRow - CONTRACT.mapFirstRow + 1;
  var ab = normalizeMatrix(snapshot.ab, followCount, 2);
  var dToF = normalizeMatrix(snapshot.dToF, followCount, 3);
  var map = normalizeMatrix(snapshot.map, mapCount, 14);
  var daily = [];
  var latestByTicket = {};
  var lastDailyRow = CONTRACT.followFirstRow - 1;
  var lastMapRow = CONTRACT.mapFirstRow - 1;
  var mappingById = {};
  var mappingByDailyRow = {};
  var offlinePreviewByDailyRow = {};

  for (var index = 0; index < followCount; index += 1) {
    var rowNumber = CONTRACT.followFirstRow + index;
    var row = { a: ab[index][0], b: ab[index][1], d: dToF[index][0], e: dToF[index][1], f: dToF[index][2] };
    daily.push(row);
    if (!dailyRowBlank(row)) {
      lastDailyRow = rowNumber;
      var ticketNo = asText(row.a).trim();
      var followedAt = Number(row.b);
      if (ticketNo && isFinite(followedAt)) latestByTicket[ticketNo] = Math.max(latestByTicket[ticketNo] || 0, followedAt);
    }
  }
  for (var mapIndex = 0; mapIndex < mapCount; mapIndex += 1) {
    var mapRowNumber = CONTRACT.mapFirstRow + mapIndex;
    if (map[mapIndex].some(function (value) { return !isBlank(value); })) lastMapRow = mapRowNumber;
    var followUpId = asText(map[mapIndex][2]).trim(); // C列
    if (!followUpId) continue;
    if (mappingById[followUpId]) throw syncError('DUPLICATE_FOLLOWUP_MAPPING', '跟进映射表存在重复ID：' + followUpId);
    var mappedDailyRow = Number(map[mapIndex][12]); // M列
    if (isFinite(mappedDailyRow) && mappedDailyRow >= CONTRACT.followFirstRow && mappedDailyRow <= CONTRACT.followLastRow) {
      var mappedFollowUpId = mappingByDailyRow[mappedDailyRow];
      if (mappedFollowUpId && mappedFollowUpId !== followUpId) {
        throw syncError('DUPLICATE_DAILY_ROW_MAPPING', '每日跟进第 ' + mappedDailyRow + ' 行已映射到多个跟进ID');
      }
      mappingByDailyRow[mappedDailyRow] = followUpId;
      if (isOfflinePreviewMappingRow(map[mapIndex], mappedDailyRow)) {
        offlinePreviewByDailyRow[mappedDailyRow] = {
          followUpId: followUpId,
          mapRow: mapRowNumber,
          ticketNo: asText(map[mapIndex][4]).trim()
        };
      }
    }
    mappingById[followUpId] = {
      mapRow: mapRowNumber,
      dailyRow: mappedDailyRow
    };
  }

  var operations = [];
  var sorted = followups.slice().sort(function (a, b) {
    return asText(a.followedAt).localeCompare(asText(b.followedAt)) ||
      asText(a.followUpId).localeCompare(asText(b.followUpId));
  });
  sorted.forEach(function (followUp) {
    var followUpId = asText(followUp.followUpId).trim();
    var mapped = mappingById[followUpId];
    if (mapped) {
      if (!isFinite(mapped.dailyRow) || mapped.dailyRow < CONTRACT.followFirstRow || mapped.dailyRow > CONTRACT.followLastRow) {
        throw syncError('INVALID_FOLLOWUP_MAPPING_ROW', '跟进ID ' + followUpId + ' 映射到无效行');
      }
      if (hasOwn(followUp, 'sourceDailyRow') && !isBlank(followUp.sourceDailyRow) &&
          Number(followUp.sourceDailyRow) !== mapped.dailyRow) {
        throw syncError('FOLLOWUP_SOURCE_ROW_MAPPING_CONFLICT', '跟进ID ' + followUpId + ' 的来源行与既有映射行不一致');
      }
      var existing = daily[mapped.dailyRow - CONTRACT.followFirstRow];
      if (dailyRowMatches(existing, followUp) || dailyRowMatchesHistoricalSource(existing, followUp)) {
        operations.push({ kind: 'unchanged', followUp: followUp, dailyRow: mapped.dailyRow, mapRow: mapped.mapRow });
        return;
      }
      if (!dailyRowCompatiblePartial(existing, followUp)) {
        throw syncError('FOLLOWUP_MAPPING_CONFLICT', '跟进ID ' + followUpId + ' 的表格行与同步内容不一致');
      }
      operations.push({ kind: 'recover', followUp: followUp, dailyRow: mapped.dailyRow, mapRow: mapped.mapRow });
      daily[mapped.dailyRow - CONTRACT.followFirstRow] = {
        a: followUp.ticketNo, b: dateToExcelSerial(followUp.followedAt, false),
        d: followUp.followerName, e: followUp.content, f: followUp.status
      };
      return;
    }

    if (hasOwn(followUp, 'sourceDailyRow') && !isBlank(followUp.sourceDailyRow)) {
      var sourceDailyRow = Number(followUp.sourceDailyRow);
      var existingFollowUpId = mappingByDailyRow[sourceDailyRow];
      if (existingFollowUpId && existingFollowUpId !== followUpId) {
        var offlinePreview = offlinePreviewByDailyRow[sourceDailyRow];
        var canReplaceOfflinePreview = offlinePreview &&
          offlinePreview.followUpId === existingFollowUpId &&
          offlinePreview.ticketNo === asText(followUp.ticketNo).trim();
        if (!canReplaceOfflinePreview) {
          throw syncError('FOLLOWUP_RECONCILIATION_ROW_CONFLICT', '每日跟进第 ' + sourceDailyRow + ' 行已映射到其他跟进ID');
        }
        var offlineSourceDaily = daily[sourceDailyRow - CONTRACT.followFirstRow];
        if (!dailyRowMatchesHistoricalSource(offlineSourceDaily, followUp)) {
          throw syncError('FOLLOWUP_RECONCILIATION_MISMATCH', '跟进ID ' + followUpId + ' 与每日跟进第 ' + sourceDailyRow + ' 行内容不一致');
        }
        delete mappingById[existingFollowUpId];
        mappingById[followUpId] = { mapRow: offlinePreview.mapRow, dailyRow: sourceDailyRow };
        mappingByDailyRow[sourceDailyRow] = followUpId;
        delete offlinePreviewByDailyRow[sourceDailyRow];
        operations.push({ kind: 'reconcile', followUp: followUp, dailyRow: sourceDailyRow, mapRow: offlinePreview.mapRow });
        return;
      }
      var sourceDaily = daily[sourceDailyRow - CONTRACT.followFirstRow];
      if (!dailyRowMatchesHistoricalSource(sourceDaily, followUp)) {
        throw syncError('FOLLOWUP_RECONCILIATION_MISMATCH', '跟进ID ' + followUpId + ' 与每日跟进第 ' + sourceDailyRow + ' 行内容不一致');
      }
      var reconciliationMapRow = lastMapRow + 1;
      if (reconciliationMapRow > CONTRACT.mapLastRow) {
        throw syncError('FOLLOW_MAP_CAPACITY_EXCEEDED', '工作台跟进映射已无可用行（5-2005）');
      }
      lastMapRow = reconciliationMapRow;
      mappingById[followUpId] = { mapRow: reconciliationMapRow, dailyRow: sourceDailyRow };
      mappingByDailyRow[sourceDailyRow] = followUpId;
      operations.push({ kind: 'reconcile', followUp: followUp, dailyRow: sourceDailyRow, mapRow: reconciliationMapRow });
      return;
    }

    var serial = dateToExcelSerial(followUp.followedAt, false);
    var latest = latestByTicket[followUp.ticketNo] || 0;
    if (latest && serial + 0.000001 < latest) {
      throw syncError('BACKDATED_FOLLOWUP_REQUIRES_RECONCILIATION', '工单 ' + followUp.ticketNo + ' 有早于现有最新记录的新增跟进，已停止以防最新状态被覆盖');
    }
    var nextDailyRow = lastDailyRow + 1;
    while (mappingByDailyRow[nextDailyRow] && nextDailyRow <= CONTRACT.followLastRow) nextDailyRow += 1;
    var nextMapRow = lastMapRow + 1;
    if (nextDailyRow > CONTRACT.followLastRow) throw syncError('FOLLOW_SHEET_CAPACITY_EXCEEDED', '每日跟进已无可用行（6-2005）');
    if (nextMapRow > CONTRACT.mapLastRow) throw syncError('FOLLOW_MAP_CAPACITY_EXCEEDED', '工作台跟进映射已无可用行（5-2005）');
    lastDailyRow = nextDailyRow;
    lastMapRow = nextMapRow;
    latestByTicket[followUp.ticketNo] = Math.max(latest, serial);
    mappingById[followUpId] = { mapRow: nextMapRow, dailyRow: nextDailyRow };
    mappingByDailyRow[nextDailyRow] = followUpId;
    operations.push({ kind: 'append', followUp: followUp, dailyRow: nextDailyRow, mapRow: nextMapRow });
  });
  return operations;
}

function cellAddress(column, row) {
  return column + String(row);
}

function assertMainFormulaTemplate(sheet, row, contextLabel) {
  ['A', 'B', 'G', 'I', 'J', 'K', 'L'].forEach(function (column) {
    var formula = asText(sheet.Range(cellAddress(column, row)).Formula);
    if (formula.charAt(0) !== '=') {
      throw syncError('MAIN_TEMPLATE_FORMULA_MISSING', (contextLabel || '工单目标行') + ' ' + row + ' 的公式列 ' + column + ' 缺失');
    }
  });
}

function assertDailyFormulaTemplate(sheet, row) {
  var formula = asText(sheet.Range(cellAddress('C', row)).Formula);
  if (formula.charAt(0) !== '=') {
    throw syncError('FOLLOW_TEMPLATE_FORMULA_MISSING', '删除工单关联的每日跟进行 ' + row + ' 的公式列 C 缺失');
  }
}

function getOptionalWorksheet(application, name) {
  try {
    return application.Worksheets.Item(name) || null;
  } catch (error) {
    return null;
  }
}

function readWorkbookSnapshot(mainSheet, followSheet, mapSheet, ticketMapSheet, archiveMapSheet) {
  return {
    main: {
      xy: mainSheet.Range('X6:Y1005').Value2,
      cToF: mainSheet.Range('C6:F1005').Value2,
      h: mainSheet.Range('H6:H1005').Value2
    },
    follow: {
      ab: followSheet.Range('A6:B2005').Value2,
      dToF: followSheet.Range('D6:F2005').Value2,
      map: mapSheet.Range('A5:N2005').Value2
    },
    ticketMap: ticketMapSheet ? ticketMapSheet.Range('A5:P1005').Value2 : [],
    archiveMap: archiveMapSheet ? archiveMapSheet.Range('A5:M1005').Value2 : []
  };
}

function blankRowValues(columnCount) {
  var row = [];
  for (var index = 0; index < columnCount; index += 1) row.push('');
  return [row];
}

function writeDeletionOperation(mainSheet, followSheet, mapSheet, ticketMapSheet, archiveMapSheet, operation) {
  if (operation.mainRow) {
    mainSheet.Range('C' + operation.mainRow + ':F' + operation.mainRow).Value2 = blankRowValues(4);
    mainSheet.Range('H' + operation.mainRow).Value2 = '';
    mainSheet.Range('X' + operation.mainRow + ':Y' + operation.mainRow).Value2 = blankRowValues(2);
  }
  operation.dailyRows.forEach(function (rowNumber) {
    followSheet.Range('A' + rowNumber + ':B' + rowNumber).Value2 = blankRowValues(2);
    followSheet.Range('D' + rowNumber + ':F' + rowNumber).Value2 = blankRowValues(3);
  });
  operation.followMapRows.forEach(function (rowNumber) {
    mapSheet.Range('A' + rowNumber + ':N' + rowNumber).Value2 = blankRowValues(14);
  });
  if (ticketMapSheet) {
    operation.ticketMapRows.forEach(function (rowNumber) {
      ticketMapSheet.Range('A' + rowNumber + ':P' + rowNumber).Value2 = blankRowValues(16);
    });
  }
  if (archiveMapSheet) {
    operation.archiveMapRows.forEach(function (rowNumber) {
      archiveMapSheet.Range('A' + rowNumber + ':M' + rowNumber).Value2 = blankRowValues(13);
    });
  }
}

function writeMainOperation(sheet, operation) {
  var row = operation.row;
  // 永久编号先写；若后续链路中断，重试会按X列找到同一行，绝不生成第二条。
  if (operation.writePermanent) sheet.Range('X' + row + ':Y' + row).Value2 = [operation.permanentValues];
  if (operation.writeCToF) sheet.Range('C' + row + ':F' + row).Value2 = [operation.cToFValues];
  if (operation.writeH) sheet.Range('H' + row).Value2 = operation.hValue;
}

function mappingValues(operation) {
  var followUp = operation.followUp;
  return [[
    '已同步',
    '在线直连',
    followUp.followUpId,
    followUp.internalId || followUp.ticketId,
    followUp.ticketNo,
    followUp.type || 'follow_up',
    followUp.content,
    followUp.fromProgress || '',
    followUp.toProgress || followUp.status,
    followUp.followerName,
    followUp.followerId || '',
    dateToExcelSerial(followUp.followedAt, false),
    operation.dailyRow,
    '通过'
  ]];
}

function writeFollowOperation(followSheet, mapSheet, operation) {
  if (operation.kind === 'unchanged') return;
  var followUp = operation.followUp;
  if (operation.kind === 'append' || operation.kind === 'reconcile') {
    // 新增时映射先落盘；历史对账只补映射，绝不改动已核验的每日跟进行。
    mapSheet.Range('A' + operation.mapRow + ':N' + operation.mapRow).Value2 = mappingValues(operation);
  }
  if (operation.kind === 'reconcile') return;
  followSheet.Range('A' + operation.dailyRow + ':B' + operation.dailyRow).Value2 = [[
    followUp.ticketNo,
    dateToExcelSerial(followUp.followedAt, false)
  ]];
  followSheet.Range('D' + operation.dailyRow + ':F' + operation.dailyRow).Value2 = [[
    followUp.followerName,
    followUp.content,
    followUp.status
  ]];
}

function protectLikeBefore(sheet, wasProtected) {
  if (wasProtected) sheet.Protect();
}

function assertWorkbookSaved(saveResponse, verifyRuntimeWrite) {
  // AirScript 2.0（Beta）当前可能不返回1.0文档中的Save结果；此时必须逐项回读验证，
  // 确认运行时已接收全部写入后，才依赖2.0在脚本结束时的自动持久化。
  if (saveResponse === undefined || saveResponse === null || saveResponse === '') {
    verifyRuntimeWrite();
    return 'runtime-autosave-verified';
  }
  var response = saveResponse;
  if (typeof response === 'string') {
    try { response = JSON.parse(response); } catch (error) { response = { result: response }; }
  }
  var result = asText(response && typeof response === 'object' ? (response.result || response.status) : response).trim();
  if (result === 'ok' || result === 'nochange') return;
  throw syncError('WORKBOOK_SAVE_FAILED', '云表保存失败：' + (result || '未返回保存确认'));
}

function oneRowValues(range, expectedColumns) {
  var value = range.Value2;
  if (!Array.isArray(value)) return expectedColumns === 1 ? [value] : [];
  if (Array.isArray(value[0])) return normalizeMatrix(value, 1, expectedColumns)[0];
  return normalizeMatrix([value], 1, expectedColumns)[0];
}

function markDeletionPlanReuse(deletePlan, mainPlan, followPlan) {
  deletePlan.forEach(function (operation) {
    operation.mainReused = mainPlan.some(function (mainOperation) {
      return operation.mainRow && mainOperation.row === operation.mainRow;
    });
    operation.dailyRowsReused = {};
    operation.followMapRowsReused = {};
    followPlan.forEach(function (followOperation) {
      if (operation.dailyRows.indexOf(followOperation.dailyRow) >= 0) {
        operation.dailyRowsReused[followOperation.dailyRow] = true;
      }
      if (operation.followMapRows.indexOf(followOperation.mapRow) >= 0) {
        operation.followMapRowsReused[followOperation.mapRow] = true;
      }
    });
  });
}

function verifyDeletionWrites(mainSheet, followSheet, mapSheet, ticketMapSheet, archiveMapSheet, deletePlan) {
  var verified = 0;
  deletePlan.forEach(function (operation) {
    if (operation.mainRow) {
      assertMainFormulaTemplate(mainSheet, operation.mainRow, '删除工单目标行');
      var mainNumberAndDate = oneRowValues(mainSheet.Range('X' + operation.mainRow + ':Y' + operation.mainRow), 2);
      if (valuesEqual(mainNumberAndDate[0], operation.ticketNo)) {
        throw syncError('DELETE_VERIFICATION_FAILED', '工单 ' + operation.ticketNo + ' 仍存在于主表隐藏编号列');
      }
      if (!operation.mainReused) {
        if (!rowIsBlank(mainNumberAndDate) ||
            !rowIsBlank(oneRowValues(mainSheet.Range('C' + operation.mainRow + ':F' + operation.mainRow), 4)) ||
            !isBlank(oneRowValues(mainSheet.Range('H' + operation.mainRow), 1)[0])) {
          throw syncError('DELETE_VERIFICATION_FAILED', '工单 ' + operation.ticketNo + ' 的主表业务字段未完全清空');
        }
      }
    }
    operation.dailyRows.forEach(function (rowNumber) {
      assertDailyFormulaTemplate(followSheet, rowNumber);
      var ab = oneRowValues(followSheet.Range('A' + rowNumber + ':B' + rowNumber), 2);
      if (valuesEqual(ab[0], operation.ticketNo)) {
        throw syncError('DELETE_VERIFICATION_FAILED', '工单 ' + operation.ticketNo + ' 仍存在于每日跟进第 ' + rowNumber + ' 行');
      }
      if (!operation.dailyRowsReused[rowNumber] &&
          (!rowIsBlank(ab) || !rowIsBlank(oneRowValues(followSheet.Range('D' + rowNumber + ':F' + rowNumber), 3)))) {
        throw syncError('DELETE_VERIFICATION_FAILED', '工单 ' + operation.ticketNo + ' 的每日跟进内容未完全清空');
      }
    });
    operation.followMapRows.forEach(function (rowNumber) {
      var mapValues = oneRowValues(mapSheet.Range('A' + rowNumber + ':N' + rowNumber), 14);
      if (valuesEqual(mapValues[4], operation.ticketNo)) {
        throw syncError('DELETE_VERIFICATION_FAILED', '工单 ' + operation.ticketNo + ' 仍存在于跟进映射表');
      }
      if (!operation.followMapRowsReused[rowNumber] && !rowIsBlank(mapValues)) {
        throw syncError('DELETE_VERIFICATION_FAILED', '工单 ' + operation.ticketNo + ' 的跟进映射内容未完全清空');
      }
    });
    if (ticketMapSheet) {
      operation.ticketMapRows.forEach(function (rowNumber) {
        if (!rowIsBlank(oneRowValues(ticketMapSheet.Range('A' + rowNumber + ':P' + rowNumber), 16))) {
          throw syncError('DELETE_VERIFICATION_FAILED', '工单 ' + operation.ticketNo + ' 的工单映射内容未完全清空');
        }
      });
    }
    if (archiveMapSheet) {
      operation.archiveMapRows.forEach(function (rowNumber) {
        if (!rowIsBlank(oneRowValues(archiveMapSheet.Range('A' + rowNumber + ':M' + rowNumber), 13))) {
          throw syncError('DELETE_VERIFICATION_FAILED', '工单 ' + operation.ticketNo + ' 的归档映射内容未完全清空');
        }
      });
    }
    verified += 1;
  });
  return verified;
}

function verifyWorkbookWrites(mainSheet, followSheet, mapSheet, mainPlan, followPlan) {
  mainPlan.forEach(function (operation) {
    var row = operation.row;
    var permanentReadback = oneRowValues(mainSheet.Range('X' + row + ':Y' + row), 2);
    if (!valuesEqual(permanentReadback[0], operation.permanentValues[0]) ||
        (operation.writePermanent && !valuesEqual(permanentReadback[1], operation.permanentValues[1]))) {
      throw syncError('WRITE_VERIFICATION_FAILED', '工单 ' + operation.ticket.ticketNo + ' 的永久编号或日期回读不一致');
    }
    if (!rowValuesEqual(oneRowValues(mainSheet.Range('C' + row + ':F' + row), 4), operation.cToFValues)) {
      throw syncError('WRITE_VERIFICATION_FAILED', '工单 ' + operation.ticket.ticketNo + ' 的来源字段回读不一致');
    }
    if (!valuesEqual(oneRowValues(mainSheet.Range('H' + row), 1)[0], operation.hValue)) {
      throw syncError('WRITE_VERIFICATION_FAILED', '工单 ' + operation.ticket.ticketNo + ' 的计划完成时间回读不一致');
    }
  });
  followPlan.forEach(function (operation) {
    var followUp = operation.followUp;
    var dailyAB = oneRowValues(followSheet.Range('A' + operation.dailyRow + ':B' + operation.dailyRow), 2);
    var dailyDToF = oneRowValues(followSheet.Range('D' + operation.dailyRow + ':F' + operation.dailyRow), 3);
    if (!rowValuesEqual(dailyAB, [
      followUp.ticketNo, dateToExcelSerial(followUp.followedAt, false)
    ])) {
      throw syncError('WRITE_VERIFICATION_FAILED', '跟进 ' + followUp.followUpId + ' 的编号或时间回读不一致');
    }
    var dailyReadback = {
      a: dailyAB[0], b: dailyAB[1], d: dailyDToF[0], e: dailyDToF[1], f: dailyDToF[2]
    };
    var dailyReadbackMatches = (operation.kind === 'reconcile' || operation.kind === 'unchanged')
      ? dailyRowMatchesHistoricalSource(dailyReadback, followUp)
      : dailyRowMatches(dailyReadback, followUp);
    if (!dailyReadbackMatches) {
      throw syncError('WRITE_VERIFICATION_FAILED', '跟进 ' + followUp.followUpId + ' 的内容回读不一致');
    }
    if (!valuesEqual(oneRowValues(mapSheet.Range('C' + operation.mapRow), 1)[0], followUp.followUpId) ||
        !valuesEqual(oneRowValues(mapSheet.Range('M' + operation.mapRow), 1)[0], operation.dailyRow)) {
      throw syncError('WRITE_VERIFICATION_FAILED', '跟进 ' + followUp.followUpId + ' 的幂等映射回读不一致');
    }
  });
  if (mainSheet.ProtectContents === false || followSheet.ProtectContents === false || mapSheet.ProtectContents === false) {
    throw syncError('PROTECTION_VERIFICATION_FAILED', '来源表或内部映射表未恢复保护');
  }
  // WPS 2.0 可能以 false、0 或 xlSheetHidden 枚举返回隐藏状态；只把明确 true 判为未隐藏。
  if (mapSheet.Visible === true) throw syncError('PROTECTION_VERIFICATION_FAILED', '内部跟进映射表未隐藏');
}

function executeWorkbookSync(payload, application) {
  validatePayload(payload);
  var mainSheet = application.Worksheets.Item(CONTRACT.mainSheet);
  var followSheet = application.Worksheets.Item(CONTRACT.followSheet);
  var mapSheet = application.Worksheets.Item(CONTRACT.followMapSheet);
  var ticketMapSheet = getOptionalWorksheet(application, CONTRACT.ticketMapSheet);
  var archiveMapSheet = getOptionalWorksheet(application, CONTRACT.archiveMapSheet);
  if (!mainSheet || !followSheet || !mapSheet) throw syncError('WORKBOOK_CONTRACT_MISSING', '缺少必要工作表');

  var snapshot = readWorkbookSnapshot(mainSheet, followSheet, mapSheet, ticketMapSheet, archiveMapSheet);
  var deletePlan = buildDeletionPlan(payload.deletions, snapshot);
  // 先在快照中虚拟清空，使同一批次的新工单可安全复用刚释放的行。
  applyDeletionPlanToSnapshot(deletePlan, snapshot);
  var mainPlan = buildMainPlan(payload.tickets, snapshot.main);
  var followPlan = buildFollowPlan(payload.followups, snapshot.follow);
  markDeletionPlanReuse(deletePlan, mainPlan, followPlan);
  deletePlan.forEach(function (operation) {
    if (operation.mainRow) assertMainFormulaTemplate(mainSheet, operation.mainRow, '删除工单目标行');
    operation.dailyRows.forEach(function (rowNumber) { assertDailyFormulaTemplate(followSheet, rowNumber); });
  });
  mainPlan.filter(function (operation) { return operation.isNew; }).forEach(function (operation) {
    assertMainFormulaTemplate(mainSheet, operation.row, '新工单目标行');
  });

  var mainWasProtected = mainSheet.ProtectContents !== false;
  var followWasProtected = followSheet.ProtectContents !== false;
  var mapWasProtected = mapSheet.ProtectContents === true;
  var ticketMapWasProtected = ticketMapSheet && ticketMapSheet.ProtectContents === true;
  var archiveMapWasProtected = archiveMapSheet && archiveMapSheet.ProtectContents === true;
  var writeError = null;
  var protectionError = null;
  var deletionsVerified = 0;
  try {
    if (mainWasProtected) mainSheet.Unprotect();
    if (followWasProtected) followSheet.Unprotect();
    if (mapWasProtected) mapSheet.Unprotect();
    if (ticketMapWasProtected) ticketMapSheet.Unprotect();
    if (archiveMapWasProtected) archiveMapSheet.Unprotect();
    // 实际写入也先删除后新增；不删整行，只把指定业务单元格设为空值。
    deletePlan.forEach(function (operation) {
      writeDeletionOperation(mainSheet, followSheet, mapSheet, ticketMapSheet, archiveMapSheet, operation);
    });
    mainPlan.forEach(function (operation) { writeMainOperation(mainSheet, operation); });
    followPlan.forEach(function (operation) { writeFollowOperation(followSheet, mapSheet, operation); });
  } catch (error) {
    writeError = error;
  } finally {
    try { protectLikeBefore(mainSheet, mainWasProtected); } catch (error) { protectionError = protectionError || error; }
    try { protectLikeBefore(followSheet, followWasProtected); } catch (error) { protectionError = protectionError || error; }
    try { if (ticketMapSheet) protectLikeBefore(ticketMapSheet, ticketMapWasProtected); } catch (error) { protectionError = protectionError || error; }
    try { if (archiveMapSheet) protectLikeBefore(archiveMapSheet, archiveMapWasProtected); } catch (error) { protectionError = protectionError || error; }
    // 跟进映射是幂等索引，不向普通用户展示，并始终恢复为受保护状态。
    try { mapSheet.Protect(); } catch (error) { protectionError = protectionError || error; }
    try { mapSheet.Visible = false; } catch (error) { protectionError = protectionError || error; }
    // 保护恢复后再保存；WPS Save 会以返回值报告空间满/队列满等失败，不能只依赖异常。
    try {
      assertWorkbookSaved(application.ActiveWorkbook.Save(), function () {
        verifyWorkbookWrites(mainSheet, followSheet, mapSheet, mainPlan, followPlan);
      });
      // Save 返回 ok 时旧逻辑会信任保存回执；删除必须额外逐项回读，才能向 Edge 报 verified。
      deletionsVerified = verifyDeletionWrites(
        mainSheet, followSheet, mapSheet, ticketMapSheet, archiveMapSheet, deletePlan
      );
    } catch (error) { protectionError = protectionError || error; }
  }
  if (writeError) throw writeError;
  if (protectionError) throw protectionError;

  var result = {
    ok: true,
    requestId: asText(payload.requestId),
    mode: asText(payload.mode),
    deletions: payload.deletions.length,
    deletionsReceived: payload.deletions.length,
    deletionsCleared: deletePlan.filter(function (operation) { return operation.willClear; }).length,
    deletionsVerified: deletionsVerified,
    mainRowsCleared: deletePlan.filter(function (operation) { return operation.mainNeedsClear; }).length,
    followRowsCleared: deletePlan.reduce(function (count, operation) { return count + operation.dailyRows.length; }, 0),
    followMapRowsCleared: deletePlan.reduce(function (count, operation) { return count + operation.followMapRows.length; }, 0),
    ticketMapRowsCleared: deletePlan.reduce(function (count, operation) { return count + operation.ticketMapRows.length; }, 0),
    archiveMapRowsCleared: deletePlan.reduce(function (count, operation) { return count + operation.archiveMapRows.length; }, 0),
    ticketsReceived: payload.tickets.length,
    ticketsInserted: mainPlan.filter(function (operation) { return operation.isNew; }).length,
    ticketsUpdated: mainPlan.filter(function (operation) {
      return !operation.isNew && (operation.writeCToF || operation.writeH);
    }).length,
    ticketsUnchanged: mainPlan.filter(function (operation) {
      return !operation.isNew && !operation.writeCToF && !operation.writeH;
    }).length,
    followupsReceived: payload.followups.length,
    followupsAppended: followPlan.filter(function (operation) { return operation.kind === 'append'; }).length,
    followupsReconciled: followPlan.filter(function (operation) { return operation.kind === 'reconcile'; }).length,
    followupsRecovered: followPlan.filter(function (operation) { return operation.kind === 'recover'; }).length,
    followupsUnchanged: followPlan.filter(function (operation) { return operation.kind === 'unchanged'; }).length
  };
  console.log(JSON.stringify(result));
  return result;
}

function runAirScript() {
  // WPS 同步执行 API 的 data.result 类型为字符串，显式序列化便于服务端严格验收。
  return JSON.stringify(executeWorkbookSync(Context.argv, Application));
}

return runAirScript();
