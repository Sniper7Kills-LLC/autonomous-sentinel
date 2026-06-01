import Link from 'next/link';
import { Badge, MessageTypeBadge } from '@/components/ui/Badge';
import type { DisplayMessage } from '@/lib/messages/types';
import { Highlight } from './Highlight';
import cardStyles from '@/components/browse/MessageCard.module.css';

interface SearchResultCardProps {
  message: DisplayMessage;
  query: string;
}

/**
 * A single search hit. Mirrors `MessageCard` but wraps the matched
 * substrings of the query in `<mark>` across body + callsigns.
 */
export function SearchResultCard({ message, query }: SearchResultCardProps) {
  const ts = formatBroadcastTs(message.broadcastTs);
  const body = message.body ?? '';
  const truncated = body.length > 320;
  const display = truncated ? body.slice(0, 320) + '…' : body;
  return (
    <Link href={`/messages/view?id=${encodeURIComponent(message.id)}`} className={cardStyles.link}>
      <article className={cardStyles.card} data-type={message.type}>
        <div className={cardStyles.top}>
          <MessageTypeBadge type={message.type} />
          <span className={cardStyles.ts}>{ts}</span>
          <span className={cardStyles.spacer} />
          {message.flaggedForReview && <Badge tone="warn">FLAGGED</Badge>}
          {typeof message.confidence === 'number' && (
            <Badge tone={confidenceTone(message.confidence)}>
              CONF {message.confidence.toFixed(2)}
            </Badge>
          )}
        </div>
        {(message.sender || message.receiver) && (
          <div className={cardStyles.callsigns}>
            {message.sender && (
              <span className={cardStyles.callsign}>
                <Highlight text={message.sender} query={query} />
              </span>
            )}
            {message.sender && message.receiver && (
              <span className={cardStyles.arrow} aria-hidden>
                →
              </span>
            )}
            {message.receiver && (
              <span className={cardStyles.callsign}>
                <Highlight text={message.receiver} query={query} />
              </span>
            )}
          </div>
        )}
        {body && (
          <p className={`${cardStyles.body} ${truncated ? cardStyles.bodyFade : ''}`}>
            <Highlight text={display} query={query} />
          </p>
        )}
      </article>
    </Link>
  );
}

function confidenceTone(c: number): 'success' | 'warn' | 'danger' {
  if (c >= 0.8) return 'success';
  if (c >= 0.6) return 'warn';
  return 'danger';
}

function formatBroadcastTs(ts: string): string {
  if (!ts) return '';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toISOString().slice(0, 19).replace('T', ' ') + 'Z';
}
