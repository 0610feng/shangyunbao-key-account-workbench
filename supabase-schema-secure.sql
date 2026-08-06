begin;

-- 如果旧版脚本曾被执行，先封闭旧表的匿名访问，但不删除任何历史数据。
do $$
declare
  legacy_table text;
begin
  foreach legacy_table in array array['users','issues','knowledge','archives','daily_reports']
  loop
    if to_regclass('public.' || legacy_table) is not null then
      execute format('alter table public.%I enable row level security', legacy_table);
      execute format('revoke all on table public.%I from anon, authenticated', legacy_table);
    end if;
  end loop;
end $$;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text not null,
  name text not null,
  department text not null default '',
  role text not null default 'member' check (role in ('admin','member')),
  can_view_all boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists profiles_username_lower_unique
  on public.profiles (lower(username));

create table if not exists public.workbench_data (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  payload jsonb not null default '{"issues":[],"knowledge":[],"archives":[],"dailySupps":{}}'::jsonb,
  updated_at timestamptz not null default now(),
  constraint payload_is_object check (jsonb_typeof(payload) = 'object')
);

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin'
  );
$$;

revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to authenticated;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  first_account boolean;
  requested_username text;
  requested_name text;
begin
  select not exists(select 1 from public.profiles) into first_account;
  requested_username := coalesce(nullif(trim(new.raw_user_meta_data ->> 'username'), ''), split_part(new.email, '@', 1));
  requested_name := coalesce(nullif(trim(new.raw_user_meta_data ->> 'name'), ''), requested_username);

  insert into public.profiles (id, username, name, department, role, can_view_all)
  values (
    new.id,
    requested_username,
    requested_name,
    coalesce(new.raw_user_meta_data ->> 'department', ''),
    case when first_account then 'admin' else 'member' end,
    first_account
  );

  insert into public.workbench_data (user_id) values (new.id);
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute procedure public.set_updated_at();

drop trigger if exists workbench_data_set_updated_at on public.workbench_data;
create trigger workbench_data_set_updated_at
  before update on public.workbench_data
  for each row execute procedure public.set_updated_at();

alter table public.profiles enable row level security;
alter table public.workbench_data enable row level security;

drop policy if exists profiles_select_own_or_admin on public.profiles;
create policy profiles_select_own_or_admin
  on public.profiles for select to authenticated
  using (id = auth.uid() or public.is_admin());

drop policy if exists profiles_update_admin on public.profiles;
create policy profiles_update_admin
  on public.profiles for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists workbench_select_own_or_admin on public.workbench_data;
create policy workbench_select_own_or_admin
  on public.workbench_data for select to authenticated
  using (user_id = auth.uid() or public.is_admin());

drop policy if exists workbench_insert_own on public.workbench_data;
create policy workbench_insert_own
  on public.workbench_data for insert to authenticated
  with check (user_id = auth.uid());

drop policy if exists workbench_update_own on public.workbench_data;
create policy workbench_update_own
  on public.workbench_data for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists workbench_delete_own on public.workbench_data;
create policy workbench_delete_own
  on public.workbench_data for delete to authenticated
  using (user_id = auth.uid());

revoke all on public.profiles, public.workbench_data from anon;
grant select on public.profiles to authenticated;
grant select, insert, update, delete on public.workbench_data to authenticated;
grant update (name, department, role, can_view_all) on public.profiles to authenticated;

commit;
