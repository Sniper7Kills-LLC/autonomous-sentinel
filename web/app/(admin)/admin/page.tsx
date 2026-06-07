'use client';

import Link from 'next/link';
import { PageHeader } from '@/components/layout/PageHeader';
import { AdminGate } from '@/components/admin/AdminGate';
import styles from './AdminDashboard.module.css';

/**
 * Admin index / dashboard (#546).
 *
 * Landing grid for the admin area — one card per operator tool, grouped by
 * domain, mirroring the sidebar nav so every surface is reachable from here
 * (the index previously linked only two). Admin-only.
 */

interface Tool {
  href: string;
  title: string;
  desc: string;
  soon?: boolean;
}

const GROUPS: { heading: string; tools: Tool[] }[] = [
  {
    heading: 'Pipeline & content',
    tools: [
      {
        href: '/admin/linguistic',
        title: 'Linguistic Logic',
        desc: 'Bedrock prompt-template versions, thresholds, schemas + the generated-rule review queue.',
      },
      {
        href: '/admin/dlq',
        title: 'DLQ + reprocess',
        desc: 'Inspect dead-lettered pipeline messages and requeue or drop them.',
      },
      {
        href: '/admin/transmitters',
        title: 'Transmitters',
        desc: 'Curate the public transmitter list shown on the propagation map.',
      },
      {
        href: '/admin/callsigns',
        title: 'Callsigns',
        desc: 'Maintain the callsign dictionary; confirm or reject AI-suggested entries.',
      },
      {
        href: '/admin/fine-tune',
        title: 'Fine-tune',
        desc: 'Trigger a custom EAM Whisper fine-tune from validated corrections.',
        soon: true,
      },
    ],
  },
  {
    heading: 'Community',
    tools: [
      {
        href: '/admin/moderation',
        title: 'Moderation queue',
        desc: 'Review flagged transcripts, comments + user-reported abuse.',
      },
      {
        href: '/admin/reputation',
        title: 'Reputation formula',
        desc: 'Tune the reputation weights that drive community vote weighting.',
      },
    ],
  },
  {
    heading: 'Access & safety',
    tools: [
      {
        href: '/admin/bans',
        title: 'Ban management',
        desc: 'Ban by account, country or IP CIDR; choose write-only or read-block scope.',
      },
      {
        href: '/admin/banned-regions',
        title: 'Banned regions',
        desc: 'Edit the per-country landing page shown to blocked visitors.',
      },
      {
        href: '/admin/users',
        title: 'User groups',
        desc: 'Grant or revoke moderator / admin / diagnostics group membership.',
      },
    ],
  },
  {
    heading: 'Operations',
    tools: [
      {
        href: '/admin/audit',
        title: 'Audit log',
        desc: 'Filterable, read-only history of every admin / mod / system action with diffs.',
      },
      {
        href: '/admin/playback',
        title: 'Playback limits',
        desc: 'Tune per-IP audio rate limits; view most-played audio + top listeners.',
      },
      {
        href: '/admin/budget',
        title: 'AWS budget',
        desc: 'Set the soft / loud / hard monthly spend thresholds + alert email.',
      },
    ],
  },
];

export default function AdminIndexPage() {
  return (
    <>
      <PageHeader
        eyebrow="§09 · Admin"
        title="Admin"
        lede="Operator tooling. Administrators only."
      />
      <AdminGate>
        <div className={styles.page}>
          {GROUPS.map((group) => (
            <section key={group.heading} className={styles.group} aria-label={group.heading}>
              <h2 className={styles.groupHead}>{group.heading}</h2>
              <div className={styles.grid}>
                {group.tools.map((tool) =>
                  tool.soon ? (
                    <div
                      key={tool.href}
                      className={`${styles.card} ${styles.soon}`}
                      aria-disabled="true"
                    >
                      <span className={styles.cardTitle}>{tool.title}</span>
                      <span className={styles.cardDesc}>{tool.desc}</span>
                      <span className={styles.soonTag}>Coming soon</span>
                    </div>
                  ) : (
                    <Link key={tool.href} href={tool.href} className={styles.card}>
                      <span className={styles.cardTitle}>{tool.title}</span>
                      <span className={styles.cardDesc}>{tool.desc}</span>
                      <span className={styles.arrow}>Open →</span>
                    </Link>
                  ),
                )}
              </div>
            </section>
          ))}
        </div>
      </AdminGate>
    </>
  );
}
