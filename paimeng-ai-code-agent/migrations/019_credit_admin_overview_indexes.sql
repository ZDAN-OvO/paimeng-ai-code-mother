-- 额度管理总览的读模型索引（docs/plans/admin-credit-quota.md「总览查询必须只读」）。
-- 总览按 pool 预聚合 credit_entry，再按 charge.create_time 归属账期；charge 侧已有
-- idx_credit_charge_user_time，这里补 entry 侧按池的索引，避免全表扫描后再 join。
-- 只加索引，不改表结构、不写业务数据。
CREATE INDEX IF NOT EXISTS idx_credit_entry_pool_charge ON credit_entry (pool, charge_id);
