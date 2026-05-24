import { Badge, MessageTypeBadge, type MessageType } from '@/components/ui/Badge';
import styles from './MessageDetail.module.css';

/**
 * Canonical char count for an ALLSTATIONS / EAM body. 30 is the most common
 * length; 22 and 28 also occur in-spec. The UI surfaces a CHAR-count badge
 * ONLY when the observed length deviates from 30.
 */
export const ALLSTATIONS_CANONICAL_CHARS = 30;

/**
 * Digits routinely excluded from in-spec EAM bodies because they are
 * ambiguous when spoken under HF conditions. A transcript containing any
 * of these is flagged as suspect-but-possible.
 */
const SUSPECT_DIGITS = new Set(['0', '1', '8', '9']);

export interface ParsedMessage {
  id: string;
  type: MessageType;
  broadcastTs: string; // ISO UTC
  sender: string;
  receiver: string;
  frequency: string; // e.g. "11.175 USB"
  /**
   * Count of separately-recorded broadcasts of this body. DB-dynamic — grows
   * as additional SDRs upload matching captures. Renders as `REPEATED ×N`
   * whenever the count is > 1.
   */
  repetitions?: number;
  confidence: number; // 0..1
  body: MessageBody;
}

export type MessageBody =
  | {
      kind: 'ALLSTATIONS';
      /** Six-character alphanumeric preamble (first 6 chars of the body). */
      preamble: string;
      /** Full body — preamble + tail. Concatenated, no whitespace. */
      characters: string;
      /** Trailing 2-char authentication, when present. */
      auth?: string;
      /**
       * When the auth-window first-two-char indicator should be surfaced.
       * Defaults to true. Owner can flip false to hide the OPSEC tell
       * if/when the project decides to suppress it.
       */
      showAuthWindow?: boolean;
    }
  | {
      kind: 'SKYKING';
      /** Minutes past UTC hour as a 2-digit string e.g. "14". */
      time: string;
      /**
       * The Skyking codeword. Pre-2015 traffic is a 3-character phonetic
       * group (e.g. "PT3"); post-2015 may be a codename word (e.g. "BEARS",
       * "BILBO"). Renderer auto-detects and styles distinctly.
       */
      codeword: string;
      /** Two-character time-dependent authenticator. */
      auth: string;
    }
  | {
      kind: 'SKYBIRD' | 'SKYMASTER';
      preamble?: string;
      text: string;
    }
  | {
      kind: 'RADIOCHECK';
      /**
       * Result phrase. Common values: "LOUD AND CLEAR", "READABLE", "WEAK",
       * "NO COPY". Free-string so off-spec exchanges still render.
       */
      result: string;
    }
  | {
      kind: 'BACKEND';
      admin: string;
      role?: string;
      text: string;
      severity?: 'info' | 'warn' | 'danger';
    }
  | {
      kind: 'DISREGARDED';
      /**
       * Disregarded messages are otherwise-typed broadcasts the original
       * sender retracted after the fact. The body stays free-form because
       * the underlying message type varies.
       */
      text: string;
    }
  | {
      kind: 'OTHER';
      text: string;
    };

interface MessageDetailProps {
  message: ParsedMessage;
}

export function MessageDetail({ message }: MessageDetailProps) {
  const { type, broadcastTs, frequency, repetitions, confidence } = message;
  const isAdmin = message.body.kind === 'BACKEND';
  return (
    <article className={styles.card} data-type={type}>
      <header className={styles.header}>
        <div className={styles.headTop}>
          <MessageTypeBadge type={type} />
          <span className={styles.ts}>{broadcastTs}</span>
          {!isAdmin && <span className={styles.freq}>{frequency}</span>}
          {isAdmin && <span className={styles.adminFlag}>SITE ADMINISTRATOR</span>}
          <span className={styles.spacer} />
          {!isAdmin && <ConfidenceBadge value={confidence} />}
        </div>
        {!isAdmin && (
          <div className={styles.headBottom}>
            <span className={styles.callsignBlock}>
              <span className={styles.label}>From</span>
              <span className={styles.callsign}>{message.sender}</span>
            </span>
            <span className={styles.arrow} aria-hidden>
              →
            </span>
            <span className={styles.callsignBlock}>
              <span className={styles.label}>To</span>
              <span className={styles.callsign}>{message.receiver}</span>
            </span>
            <span className={styles.spacer} />
            {repetitions && repetitions > 1 ? <RepetitionBadge count={repetitions} /> : null}
          </div>
        )}
      </header>
      <div className={styles.bodyWrap}>
        <RenderBody body={message.body} />
      </div>
    </article>
  );
}

