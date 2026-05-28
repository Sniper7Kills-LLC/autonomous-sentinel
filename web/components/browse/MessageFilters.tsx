'use client';

import { useCallback, useMemo, useState } from 'react';
import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import { Field, Input, Select } from '@/components/ui/Field';
import { Button } from '@/components/ui/Button';
import {
  MESSAGE_TYPES,
  type MessageFilters,
  parseFiltersFromParams,
  serializeFiltersToParams,
  isFiltersEmpty,
} from '@/lib/messages/filters';
import styles from './MessageFilters.module.css';

const FILTER_LABELS: Record<keyof MessageFilters, string> = {
  type: 'TYPE',
  from: 'FROM',
  to: 'TO',
  sender: 'SENDER',
  receiver: 'RECEIVER',
};

export interface MessageFiltersProps {
  /** When set, locks the `type` filter to this value and hides the type input. */
  forcedType?: MessageFilters['type'];
}

export function MessageFiltersBar({ forcedType }: MessageFiltersProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const current = useMemo(
    () => parseFiltersFromParams(new URLSearchParams(searchParams.toString())),
    [searchParams],
  );
  const effective = useMemo<MessageFilters>(
    () => (forcedType ? { ...current, type: forcedType } : current),
    [current, forcedType],
  );
  const [draft, setDraft] = useState<MessageFilters>(effective);

  const apply = useCallback(() => {
    const next = forcedType ? { ...draft, type: forcedType } : draft;
    const params = serializeFiltersToParams(next);
    if (forcedType) params.delete('type');
    const search = params.toString();
    router.replace(search ? `${pathname}?${search}` : pathname);
  }, [draft, forcedType, pathname, router]);

  const removeChip = useCallback(
    (key: keyof MessageFilters) => {
      if (key === 'type' && forcedType) return;
      const next = { ...effective };
      delete next[key];
      setDraft(next);
      const params = serializeFiltersToParams(next);
      if (forcedType) params.delete('type');
      const search = params.toString();
      router.replace(search ? `${pathname}?${search}` : pathname);
    },
    [effective, forcedType, pathname, router],
  );

  const clearAll = useCallback(() => {
    const cleared: MessageFilters = forcedType ? { type: forcedType } : {};
    setDraft(cleared);
    if (forcedType) {
      router.replace(pathname);
    } else {
      router.replace(pathname);
    }
  }, [forcedType, pathname, router]);

  const chipFilters = useMemo(() => {
    return (Object.keys(effective) as (keyof MessageFilters)[]).filter((k) => {
      if (effective[k] === undefined) return false;
      if (k === 'type' && forcedType) return false;
      return true;
    });
  }, [effective, forcedType]);

  return (
    <>
      {chipFilters.length > 0 && (
        <div className={styles.chips}>
          {chipFilters.map((key) => (
            <span key={key} className={styles.chip}>
              <span className={styles.chipKey}>{FILTER_LABELS[key]}</span>
              <span>{effective[key]}</span>
              <button
                type="button"
                className={styles.chipClose}
                onClick={() => removeChip(key)}
                aria-label={`Remove ${FILTER_LABELS[key]} filter`}
              >
                ×
              </button>
            </span>
          ))}
          {!isFiltersEmpty(effective) && (
            <button type="button" className={styles.clearAll} onClick={clearAll}>
              Clear all
            </button>
          )}
        </div>
      )}
      <form
        className={styles.bar}
        onSubmit={(e) => {
          e.preventDefault();
          apply();
        }}
        aria-label="Filter messages"
      >
        {!forcedType && (
          <Field label="Type" htmlFor="filter-type">
            <Select
              id="filter-type"
              value={draft.type ?? ''}
              onChange={(e) =>
                setDraft((d) => ({
                  ...d,
                  type: e.target.value
                    ? (e.target.value as (typeof MESSAGE_TYPES)[number])
                    : undefined,
                }))
              }
            >
              <option value="">Any</option>
              {MESSAGE_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Field label="From" htmlFor="filter-from">
          <Input
            id="filter-from"
            type="date"
            value={draft.from ?? ''}
            onChange={(e) => setDraft((d) => ({ ...d, from: e.target.value || undefined }))}
          />
        </Field>
        <Field label="To" htmlFor="filter-to">
          <Input
            id="filter-to"
            type="date"
            value={draft.to ?? ''}
            onChange={(e) => setDraft((d) => ({ ...d, to: e.target.value || undefined }))}
          />
        </Field>
        <Field label="Sender" htmlFor="filter-sender">
          <Input
            id="filter-sender"
            type="text"
            placeholder="MAINSAIL"
            value={draft.sender ?? ''}
            onChange={(e) => setDraft((d) => ({ ...d, sender: e.target.value || undefined }))}
          />
        </Field>
        <Field label="Receiver" htmlFor="filter-receiver">
          <Input
            id="filter-receiver"
            type="text"
            placeholder="ANCHOR"
            value={draft.receiver ?? ''}
            onChange={(e) => setDraft((d) => ({ ...d, receiver: e.target.value || undefined }))}
          />
        </Field>
        <div className={styles.actions}>
          <Button type="submit" size="sm">
            Apply
          </Button>
        </div>
      </form>
    </>
  );
}
