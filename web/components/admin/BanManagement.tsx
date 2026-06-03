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
import {
  listCountryBans,
  addCountryBan,
  removeCountryBan,
  listIpBans,
  addIpBan,
  removeIpBan,
  isValidCidr,
  fetchWafMetrics,
  type BanScope,
  type CountryBanRow,
  type IpBanRow,
  type WafMetrics,
} from '@/lib/admin/waf-bans';
import { BannedRegionEditor } from '@/components/admin/BannedRegionEditor';
import styles from './BanManagement.module.css';

/**
 * Admin ban management (#112).
 *
 * Tabs:
 *  - **Users** — ban / unban accounts via `banUser` / `unbanUser` (audited).
 *  - **IP CIDR** — block CIDR ranges (`BannedIp` model); per-ban read/write
 *    scope + optional expiry. `wafSync` (#200) reconciles to the WAF IPSets.
 *  - **Country** — block ISO-3166-1 alpha-2 countries (`BannedCountry`);
 *    per-ban scope. `wafSync` (#199) reconciles to the WAF geo rules.
 *  - **Region pages** — author the per-country landing shown to read-blocked
 *    visitors (`BannedRegionPage`, #113 / served by #202).
 *
 * All writes are admin-only server-side; `AdminGate` only decides render.
 */

type Tab = 'users' | 'ip' | 'country' | 'regions';

const TABS: { id: Tab; label: string }[] = [
  { id: 'users', label: 'Users' },
  { id: 'ip', label: 'IP CIDR' },
  { id: 'country', label: 'Country' },
  { id: 'regions', label: 'Region pages' },
];

const SCOPE_LABEL: Record<BanScope, string> = {
  write: 'Write-only',
  read_write: 'Read + write',
};

export function BanManagement() {
  const [tab, setTab] = useState<Tab>('users');

  return (
    <section className={styles.wrap} aria-label="Ban management">
      <WafMetricsBanner />
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

      {tab === 'users' ? <UserBansTab /> : null}
      {tab === 'ip' ? <IpBansTab /> : null}
      {tab === 'country' ? <CountryBansTab /> : null}
      {tab === 'regions' ? <BannedRegionEditor /> : null}
    </section>
  );
}

/** WAF blocked/allowed request summary (#673). Degrades silently if absent. */
function WafMetricsBanner() {
  const [metrics, setMetrics] = useState<WafMetrics | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const m = await fetchWafMetrics(24);
        if (live) setMetrics(m);
      } catch {
        if (live) setFailed(true);
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  if (failed || !metrics) return null;

  return (
    <div className={styles.metrics} role="status" aria-label="WAF request metrics (last 24h)">
      <span className={styles.metric}>
        <strong>{metrics.blockedRequests.toLocaleString()}</strong> blocked
      </span>
      <span className={styles.metric}>
        <strong>{metrics.allowedRequests.toLocaleString()}</strong> allowed
      </span>
      <span className={styles.metricNote}>WAF · last {metrics.windowHours}h</span>
    </div>
  );
}

/** Write-only / read+write radio shared by the IP + country add forms. */
function ScopeRadio({
  name,
  value,
  onChange,
  disabled,
}: {
  name: string;
  value: BanScope;
  onChange: (v: BanScope) => void;
  disabled?: boolean;
}) {
  return (
    <fieldset className={styles.scopeGroup} aria-label="Ban scope">
      {(['write', 'read_write'] as BanScope[]).map((s) => (
        <label key={s} className={styles.scopeOption}>
          <input
            type="radio"
            name={name}
            value={s}
            checked={value === s}
            disabled={disabled}
            onChange={() => onChange(s)}
          />
          {SCOPE_LABEL[s]}
        </label>
      ))}
    </fieldset>
  );
}

