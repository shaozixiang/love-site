-- =====================================================================
-- 可选加固：把匿名角色 anon 收紧为只读（与 Supabase 2025-10-30 新默认一致）
-- ---------------------------------------------------------------------
-- 背景：本站历史上对 public 表执行过 GRANT ALL ... TO anon，导致 anon
--       拥有 DELETE/INSERT/UPDATE/TRUNCATE 等写/DDL 权限。
--       虽然所有表已开启 RLS 且无匿名策略（写操作会被 RLS 拒绝），
--       但表级权限偏宽，不符合最小权限原则。
--
-- 安全性：不影响网站功能——
--   - 前端所有数据请求走 /api/db 代理，服务端用 service_role；
--   - GitHub Actions 保活只需 anon SELECT site_config；
--   - 没有使用 Supabase Auth，authenticated 角色无实际用户。
--   - 本站表均为 uuid 主键，无序列，故不处理序列权限。
--
-- 用法：Supabase SQL Editor 整段粘贴运行，可重复执行（幂等）。
--       运行后核对：anon 应全部只剩 SELECT。
-- =====================================================================

-- 1) 收回 anon 在现有表上的全部权限，只保留 SELECT
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO anon;

-- 2) 同步默认权限：以后 postgres 新建的表，anon 也只自动获得 SELECT
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON TABLES FROM anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT SELECT ON TABLES TO anon;

-- 3) （可选）authenticated 收紧为标准读写。本站未用 Supabase Auth，
--    此角色无实际用户，收紧仅为权限干净；如不想动可注释掉本段。
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON TABLES FROM authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO authenticated;

-- 4) 核对：anon 应全部为 SELECT；authenticated 为 DELETE/INSERT/SELECT/UPDATE
SELECT grantee, table_name,
       string_agg(privilege_type, ', ' ORDER BY privilege_type) AS grants
FROM information_schema.role_table_grants
WHERE table_schema = 'public'
  AND grantee IN ('anon', 'authenticated', 'service_role')
GROUP BY grantee, table_name
ORDER BY table_name, grantee;
