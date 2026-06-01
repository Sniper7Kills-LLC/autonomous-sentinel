'use client';

import { useEffect, useState } from 'react';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { useSessionState } from '@/components/account/SessionGreeting';
import { getProfile, type DisplayProfile, type UserRole } from '@/lib/users/profile';
import styles from './ProfileView.module.css';

interface ProfileViewProps {
  /** Cognito sub of the profile to display. */
  id: string;
}

const ROLE_TONE: Record<UserRole, BadgeTone> = {
  admin: 'danger',
  moderator: 'accent',
  member: 'neutral',
};

function roleLabel(role: UserRole): string {
  return role.toUpperCase();
}

function formatJoined(ts: string | null): string | null {
  if (!ts) return null;
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

/**
 * `<ProfileView>` — public operator profile card (#85).
 *
 * Shows display name / handle, role badge, account-join date, and
 * reputation-derived submission stats (the truthful public source; the
 * User model carries no denormalized counts and we do not scan the
 * unbounded Recording/Comment lists). When the user has self-deleted,
 * `getUserPublic` returns the row with PII nulled + `piiBlanked=true` and
 * we render the deactivated-account empty state instead.
 *
 * Supporter badge: NOT rendered. Badge state lives on the `Donation`
 * model, which has no public read surface, so there is nothing truthful
 * to show here yet. The badge slot is owned by #106 (supporter badge
 * display) once a public badge-state read exists — see the marked slot
 * below. We deliberately render nothing rather than fake a badge.
 */
export function ProfileView({ id }: ProfileViewProps) {
  const [profile, setProfile] = useState<DisplayProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const session = useSessionState();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getProfile(id)
      .then((p) => {
        if (!cancelled) setProfile(p);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (loading) {
    return (
      <div className={styles.notice} aria-busy>
        Loading profile…
      </div>
    );
  }

  if (error) {
    return (
      <div className={styles.notice} role="alert">
        Could not load profile: {error}
      </div>
    );
  }

  if (!profile) {
    return <div className={styles.notice}>No operator found for that id.</div>;
  }

  if (profile.piiBlanked) {
    return (
      <div className={styles.shell}>
        <section className={styles.card}>
          <p className={styles.deactivated}>This account has been deactivated.</p>
        </section>
      </div>
    );
  }

  const isSelf = session.signedIn && session.sub === profile.id;
  const joined = formatJoined(profile.joinedAt);
  const label = profile.displayName ?? profile.handle ?? 'Operator';

  return (
    <div className={styles.shell}>
      <section className={styles.card} aria-labelledby="profile-name">
        <div className={styles.top}>
          <h2 id="profile-name" className={styles.name}>
            {label}
          </h2>
          <Badge tone={ROLE_TONE[profile.role]}>{roleLabel(profile.role)}</Badge>
          {isSelf && <Badge tone="info">YOU</Badge>}
          {/*
            Supporter-badge slot (#106): the Donation model has no public
            read surface yet, so no badge data is available here. Render
            nothing rather than fake a badge — wire the public badge-state
            read in #106.
          */}
        </div>

        {profile.handle && profile.displayName && profile.handle !== profile.displayName && (
          <p className={styles.handle}>@{profile.handle}</p>
        )}

        {joined && (
          <p className={styles.joined}>
            Joined <time dateTime={profile.joinedAt ?? undefined}>{joined}</time>
          </p>
        )}
      </section>

      <section className={styles.card} aria-labelledby="profile-stats">
        <h3 id="profile-stats" className={styles.sectionHead}>
          Contribution stats
        </h3>
        {profile.reputation ? (
          <dl className={styles.stats}>
            <div className={styles.stat}>
              <dt className={styles.statLabel}>Validated submissions</dt>
              <dd className={styles.statValue}>{profile.reputation.validatedSubmissions}</dd>
            </div>
            <div className={styles.stat}>
              <dt className={styles.statLabel}>Accepted corrections</dt>
              <dd className={styles.statValue}>{profile.reputation.acceptedCorrections}</dd>
            </div>
            <div className={styles.stat}>
              <dt className={styles.statLabel}>Reputation weight</dt>
              <dd className={styles.statValue}>{profile.reputation.computedWeight.toFixed(1)}×</dd>
            </div>
          </dl>
        ) : (
          <p className={styles.noStats}>No contributions recorded yet.</p>
        )}
      </section>

      {isSelf && (
        <section className={styles.card} aria-labelledby="self-actions">
          <h3 id="self-actions" className={styles.sectionHead}>
            Account
          </h3>
          {/*
            Profile editing form is a separate issue under account
            settings (#85 "Out of scope"); account deletion lives at
            #101 (route: /settings/delete). Link out rather than
            embedding those flows here.
          */}
          <div className={styles.actions}>
            <a className={styles.actionLink} href="/settings/notifications">
              Notification settings
            </a>
            <a className={styles.actionLink} href="/settings/delete">
              Delete account
            </a>
          </div>
        </section>
      )}
    </div>
  );
}
