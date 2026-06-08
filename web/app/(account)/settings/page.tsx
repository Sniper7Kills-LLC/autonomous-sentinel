'use client';

import Link from 'next/link';
import { PageHeader } from '@/components/layout/PageHeader';
import styles from './SettingsDashboard.module.css';

/**
 * Settings dashboard (#788).
 *
 * Landing grid for the account area — one card per settings surface, grouped,
 * mirroring the admin dashboard. The `(account)` layout already gates this
 * behind `RequireAuth`, so no extra auth check here.
 */

interface Surface {
  href: string;
  title: string;
  desc: string;
}

const GROUPS: { heading: string; surfaces: Surface[] }[] = [
  {
    heading: 'Account',
    surfaces: [
      {
        href: '/settings/profile',
        title: 'Profile',
        desc: 'Display name, bio, and avatar — your public profile.',
      },
      {
        href: '/settings/security',
        title: 'Security',
        desc: 'Password and TOTP two-factor authentication.',
      },
    ],
  },
  {
    heading: 'Contributions',
    surfaces: [
      {
        href: '/uploads',
        title: 'My uploads',
        desc: 'Every recording you have uploaded with its per-step pipeline status.',
      },
      {
        href: '/settings/sdrs',
        title: 'SDRs',
        desc: 'Register receivers you operate, or submit a public one for admin review.',
      },
    ],
  },
  {
    heading: 'Preferences',
    surfaces: [
      {
        href: '/settings/notifications',
        title: 'Notifications',
        desc: 'Email, web-push, and Discord alerts per message type.',
      },
    ],
  },
  {
    heading: 'Danger zone',
    surfaces: [
      {
        href: '/settings/delete',
        title: 'Delete account',
        desc: 'Permanently delete your account; data + audit trail are retained per policy.',
      },
    ],
  },
];

export default function SettingsIndexPage() {
  return (
    <>
      <PageHeader
        eyebrow="§ Account"
        title="Settings"
        lede="Manage your account, contributions, and preferences."
      />
      <div className={styles.page}>
        {GROUPS.map((group) => (
          <section key={group.heading} className={styles.group} aria-label={group.heading}>
            <h2 className={styles.groupHead}>{group.heading}</h2>
            <div className={styles.grid}>
              {group.surfaces.map((s) => (
                <Link key={s.href} href={s.href} className={styles.card}>
                  <span className={styles.cardTitle}>{s.title}</span>
                  <span className={styles.cardDesc}>{s.desc}</span>
                  <span className={styles.arrow}>Open →</span>
                </Link>
              ))}
            </div>
          </section>
        ))}
      </div>
    </>
  );
}