function ScopeBadge({ scope }: { scope: BanScope }) {
  return (
    <span className={styles.scopeBadge} data-scope={scope}>
      {SCOPE_LABEL[scope]}
    </span>
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

/* ------------------------------------------------------------------ */
/* Country bans                                                        */
/* ------------------------------------------------------------------ */

function CountryBansTab() {
  const [rows, setRows] = useState<CountryBanRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const [iso2, setIso2] = useState('');
  const [reason, setReason] = useState('');
  const [scope, setScope] = useState<BanScope>('write');

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setRows(await listCountryBans());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load country bans.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const add = useCallback(async () => {
    const code = iso2.trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(code)) {
      setError('Enter a 2-letter ISO country code (e.g. RU, CN, KP).');
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await addCountryBan({ iso2: code, scope, reason });
      setNotice(`Blocked ${code} (${SCOPE_LABEL[scope].toLowerCase()}).`);
      setIso2('');
      setReason('');
      setScope('write');
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to add country ban.');
    } finally {
      setBusy(false);
    }
  }, [iso2, scope, reason, reload]);

  const remove = useCallback(async (row: CountryBanRow) => {
    if (typeof window !== 'undefined' && !window.confirm(`Unblock country ${row.iso2}?`)) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await removeCountryBan(row.iso2);
      setRows((prev) => prev.filter((r) => r.iso2 !== row.iso2));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to remove country ban.');
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
          void add();
        }}
        aria-label="Block a country"
      >
        <input
          type="text"
          className={styles.input}
          placeholder="ISO code (e.g. RU)"
          maxLength={2}
          value={iso2}
          onChange={(e) => setIso2(e.target.value.toUpperCase())}
          aria-label="ISO country code to block"
        />
        <input
          type="text"
          className={styles.input}
          placeholder="reason (optional)"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          aria-label="Block reason"
        />
        <ScopeRadio name="country-scope" value={scope} onChange={setScope} disabled={busy} />
        <Button type="submit" variant="danger" size="sm" disabled={busy}>
          Block
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
        {loading ? 'Loading…' : `${count} blocked countr${count === 1 ? 'y' : 'ies'}`}
      </div>

      {!loading && count === 0 ? (
        <p className={styles.empty}>No countries are currently blocked.</p>
      ) : (
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col">Country</th>
              <th scope="col">Scope</th>
              <th scope="col">Reason</th>
              <th scope="col" className={styles.actionCol}>
                Action
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.iso2}>
                <td>
                  <code className={styles.mono}>{row.iso2}</code>
                </td>
                <td>
                  <ScopeBadge scope={row.scope} />
                </td>
                <td>{row.reason ?? <span className={styles.sub}>—</span>}</td>
                <td className={styles.actionCol}>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={busy}
                    onClick={() => {
                      void remove(row);
                    }}
                  >
                    Unblock
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

/* ------------------------------------------------------------------ */
/* IP-CIDR bans                                                        */
/* ------------------------------------------------------------------ */

function IpBansTab() {
  const [rows, setRows] = useState<IpBanRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const [cidr, setCidr] = useState('');
  const [reason, setReason] = useState('');
  const [scope, setScope] = useState<BanScope>('write');
  const [expiresAt, setExpiresAt] = useState('');

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setRows(await listIpBans());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load IP bans.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const cidrValid = cidr.trim() === '' || isValidCidr(cidr);

  const add = useCallback(async () => {
    const range = cidr.trim();
    if (!isValidCidr(range)) {
      setError('Enter a valid IPv4 or IPv6 CIDR (e.g. 203.0.113.0/24 or 2001:db8::/32).');
      return;
    }
    // datetime-local is the admin's LOCAL wall-clock time; new Date() parses it
    // as local and toISOString() stores the equivalent UTC instant. The table
    // renders it back via toLocaleString(), so input + display match. Reject a
    // past expiry: wafSync drops already-expired rows, so it would be a silent
    // no-op ban (the WAF IPSet never gets the CIDR). Blank = permanent.
    let iso: string | null = null;
    if (expiresAt) {
      const ts = new Date(expiresAt).getTime();
      if (Number.isNaN(ts) || ts <= Date.now()) {
        setError('Expiry must be in the future. Leave it blank for a permanent ban.');
        return;
      }
      iso = new Date(ts).toISOString();
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await addIpBan({ cidr: range, scope, reason, expiresAt: iso });
      setNotice(`Blocked ${range} (${SCOPE_LABEL[scope].toLowerCase()}).`);
      setCidr('');
      setReason('');
      setScope('write');
      setExpiresAt('');
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to add IP ban.');
    } finally {
      setBusy(false);
    }
  }, [cidr, scope, reason, expiresAt, reload]);

  const remove = useCallback(async (row: IpBanRow) => {
    if (typeof window !== 'undefined' && !window.confirm(`Unblock ${row.cidr}?`)) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await removeIpBan(row.cidr);
      setRows((prev) => prev.filter((r) => r.cidr !== row.cidr));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to remove IP ban.');
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
          void add();
        }}
        aria-label="Block an IP CIDR range"
      >
        <input
          type="text"
          className={styles.input}
          placeholder="CIDR (e.g. 203.0.113.0/24)"
          value={cidr}
          onChange={(e) => setCidr(e.target.value)}
          aria-label="IP CIDR range to block"
          aria-invalid={!cidrValid}
        />
        <input
          type="text"
          className={styles.input}
          placeholder="reason (optional)"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          aria-label="Block reason"
        />
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Expires (optional)</span>
          <input
            type="datetime-local"
            className={styles.input}
            value={expiresAt}
            onChange={(e) => setExpiresAt(e.target.value)}
            aria-label="Expiry (optional)"
            title="Optional expiry (local time, must be in the future) — the ban auto-lifts after this. Leave blank for a permanent ban."
          />
        </label>
        <ScopeRadio name="ip-scope" value={scope} onChange={setScope} disabled={busy} />
        <Button type="submit" variant="danger" size="sm" disabled={busy || !cidrValid}>
          Block
        </Button>
      </form>

      {!cidrValid ? (
        <p className={styles.error} role="alert">
          Not a valid IPv4 or IPv6 CIDR.
        </p>
      ) : null}
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
        {loading ? 'Loading…' : `${count} blocked range${count === 1 ? '' : 's'}`}
      </div>

      {!loading && count === 0 ? (
        <p className={styles.empty}>No IP ranges are currently blocked.</p>
      ) : (
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col">CIDR</th>
              <th scope="col">Scope</th>
              <th scope="col">Reason</th>
              <th scope="col">Expires</th>
              <th scope="col" className={styles.actionCol}>
                Action
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.cidr}>
                <td>
                  <code className={styles.mono}>{row.cidr}</code>
                  <div className={styles.sub}>{row.ipVersion}</div>
                </td>
                <td>
                  <ScopeBadge scope={row.scope} />
                </td>
                <td>{row.reason ?? <span className={styles.sub}>—</span>}</td>
                <td className={styles.sub}>
                  {row.expiresAt ? new Date(row.expiresAt).toLocaleString() : '—'}
                </td>
                <td className={styles.actionCol}>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={busy}
                    onClick={() => {
                      void remove(row);
                    }}
                  >
                    Unblock
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
