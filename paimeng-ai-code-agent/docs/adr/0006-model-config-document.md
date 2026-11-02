# Store model configuration and explicit CNY token prices in one JSON document

- Status: accepted
- Date: 2026-11-02
- Partially supersedes: [ADR-0004](0004-credit-billing.md), selling-price source and price-history storage only

## Context

Providers, model identity, slot assignments and selling prices form one small configuration aggregate. Editing them through separate provider/alias tables and a Rate card administration page makes it possible to configure a price that no assigned model can use. The proposed relational expansion in [provider-model-billing](../plans/provider-model-billing.md) would add more business tables and preserve that separate pricing workflow. The chosen design keeps this aggregate in PostgreSQL as JSONB and makes each provider model own its explicit selling-price versions.

ADR-0004 fixed the Credit denomination and tied selling prices to 3x upstream peak USD cost. The denomination remains useful; a fixed multiplier and an exchange-rate calculation are no longer the selling-price policy. Admins must be able to enter CNY prices directly, including when upstream cost is unknown.

## Decision

**One document is the model configuration authority.** The `app_config` row with `key='model_config'` stores `revision`, `refresh_epoch`, `updated_at` and a `value` JSONB document. The document has `schemaVersion`, `providers` (each with connection configuration, credentials references or ciphertext, and nested models), `slots` (model IDs and call settings), and `legacyPrices` for migrated prices that cannot be associated with current models. There are no separate provider/model/slot/price business tables in the new write path. Slot definitions and their required capabilities remain code constants.

**Provider models have independent identities.** Each model has a stable `pm_...` ID, an upstream request name unique within its provider, capabilities and price history. The same upstream name at two providers represents two models and can have two prices. Slot assignments select a model ID; provider connection details and model capabilities are shared, while call settings belong to the assignment. Existing runtime alias types are compatibility projections of assignments, not a second configuration source.

**Selling prices are explicit CNY token prices.** Each model's `prices` array contains append-only versions with `version`, UTC `effectiveAt`, `currency='CNY'`, `inputMissFen`, `inputHitFen` and `outputFen`. Values are non-negative integer fen per 1M tokens; the three values cannot all be zero. The UI displays yuan per 1M tokens. Because 1 Credit = ¥0.01 = 1 fen, a stored price of 600 means ¥6 / 1M tokens and 600 Credit / 1M tokens. Settlement sums token × price and rounds once at the charge-total boundary.

There is no multiplier or exchange-rate input in the selling-price flow. Optional upstream USD prices are reference/cost data and never generate or change the CNY selling price. This replaces ADR-0004's Rate card selling-price administration, 3x Markup policy and implied price ratios. It does not change the fixed Credit denomination, token-only charging scope, settlement/reversal rules, quota rules or overdraft policy.

**A price change appends a version.** The admin mutation generates a monotonically increasing version and an effective time at save (or the previous latest time + 1 ms to avoid collisions). It does not offer backdating or scheduling. Migrated versions retain their original effective times, including future versions. Billing selects the latest version not later than each step's time; missing prices remain `unpriced`/`partial`. A newly assigned slot requires an enabled provider/model, the required capabilities and a currently effective price. Initialization may create required assignments without prices; these still need explicit pricing before normal use.

**Concurrency and validity belong to the server.** A mutation locks the single row, checks `expectedRevision`, validates the complete candidate document, then increments `revision`. `applyImmediately` additionally increments `refresh_epoch`; a separate apply operation only increments the epoch. Versions are decimal strings over HTTP. JSONB provides atomic storage, but nested uniqueness, references and slot requirements need application validation rather than relational foreign keys. Invalid references cannot be silently repaired by choosing another model.

**Historical billing snapshots remain authoritative.** `credit_charge.usage_snapshot`, `rate_card_snapshot` and cost data retain the values applied to already priced steps. The legacy snapshot field names and billing view types remain for compatibility; they do not imply a live Rate card table. Changing the document, switching a slot, rotating a key or adding a price must not reprice those steps. Reconciliation may append facts for unpriced or late steps and update charge projections, but cannot rewrite an already priced step's applied price. Refunds remain compensating entries. The JSON price history is configuration, not a substitute for independent charge/ledger records.

**Legacy configuration tables survive one release.** Migration 023 introduces the carrier row; reviewed backfill copies existing configuration and prices before Next and harness switch together. `model_provider`, `model_alias`, `model_config_state` and `credit_rate_card` are retained for one release as rollback evidence and are no longer runtime read/write sources. There is no ongoing dual write. Removing them requires a later migration after rollback review. Backfill must preserve historical amounts, snapshots and entries and must not initiate settlement.

## Alternatives considered

- **Relational provider/model/slot/price tables:** database constraints and independent writes scale better, but add schema and join complexity to a small, jointly edited configuration aggregate. The superseded P1–P6 plan must not be merged.
- **Keep Rate card administration alongside model editing:** preserves the old workflow but leaves two places to manage one model's selling price and encourages disconnected identity strings.
- **Compute selling price from USD × multiplier × exchange rate:** reduces manual entry but makes the selling-price policy depend on cost availability and implicit currency assumptions. Explicit CNY values are reviewable and remain independent of upstream references.
- **Read current prices when displaying old bills:** avoids storing snapshots but changes historical meaning after every edit. Rejected; applied prices must remain independently auditable.

## Consequences

- All configuration edits contend on one row and share one revision. Concurrent editors reload after a 409; independent per-provider writes are not supported.
- The document grows with model and price history. Its byte size is visible to Admin; historical charges stay outside it. This design is for the current configuration scale, not an unbounded usage ledger.
- Legacy unassociated prices stay in `legacyPrices`; they must not appear as a current model's configured price. Billing retains its existing provider/name compatibility resolution; the abandoned plan's new step-ID schema is not part of this decision.
- Price correction for old unpriced usage needs a reviewed migration/repair procedure: the admin save cannot backdate a price. Operators must not overwrite historical charge snapshots or edit retained legacy tables to make the new runtime see a price.
- Migration and rollback are gated by a reviewed backfill and verification of both configuration and unchanged billing facts. Retaining old tables alone does not make rollback lossless after JSON edits or new charges.

Implementation contracts: [model document](../../src/shared/model-document.ts), [configuration store](../../src/server/models/store.ts), [JSON price reader](../../src/server/billing/rate-card.ts), [migration 023](../../migrations/023_app_config_model_config.sql). Operations: [model configuration](../provider-convergence.md), [billing and migration runbook](../billing-operations.md). Historical UI exploration: [deprecated provider-pricing prototype](../prototypes/deprecated/provider-pricing/README.md).
