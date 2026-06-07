import { describe, it, expect } from 'vitest';
import { sortByBroadcastDesc } from './MessagesList';
import type { DisplayMessage } from '@/lib/messages/types';

function msg(id: string, broadcastTs: string): DisplayMessage {
  return { id, broadcastTs } as DisplayMessage;
}

describe('sortByBroadcastDesc (#754)', () => {
  it('orders messages newest broadcast first', () => {
    const out = sortByBroadcastDesc([
      msg('a', '2026-06-01T00:00:00Z'),
      msg('c', '2026-06-03T00:00:00Z'),
      msg('b', '2026-06-02T00:00:00Z'),
    ]);
    expect(out.map((m) => m.id)).toEqual(['c', 'b', 'a']);
  });

  it('sorts rows with no broadcast time last', () => {
    const out = sortByBroadcastDesc([
      msg('none', ''),
      msg('new', '2026-06-05T00:00:00Z'),
      msg('old', '2026-06-01T00:00:00Z'),
    ]);
    expect(out.map((m) => m.id)).toEqual(['new', 'old', 'none']);
  });

  it('does not mutate the input array', () => {
    const input = [msg('a', '2026-06-01T00:00:00Z'), msg('b', '2026-06-02T00:00:00Z')];
    const snapshot = input.map((m) => m.id);
    sortByBroadcastDesc(input);
    expect(input.map((m) => m.id)).toEqual(snapshot);
  });
});
