-- ============================================================
-- 情侣小站 · 隐私修复补丁（2026-10-26，幂等，可重复执行）
-- 执行方式：Supabase Dashboard → SQL Editor → 整段粘贴 → Run
-- 项目地址：https://supabase.com/dashboard/project/txeynuvttibnilvttieu/sql/new
-- 包含三部分（全部幂等）：
--   1. change_username 函数补 author_name 列级联（改名后历史动态/留言等显示新名）
--   2. 回刷现有数据：所有含 author_name 列的表，快照与 author 不一致的同步为 author
--   3. 气泡照片隐私：feeds/messages 加 bubble_ok 列、bubble_config 加 photo_scope 列
-- ============================================================

-- ---------- 1. 修正 change_username 函数（新增 2.7 段：author_name 展示列级联） ----------
create or replace function public.change_username(old_name text, new_name text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  t record;
  new_n text;
  has_old boolean;
  has_new boolean;
begin
  -- 1) 基础校验
  new_n := btrim(coalesce(new_name, ''));
  old_name := btrim(coalesce(old_name, ''));

  if old_name = '' or new_n = '' then
    raise exception '用户名不能为空';
  end if;
  if length(new_n) > 64 then
    raise exception '用户名最长 64 个字符';
  end if;
  if new_n !~ '^[A-Za-z0-9_.\-]+$' then
    raise exception '用户名只能包含字母、数字、下划线、点、减号';
  end if;
  if new_n = 'admin' then
    raise exception '该用户名不可用，请更换';
  end if;

  select exists(select 1 from public.users where username = old_name) into has_old;
  if not has_old then
    raise exception '原用户不存在：%', old_name;
  end if;

  select exists(select 1 from public.users where username = new_n) into has_new;
  if has_new then
    raise exception '该用户名已被占用：%', new_n;
  end if;

  if new_n = old_name then
    raise exception '新用户名与当前相同';
  end if;

  -- 2) 遍历 public 下所有业务表，统一替换 author / deleted_by / likes / comments / author_name / by
  for t in
    select table_name
    from information_schema.tables
    where table_schema = 'public'
      and table_type = 'BASE TABLE'
  loop
    -- 日志表保留审计历史，不做改动；users 主键与 site_config 单独处理
    if t.table_name in ('admin_logs', 'logs', 'users', 'site_config') then
      continue;
    end if;

    -- 2.1 单值 author 列
    if exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = t.table_name
        and column_name = 'author'
    ) then
      execute format('update %I set author = $1 where author = $2', t.table_name)
      using new_n, old_name;
    end if;

    -- 2.2 软删除记录人 deleted_by
    if exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = t.table_name
        and column_name = 'deleted_by'
    ) then
      execute format('update %I set deleted_by = $1 where deleted_by = $2', t.table_name)
      using new_n, old_name;
    end if;

    -- 2.3 likes：可能是 jsonb 数组，也可能是 Postgres 原生数组 text[]，两种都处理
    if exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = t.table_name
        and column_name = 'likes' and data_type in ('jsonb', 'json')
    ) then
      execute format(
        'update %I set likes = (
           select coalesce(jsonb_agg(case when e::text = to_jsonb($2)::text
                                         then to_jsonb($1) else e end),
                           ''[]''::jsonb)
           from jsonb_array_elements(coalesce(likes::jsonb, ''[]''::jsonb)) as e
         )
         where exists (
           select 1 from jsonb_array_elements(likes::jsonb) as e2
           where e2::text = to_jsonb($2)::text
         )',
        t.table_name
      )
      using new_n, old_name;
    elsif exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = t.table_name
        and column_name = 'likes' and data_type = 'ARRAY'
    ) then
      execute format(
        'update %I set likes = array_replace(likes, $2, $1) where $2 = any(likes)',
        t.table_name
      )
      using new_n, old_name;
    end if;

    -- 2.4 comments：jsonb/json 对象数组，替换每个对象里的 author 字段
    if exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = t.table_name
        and column_name = 'comments' and data_type in ('jsonb', 'json')
    ) then
      execute format(
        'update %I set comments = (
           select coalesce(jsonb_agg(case when e->>''author'' = $2
                                         then jsonb_set(e, ''{author}'', to_jsonb($1))
                                         else e end),
                           ''[]''::jsonb)
           from jsonb_array_elements(coalesce(comments::jsonb, ''[]''::jsonb)) as e
         )
         where comments::jsonb @> jsonb_build_array(jsonb_build_object(''author'', $2))',
        t.table_name
      )
      using new_n, old_name;
    end if;

    -- 2.5 comments jsonb 内展示字段 authorName 同步改名
    if exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = t.table_name
        and column_name = 'comments' and data_type in ('jsonb', 'json')
    ) then
      execute format(
        'update %I set comments = (
           select coalesce(jsonb_agg(case when e->>''author'' = $2
                                         then jsonb_set(jsonb_set(e, ''{author}'', to_jsonb($1)),
                                                        ''{authorName}'', to_jsonb($1))
                                         else e end),
                           ''[]''::jsonb)
           from jsonb_array_elements(coalesce(comments::jsonb, ''[]''::jsonb)) as e
         )
         where comments::jsonb @> jsonb_build_array(jsonb_build_object(''author'', $2))',
        t.table_name
      )
      using new_n, old_name;
    end if;

    -- 2.6 “by” 列（如 angry_mode.by）同步改名
    if exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = t.table_name
        and column_name = 'by'
    ) then
      execute format('update %I set "by" = $1 where "by" = $2', t.table_name)
      using new_n, old_name;
    end if;

    -- 2.7（新增）author_name 展示快照列同步改名（P0 修复：改名后历史内容仍显示旧名）
    if exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = t.table_name
        and column_name = 'author_name'
    ) then
      execute format('update %I set author_name = $1 where author = $2 and author_name is not null', t.table_name)
      using new_n, old_name;
    end if;
  end loop;

  -- 3) 通知配置键 email_<用户名>
  update public.site_config
     set key = 'email_' || new_n
   where key = 'email_' || old_name;

  -- 4) 最后修改 users 主键（users.username 是主键）
  update public.users set username = new_n where username = old_name;

  return jsonb_build_object('ok', true, 'old', old_name, 'new', new_n);
end;
$$;

-- 允许后端 service_role 调用
grant execute on function public.change_username(text, text) to service_role;

-- ---------- 2. 回刷现有数据：所有含 author_name 列的表同步为 author ----------
do $$
declare
  t record;
begin
  for t in
    select table_name
    from information_schema.columns
    where table_schema = 'public'
      and column_name = 'author_name'
      and table_name in ('feeds', 'messages', 'loves', 'memories', 'memos', 'schedules', 'countdowns', 'travel_markers')
  loop
    execute format(
      'update %I set author_name = author where author is not null and author_name is distinct from author',
      t.table_name
    );
  end loop;
end;
$$;

-- ---------- 3. 气泡照片隐私 ----------
-- feeds/messages 逐条控制：该条内容的照片是否允许进入梦幻气泡（默认允许）
alter table public.feeds add column if not exists bubble_ok boolean default true;
alter table public.messages add column if not exists bubble_ok boolean default true;

-- bubble_config 全局照片范围：all=全部（留言板+相册）/ feeds=仅相册 / messages=仅留言板 / none=不显示照片气泡
alter table public.bubble_config add column if not exists photo_scope text default 'all';

-- 完成提示
select '隐私修复补丁执行完成（改名级联 author_name + 数据回刷 + 气泡隐私列）' as result;
