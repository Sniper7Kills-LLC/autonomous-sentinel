'use client';

import { filtersToAppSyncFilter, type MessageFilters } from './filters';
import { listMessagesWithFilter } from './query';
import type { ListResult } from './types';

/**
 * Search filters reuse the browse dimensions (type + date range). The
 * free-text query is layered on top as an OR of `contains` across the
 * Message's text fields.
 */
export type SearchFilters = Pick<MessageFilters, 'type' | 'from' | 'to'>;

/**
 * Build the AppSync model filter for a best-effort full-text search.
 *
 * v1 deviation from #87: rather than an AppSync custom `searchMessages`
 * query + Lambda resolver, we drive `Message.list` directly with a
 * `contains` filter from the client — the same DDB scan+filter the
 * Lambda would perform, with no new backend and nothing to break the
 * static export. The OpenSearch migration (#182) supersedes the
 * backend either way, and the UI does not change when it lands.
 *
 * The query is matched (case-sensitively, as DynamoDB `contains` is a
 * literal substring test — no regex) against `body`, `sender`, and
 * `receiver`. Special characters are passed through verbatim as a
 * literal value: there is no regex compilation, so nothing to inject
 * or break. The soft-delete exclusion from `filtersToAppSyncFilter`
 * is always preserved.
 */
export function buildSearchFilter(q: string, filters: SearchFilters): Record<string, unknown> {
  const base = filtersToAppSyncFilter(filters);
  // Normalise to a flat AND list so we can append the OR block. A
  // single-term result (e.g. only the deleted-exclusion) comes back
  // un-wrapped from `filtersToAppSyncFilter`.
  const and: Record<string, unknown>[] = (() => {
    if (!base) return [];
    if (Array.isArray((base as { and?: unknown }).and)) {
      return (base as { and: Record<string, unknown>[] }).and;
    }
    return [base];
  })();

  const trimmed = q.trim();
  if (trimmed) {
    // Prepend the free-text OR block so it reads first in the filter.
    and.unshift({
      or: [
        { body: { contains: trimmed } },
        { sender: { contains: trimmed } },
        { receiver: { contains: trimmed } },
      ],
    });
  }
  return { and };
}

export interface SearchMessagesOptions extends SearchFilters {
  nextToken?: string | null;
  pageSize?: number;
}

/**
 * Best-effort full-text search over published Messages. Combines the
 * browse filters with a `contains`-OR over the text fields and pages
 * via the standard `nextToken` cursor.
 */
export async function searchMessages(
  q: string,
  opts: SearchMessagesOptions = {},
): Promise<ListResult> {
  const { nextToken, pageSize, ...filters } = opts;
  return listMessagesWithFilter({
    filter: buildSearchFilter(q, filters),
    nextToken,
    pageSize,
  });
}
