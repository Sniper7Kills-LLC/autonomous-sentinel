'use client';

import Link from 'next/link';
import { PageHeader } from '@/components/layout/PageHeader';
import { AdminGate } from '@/components/admin/AdminGate';
import styles from '@/components/admin/AdminLinguistic.module.css';

/**
 * Admin index (#546).
 *
 * Landing page for the admin area. Currently links the Linguistic Logic
 * config surface; future admin tools (transmitter editor, callsign
 * editor, ban management, etc.) hang off this index. Admin-only.
 */
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
          <section className={styles.section} aria-labelledby="admin-tools">
            <header className={styles.sectionHead}>
              <h2 id="admin-tools" className={styles.sectionTitle}>
                Tools
              </h2>
            </header>
            <ul className={styles.list}>
              <li className={styles.row}>
                <div className={styles.rowBody}>
                  <span className={styles.idMono}>Linguistic Logic</span>
                  <span className={styles.muted}>
                    Bedrock prompt-template versions + generated-rule review queue.
                  </span>
                </div>
                <div className={styles.rowRight}>
                  <Link href="/admin/linguistic" className={styles.link}>
                    Open →
                  </Link>
                </div>
              </li>
            </ul>
          </section>
        </div>
      </AdminGate>
    </>
  );
}
