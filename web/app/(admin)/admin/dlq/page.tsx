'use client';

import { PageHeader } from '@/components/layout/PageHeader';
import { DlqList } from '@/components/admin/DlqList';

/**
 * Admin · DLQ + manual reprocess (#107).
 *
 * Surfaces every recording / job stuck on a pipeline-stage dead-letter
 * queue (preprocess / transcribe / linguistic) with one-click retry +
 * drop, so an admin can triage failures without opening the AWS console
 * (a phase-4 exit criterion). The surrounding `(admin)` chrome gates
 * render to the admin group; every DLQ operation is admin-gated
 * server-side too.
 */
export default function AdminDlqPage() {
  return (
    <>
      <PageHeader
        eyebrow="§04 · Admin"
        title="DLQ + manual reprocess"
        lede="Triage recordings stuck on a pipeline dead-letter queue. Retry re-queues to the primary queue for another attempt; Drop permanently removes the message and marks the recording FAILED. Administrators only."
      />
      <DlqList />
    </>
  );
}
