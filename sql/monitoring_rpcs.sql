-- ============================================================
-- 情侣小站 · 监控聚合 RPC（幂等，可重复执行）
-- 用途：/api/monitor 通过 service_role 调用这两个函数，
--       避免在 Function 里写复杂聚合 SQL，同时把统计权限收敛在 DB 内。
-- 执行方式：Supabase Dashboard → SQL Editor → 粘贴本文件 → Run。
-- 注意：admin_logs 的用户列名是 "user"（保留字，SQL 中必须加双引号）。
-- ============================================================

-- 1) 表大小与行数估算 --------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_table_sizes()
RETURNS TABLE (
  table_name      text,
  total_size_mb   numeric,
  rows_estimate   bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
  RETURN QUERY
  SELECT
    t.relname::text                                                    AS table_name,
    round(pg_total_relation_size(t.oid)::numeric / 1024.0 / 1024.0, 2) AS total_size_mb,
    COALESCE(c.reltuples, 0)::bigint                                    AS rows_estimate
  FROM pg_class t
  JOIN pg_namespace n ON n.oid = t.relnamespace
  LEFT JOIN pg_class c ON c.oid = t.oid
  WHERE n.nspname = 'public'
    AND t.relkind IN ('r', 'p')
  ORDER BY pg_total_relation_size(t.oid) DESC;
END;
$$;

REVOKE ALL ON FUNCTION public.get_table_sizes() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_table_sizes() TO service_role;

-- 2) 访问审计聚合（最近 7 天 + 最近 200 条明细） ------------------------------
CREATE OR REPLACE FUNCTION public.get_access_stats()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_recent    jsonb;
  v_by_user   jsonb;
  v_by_action jsonb;
  v_day7      jsonb;
BEGIN
  -- 最近 200 条明细（Function 侧再做 details 脱敏）
  SELECT jsonb_agg(row_to_json(t)) INTO v_recent
  FROM (
    SELECT action, "user", details, created_at
    FROM public.admin_logs
    ORDER BY created_at DESC
    LIMIT 200
  ) t;

  SELECT jsonb_agg(jsonb_build_object('user', "user", 'count', cnt)) INTO v_by_user
  FROM (
    SELECT "user", count(*) AS cnt
    FROM public.admin_logs
    GROUP BY "user"
    ORDER BY cnt DESC
    LIMIT 20
  ) t;

  SELECT jsonb_agg(jsonb_build_object('action', action, 'count', cnt)) INTO v_by_action
  FROM (
    SELECT action, count(*) AS cnt
    FROM public.admin_logs
    GROUP BY action
    ORDER BY cnt DESC
    LIMIT 30
  ) t;

  SELECT jsonb_agg(jsonb_build_object('date', to_char(d, 'MM-DD'), 'count', cnt)) INTO v_day7
  FROM (
    SELECT generated::date AS d, count(*) AS cnt
    FROM (
      SELECT created_at::date AS generated
      FROM public.admin_logs
      WHERE created_at >= now() - interval '7 days'
    ) x
    GROUP BY generated
    ORDER BY generated
  ) t;

  RETURN jsonb_build_object(
    'recent',    COALESCE(v_recent,    '[]'::jsonb),
    'byUser',    COALESCE(v_by_user,   '[]'::jsonb),
    'byAction',  COALESCE(v_by_action, '[]'::jsonb),
    'day7',      COALESCE(v_day7,      '[]'::jsonb)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_access_stats() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_access_stats() TO service_role;
