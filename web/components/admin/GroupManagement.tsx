'use client';

import { useCallback, useState } from 'react';
import { Button } from '@/components/ui/Button';
import {
  ASSIGNABLE_GROUPS,
  findUserSubByEmail,
  listUserGroups,
  setUserGroup,
  type AssignableGroup,
} from '@/lib/admin/groups';
import styles from './GroupManagement.module.css';

/**
 * Admin user-group management (#743).
 *
 * Look up a user by email, then add/remove Cognito groups via the
 * admin-only `setUserGroup` mutation. The `diagnostics` group gates the
 * deep linguistic-trace debug surface; the hierarchy groups
 * (admin/moderator/member) drive the rest of authorization. All writes are
 * admin-only server-side + audited (`USER_ROLE_CHANGE`); this only decides
 * what to render.
 */
export function GroupManagement() {
  const [email, setEmail] = useState('');
  const [sub, setSub] = useState<string | null>(null);
  const [resolvedEmail, setResolvedEmail] = useState<string | null>(null);
  const [groups, setGroups] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyGroup, setBusyGroup] = useState<AssignableGroup | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const lookup = useCallback(async () => {
    const addr = email.trim();
    if (!addr) {
      setError('Enter the email of the user to manage.');
      return;
    }
    setLoading(true);
    setError(null);
    setNotice(null);
    setSub(null);
    try {
      const found = await findUserSubByEmail(addr);
      if (!found) {
        setError(`No user found for ${addr}.`);
        return;
      }
      const current = await listUserGroups(found);
      setSub(found);
      setResolvedEmail(addr);
      setGroups(current);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Lookup failed.');
    } finally {
      setLoading(false);
    }
  }, [email]);

  const toggle = useCallback(
    async (group: AssignableGroup, isMember: boolean) => {
      if (!sub) return;
      setBusyGroup(group);
      setError(null);
      setNotice(null);
      try {
        const updated = await setUserGroup(sub, group, isMember ? 'remove' : 'add');
        setGroups(updated);
        setNotice(`${isMember ? 'Removed' : 'Added'} ${group}.`);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Update failed.');
      } finally {
        setBusyGroup(null);
      }
    },
    [sub],
  );

  return (
    <section className={styles.wrap} aria-label="User group management">
      <form
        className={styles.lookupForm}
        onSubmit={(e) => {
          e.preventDefault();
          void lookup();
        }}
        aria-label="Look up a user"
      >
        <input
          type="email"
          className={styles.input}
          placeholder="user@email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          aria-label="User email to look up"
        />
        <Button type="submit" size="sm" disabled={loading}>
          {loading ? 'Looking up…' : 'Look up'}
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

      {sub ? (
        <div className={styles.panel} data-testid="group-editor">
          <p className={styles.who}>
            Managing <strong>{resolvedEmail}</strong> <code className={styles.mono}>{sub}</code>
          </p>
          <ul className={styles.groupList}>
            {ASSIGNABLE_GROUPS.map((group) => {
              const isMember = groups.includes(group);
              return (
                <li key={group} className={styles.groupRow}>
                  <span className={styles.groupName}>
                    {group}
                    {isMember ? (
                      <span className={styles.memberBadge} data-testid={`member-${group}`}>
                        member
                      </span>
                    ) : null}
                  </span>
                  <Button
                    variant={isMember ? 'secondary' : 'primary'}
                    size="sm"
                    disabled={busyGroup !== null}
                    loading={busyGroup === group}
                    onClick={() => {
                      void toggle(group, isMember);
                    }}
                  >
                    {isMember ? 'Remove' : 'Add'}
                  </Button>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
