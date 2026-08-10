begin;

-- 人员管理使用“软移除”：账号和全部历史业务数据均保留，仅停止继续登录和写入。
alter table public.profiles
  add column if not exists is_active boolean not null default true,
  add column if not exists deactivated_at timestamptz,
  add column if not exists deactivated_by uuid references auth.users(id) on delete set null,
  add column if not exists deactivation_reason text;

create index if not exists profiles_active_lookup_idx
  on public.profiles (is_active, created_at);

create or replace function public.is_active_user()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles
    where id = auth.uid() and is_active = true
  );
$$;

revoke all on function public.is_active_user() from public, anon;
grant execute on function public.is_active_user() to authenticated;

-- 停用后的管理员也不能继续拥有管理权限。
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles
    where id = auth.uid()
      and role = 'admin'
      and is_active = true
  );
$$;

revoke all on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;

create or replace function public.admin_set_member_active(
  p_user_id uuid,
  p_active boolean
)
returns table (
  id uuid,
  is_active boolean,
  deactivated_at timestamptz,
  deactivated_by uuid
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile public.profiles%rowtype;
begin
  if auth.uid() is null or not public.is_admin() then
    raise exception using errcode = '42501', message = 'ADMIN_REQUIRED';
  end if;
  if p_user_id is null or p_active is null then
    raise exception using errcode = '22023', message = 'MEMBER_ACTIVE_ARGUMENT_REQUIRED';
  end if;
  if p_user_id = auth.uid() then
    raise exception using errcode = '22023', message = 'ADMIN_CANNOT_DEACTIVATE_SELF';
  end if;

  select * into v_profile
  from public.profiles
  where public.profiles.id = p_user_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'MEMBER_NOT_FOUND';
  end if;

  update public.profiles as target
  set is_active = p_active,
      deactivated_at = case
        when p_active then null
        when target.is_active then now()
        else target.deactivated_at
      end,
      deactivated_by = case
        when p_active then null
        when target.is_active then auth.uid()
        else target.deactivated_by
      end,
      deactivation_reason = case
        when p_active then null
        when target.is_active then '管理员移除'
        else target.deactivation_reason
      end
  where target.id = p_user_id
  returning target.* into v_profile;

  return query
  select v_profile.id, v_profile.is_active, v_profile.deactivated_at, v_profile.deactivated_by;
end;
$$;

revoke all on function public.admin_set_member_active(uuid, boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.admin_set_member_active(uuid, boolean)
  to authenticated;

-- 已移除成员仍可读取自己的 profile，从而得到明确的“账号已移除”提示；
-- 但其业务数据读写全部由数据库拒绝，不能绕过前端继续操作。
drop policy if exists workbench_select_own_or_admin on public.workbench_data;
create policy workbench_select_own_or_admin
  on public.workbench_data for select to authenticated
  using (
    (user_id = auth.uid() and public.is_active_user())
    or public.is_admin()
  );

drop policy if exists workbench_insert_own on public.workbench_data;
create policy workbench_insert_own
  on public.workbench_data for insert to authenticated
  with check (user_id = auth.uid() and public.is_active_user());

drop policy if exists workbench_update_own on public.workbench_data;
create policy workbench_update_own
  on public.workbench_data for update to authenticated
  using (user_id = auth.uid() and public.is_active_user())
  with check (user_id = auth.uid() and public.is_active_user());

drop policy if exists workbench_delete_own on public.workbench_data;
create policy workbench_delete_own
  on public.workbench_data for delete to authenticated
  using (user_id = auth.uid() and public.is_active_user());

commit;