/* ============================================================
   Per-type body renderers
   ============================================================ */

function RenderBody({ body }: { body: MessageBody }) {
  switch (body.kind) {
    case 'ALLSTATIONS':
      return <AllStationsBody body={body} />;
    case 'SKYKING':
      return <SkykingBody body={body} />;
    case 'SKYBIRD':
    case 'SKYMASTER':
      return <SkybirdBody body={body} />;
    case 'RADIOCHECK':
      return <RadioCheckBody body={body} />;
    case 'BACKEND':
      return <BackendBody body={body} />;
    case 'DISREGARDED':
      return <DisregardedBody body={body} />;
    case 'OTHER':
      return <OtherBody body={body} />;
  }
}

function AllStationsBody({ body }: { body: Extract<MessageBody, { kind: 'ALLSTATIONS' }> }) {
  const chars = stripWhitespace(body.characters);
  const len = chars.length;
  const isOffSpecLength = len !== ALLSTATIONS_CANONICAL_CHARS;
  const suspectChars = findSuspectChars(chars);
  const hasSuspect = suspectChars.length > 0;
  const authWindow = body.preamble.slice(0, 2);
  const showAuth = body.showAuthWindow !== false;

  return (
    <div className={styles.body}>
      {showAuth && (
        <div className={styles.authWindow}>
          <span className={styles.authWindowLabel}>AUTH WINDOW</span>
          <span className={styles.authWindowVal}>{authWindow}</span>
          <span className={styles.authWindowHint}>stable ~8&ndash;26 days</span>
        </div>
      )}

      <div className={styles.preambleBlock}>
        <span className={styles.preambleLabel}>PREAMBLE</span>
        <span className={styles.preambleVal}>{body.preamble}</span>
      </div>

      <div className={styles.charBlock} data-suspect={hasSuspect}>
        {[...chars].map((c, i) => {
          const suspect = SUSPECT_DIGITS.has(c);
          const inPreamble = i < 6;
          return (
            <span
              key={i}
              className={`${styles.char} ${suspect ? styles.charSuspect : ''} ${
                inPreamble ? styles.charPreamble : ''
              }`}
              data-pos={i}
            >
              {c}
            </span>
          );
        })}
      </div>

      <div className={styles.bodyMeta}>
        {isOffSpecLength && <CharCountBadge length={len} />}
        {hasSuspect && <Badge tone="warn">SUSPECT CHARS · {suspectChars.join(' ')}</Badge>}
        {body.auth && (
          <span className={styles.authChip}>
            <span className={styles.authLabel}>AUTH</span>
            <span className={styles.authVal}>{body.auth}</span>
          </span>
        )}
      </div>
    </div>
  );
}

function SkykingBody({ body }: { body: Extract<MessageBody, { kind: 'SKYKING' }> }) {
  const isCodename = isLikelyCodename(body.codeword);
  return (
    <div className={styles.body}>
      <div className={styles.skykingHead}>
        <span className={styles.priorityRule}>SKYKING — DO NOT ANSWER</span>
        <span className={styles.timeChip}>
          <span className={styles.timeLabel}>TIME</span>
          <span className={styles.timeVal}>{body.time}</span>
        </span>
      </div>
      <div className={isCodename ? styles.codenameWrap : styles.phoneticGroupWrap}>
        <span className={styles.codewordTag}>{isCodename ? 'CODENAME' : 'GROUP'}</span>
        <span className={isCodename ? styles.codename : styles.phoneticGroup}>
          {body.codeword.toUpperCase()}
        </span>
      </div>
      <div className={styles.bodyMeta}>
        <span className={styles.authChip}>
          <span className={styles.authLabel}>AUTH</span>
          <span className={styles.authVal}>{body.auth}</span>
        </span>
      </div>
    </div>
  );
}

