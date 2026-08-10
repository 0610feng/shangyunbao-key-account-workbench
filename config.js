// Supabase 的 publishable key 是浏览器端公开配置；真正的数据安全由数据库 RLS 策略保证。
window.WORKBENCH_CONFIG = {
  supabaseUrl: 'https://leinudkgnwyqrdsyxmmw.supabase.co',
  supabaseAnonKey: 'sb_publishable_B17k675ocK4NGfz-5wSnDA_LTJjg_Z-',
  // 已在备份云表格完成编号、字段、幂等、保护及真实链路验证后启用。
  ticketNumberingEnabled: true,
  ticketNumberRpc: 'allocate_ticket_no',
  workbookSyncEnabled: true,
  workbookSyncFunction: 'kdocs-workbook-sync'
};
