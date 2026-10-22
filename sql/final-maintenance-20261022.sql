-- ============================================================
-- 情侣小站 · 收尾维护 SQL（2026-10-22，幂等，可重复执行）
-- 执行方式：Supabase Dashboard → SQL Editor → 粘贴本文件 → Run
-- 项目地址：https://supabase.com/dashboard/project/txeynuvttibnilvttieu/sql/new
-- 本文件共 3 步，全部为安全的幂等语句；执行完无需重启任何服务。
-- 另需依次执行两个独立脚本（已在本文件末尾给出说明）：
--   sql/monitoring_rpcs.sql          （监控仪表盘“表大小/访问统计”取数）
--   sql/rename-cascade-supplement.sql（改名级联补丁）
-- ============================================================

-- 步骤 1：删除 users 表遗留的明文 password 列（安全扫描 high 项）
-- 现行登录只使用 password_hash/password_salt，该列是历史遗留的明文密码，
-- 任何持有 service role 的调用都能读到。删除不影响登录（含旧 SHA-256 账号，
-- 哈希存在 password_hash/password_salt 中）。
ALTER TABLE public.users DROP COLUMN IF EXISTS password;

-- 步骤 2：将遗留的 couple-media Storage 桶改为私有（安全扫描 medium 项）
-- 站点图片/视频实际存放在 GitHub 私密图仓 couple-images，Supabase Storage 未被
-- 业务使用；该桶当前为 public，桶内（若有）任何对象可被未授权用户直接访问。
-- 若确认桶内为空（Dashboard → Storage 查看），可在控制台直接删除该桶；
-- 不删除则执行下句把它改为私有，效果等价。
UPDATE storage.buckets
SET public = false
WHERE name = 'couple-media'
  AND public = true;

-- 步骤 3：复核（可选）。执行后查询结果应返回 false 与 NOTICE：
-- SELECT name, public FROM storage.buckets WHERE name = 'couple-media';
-- NOTICE: column "password" of relation "public.users" does not exist, skipping
-- （第二次执行时出现，说明列已删除，属正常）

-- ============================================================
-- 执行完本文件后，请继续依次执行：
--   1) sql/monitoring_rpcs.sql            监控仪表盘表大小/访问统计 RPC
--   2) sql/rename-cascade-supplement.sql  改名级联补丁（comments.authorName / by 列）
-- 两个文件均为 CREATE OR REPLACE，幂等。
-- ============================================================
