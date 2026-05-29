'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import {
  getMyNotificationPreference,
  setNotificationPreference,
  type NotificationPrefView,
} from '@/lib/notifications/query';
import { MESSAGE_TYPES, type MessageType } from '@/lib/messages/filters';
import styles from './NotificationsForm.module.css';

/**
 * `<NotificationsForm>` — wire-up for the existing
 * `getMyNotificationPreference` / `setNotificationPreference`
 * server mutations (#100).
 *
 * Channels at v1:
 *   - Email (toggle only; per-event subscription gated by `subscribedTypes`)
 *   - Push (toggle only; web push subscription registration deferred
 *     to #129 follow-up — toggle still persists)
 *   - Discord webhook (URL + enable toggle; server KMS-encrypts the
 *     URL before storage per #288)
 *   - Weekly digest (single boolean)
 *
 * Per-message-type subscription granularity matches the
 * `MESSAGE_TYPES` enum.
 */
export function NotificationsForm() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pref, setPref] = useState<NotificationPrefView | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const live = await getMyNotificationPreference();
        if (!cancelled) setPref(live);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const update = useCallback((patch: Partial<NotificationPrefView>) => {
    setPref((prev) => (prev ? { ...prev, ...patch } : prev));
    setSavedAt(null);
  }, []);

  const toggleType = useCallback(
    (type: MessageType) => {
      if (!pref) return;
      const next = pref.subscribedTypes.includes(type)
        ? pref.subscribedTypes.filter((t) => t !== type)
        : [...pref.subscribedTypes, type];
      update({ subscribedTypes: next });
    },
    [pref, update],
  );

  const save = useCallback(async () => {
    if (!pref) return;
    setSubmitting(true);
    setError(null);
    try {
      const updated = await setNotificationPreference({
        emailEnabled: pref.emailEnabled,
        pushEnabled: pref.pushEnabled,
        discordWebhookEnabled: pref.discordWebhookEnabled,
        discordWebhookUrl: pref.discordWebhookUrl,
        subscribedTypes: pref.subscribedTypes,
        weeklyDigest: pref.weeklyDigest,
      });
      setPref(updated);
      setSavedAt(new Date().toISOString().slice(11, 19) + 'Z');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }, [pref]);

  if (loading) {
    return (
      <p style={{ fontFamily: 'var(--font-jb-mono)', color: 'var(--text-2)' }}>
        Loading your preferences…
      </p>
    );
  }

  if (error && !pref) {
    return (
      <div className={styles.error} role="alert">
        Could not load preferences: {error}
      </div>
    );
  }

  if (!pref) return null;

  return (
    <form
      noValidate
      className={styles.shell}
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
      aria-label="Notification preferences"
    >
      <section className={styles.section}>
        <div className={styles.sectionHead}>
          <h3 className={styles.title}>Channels</h3>
        </div>
        <label className={styles.toggleRow}>
          <input
            type="checkbox"
            checked={pref.emailEnabled}
            onChange={(e) => update({ emailEnabled: e.target.checked })}
          />
          Email — verified address on file
        </label>
        <label className={styles.toggleRow}>
          <input
            type="checkbox"
            checked={pref.pushEnabled}
            onChange={(e) => update({ pushEnabled: e.target.checked })}
          />
          Web Push — browser notifications (subscription registration ships in a follow-up; toggle
          persists today)
        </label>
        <label className={styles.toggleRow}>
          <input
            type="checkbox"
            checked={pref.discordWebhookEnabled}
            onChange={(e) => update({ discordWebhookEnabled: e.target.checked })}
          />
          Discord webhook
        </label>
        {pref.discordWebhookEnabled && (
          <input
            type="url"
            className={styles.webhookInput}
            placeholder="https://discord.com/api/webhooks/…"
            value={pref.discordWebhookUrl ?? ''}
            onChange={(e) => update({ discordWebhookUrl: e.target.value || null })}
            aria-label="Discord webhook URL"
          />
        )}
        <p className={styles.caption}>
          Discord URL is KMS-encrypted at rest. Only the owner + admins ever see the plaintext (the
          Lambda decrypts per-caller).
        </p>
      </section>

      <section className={styles.section}>
        <div className={styles.sectionHead}>
          <h3 className={styles.title}>Message types you want pinged on</h3>
        </div>
        <div className={styles.typeGrid} role="group" aria-label="Subscribed message types">
          {MESSAGE_TYPES.map((t) => {
            const active = pref.subscribedTypes.includes(t);
            return (
              <label
                key={t}
                className={`${styles.typeChip} ${active ? styles.typeChipActive : ''}`}
              >
                <input
                  type="checkbox"
                  checked={active}
                  onChange={() => toggleType(t)}
                  style={{ accentColor: 'var(--color-accent)' }}
                />
                {t}
              </label>
            );
          })}
        </div>
      </section>

      <section className={styles.section}>
        <div className={styles.sectionHead}>
          <h3 className={styles.title}>Digest</h3>
        </div>
        <label className={styles.toggleRow}>
          <input
            type="checkbox"
            checked={pref.weeklyDigest}
            onChange={(e) => update({ weeklyDigest: e.target.checked })}
          />
          Weekly summary email (Monday UTC)
        </label>
      </section>

      {error && (
        <div className={styles.error} role="alert">
          {error}
        </div>
      )}

      <div className={styles.actions}>
        {savedAt && (
          <span className={`${styles.status} ${styles.statusOk}`} aria-live="polite">
            Saved at {savedAt}
          </span>
        )}
        <Button type="submit" loading={submitting} disabled={submitting}>
          Save preferences
        </Button>
      </div>
    </form>
  );
}
