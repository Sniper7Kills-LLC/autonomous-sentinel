'use client';

import { PageHeader } from '@/components/layout/PageHeader';
import { ModerationQueue } from '@/components/admin/ModerationQueue';

/**
 * Admin · Moderation queue (#118).
 *
 * The unified triage surface for flagged + reported content. The
 * surrounding `(admin)` chrome (`AdminChrome`) already gates render to
 * the `admin` + `moderator` Cognito groups, and every AppSync model the
 * queue touches enforces the same authorization server-side. The page
 * just renders the heading + the queue component.
 */
export default function AdminModerationPage() {
  return (
    <>
      <PageHeader
        eyebrow="§04 · Admin"
        title="Moderation queue"
        lede="Triage flagged comments, flagged messages, and user reports in one place. Oldest first. Moderators + administrators only."
      />
      <ModerationQueue />
    </>
  );
}
