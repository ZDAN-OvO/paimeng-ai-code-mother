# One append-only Credit ledger, with expiry as an entry

- Status: accepted
- Date: 2026-11-03
- Supersedes: ADR-0004's “Two pools, deducted quota first” section and ADR-0005's issue/grant fact model.

## Context

ADR-0004 introduced two pools (`quota` / `balance`) because monthly allowances and purchased
Credit behave differently: one resets, one accumulates, only one may go negative. ADR-0005 then
made the monthly amount a versioned policy and added a separate issuance fact (`credit_quota_issue`),
a separate adjustment table, and a batch preview/receipt pair. Each decision was locally reasonable,
but the combination produced six tables describing one quantity, and an admin page with ten
sections.

The user-visible consequence: every balance had to be explained as “quota + balance”, every
allocation rule as “quota first”, and every admin action as “which table does this write?” The
prototype review (`docs/prototypes/archive/credit-ledger/`) picked a master-detail ledger: the
admin opens a person, reads the flows, and sees why the number is what it is.

## Decision

**One append-only table, `credit_ledger`, is the only truth for a user's Credit.**

```
kind     quota | topup | grant | consume | refund | expire
origin   rule | manual | payment | charge | expiry | reversal
credits  signed: consume/expire negative, refund positive
period   'YYYY-MM' for quota and everything carved out of it
expires_at  set on quota and on the consumes/refunds/expires that belong to that bucket
```

`kind` says what happened; `expires_at` says whether the Credit is limited. “Limited” and “lasting”
are therefore two views of one sum, not two pools:

- available = Σ credits (negative is a debt and is allowed);
- limited = Σ of buckets whose `expires_at` is still in the future;
- lasting = available − limited.

**Deduction order is by expiry.** Settlement consumes the bucket that expires first; a charge that
crosses buckets writes one `consume` row per bucket, so a bill still shows “how much of this was
limited Credit”.

**Expiry is a real entry, not a derived line.** At the Beijing month boundary the remainder of the
previous period is written as one negative `expire` row (`origin='expiry'`, one per user and period,
enforced by a partial unique index). Writing it has three paths:

1. lazily, whenever that user's balance is read or written (summary, admin detail, settlement,
   manual issue, reversal);
2. `npm run billing:expire`, an idempotent sweep suitable for an external cron;
3. a read-model correction: list queries subtract remainders of periods whose expiry row has not
   been written yet, so a lagging sweep never overstates a balance.

The writer and the read correction share one SQL definition of “remainder of a finished period”.

**Reversal inherits the original bucket.** A `refund` copies the original `period` / `expires_at`
instead of deciding whether the bucket is still current. If the bucket has already expired, the
same transaction also writes an `origin='reversal'` `expire` row of the same amount, so the refund
is visible in the ledger but does not resurrect Credit that should be gone.

**Rules stay a versioned policy.** `credit_quota_policy` remains exactly as ADR-0005 defined it;
what changes is that issuing it writes a `quota` / `rule` row instead of an issue row plus a grant.
Zero-amount issuance also writes a row (`credits = 0`) so “already handled this month” is a fact,
not an amount comparison; the owner-facing ledger hides zero rows, the admin ledger greys them.

**Batches lose preview and per-user receipts.** Issuing pending users is idempotent, so a preview
token and a receipt table buy nothing. One `credit_operation` row per batch records who ran it,
the counts, the total, and up to 200 failure reasons. It is a summary, not a second truth: the
amounts and recipients are the ledger rows sharing its `request_id`.

## Alternatives considered

- **Keep two pools and only redesign the page**: the page would still have to explain two numbers
  and two deduction rules; the prototype immediately needed the ledger model to render a single
  “why” column. Rejected.
- **Derive expiry without writing rows**: simpler writes, but the ledger could not answer “why did
  this month drop by 500?” and the boundary would depend on a scheduled job anyway. The user chose
  explicit rows.
- **Write expiry only from a cron**: balances would be wrong between the boundary and the run, and
  a missed run would be invisible. Rejected in favour of lazy write + read correction + sweep.
- **Keep `credit_quota_issue` as the “already issued” marker**: that is the same fact as the rule
  row, and keeping both re-creates the two-sources problem. Rejected.
- **Let reversal decide “is this still the current period?”**: this special case exists only to
  protect pool semantics; inheriting `expires_at` removes it.

## Consequences

- Settlement and reversal now lock one `credit_balance` row instead of two `credit_account` rows;
  the lock order question disappears.
- `credit_balance` remains a snapshot (`available`, `next_expiry_at`) and is still not the truth;
  it is recomputed from the ledger inside the lock and reported by reconciliation.
- A charge's entries are ledger rows with `charge_id`; `credit_charge.credits` stays a projection.
- `credit_grant`, `credit_entry`, `credit_account`, `credit_quota_issue`, `credit_quota_adjustment`
  and the batch pair become read-only after migration 024 and are dropped in 025 after a release.
- The admin page becomes one master-detail screen; the “quota management” tab, preview/execute/retry
  and per-user receipt tables disappear.
- Internal identifiers keep the `credit_*` prefix; user-facing copy says 积分 / 限时积分 / 长期积分.
