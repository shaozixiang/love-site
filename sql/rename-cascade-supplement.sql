-- ============================================================
-- 情侣小站 · 改名级联补丁（P1-06，幂等，可重复执行）
-- 在 docs/change-username-function.sql 的基础上补齐两处遗漏：
--   1. comments jsonb 内每条评论的展示字段 authorName（emoji+旧名）随改名更新
--   2. 各表 “by” 列（如 angry_mode.by）随改名更新
-- 执行方式：Supabase Dashboard → SQL Editor → 整段粘贴 → Run。
-- 说明：本文件以 CREATE OR REPLACE 重写 change_username 函数（与原函数同签名），
--       原逻辑（author/deleted_by/likes/comments.author/email_<用户名>）全部保留，
--       仅在遍历循环中新增 2.5 / 2.6 两段。display 名直接存新用户名（emoji 前缀在
--       改名时丢失，属已知 cosmetic 限制）。
-- ============================================================

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

  -- 2) 遍历 public 下所有业务表，统一替换 author / deleted_by / likes / comments
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

    -- 2.5（新增）comments jsonb 内展示字段 authorName 同步改名（P1-06）
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

    -- 2.6（新增）“by” 列（如 angry_mode.by）同步改名（P1-06）
    if exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = t.table_name
        and column_name = 'by'
    ) then
      execute format('update %I set "by" = $1 where "by" = $2', t.table_name)
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

-- 完成提示
select 'change_username 函数已更新为补丁版（含 authorName / by 级联）' as result;
