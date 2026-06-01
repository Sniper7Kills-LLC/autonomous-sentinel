import { diffWordsWithSpace } from 'diff';

export type DiffOp = 'added' | 'removed' | 'unchanged';

export interface DiffSegment {
  op: DiffOp;
  value: string;
}

/**
 * Word-level diff of `current` → `next` for the inline correction form
 * (#93). Renders what the user is changing so they can sanity-check their
 * edit before it lands as a community-vote revision. Whitespace is
 * preserved so the rendered diff matches the textarea content.
 */
export function diffTranscript(current: string, next: string): DiffSegment[] {
  return diffWordsWithSpace(current, next).map((part) => ({
    op: part.added ? 'added' : part.removed ? 'removed' : 'unchanged',
    value: part.value,
  }));
}

/** True when the diff contains at least one added or removed segment. */
export function hasChanges(segments: DiffSegment[]): boolean {
  return segments.some((s) => s.op !== 'unchanged');
}
