import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

type JsonRecord = Record<string, unknown>;
type WorkbenchRow = { user_id: string; payload: JsonRecord; updated_at?: string };
type ProfileRow = { id: string; name: string; role: string; can_view_all?: boolean };

const EXCEL_URGENCIES = new Set(["紧急", "高", "普通", "低"]);
const EXCEL_ASSIGNEES = new Set([
  "郑康", "张国鹏", "杨柳", "杜梦新", "耿怡哲", "张胜飞", "张铭", "张淦杨",
]);
const FOLLOW_STATUSES = new Set(["跟进中", "已完结"]);
const CURRENT_STATUSES = new Set(["跟进中", "已完结", "未跟进", "已逾期"]);

class IntegrationError extends Error {
  status: number;
  code: string;
  details?: JsonRecord;

  constructor(status: number, code: string, message: string, details?: JsonRecord) {
    super(message);
    this.name = "IntegrationError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function parseWpsResult(value: unknown): JsonRecord {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new IntegrationError(502, "WPS_INVALID_RESPONSE", "WPS AirScript 返回结果不是有效 JSON");
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new IntegrationError(502, "WPS_INVALID_RESPONSE", "WPS AirScript 未返回可验证的对象结果");
  }
  return parsed as JsonRecord;
}

function array(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.filter((item) => item && typeof item === "object").map(record) : [];
}

