-- =====================================================================
-- 适配 Supabase 2025-10-30 变更：public 新建表不再自动授予 Data API 权限
-- ---------------------------------------------------------------------
-- 背景：2025-10-30 起，在 public schema 中【新创建】的表不再自动拥有
--       anon / authenticated / service_role 的访问授权；
--       若不手动 GRANT，supabase-js / PostgREST / GraphQL 会报
--       "permission denied"。现有表不受影响，本脚本用于：
--         1) 给现有表补齐默认授权（保险，幂等）；
--         2) 用 ALTER DEFAULT PRIVILEGES 让【以后新建的表自动获得授权】，
--            一劳永逸，覆盖新建项目 / preview 分支 / supabase db reset。
--
-- 安全说明：本脚本只改“API 能否到达表”，不改变行级安全（RLS）。
--          本站所有表均已开启 RLS 且不开放匿名策略，数据可见性仍由
--          RLS + Cloudflare 服务端代理（service_role）控制，GRANT 不会
--          造成数据泄露。
--
-- 用法：Supabase 控制台 → SQL Editor → 整段粘贴 → Run。可重复执行。
-- =====================================================================

-- 0) 确保 public schema 本身可访问
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

-- 1) 现有表：补齐与 Supabase 历史默认一致的 Data API 授权
--    （本站现有 15 张表：feeds, messages, loves, memories, memos,
--      schedules, countdowns, travel_markers, users, bubble_config,
--      bubble_photos, angry_mode, apologies, admin_logs, site_config）
GRANT SELECT                                  ON ALL TABLES IN SCHEMA public TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE          ON ALL TABLES IN SCHEMA public TO authenticated;
GRANT ALL                                     ON ALL TABLES IN SCHEMA public TO service_role;

-- 2) 现有序列（若有自增/serial 列）授权
GRANT USAGE, SELECT                           ON ALL SEQUENCES IN SCHEMA public TO anon;
GRANT USAGE, SELECT, UPDATE                   ON ALL SEQUENCES IN SCHEMA public TO authenticated;
GRANT ALL                                     ON ALL SEQUENCES IN SCHEMA public TO service_role;

-- 3) 【关键】默认权限：以后 postgres 角色在 public 新建的表/序列
--    自动获得上述授权，彻底免疫 10-30 变更，新建表后无需再手动 GRANT。
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT SELECT ON TABLES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT ALL ON TABLES TO service_role;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT ALL ON SEQUENCES TO service_role;

-- 4) 可选核对：执行后查看三张角色对每张表的列级授权是否齐全
--    （priv 类型分别为 anon / authenticated / service_role，
--      SELECT 列应为 true；service_role 的 INSERT/UPDATE/DELETE 也应为 true）
SELECT grantee, table_name,
       string_agg(privilege_type, ', ' ORDER BY privilege_type) AS grants
FROM information_schema.role_table_grants
WHERE table_schema = 'public'
  AND grantee IN ('anon', 'authenticated', 'service_role')
GROUP BY grantee, table_name
ORDER BY table_name, grantee;
