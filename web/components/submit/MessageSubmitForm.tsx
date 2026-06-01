'use client';

import { useCallback, useState } from 'react';
import Link from 'next/link';
import { getDataClient } from '@/lib/amplifyClient';
import { Button } from '@/components/ui/Button';
import { Field, Input, Select, Textarea } from '@/components/ui/Field';
import { MESSAGE_TYPES, type MessageType } from '@/lib/messages/filters';
import styles from './MessageSubmitForm.module.css';

interface SubmitResultMessage {
  id: string;
  publishedAt: string | null;
  flaggedForReview: boolean | null;
}

interface FormState {
  broadcastTs: string;
  type: MessageType | '';
  sender: string;
  receiver: string;
  body: string;
}

const EMPTY: FormState = {
  broadcastTs: '',
  type: '',
  sender: '',
  receiver: '',
  body: '',
};

export function MessageSubmitForm() {
  const [form, setForm] = useState<FormState>(EMPTY);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SubmitResultMessage | null>(null);

  const update = useCallback(<K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  }, []);

  const submit = useCallback(async () => {
    setError(null);
    setResult(null);
    if (!form.broadcastTs) {
      setError('Broadcast timestamp is required.');
      return;
    }
    const ts = new Date(form.broadcastTs);
    if (Number.isNaN(ts.getTime())) {
      setError('Broadcast timestamp is not a valid date/time.');
      return;
    }
    setSubmitting(true);
    try {
      const client = getDataClient();
      const args: {
        broadcastTs: string;
        type?: string;
        sender?: string;
        receiver?: string;
        body?: string;
      } = { broadcastTs: ts.toISOString() };
      if (form.type) args.type = form.type;
      if (form.sender.trim()) args.sender = form.sender.trim();
      if (form.receiver.trim()) args.receiver = form.receiver.trim();
      if (form.body.trim()) args.body = form.body.trim();
      // Cast the mutation accessor itself so the type-aware checker
      // does not unfold the recursive Schema-derived argument generics
      // (matches the TS2589 workaround in `lib/messages/query.ts`).
      const submitFn = client.mutations.submitRecordingLessMessage as unknown as (
        input: Record<string, unknown>,
        opts: Record<string, unknown>,
      ) => Promise<{
        data?: {
          id?: string;
          publishedAt?: string | null;
          flaggedForReview?: boolean | null;
        } | null;
        errors?: { message: string }[] | null;
      }>;
      const raw = await submitFn(args, { authMode: 'userPool' });
      if (raw.errors?.length) {
        throw new Error(raw.errors.map((e) => e.message).join('; '));
      }
      const created = raw.data;
      if (!created?.id) {
        throw new Error('submitRecordingLessMessage returned no Message id');
      }
      setResult({
        id: created.id,
        publishedAt: created.publishedAt ?? null,
        flaggedForReview: created.flaggedForReview ?? null,
      });
      setForm(EMPTY);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }, [form]);

  const isQueued = result !== null && !result.publishedAt;

  return (
    <form
      className={styles.form}
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      aria-label="Submit recording-less message"
    >
      <Field
        label="Broadcast timestamp (UTC)"
        htmlFor="msg-ts"
        hint="When you heard the broadcast. Stored in UTC regardless of input timezone."
        required
      >
        <Input
          id="msg-ts"
          type="datetime-local"
          value={form.broadcastTs}
          onChange={(e) => update('broadcastTs', e.target.value)}
          required
        />
      </Field>

      <div className={styles.row}>
        <Field label="Type" htmlFor="msg-type">
          <Select
            id="msg-type"
            value={form.type}
            onChange={(e) => update('type', (e.target.value as MessageType) || '')}
          >
            <option value="">Auto / unknown</option>
            {MESSAGE_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Sender" htmlFor="msg-sender">
          <Input
            id="msg-sender"
            type="text"
            placeholder="MAINSAIL"
            value={form.sender}
            onChange={(e) => update('sender', e.target.value)}
          />
        </Field>
      </div>

      <Field label="Receiver" htmlFor="msg-receiver">
        <Input
          id="msg-receiver"
          type="text"
          placeholder="ANCHOR"
          value={form.receiver}
          onChange={(e) => update('receiver', e.target.value)}
        />
      </Field>

      <Field
        label="Body"
        htmlFor="msg-body"
        hint="Verbatim text of the broadcast. Will be flagged for community review on submission."
      >
        <Textarea
          id="msg-body"
          rows={6}
          placeholder="…the broadcast you heard"
          value={form.body}
          onChange={(e) => update('body', e.target.value)}
        />
      </Field>

      {error && (
        <div className={styles.errorBox} role="alert">
          {error}
        </div>
      )}

      {result && (
        <div role="status" className={`${styles.successBox} ${isQueued ? styles.queuedBox : ''}`}>
          {isQueued
            ? 'Submitted — your message is in the moderator queue (your reputation is below the publish-now threshold).'
            : 'Submitted — your message is live, flagged for community review per the recording-less submission policy.'}{' '}
          <Link href={`/messages/${encodeURIComponent(result.id)}`}>View detail →</Link>
        </div>
      )}

      <div className={styles.actions}>
        <Button type="submit" loading={submitting} disabled={submitting}>
          Submit message
        </Button>
      </div>
    </form>
  );
}
