/*
 * 金山文档 AirScript：把 Supabase Edge Function 传入的增量/全量数据安全写入工单表。
 * 只写：
 *   工单登记与跟进 C,D,E,F,H,X,Y
 *   每日跟进 A,B,D,E,F
 *   工作台跟进映射 A:N（仅作为跟进ID幂等索引）
 * 绝不写驾驶舱、公式列、当前未完结、已完结等动态结果表。
 */

var CONTRACT = {
  mainSheet: '工单登记与跟进',
  followSheet: '每日跟进',
  followMapSheet: '工作台跟进映射',
  mainFirstRow: 6,
  mainLastRow: 1005,
  followFirstRow: 6,
  followLastRow: 2005,
  mapFirstRow: 5,
  mapLastRow: 2005,
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
  if (payload.schemaVersion !== 1) throw syncError('UNSUPPORTED_SCHEMA_VERSION', '仅支持 schemaVersion=1');
  if (!Array.isArray(payload.tickets) || !Array.isArray(payload.followups)) {
    throw syncError('INVALID_PAYLOAD_COLLECTIONS', 'tickets 和 followups 必须为数组');
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
    mappingById[followUpId] = {
      mapRow: mapRowNumber,
      dailyRow: Number(map[mapIndex][12]) // M列
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
      var existing = daily[mapped.dailyRow - CONTRACT.followFirstRow];
      if (dailyRowMatches(existing, followUp)) {
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

    var serial = dateToExcelSerial(followUp.followedAt, false);
    var latest = latestByTicket[followUp.ticketNo] || 0;
    if (latest && serial + 0.000001 < latest) {
      throw syncError('BACKDATED_FOLLOWUP_REQUIRES_RECONCILIATION', '工单 ' + followUp.ticketNo + ' 有早于现有最新记录的新增跟进，已停止以防最新状态被覆盖');
    }
    var nextDailyRow = lastDailyRow + 1;
    var nextMapRow = lastMapRow + 1;
    if (nextDailyRow > CONTRACT.followLastRow) throw syncError('FOLLOW_SHEET_CAPACITY_EXCEEDED', '每日跟进已无可用行（6-2005）');
    if (nextMapRow > CONTRACT.mapLastRow) throw syncError('FOLLOW_MAP_CAPACITY_EXCEEDED', '工作台跟进映射已无可用行（5-2005）');
    lastDailyRow = nextDailyRow;
    lastMapRow = nextMapRow;
    latestByTicket[followUp.ticketNo] = Math.max(latest, serial);
    mappingById[followUpId] = { mapRow: nextMapRow, dailyRow: nextDailyRow };
    operations.push({ kind: 'append', followUp: followUp, dailyRow: nextDailyRow, mapRow: nextMapRow });
  });
  return operations;
}

function cellAddress(column, row) {
  return column + String(row);
}

function assertNewRowFormulaTemplate(sheet, row) {
  ['A', 'B', 'G', 'I', 'J', 'K', 'L'].forEach(function (column) {
    var formula = asText(sheet.Range(cellAddress(column, row)).Formula);
    if (formula.charAt(0) !== '=') {
      throw syncError('MAIN_TEMPLATE_FORMULA_MISSING', '新工单目标行 ' + row + ' 的公式列 ' + column + ' 缺失');
    }
  });
}

function readWorkbookSnapshot(mainSheet, followSheet, mapSheet) {
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
    }
  };
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
  if (operation.kind === 'append') {
    // 映射先落盘；若每日跟进写入中断，下次会识别空行并恢复，不会重复追加。
    mapSheet.Range('A' + operation.mapRow + ':N' + operation.mapRow).Value2 = mappingValues(operation);
  }
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
    if (!rowValuesEqual(oneRowValues(followSheet.Range('A' + operation.dailyRow + ':B' + operation.dailyRow), 2), [
      followUp.ticketNo, dateToExcelSerial(followUp.followedAt, false)
    ])) {
      throw syncError('WRITE_VERIFICATION_FAILED', '跟进 ' + followUp.followUpId + ' 的编号或时间回读不一致');
    }
    if (!rowValuesEqual(oneRowValues(followSheet.Range('D' + operation.dailyRow + ':F' + operation.dailyRow), 3), [
      followUp.followerName, followUp.content, followUp.status
    ])) {
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
  if (!mainSheet || !followSheet || !mapSheet) throw syncError('WORKBOOK_CONTRACT_MISSING', '缺少必要工作表');

  var snapshot = readWorkbookSnapshot(mainSheet, followSheet, mapSheet);
  var mainPlan = buildMainPlan(payload.tickets, snapshot.main);
  var followPlan = buildFollowPlan(payload.followups, snapshot.follow);
  mainPlan.filter(function (operation) { return operation.isNew; }).forEach(function (operation) {
    assertNewRowFormulaTemplate(mainSheet, operation.row);
  });

  var mainWasProtected = mainSheet.ProtectContents !== false;
  var followWasProtected = followSheet.ProtectContents !== false;
  var mapWasProtected = mapSheet.ProtectContents === true;
  var writeError = null;
  var protectionError = null;
  try {
    if (mainWasProtected) mainSheet.Unprotect();
    if (followWasProtected) followSheet.Unprotect();
    if (mapWasProtected) mapSheet.Unprotect();
    mainPlan.forEach(function (operation) { writeMainOperation(mainSheet, operation); });
    followPlan.forEach(function (operation) { writeFollowOperation(followSheet, mapSheet, operation); });
  } catch (error) {
    writeError = error;
  } finally {
    try { protectLikeBefore(mainSheet, mainWasProtected); } catch (error) { protectionError = protectionError || error; }
    try { protectLikeBefore(followSheet, followWasProtected); } catch (error) { protectionError = protectionError || error; }
    // 跟进映射是幂等索引，不向普通用户展示，并始终恢复为受保护状态。
    try { mapSheet.Protect(); } catch (error) { protectionError = protectionError || error; }
    try { mapSheet.Visible = false; } catch (error) { protectionError = protectionError || error; }
    // 保护恢复后再保存；WPS Save 会以返回值报告空间满/队列满等失败，不能只依赖异常。
    try {
      assertWorkbookSaved(application.ActiveWorkbook.Save(), function () {
        verifyWorkbookWrites(mainSheet, followSheet, mapSheet, mainPlan, followPlan);
      });
    } catch (error) { protectionError = protectionError || error; }
  }
  if (writeError) throw writeError;
  if (protectionError) throw protectionError;

  var result = {
    ok: true,
    requestId: asText(payload.requestId),
    mode: asText(payload.mode),
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