function SkybirdBody({ body }: { body: Extract<MessageBody, { kind: 'SKYBIRD' | 'SKYMASTER' }> }) {
  return (
    <div className={styles.body}>
      {body.preamble && <div className={styles.preamble}>{body.preamble}</div>}
      <p className={styles.freeText}>{body.text}</p>
    </div>
  );
}

function RadioCheckBody({ body }: { body: Extract<MessageBody, { kind: 'RADIOCHECK' }> }) {
  return (
    <div className={`${styles.body} ${styles.bodyCenter}`}>
      <div className={styles.testCount}>RADIO CHECK</div>
      <div className={styles.resultLine}>{body.result}</div>
    </div>
  );
}

function BackendBody({ body }: { body: Extract<MessageBody, { kind: 'BACKEND' }> }) {
  const severity = body.severity ?? 'info';
  return (
    <div className={`${styles.body} ${styles.admin}`} data-severity={severity}>
      <div className={styles.adminHead}>
        <span className={styles.adminAvatar} aria-hidden>
          ◈
        </span>
        <div className={styles.adminAttribution}>
          <span className={styles.adminName}>{body.admin}</span>
          <span className={styles.adminRole}>{body.role ?? 'Site administrator'}</span>
        </div>
        <span className={styles.spacer} />
        <span className={styles.adminBadge} data-severity={severity}>
          {severity === 'danger'
            ? 'NOTICE — URGENT'
            : severity === 'warn'
              ? 'NOTICE'
              : 'ANNOUNCEMENT'}
        </span>
      </div>
      <p className={styles.adminText}>{body.text}</p>
    </div>
  );
}

function DisregardedBody({ body }: { body: Extract<MessageBody, { kind: 'DISREGARDED' }> }) {
  return (
    <div className={`${styles.body} ${styles.disregarded}`}>
      <div className={styles.disregardStamp}>DISREGARDED</div>
      <p className={styles.freeText}>{body.text}</p>
    </div>
  );
}

function OtherBody({ body }: { body: Extract<MessageBody, { kind: 'OTHER' }> }) {
  return (
    <div className={styles.body}>
      <p className={styles.freeText}>{body.text}</p>
    </div>
  );
}

/* ============================================================
   Sub-badges + helpers
   ============================================================ */

function CharCountBadge({ length }: { length: number }) {
  const delta = length - ALLSTATIONS_CANONICAL_CHARS;
  return (
    <Badge tone="warn">
      {length} CHAR · {delta > 0 ? '+' : ''}
      {delta} vs {ALLSTATIONS_CANONICAL_CHARS}
    </Badge>
  );
}

function RepetitionBadge({ count }: { count: number }) {
  return (
    <span className={styles.repBadge} title={`Observed in ${count} broadcasts`}>
      <span className={styles.repIcon} aria-hidden>
        ↻
      </span>
      <span className={styles.repLabel}>REPEATED ×{count}</span>
    </span>
  );
}

function ConfidenceBadge({ value }: { value: number }) {
  const tone: 'success' | 'warn' | 'danger' =
    value >= 0.8 ? 'success' : value >= 0.6 ? 'warn' : 'danger';
  return <Badge tone={tone}>CONF {value.toFixed(2)}</Badge>;
}

function stripWhitespace(s: string): string {
  return s.replace(/\s+/g, '');
}

function findSuspectChars(s: string): string[] {
  const out = new Set<string>();
  for (const ch of s) {
    if (SUSPECT_DIGITS.has(ch)) out.add(ch);
  }
  return [...out];
}

/**
 * Skyking codewords come in two flavors:
 *   1. 3-character phonetic group (e.g. "PT3", "BAK", "K2J") — pre-2015.
 *   2. Codename word(s) (e.g. "BEARS", "BILBO", "THE DOORS") — post-2015.
 *
 * Heuristic: alpha-only AND (length > 3 OR contains a space) ⇒ codename.
 * Three-char alpha groups (e.g. "BAK") still render as a phonetic group.
 */
function isLikelyCodename(codeword: string): boolean {
  if (/\s/.test(codeword)) return true;
  if (!/^[A-Za-z]+$/.test(codeword)) return false;
  return codeword.length > 3;
}
