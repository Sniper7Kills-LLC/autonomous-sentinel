'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/Button';
import {
  listBannedUsers,
  findUserSubByEmail,
  banUserBySub,
  unbanUserBySub,
  type BannedUser,
} from '@/lib/admin/bans';
import styles from './BanManagement.module.css';

/**
 * Admin ban management (#112).
 *
 * v1 ships the **Users** tab — list currently-banned accounts, ban a user
 * (by email lookup), and lift a ban — all backed by the `banUser` /
 * `unbanUser` mutations + the audit log. The **IP CIDR** and **Country**
 * tabs are placeholders: they depend on the AWS WAF rulesets (#199 / #200)
 * which are not built yet, so they render a "coming with WAF" note rather
 * than a non-functional form.
 */

type Tab = 'users' | 'ip' | 'country';

const TABS: { id: Tab; label: string; ready: boolean }[] = [
  { id: 'users', label: 'Users', ready: true },
  { id: 'ip', label: 'IP CIDR', ready: false },
  { id: 'country', label: 'Country', ready: false },
];

export function BanManagement() {
  const [tab, setTab] = useState<Tab>('users');

  return (
    <section className={styles.wrap} aria-label="Ban management">
      <div className={styles.tabs} role="tablist" aria-label="Ban target type">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={`${styles.tab} ${tab === t.id ? styles.tabActive : ''}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'users' ? (
        <UserBansTab />
      ) : (
        <p className={styles.deferred}>
          {tab === 'ip' ? 'IP CIDR' : 'Country'} bans arrive with the AWS WAF rulesets (#199 /
          #200). User-account bans are managed on the Users tab.
        </p>
      )}
    </section>
  );
}

function UserBansTab() {
  const [rows, setRows] = useState<BannedUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState('');
  const [reason, setReason] = useState('');
  const [notice, setNotice] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setRows(await listBannedUsers());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load banned users.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const ban = useCallback(async () => {
    const addr = email.trim();
    if (!addr) {
      setError('Enter the email of the user to ban.');
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const sub = await findUserSubByEmail(addr);
      if (!sub) {
        setError(`No user found for ${addr}.`);
        return;
      }
      await banUserBySub(sub, reason.trim());
      setNotice(`Banned ${addr}.`);
      setEmail('');
      setReason('');
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ban failed.');
    } finally {
      setBusy(false);
    }
  }, [email, reason, reload]);

  const unban = useCallback(async (u: BannedUser) => {
    if (
      typeof window !== 'undefined' &&
      !window.confirm(`Lift the ban on ${u.email ?? u.cognitoSub}?`)
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await unbanUserBySub(u.cognitoSub, 'Unbanned from admin UI');
      setRows((prev) => prev.filter((r) => r.cognitoSub !== u.cognitoSub));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unban failed.');
    } finally {
      setBusy(false);
    }
  }, []);

  const count = useMemo(() => rows.length, [rows]);

  return (
    <div className={styles.panel}>
      <form
        className={styles.banForm}
        onSubmit={(e) => {
          e.preventDefault();
          void ban();
        }}
        aria-label="Ban a user"
      >
        <input
          type="email"
          className={styles.input}
          placeholder="user@email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          aria-label="User email to ban"
        />
        <input
          type="text"
          className={styles.input}
          placeholder="reason (optional)"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          aria-label="Ban reason"
        />
        <Button type="submit" variant="danger" size="sm" disabled={busy}>
          Ban
        </Button>
      </form>

      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className={styles.notice} role="status">
          {notice}
        </p>
      ) : null}

      <div className={styles.count} aria-live="polite">
        {loading ? 'Loading…' : `${count} banned user${count === 1 ? '' : 's'}`}
      </div>

      {!loading && count === 0 ? (
        <p className={styles.empty}>No users are currently banned.</p>
      ) : (
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col">User</th>
              <th scope="col">Reason</th>
              <th scope="col">Banned</th>
              <th scope="col" className={styles.actionCol}>
                Action
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((u) => (
              <tr key={u.cognitoSub}>
                <td>
                  <div>{u.email ?? <code className={styles.mono}>{u.cognitoSub}</code>}</div>
                  {u.displayName ? <div className={styles.sub}>{u.displayName}</div> : null}
                </td>
                <td>{u.bannedReason ?? <span className={styles.sub}>—</span>}</td>
                <td className={styles.sub}>
                  {u.bannedAt ? new Date(u.bannedAt).toLocaleString() : '—'}
                </td>
                <td className={styles.actionCol}>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={busy}
                    onClick={() => {
                      void unban(u);
                    }}
                  >
                    Unban
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
