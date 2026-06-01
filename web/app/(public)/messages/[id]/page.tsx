import { PageHeader } from '@/components/layout/PageHeader';
import { MessageDetailView } from '@/components/browse/MessageDetailView';

/**
 * Canonical message-detail route (#71). Replaces the legacy
 * `/message?id=<uuid>` query-param page with a clean
 * `/messages/<id>` path so the vote / revision / player surface is
 * linkable and shareable.
 */
export default async function MessageDetailRoute({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <>
      <PageHeader eyebrow="§02 · Message" title="Detail" />
      <MessageDetailView messageId={id} />
    </>
  );
}
