// Supabase 的 publishable key 是浏览器端公开配置；真正的数据安全由数据库 RLS 策略保证。
window.WORKBENCH_CONFIG = {
  supabaseUrl: 'https://leinudkgnwyqrdsyxmmw.supabase.co',
  supabaseAnonKey: 'sb_publishable_B17k675ocK4NGfz-5wSnDA_LTJjg_Z-',
  // 已在备份云表格完成编号、字段、幂等、保护及真实链路验证后启用。
  ticketNumberingEnabled: true,
  ticketNumberRpc: 'allocate_ticket_no',
  workbookSyncEnabled: true,
  workbookSyncFunction: 'kdocs-workbook-sync',
  // 双向回写只在数据库迁移、Edge Function和WPS AirScript全部完成备份环境验收后开启。
  // 关闭时仍保持现有“客户管家台 -> WPS”单向同步，不会改变正式表。
  workbookBidirectionalEnabled: false,
  workbookBidirectionalFunction: 'kdocs-workbook-ingest',
  workbookBidirectionalPollMs: 30000
};
