-- Supabase 权限字段修复 SQL
-- 使用方法：Supabase 左侧 SQL Editor -> New query -> 粘贴这段 -> Run

-- 1. 给 users 表补权限字段：full=完整权限，comment=仅评论/点赞，view=仅浏览
alter table public.users
add column if not exists permission text default 'full';

-- 2. 给 users 表补角色字段：admin=管理员，user=普通用户
alter table public.users
add column if not exists role text default 'user';

-- 3. 在线状态字段：网站的在线/离线显示会用到
alter table public.users
add column if not exists last_active timestamptz;

alter table public.users
add column if not exists is_online boolean default false;

-- 4. 把空值补成默认值
update public.users
set permission = 'full'
where permission is null;

update public.users
set role = case when username = 'admin' then 'admin' else coalesce(role, 'user') end
where role is null or username = 'admin';

-- 5. 如果字段以前乱填过，这里统一修正成合法值
update public.users
set permission = 'full'
where permission not in ('view', 'comment', 'full');

update public.users
set role = 'user'
where role not in ('user', 'admin') and username <> 'admin';

-- 6. 可选：加约束，防止以后写入奇怪值。
-- 如果执行时报 constraint already exists，说明已经有了，可以忽略。
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'users_permission_check'
  ) then
    alter table public.users
    add constraint users_permission_check
    check (permission in ('view', 'comment', 'full'));
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'users_role_check'
  ) then
    alter table public.users
    add constraint users_role_check
    check (role in ('user', 'admin'));
  end if;
end $$;

-- 7. 看看当前用户权限是否正常
select username, permission, role, last_active, is_online
from public.users
order by username;
