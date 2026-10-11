-- ============================================================
-- 情侣小站 · 回收站功能字段迁移
-- 作用：给所有内容表增加“软删除”字段，删除内容时不物理删除：
--   deleted_at  为空 = 正常显示；有时间 = 已在回收站
--   deleted_by  记录是谁删除的（账号名）
-- 本脚本只新增可空字段，不删除、不修改任何现有字段与数据，安全可重复执行。
-- 在 Supabase → SQL Editor 中整段粘贴运行即可。
-- ============================================================

alter table public.feeds          add column if not exists deleted_at timestamptz;
alter table public.feeds          add column if not exists deleted_by text;

alter table public.messages       add column if not exists deleted_at timestamptz;
alter table public.messages       add column if not exists deleted_by text;

alter table public.loves          add column if not exists deleted_at timestamptz;
alter table public.loves          add column if not exists deleted_by text;

alter table public.memories       add column if not exists deleted_at timestamptz;
alter table public.memories       add column if not exists deleted_by text;

alter table public.memos          add column if not exists deleted_at timestamptz;
alter table public.memos          add column if not exists deleted_by text;

alter table public.schedules      add column if not exists deleted_at timestamptz;
alter table public.schedules      add column if not exists deleted_by text;

alter table public.countdowns     add column if not exists deleted_at timestamptz;
alter table public.countdowns     add column if not exists deleted_by text;

alter table public.travel_markers add column if not exists deleted_at timestamptz;
alter table public.travel_markers add column if not exists deleted_by text;

alter table public.apologies      add column if not exists deleted_at timestamptz;
alter table public.apologies      add column if not exists deleted_by text;

-- 为回收站列表查询建索引（可选，数据量大时加快后台加载）
create index if not exists idx_feeds_deleted_at          on public.feeds(deleted_at);
create index if not exists idx_messages_deleted_at       on public.messages(deleted_at);
create index if not exists idx_loves_deleted_at          on public.loves(deleted_at);
create index if not exists idx_memories_deleted_at       on public.memories(deleted_at);
create index if not exists idx_memos_deleted_at          on public.memos(deleted_at);
create index if not exists idx_schedules_deleted_at      on public.schedules(deleted_at);
create index if not exists idx_countdowns_deleted_at     on public.countdowns(deleted_at);
create index if not exists idx_travel_markers_deleted_at on public.travel_markers(deleted_at);
create index if not exists idx_apologies_deleted_at      on public.apologies(deleted_at);