function text(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

function trimmed(value: unknown): string {
  return text(value).trim();
}

function issueScopeKey(ownerUserId: unknown, issueId: unknown): string {
  return `${trimmed(ownerUserId)}:${trimmed(issueId)}`;
}

function env(name: string): string {
  const value = Deno.env.get(name)?.trim() ?? "";
  if (!value) throw new IntegrationError(503, "MISSING_SERVER_CONFIGURATION", `服务端缺少环境变量 ${name}`);
  return value;
}

function booleanEnv(name: string): boolean {
  return /^(1|true|yes|on)$/i.test(Deno.env.get(name)?.trim() ?? "");
}

function normalizeUrgency(value: unknown, legacyPriority: unknown): string {
  const explicit = trimmed(value);
  if (EXCEL_URGENCIES.has(explicit)) return explicit;
  const priority = trimmed(legacyPriority || value);
  if (priority === "P0") return "紧急";
  if (priority === "P1") return "高";
  if (priority === "P2") return "普通";
  return "";
}

function normalizeFollowStatus(value: unknown): string {
  const status = trimmed(value);
  if (status === "已完结") return "已完结";
  if (status === "跟进中" || status === "阶段性完成") return "跟进中";
  return "";
}

function dateOnly(value: unknown): string {
  const match = text(value).match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : "";
}

function isValidDateLike(value: string): boolean {
  return Boolean(value) && !Number.isNaN(Date.parse(value.length === 10 ? `${value}T00:00:00+08:00` : value));
}

function shanghaiToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

function shanghaiBusinessDate(value: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(parsed);
  const byType = new Map(parts.map((part) => [part.type, part.value]));
  return `${byType.get("year")}-${byType.get("month")}-${byType.get("day")}`;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as JsonRecord;
  return `{${Object.keys(obj).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`).join(",")}}`;
}

async function sha256(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(stableStringify(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((part) => part.toString(16).padStart(2, "0")).join("");
}

function normalizeFollowUp(
  raw: JsonRecord,
  ticket: { id: string; ticketNo: string; ownerUserId: string; assigneeId: string; assigneeName: string },
  index: number,
): JsonRecord {
  const rawId = trimmed(raw.followUpId || raw.id);
  const followUpId = rawId || `legacy:${ticket.ownerUserId}:${ticket.id}:${index}`;
  const type = trimmed(raw.type) || "follow_up";
  const followedAt = trimmed(raw.followedAt || raw.createdAt || raw.updatedAt);
  const followerId = trimmed(raw.followerId || raw.authorId || ticket.assigneeId);
  const followerName = trimmed(raw.followerName || raw.authorName || ticket.assigneeName);
  const content = text(raw.content);
  const status = normalizeFollowStatus(raw.status || raw.toProgress);
  const sourceDailyRowText = trimmed(raw.sourceDailyRow);
  const sourceDailyRow = sourceDailyRowText ? Number(sourceDailyRowText) : undefined;
  const sourceFollowUpStatus = Object.prototype.hasOwnProperty.call(raw, "sourceFollowUpStatus")
    ? text(raw.sourceFollowUpStatus)
    : undefined;

  return {
    id: followUpId,
    followUpId,
    ticketId: ticket.id,
    internalId: ticket.id,
    ticketNo: ticket.ticketNo,
    followedAt,
    followerId,
    followerName,
    content,
    status: status || (type === "follow_up" ? "跟进中" : ""),
    type,
    fromProgress: text(raw.fromProgress),
    toProgress: text(raw.toProgress || status),
    authorId: trimmed(raw.authorId || followerId),
    authorName: trimmed(raw.authorName || followerName),
    createdAt: trimmed(raw.createdAt || followedAt),
    ...(sourceDailyRow === undefined ? {} : { sourceDailyRow }),
    ...(sourceFollowUpStatus === undefined ? {} : { sourceFollowUpStatus }),
  };
}

function mergeRawFollowUps(primary: JsonRecord[], secondary: JsonRecord[]): JsonRecord[] {
  const result: JsonRecord[] = [];
  const positions = new Map<string, number>();
  [...secondary, ...primary].forEach((item, index) => {
    const key = trimmed(item.followUpId || item.id) || `position:${index}`;
    const existing = positions.get(key);
    if (existing === undefined) {
      positions.set(key, result.length);
      result.push(item);
    } else {
      result[existing] = { ...result[existing], ...item };
    }
  });
  return result;
}

function validateTicketNo(value: string, ticketId: string): void {
  if (!/^\d{11}$/.test(value)) {
    throw new IntegrationError(409, "INVALID_OR_MISSING_TICKET_NO", `工单 ${ticketId} 缺少有效的11位工单编号`);
  }
  const datePart = value.slice(0, 8);
  const parsed = `${datePart.slice(0, 4)}-${datePart.slice(4, 6)}-${datePart.slice(6, 8)}`;
  if (!isValidDateLike(parsed) || value.endsWith("000")) {
    throw new IntegrationError(409, "INVALID_TICKET_NO", `工单 ${ticketId} 的工单编号格式不正确`);
  }
}

function normalizeTicket(
  rawIssue: JsonRecord,
  rawArchive: JsonRecord | undefined,
  owner: ProfileRow,
): { ticket: JsonRecord; manualFollowUps: JsonRecord[] } {
  const raw = rawArchive ? { ...rawArchive, ...rawIssue } : { ...rawIssue };
  const id = trimmed(rawIssue.id || rawArchive?.sourceIssueId || rawArchive?.id);
  if (!id) throw new IntegrationError(409, "MISSING_ISSUE_ID", "存在缺少内部ID的工单，已停止同步");

  const ticketNo = trimmed(rawIssue.ticketNo || rawArchive?.ticketNo);
  validateTicketNo(ticketNo, id);
  const createdAt = trimmed(rawIssue.createdAt || rawArchive?.originalCreatedAt || rawArchive?.createdAt);
  if (!isValidDateLike(createdAt)) {
    throw new IntegrationError(409, "INVALID_CREATED_AT", `工单 ${ticketNo} 缺少有效登记时间`);
  }
  const numberDate = `${ticketNo.slice(0, 4)}-${ticketNo.slice(4, 6)}-${ticketNo.slice(6, 8)}`;
  if (shanghaiBusinessDate(createdAt) !== numberDate) {
    throw new IntegrationError(409, "TICKET_DATE_MISMATCH", `工单 ${ticketNo} 的编号日期与北京时间登记日期不一致`);
  }

  const shopName = text(raw.shopName);
  const shopDesc = text(raw.shopDesc);
  if (!shopName.trim() || !shopDesc.trim()) {
    throw new IntegrationError(409, "MISSING_REQUIRED_ISSUE_FIELD", `工单 ${ticketNo} 的门店名称或门店问题为空`);
  }

  const urgency = normalizeUrgency(raw.urgency, raw.priority);
  if (!EXCEL_URGENCIES.has(urgency)) {
    throw new IntegrationError(409, "INVALID_URGENCY", `工单 ${ticketNo} 的紧急程度无法匹配表格`);
  }

  const assigneeName = trimmed(raw.assigneeName || owner.name);
  if (!EXCEL_ASSIGNEES.has(assigneeName)) {
    throw new IntegrationError(409, "ASSIGNEE_NOT_IN_WORKBOOK_LIST", `工单 ${ticketNo} 的跟进人“${assigneeName || "空"}”不在表格下拉名单中`);
  }
  const assigneeId = trimmed(raw.assigneeId || owner.id);
  const deadline = dateOnly(raw.deadline);
  if (trimmed(raw.deadline) && !isValidDateLike(deadline)) {
    throw new IntegrationError(409, "INVALID_DEADLINE", `工单 ${ticketNo} 的计划完成日期格式不正确`);
  }

  const rawFollowUps = mergeRawFollowUps(array(rawIssue.followUps), array(rawArchive?.followUps));
  const ticketIdentity = { id, ticketNo, ownerUserId: owner.id, assigneeId, assigneeName };
  let followUps = rawFollowUps.map((item, index) => normalizeFollowUp(item, ticketIdentity, index));
  let manual = followUps.filter((item) => item.type === "follow_up");

  const explicitLatestStatus = normalizeFollowStatus(raw.latestFollowUpStatus || raw.followStatus);
  const explicitCompleted = trimmed(raw.currentStatus) === "已完结" || normalizeFollowStatus(raw.progress) === "已完结";
  const archiveOnlyCompleted = !trimmed(rawIssue.id) && Boolean(rawArchive) && Boolean(trimmed(rawArchive?.completedAt));
  const provisionalLatest = manual.slice().sort((a, b) => {
    const byTime = text(a.followedAt).localeCompare(text(b.followedAt));
    return byTime || text(a.followUpId).localeCompare(text(b.followUpId));
  }).pop();
  const archiveNeedsCompletion = archiveOnlyCompleted && normalizeFollowStatus(provisionalLatest?.status) !== "已完结";
  if ((!manual.length && (explicitLatestStatus || explicitCompleted)) || archiveNeedsCompletion) {
    const status = archiveNeedsCompletion ? "已完结" : (explicitLatestStatus || "已完结");
    let followedAt = trimmed(raw.latestFollowUpAt || raw.completedAt || raw.updatedAt || createdAt);
    if (archiveNeedsCompletion && provisionalLatest) {
      const latestMillis = Date.parse(trimmed(provisionalLatest.followedAt));
      const completionMillis = Date.parse(followedAt);
      if (Number.isFinite(latestMillis) && (!Number.isFinite(completionMillis) || completionMillis <= latestMillis)) {
        followedAt = new Date(latestMillis + 1).toISOString();
      }
    }
    const synthetic = normalizeFollowUp({
      id: `system-latest:${owner.id}:${id}:${status}`,
      type: "follow_up",
      content: text(raw.latestFollowUpContent) || (status === "已完结" ? "工单已完结（工作台同步）" : "工单状态同步"),
      status,
      followedAt,
      followerId: assigneeId,
      followerName: assigneeName,
    }, ticketIdentity, followUps.length);
    followUps.push(synthetic);
    manual.push(synthetic);
  }

  manual.sort((a, b) => {
    const byTime = text(a.followedAt).localeCompare(text(b.followedAt));
    return byTime || text(a.followUpId).localeCompare(text(b.followUpId));
  });
  const latest = manual.length ? manual[manual.length - 1] : undefined;
  const latestFollowUpStatus = normalizeFollowStatus(latest?.status || raw.latestFollowUpStatus);
  const latestFollowUpContent = latest ? text(latest.content) : text(raw.latestFollowUpContent);
  const latestFollowUpAt = latest ? trimmed(latest.followedAt) : trimmed(raw.latestFollowUpAt);

  for (const followUp of manual) {
    if (!trimmed(followUp.followUpId) || !isValidDateLike(trimmed(followUp.followedAt)) || !text(followUp.content).trim()) {
      throw new IntegrationError(409, "INVALID_FOLLOWUP", `工单 ${ticketNo} 存在编号、时间或内容不完整的跟进记录`);
    }
    if (!FOLLOW_STATUSES.has(trimmed(followUp.status))) {
      throw new IntegrationError(409, "INVALID_FOLLOWUP_STATUS", `工单 ${ticketNo} 的跟进状态只能是“跟进中”或“已完结”`);
    }
    if (!EXCEL_ASSIGNEES.has(trimmed(followUp.followerName))) {
      throw new IntegrationError(409, "FOLLOWER_NOT_IN_WORKBOOK_LIST", `工单 ${ticketNo} 的跟进记录包含不在表格名单中的跟进人`);
    }
    if (followUp.sourceDailyRow !== undefined) {
      const sourceDailyRow = Number(followUp.sourceDailyRow);
      if (!Number.isInteger(sourceDailyRow) || sourceDailyRow < 6 || sourceDailyRow > 2005) {
        throw new IntegrationError(409, "INVALID_SOURCE_DAILY_ROW", `工单 ${ticketNo} 的历史跟进行号必须在 6-2005 之间`);
      }
    }
  }

  let currentStatus = "未跟进";
  if (latestFollowUpStatus === "已完结") currentStatus = "已完结";
  else if (deadline && deadline < shanghaiToday()) currentStatus = "已逾期";
  else if (latest) currentStatus = "跟进中";
  if (!CURRENT_STATUSES.has(currentStatus)) {
    throw new IntegrationError(500, "DERIVED_STATUS_ERROR", `工单 ${ticketNo} 状态推导失败`);
  }

  const completedAt = currentStatus === "已完结"
    ? trimmed(latestFollowUpAt || raw.completedAt || raw.updatedAt || createdAt)
    : "";

  const ticket: JsonRecord = {
    id,
    ticketNo,
    createdAt,
    shopName,
    shopDesc,
    urgency,
    assigneeId,
    assigneeName,
    latestFollowUpStatus,
    deadline,
    completedAt,
    latestFollowUpContent,
    latestFollowUpAt,
    currentStatus,
    // 兼容工作台旧字段，同时不替代上面的 Excel 契约字段。
    priority: text(raw.priority),
    progress: text(raw.progress),
    updatedAt: trimmed(raw.updatedAt),
    ownerUserId: owner.id,
    ownerName: owner.name,
    followUps,
  };
  return { ticket, manualFollowUps: manual };
}

function collectWorkbookPayload(
  rows: WorkbenchRow[],
  profiles: Map<string, ProfileRow>,
  targetIssueKeys: Set<string> | null,
): { tickets: JsonRecord[]; followups: JsonRecord[] } {
  const tickets: JsonRecord[] = [];
  const followups: JsonRecord[] = [];
  const ticketNos = new Set<string>();
  const followUpIds = new Set<string>();

  for (const row of rows) {
    const owner = profiles.get(row.user_id);
    if (!owner) throw new IntegrationError(409, "PROFILE_NOT_FOUND", `账号 ${row.user_id} 缺少成员资料`);
    const payload = record(row.payload);
    const issues = array(payload.issues);
    const archives = array(payload.archives);
    const archiveBySource = new Map<string, JsonRecord>();
    archives.forEach((archive) => {
      const sourceId = trimmed(archive.sourceIssueId || archive.id);
      if (sourceId) archiveBySource.set(sourceId, archive);
    });
    const issueIds = new Set<string>();

    for (const issue of issues) {
      const id = trimmed(issue.id);
      if (!id || (targetIssueKeys && !targetIssueKeys.has(issueScopeKey(row.user_id, id)))) continue;
      issueIds.add(id);
      const normalized = normalizeTicket(issue, archiveBySource.get(id), owner);
      const ticketNo = trimmed(normalized.ticket.ticketNo);
      if (ticketNos.has(ticketNo)) throw new IntegrationError(409, "DUPLICATE_TICKET_NO", `检测到重复工单编号 ${ticketNo}`);
      ticketNos.add(ticketNo);
      tickets.push(normalized.ticket);
      normalized.manualFollowUps.forEach((followUp) => {
        const id = trimmed(followUp.followUpId);
        if (followUpIds.has(id)) throw new IntegrationError(409, "DUPLICATE_FOLLOWUP_ID", `检测到重复跟进ID ${id}`);
        followUpIds.add(id);
        followups.push(followUp);
      });
    }

    // 兼容未来“完结后仅保留归档”的数据形态；当前工作台通常仍保留 issues。
    for (const archive of archives) {
      const id = trimmed(archive.sourceIssueId || archive.id);
      if (!id || issueIds.has(id) || (targetIssueKeys && !targetIssueKeys.has(issueScopeKey(row.user_id, id)))) continue;
      const normalized = normalizeTicket({}, archive, owner);
      const ticketNo = trimmed(normalized.ticket.ticketNo);
      if (ticketNos.has(ticketNo)) throw new IntegrationError(409, "DUPLICATE_TICKET_NO", `检测到重复工单编号 ${ticketNo}`);
      ticketNos.add(ticketNo);
      tickets.push(normalized.ticket);
      normalized.manualFollowUps.forEach((followUp) => {
        const followUpId = trimmed(followUp.followUpId);
        if (followUpIds.has(followUpId)) throw new IntegrationError(409, "DUPLICATE_FOLLOWUP_ID", `检测到重复跟进ID ${followUpId}`);
        followUpIds.add(followUpId);
        followups.push(followUp);
      });
    }
  }

  if (targetIssueKeys && targetIssueKeys.size) {
    const found = new Set(tickets.map((ticket) => issueScopeKey(ticket.ownerUserId, ticket.id)));
    const missing = [...targetIssueKeys].filter((key) => !found.has(key));
    if (missing.length) {
      throw new IntegrationError(404, "ISSUE_NOT_FOUND", `未找到 ${missing.length} 张本次需要同步的工单`);
    }
  }
  tickets.sort((a, b) => trimmed(a.ticketNo).localeCompare(trimmed(b.ticketNo)));
  followups.sort((a, b) => {
    const byTime = trimmed(a.followedAt).localeCompare(trimmed(b.followedAt));
    return byTime || trimmed(a.followUpId).localeCompare(trimmed(b.followUpId));
  });
  return { tickets, followups };
}

async function fetchRows(
  service: SupabaseClient,
  ownerUserIds: string[] | null,
): Promise<{ rows: WorkbenchRow[]; profiles: Map<string, ProfileRow> }> {
  let dataQuery = service.from("workbench_data").select("user_id,payload,updated_at");
  let profileQuery = service.from("profiles").select("id,name,role,can_view_all");
  if (ownerUserIds) {
    dataQuery = dataQuery.in("user_id", ownerUserIds);
    profileQuery = profileQuery.in("id", ownerUserIds);
  }
  const [dataResult, profileResult] = await Promise.all([dataQuery, profileQuery]);
  if (dataResult.error) throw new IntegrationError(500, "WORKBENCH_READ_FAILED", dataResult.error.message);
  if (profileResult.error) throw new IntegrationError(500, "PROFILE_READ_FAILED", profileResult.error.message);
  const profiles = new Map<string, ProfileRow>();
  (profileResult.data ?? []).forEach((item) => profiles.set(item.id, item as ProfileRow));
  return { rows: (dataResult.data ?? []) as WorkbenchRow[], profiles };
}

async function fetchPendingOutbox(
  service: SupabaseClient,
  ownerUserIds: string[] | null,
  targetIssueId: string,
): Promise<{ entries: JsonRecord[]; deletions: JsonRecord[]; upsertIssueKeys: Set<string> }> {
  const result = await service.rpc("list_workbook_sync_outbox", {
    p_owner_user_ids: ownerUserIds,
    p_issue_id: targetIssueId || null,
  });
  if (result.error) throw new IntegrationError(500, "OUTBOX_READ_FAILED", result.error.message);
  if (!Array.isArray(result.data)) throw new IntegrationError(500, "OUTBOX_READ_INVALID", "同步待办队列返回格式无效");

  const entries: JsonRecord[] = [];
  const deletions: JsonRecord[] = [];
  const upsertIssueKeys = new Set<string>();
  const seen = new Set<string>();
  result.data.forEach((raw) => {
    const row = record(raw);
    const ownerUserId = trimmed(row.owner_user_id || row.ownerUserId);
    const issueId = trimmed(row.issue_id || row.issueId);
    const ticketNo = trimmed(row.ticket_no || row.ticketNo);
    const revision = trimmed(row.pending_revision || row.revision);
    const deletedAt = trimmed(row.deleted_at || row.deletedAt);
    const operationRaw = trimmed(row.operation);
    const operation = operationRaw === "deleted" ? "delete" : operationRaw;
    if (!ownerUserId || !issueId || !isValidDateLike(revision)) {
      throw new IntegrationError(500, "OUTBOX_ENTRY_INVALID", "同步待办缺少账号、工单ID或有效版本");
    }
    const key = issueScopeKey(ownerUserId, issueId);
    if (seen.has(key)) throw new IntegrationError(500, "OUTBOX_ENTRY_DUPLICATED", `同步待办重复：${key}`);
    seen.add(key);
    if (operation !== "upsert" && operation !== "delete") {
      throw new IntegrationError(500, "OUTBOX_OPERATION_INVALID", `工单 ${issueId} 的同步操作无效`);
    }
    if (operation === "delete") {
      validateTicketNo(ticketNo, issueId);
      deletions.push({ issueId, ticketNo, ownerUserId, deletedAt: deletedAt || revision });
    } else {
      upsertIssueKeys.add(key);
    }
    entries.push({ ownerUserId, issueId, revision, operation, ticketNo });
  });
  deletions.sort((a, b) => trimmed(a.ticketNo).localeCompare(trimmed(b.ticketNo)));
  return { entries, deletions, upsertIssueKeys };
}

async function fetchClearedDeletionTombstone(
  service: SupabaseClient,
  ownerUserId: string,
  issueId: string,
): Promise<JsonRecord | null> {
  const result = await service
    .from("ticket_deletion_tombstones")
    .select("owner_user_id,issue_id,ticket_no,workbook_status,workbook_cleared_at")
    .eq("owner_user_id", ownerUserId)
    .eq("issue_id", issueId)
    .maybeSingle();
  if (result.error) {
    throw new IntegrationError(500, "DELETE_TOMBSTONE_READ_FAILED", result.error.message);
  }
  const tombstone = result.data ? record(result.data) : null;
  if (!tombstone || trimmed(tombstone.workbook_status) !== "cleared") return null;
  const ticketNo = trimmed(tombstone.ticket_no);
  validateTicketNo(ticketNo, issueId);
  return {
    ownerUserId: trimmed(tombstone.owner_user_id),
    issueId: trimmed(tombstone.issue_id),
    ticketNo,
    workbookClearedAt: trimmed(tombstone.workbook_cleared_at),
  };
}

async function assertTicketNumberAllocations(
  service: SupabaseClient,
  tickets: JsonRecord[],
): Promise<number> {
  const assertions = tickets.map((ticket) => ({
    ownerUserId: trimmed(ticket.ownerUserId),
    issueId: trimmed(ticket.id),
    ticketNo: trimmed(ticket.ticketNo),
  }));
  const result = await service.rpc("assert_ticket_number_allocations", { p_tickets: assertions });
  if (result.error) {
    const message = result.error.message || "工单编号归属核验失败";
    const mismatch = message.includes("TICKET_ALLOCATION_MISMATCH");
    const missing = message.includes("TICKET_ALLOCATION_NOT_FOUND");
    throw new IntegrationError(
      409,
      mismatch ? "TICKET_ALLOCATION_MISMATCH" : (missing ? "TICKET_ALLOCATION_NOT_FOUND" : "TICKET_ALLOCATION_CHECK_FAILED"),
      message,
    );
  }
  const verified = Number(result.data);
  if (!Number.isInteger(verified) || verified !== assertions.length) {
    throw new IntegrationError(500, "TICKET_ALLOCATION_CHECK_INCOMPLETE", "工单编号归属未逐张完成核验");
  }
  return verified;
}

async function finishOutbox(
  service: SupabaseClient,
  entries: JsonRecord[],
  success: boolean,
  errorCode = "",
  errorMessage = "",
): Promise<number> {
  if (!entries.length) return 0;
  const result = await service.rpc("finish_workbook_sync_outbox", {
    p_entries: entries,
    p_success: success,
    p_error_code: errorCode || null,
    p_error_message: errorMessage || null,
  });
  if (result.error) throw new IntegrationError(500, "OUTBOX_UPDATE_FAILED", result.error.message);
  return Number(result.data) || 0;
}

async function backfillMissingTicketNumbers(
  service: SupabaseClient,
  rows: WorkbenchRow[],
  targetIssueKeys: Set<string> | null,
): Promise<number> {
  const allowBackfill = booleanEnv("KDOCS_ALLOW_TICKET_BACKFILL");
  let backfilled = 0;
  for (const row of rows) {
    const payload = record(row.payload);
    const issues = array(payload.issues);
    const archives = array(payload.archives);
    const archiveBySource = new Map<string, JsonRecord>();
    archives.forEach((archive) => {
      const id = trimmed(archive.sourceIssueId || archive.id);
      if (id) archiveBySource.set(id, archive);
    });
    const candidates = issues.map((issue) => {
      const id = trimmed(issue.id);
      const issueTicketNo = trimmed(issue.ticketNo);
      const archiveTicketNo = trimmed(archiveBySource.get(id)?.ticketNo);
      return {
        id,
        createdAt: trimmed(issue.createdAt),
        ticketNo: issueTicketNo || archiveTicketNo,
        needsExistingNumberPatch: !issueTicketNo && Boolean(archiveTicketNo),
      };
    });
    const issueIds = new Set(candidates.map((item) => item.id));
    archives.forEach((archive) => {
      const id = trimmed(archive.sourceIssueId || archive.id);
      if (id && !issueIds.has(id)) candidates.push({
        id,
        createdAt: trimmed(archive.originalCreatedAt || archive.createdAt),
        ticketNo: trimmed(archive.ticketNo),
        needsExistingNumberPatch: false,
      });
    });

    for (const candidate of candidates) {
      if (!candidate.id || (targetIssueKeys && !targetIssueKeys.has(issueScopeKey(row.user_id, candidate.id)))) continue;
      if (candidate.ticketNo) {
        validateTicketNo(candidate.ticketNo, candidate.id);
        if (candidate.needsExistingNumberPatch) {
          const existingPatch = await service.rpc("backfill_workbench_ticket_no", {
            p_user_id: row.user_id,
            p_issue_id: candidate.id,
            p_ticket_no: candidate.ticketNo,
          });
          if (existingPatch.error) throw new IntegrationError(409, "TICKET_BACKFILL_FAILED", existingPatch.error.message);
          backfilled += 1;
        }
        continue;
      }
      if (!allowBackfill) {
        throw new IntegrationError(409, "TICKET_BACKFILL_DISABLED", `工单 ${candidate.id} 尚无编号；为防止撞号，自动补号当前未开启`);
      }
      if (!isValidDateLike(candidate.createdAt)) {
        throw new IntegrationError(409, "BACKFILL_CREATED_AT_INVALID", `工单 ${candidate.id} 无法按登记日期安全补号`);
      }
      const allocation = await service.rpc("allocate_ticket_no_for_owner", {
        p_owner_user_id: row.user_id,
        p_issue_id: candidate.id,
        p_created_at: candidate.createdAt,
      });
      if (allocation.error) {
        const notSeeded = allocation.error.message.includes("TICKET_COUNTER_NOT_SEEDED");
        throw new IntegrationError(409, notSeeded ? "TICKET_COUNTER_NOT_SEEDED" : "TICKET_ALLOCATION_FAILED", allocation.error.message);
      }
      const ticketNo = trimmed(allocation.data);
      validateTicketNo(ticketNo, candidate.id);
      const patch = await service.rpc("backfill_workbench_ticket_no", {
        p_user_id: row.user_id,
        p_issue_id: candidate.id,
        p_ticket_no: ticketNo,
      });
      if (patch.error) throw new IntegrationError(409, "TICKET_BACKFILL_FAILED", patch.error.message);
      backfilled += 1;
    }
  }
  return backfilled;
}

function validateWpsWebhookUrl(rawUrl: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new IntegrationError(503, "INVALID_WPS_WEBHOOK_URL", "WPS AirScript Webhook 地址无效");
  }
  const allowedHost = url.hostname === "www.kdocs.cn" || url.hostname === "kdocs.cn";
  const validPath = /^\/api\/v3\/ide\/file\/[^/]+\/script\/[^/]+\/sync_task$/.test(url.pathname);
  if (url.protocol !== "https:" || !allowedHost || !validPath || url.username || url.password) {
    throw new IntegrationError(503, "INVALID_WPS_WEBHOOK_URL", "WPS AirScript Webhook 必须是金山文档官方 HTTPS 同步执行地址");
  }
  return url.toString();
}

async function callWpsAirScript(payload: JsonRecord): Promise<JsonRecord> {
  const webhook = validateWpsWebhookUrl(env("WPS_AIRSCRIPT_WEBHOOK_URL"));
  const token = env("WPS_AIRSCRIPT_TOKEN");
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 50_000);
    try {
      const response = await fetch(webhook, {
        method: "POST",
        headers: { "Content-Type": "application/json", "AirScript-Token": token },
        body: JSON.stringify({ Context: { argv: payload } }),
        signal: controller.signal,
      });
      const raw = await response.text();
      let parsed: JsonRecord = {};
      let parsedOk = false;
      try {
        parsed = record(raw ? JSON.parse(raw) : {});
        parsedOk = Boolean(raw);
      } catch { /* handled below */ }
      if (!response.ok) {
        const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
        if (retryable && attempt < 3) throw new Error(`WPS_HTTP_${response.status}`);
        throw new IntegrationError(502, "WPS_HTTP_ERROR", `WPS AirScript 返回 HTTP ${response.status}`);
      }
      if (trimmed(parsed.error)) {
        throw new IntegrationError(502, "WPS_SCRIPT_ERROR", trimmed(parsed.error));
      }
      if (!parsedOk) throw new IntegrationError(502, "WPS_INVALID_RESPONSE", "WPS AirScript 未返回可验证的 JSON 结果");
      const data = record(parsed.data);
      // WPS 同步执行接口把脚本返回值包装为 data.result 字符串；
      // 同时兼容未来直接返回对象的情况，但拒绝空值或非 JSON 字符串。
      const result = parseWpsResult(data.result ?? parsed.result);
      if (result.ok === false) {
        throw new IntegrationError(502, "WPS_SCRIPT_REJECTED", trimmed(result.message || result.error) || "WPS AirScript 拒绝写入");
      }
      if (result.ok !== true) throw new IntegrationError(502, "WPS_INVALID_RESPONSE", "WPS AirScript 未返回成功确认");
      return result;
    } catch (error) {
      lastError = error;
      if (error instanceof IntegrationError || attempt === 3) break;
      await new Promise((resolve) => setTimeout(resolve, attempt * 700));
    } finally {
      clearTimeout(timeout);
    }
  }
  if (lastError instanceof IntegrationError) throw lastError;
  throw new IntegrationError(502, "WPS_REQUEST_FAILED", lastError instanceof Error ? lastError.message : "WPS AirScript 请求失败");
}

function assertWpsDeletionVerification(result: JsonRecord, expected: number): void {
  if (!expected) return;
  const received = Number(result.deletionsReceived);
  const verified = Number(result.deletionsVerified);
  if (!Number.isInteger(received) || !Number.isInteger(verified) || received !== expected || verified !== expected) {
    throw new IntegrationError(502, "WPS_DELETE_VERIFICATION_INCOMPLETE", `WPS仅确认清除 ${verified || 0}/${expected} 张工单`);
  }
}

function allowedOrigins(): Set<string> {
  return new Set((Deno.env.get("WORKBENCH_ALLOWED_ORIGINS") ?? "")
    .split(",").map((item) => item.trim()).filter(Boolean));
}

function corsHeaders(request: Request): HeadersInit {
  const origin = request.headers.get("Origin") ?? "";
  const allowed = allowedOrigins();
  return {
    "Access-Control-Allow-Origin": allowed.has(origin) ? origin : "null",
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

function jsonResponse(request: Request, status: number, body: JsonRecord): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(request), "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") {
    const origin = request.headers.get("Origin") ?? "";
    if (!allowedOrigins().has(origin)) return jsonResponse(request, 403, { ok: false, code: "ORIGIN_NOT_ALLOWED" });
    return new Response(null, { status: 204, headers: corsHeaders(request) });
  }
  if (request.method !== "POST") return jsonResponse(request, 405, { ok: false, code: "METHOD_NOT_ALLOWED" });

  let requestId = "";
  let scopeKey = "";
  let payloadHash = "";
  let claimed = false;
  let outboxFinished = false;
  let outboxEntries: JsonRecord[] = [];
  let service: SupabaseClient | undefined;
  try {
    const origin = request.headers.get("Origin") ?? "";
    if (origin && !allowedOrigins().has(origin)) throw new IntegrationError(403, "ORIGIN_NOT_ALLOWED", "当前网页来源不允许调用同步接口");
    const contentLength = Number(request.headers.get("Content-Length") || 0);
    if (contentLength > 16_384) throw new IntegrationError(413, "REQUEST_TOO_LARGE", "同步触发请求体过大");

    const supabaseUrl = env("SUPABASE_URL");
    const anonKey = env("SUPABASE_ANON_KEY");
    const serviceKey = env("SUPABASE_SERVICE_ROLE_KEY");
    const authorization = request.headers.get("Authorization") ?? "";
    const match = authorization.match(/^Bearer\s+(.+)$/i);
    if (!match) throw new IntegrationError(401, "AUTHENTICATION_REQUIRED", "请先登录工作台");

    const authClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authorization } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const authResult = await authClient.auth.getUser(match[1]);
    if (authResult.error || !authResult.data.user) throw new IntegrationError(401, "INVALID_SESSION", "登录状态已失效");
    const callerId = authResult.data.user.id;

    service = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const callerProfileResult = await service.from("profiles").select("id,name,role,can_view_all").eq("id", callerId).single();
    if (callerProfileResult.error) throw new IntegrationError(403, "PROFILE_NOT_FOUND", "当前账号没有工作台成员资料");
    const caller = callerProfileResult.data as ProfileRow;

    let body: JsonRecord = {};
    try { body = record(await request.json()); } catch { body = {}; }
    const requestedMode = trimmed(body.mode);
    const issueId = trimmed(body.issueId);
    const ownerUserId = trimmed(body.ownerUserId) || callerId;
    const fullMode = requestedMode === "full";
    const drainMode = requestedMode === "drain" || requestedMode === "drain_deletions";
    const deletionDrainOnly = requestedMode === "drain_deletions";
    const userFullSync = body.fullSync === true;
    const force = body.force === true;
    if ((fullMode || force) && caller.role !== "admin") {
      throw new IntegrationError(403, "ADMIN_REQUIRED", "全量或强制同步仅管理员可执行");
    }
    if (!fullMode && ownerUserId !== callerId && caller.role !== "admin") {
      throw new IntegrationError(403, "CROSS_USER_SYNC_FORBIDDEN", "无权同步其他成员的工单");
    }

    const clientReason = trimmed(body.reason);
    const targetIssueId = userFullSync || fullMode ? "" : issueId;
    const mode = fullMode ? "full" : (userFullSync ? "user_full" : (targetIssueId ? "incremental" : (deletionDrainOnly ? "delete_drain" : "drain")));
    const ownerFilter = fullMode ? null : [ownerUserId];
    const pending = await fetchPendingOutbox(service, ownerFilter, targetIssueId);
    let selectedDeletions = pending.deletions;
    let selectedUpsertKeys = pending.upsertIssueKeys;
    let selectedEntries = pending.entries;

    // 登录/定时补偿时优先处理删除，避免旧工单字段不完整阻塞“表格补删”。
    // 其余 upsert 待办仍保留，下一轮 drain 再处理。
    if (deletionDrainOnly || (drainMode && selectedDeletions.length)) {
      selectedEntries = pending.entries.filter((entry) => trimmed(entry.operation) === "delete");
      selectedUpsertKeys = new Set<string>();
      if (deletionDrainOnly) selectedDeletions = pending.deletions;
    }
    outboxEntries = selectedEntries;

    if (drainMode && !selectedEntries.length) {
      return jsonResponse(request, 200, {
        ok: true,
        status: "unchanged",
        mode,
        requestId: trimmed(body.requestId) || undefined,
        tickets: 0,
        followups: 0,
        deletions: 0,
        verifiedAllocations: 0,
      });
    }

    let fetched = await fetchRows(service, ownerFilter);

    let targetIssueKeys: Set<string> | null = null;
    if (drainMode) {
      targetIssueKeys = selectedUpsertKeys;
    } else if (!fullMode && !userFullSync && targetIssueId) {
      targetIssueKeys = selectedDeletions.length
        ? new Set<string>()
        : new Set([issueScopeKey(ownerUserId, targetIssueId)]);
    }
    if (clientReason === "issue_deleted" && !targetIssueId) {
      throw new IntegrationError(400, "ISSUE_ID_REQUIRED", "删除同步必须包含工单内部ID");
    }
    if (clientReason === "issue_deleted" && targetIssueId && !selectedDeletions.length) {
      const ticketStillExists = fetched.rows.some((row) => {
        const payload = record(row.payload);
        return array(payload.issues).some((issue) => trimmed(issue.id) === targetIssueId)
          || array(payload.archives).some((archive) => trimmed(archive.sourceIssueId || archive.id) === targetIssueId);
      });
      if (!ticketStillExists) {
        // 两个窗口同时删除同一工单时，后到请求可能在首个请求成功后才读取 outbox。
        // 永久墓碑已标记 cleared 即代表 WPS 回读完成，按幂等成功返回，不能误报失败。
        const clearedTombstone = await fetchClearedDeletionTombstone(service, ownerUserId, targetIssueId);
        if (clearedTombstone) {
          const verifiedAllocations = await assertTicketNumberAllocations(service, [{
            id: clearedTombstone.issueId,
            ticketNo: clearedTombstone.ticketNo,
            ownerUserId: clearedTombstone.ownerUserId,
          }]);
          return jsonResponse(request, 200, {
            ok: true,
            status: "unchanged",
            mode,
            requestId: trimmed(body.requestId) || undefined,
            tickets: 0,
            followups: 0,
            deletions: 1,
            verifiedAllocations,
            tombstoneStatus: "cleared",
            workbookClearedAt: clearedTombstone.workbookClearedAt || undefined,
          });
        }
        throw new IntegrationError(409, "DELETE_TOMBSTONE_NOT_FOUND", "删除凭证尚未生成，表格补删任务已保留，请稍后重试");
      }
    }

    const backfilled = await backfillMissingTicketNumbers(service, fetched.rows, targetIssueKeys);
    if (backfilled) {
      fetched = await fetchRows(service, ownerFilter);
    }
    const normalized = collectWorkbookPayload(fetched.rows, fetched.profiles, targetIssueKeys);
    const allocationAssertions = normalized.tickets.concat(selectedDeletions.map((deletion) => ({
      id: deletion.issueId,
      ticketNo: deletion.ticketNo,
      ownerUserId: deletion.ownerUserId,
    })));
    const verifiedAllocations = await assertTicketNumberAllocations(service, allocationAssertions);

    const syncData: JsonRecord = {
      schemaVersion: 2,
      mode,
      tickets: normalized.tickets,
      followups: normalized.followups,
      deletions: selectedDeletions,
    };
    payloadHash = await sha256(syncData);
    scopeKey = fullMode ? "team:full" : (targetIssueId ? `issue:${ownerUserId}:${targetIssueId}` : (deletionDrainOnly ? `user:${ownerUserId}:deletions` : `user:${ownerUserId}`));
    requestId = crypto.randomUUID();
    const clientRequestId = trimmed(body.requestId).slice(0, 300);
    const reason = clientReason.slice(0, 300);
    const jobInsert = await service.from("workbook_sync_jobs").insert({
      request_id: requestId,
      client_request_id: clientRequestId || null,
      requested_by: callerId,
      scope_key: scopeKey,
      reason,
      status: "queued",
      payload_hash: payloadHash,
    });
    if (jobInsert.error) throw new IntegrationError(500, "SYNC_JOB_CREATE_FAILED", jobInsert.error.message);

    let claimState = "busy";
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const claim = await service.rpc("claim_workbook_sync", {
        p_request_id: requestId,
        p_scope_key: scopeKey,
        p_payload_hash: payloadHash,
        p_force: force,
        p_lease_seconds: 90,
      });
      if (claim.error) throw new IntegrationError(500, "SYNC_CLAIM_FAILED", claim.error.message);
      claimState = trimmed(claim.data);
      if (claimState !== "busy") break;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 750 * (attempt + 1)));
    }
    if (claimState === "unchanged") {
      await finishOutbox(service, outboxEntries, true);
      outboxFinished = true;
      return jsonResponse(request, 200, {
        ok: true, status: "unchanged", mode, requestId, tickets: normalized.tickets.length,
        followups: normalized.followups.length, deletions: selectedDeletions.length, backfilled, verifiedAllocations,
      });
    }
    if (claimState !== "claimed") {
      return jsonResponse(request, 202, {
        ok: true, status: "busy", mode, requestId, retryAfterSeconds: 5,
        tickets: normalized.tickets.length, followups: normalized.followups.length,
        deletions: selectedDeletions.length, backfilled, verifiedAllocations,
      });
    }
    claimed = true;

    const airScriptResult = await callWpsAirScript({
      ...syncData,
      requestId,
      generatedAt: new Date().toISOString(),
    });
    assertWpsDeletionVerification(airScriptResult, selectedDeletions.length);
    await finishOutbox(service, outboxEntries, true);
    outboxFinished = true;
    const finish = await service.rpc("finish_workbook_sync", {
      p_request_id: requestId,
      p_scope_key: scopeKey,
      p_payload_hash: payloadHash,
      p_success: true,
      p_result: airScriptResult,
      p_error_code: null,
      p_error_message: null,
    });
    if (finish.error) throw new IntegrationError(500, "SYNC_FINISH_RECORD_FAILED", finish.error.message);
    claimed = false;
    return jsonResponse(request, 200, {
      ok: true,
      status: "succeeded",
      mode,
      requestId,
      tickets: normalized.tickets.length,
      followups: normalized.followups.length,
      deletions: selectedDeletions.length,
      backfilled,
      verifiedAllocations,
      workbook: airScriptResult,
    });
  } catch (error) {
    const integrationError = error instanceof IntegrationError
      ? error
      : new IntegrationError(500, "UNEXPECTED_SYNC_ERROR", error instanceof Error ? error.message : "未知同步错误");
    if (claimed && service && requestId && scopeKey && payloadHash) {
      try {
        await service.rpc("finish_workbook_sync", {
          p_request_id: requestId,
          p_scope_key: scopeKey,
          p_payload_hash: payloadHash,
          p_success: false,
          p_result: null,
          p_error_code: integrationError.code,
          p_error_message: integrationError.message,
        });
      } catch { /* 保留原始错误返回 */ }
    }
    if (!outboxFinished && service && outboxEntries.length) {
      try {
        await finishOutbox(service, outboxEntries, false, integrationError.code, integrationError.message);
      } catch { /* outbox 原记录仍保留；不覆盖本次主要错误 */ }
    }
    return jsonResponse(request, integrationError.status, {
      ok: false,
      code: integrationError.code,
      message: integrationError.message,
      requestId: requestId || undefined,
      ...(integrationError.details ? { details: integrationError.details } : {}),
    });
  }
});
