import { a } from '@aws-amplify/backend';

/**
 * ChartAggregate — precomputed stats counters for the public charts (#780).
 *
 * Supersedes the nightly proposal in #618 and the client-side windowed
 * aggregation from #80/#81/#499/#500: the stats charts now read precomputed
 * corpus-wide counters straight from this table instead of pulling raw
 * Messages and aggregating in the browser. Full-corpus accuracy, O(1) page
 * load, no client CPU.
 *
 * Rows are counter cells: one per `(metric, dimension)`.
 *   - metric=`daily-count`            dimension=`<YYYY-MM-DD>#<TYPE>`  count=broadcasts
 *   - metric=`char-freq-allstations`  dimension=`<A-Z0-9>`            count=letter occurrences
 *   - metric=`codeword-skyking`       dimension=`<CODEWORD>`          count=appearances
 *   - metric=`callsign-usage`         dimension=`<CALLSIGN>`          count=sender+receiver uses
 *   - metric=`preamble-first2`        dimension=`<XX>`               count=leading-2-char preambles
 *
 * The composite identifier `(metric, dimension)` makes `metric` the partition
 * key, so the web reads a whole chart with a single `list({ metric })` Query
 * (not a Scan). `data` carries any non-counter JSON snapshot a future metric
 * needs without a schema change.
 *
 * Writes come from the `chartAggregator` Lambda via the raw DynamoDB SDK —
 * atomic `UpdateItem ADD` on the event-driven path (Message stream) and an
 * absolute overwrite on the periodic full recompute. It writes through its own
 * IAM execution role, NOT AppSync, so the admin-write rule below only governs
 * human/admin-UI writes (there are none today). Eligibility (exclude
 * soft-deleted / flagged / unpublished) lives in the aggregator, not here.
 *
 * Authz: public-readable (the charts are public). Guests + authenticated users
 * read; only admins write through AppSync.
 */
export const ChartAggregate = a
  .model({
    metric: a.string().required(),
    dimension: a.string().required(),
    count: a.integer(),
    data: a.json(),
    computedAt: a.datetime(),
  })
  .identifier(['metric', 'dimension'])
  .authorization((allow) => [
    allow.guest().to(['read']),
    allow.authenticated().to(['read']),
    allow.groups(['admin']).to(['read', 'create', 'update', 'delete']),
  ]);
