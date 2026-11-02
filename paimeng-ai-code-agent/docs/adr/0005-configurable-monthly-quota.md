# Make the monthly quota a versioned policy, not a constant

- Status: accepted
- Date: 2026-11-02

## Context

[ADR-0004](0004-credit-billing.md) fixed the quota at 500 Credit per user per Beijing month. The
admin surface now needs two things ADR-0004 does not cover: a different default for future months,
and per-user overrides that can be zero. A zero quota is not the same fact as “no override”; the
latter must inherit the global default. Reusing the purchase/admin-grant entry points would either
violate the positive-amount grant constraint or make a quota look like money in the balance pool.
Retroactively editing a past month would also change what users already saw and spent.

## Decision

**A quota policy is an append-only version.** Each row carries `scope` (`global` or `user`),
`effective_period` (Beijing month), `mode` (`override` or, for users only, `inherit`), `credits`,
and a monotonically increasing `revision` within its `(scope, user, effective_period)` key.
Resolution for a target month takes the latest row with `effective_period <= target`, then the
highest revision. No saved policy means the code fallback of 500, recorded as source `fallback`.

**Policies only take effect in future months.** Current-month changes go through the separate
single-user adjustment path (C3), so a policy save cannot rewrite a month that may already have
been issued. Changing the global default does not touch an already issued month.

**The issuance fact is `credit_quota_issue`, one row per user and month.** It stores the resolved
base amount, policy source/version, status, and the linked `monthly_quota` grant when the amount is
positive. A zero amount still writes an issue row and no grant; this is what prevents the lazy path
from falling back to 500 the next time it runs. Existing `monthly_quota` grants are backfilled as
`legacy` issue rows and are never reinterpreted under a later policy.

**Every issuance entry point resolves the same policy.** Registration, reading the summary, the
admin entry, the CLI, and the future batch preview all call the same `ensurePeriodQuota`. The
existing `(user_id, period)` unique index remains the final idempotency guard.

## Alternatives considered

- **One mutable policy row per scope**: simple, but loses the audit trail and makes concurrent
  saves silently overwrite each other. Rejected; version rows plus `expectedRevision` return 409.
- **Reuse `credit_grant` with source `monthly_quota` for zero**: the 010 migration requires grant
  amounts to be positive. Weakening that constraint would make the ledger unable to distinguish
  “granted zero” from “not issued”.
- **Reuse `admin_grant` for overrides**: it lands in the balance pool and would bypass the
  quota-first deduction and monthly expiry rules.
- **Edit the old month when the default changes**: users may already have spent that quota, and
  historical bills would stop matching the policy that produced them. Rejected.

## Consequences

- `docs/billing-operations.md` must describe policy/issue tables rather than a single constant.
- The admin read model must read `credit_quota_issue.base_credits`; summing grants alone would miss
  zero quotas and would disagree with a later policy change.
- A quota balance is now `max(0, base + adjustments - quota-period consumption)`. The adjustment
  term is introduced in C3 and used by settlement, summary, overview, audit, and rebuild.
- There is still no scheduler. The policy is resolved lazily, and an external cron can call the
  existing `billing:quota-issue` CLI. The admin page must not claim a month-start scheduler exists.
