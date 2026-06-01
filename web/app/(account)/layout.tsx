import type { ReactNode } from 'react';
import { SiteChrome } from '@/components/layout/SiteChrome';
import { RequireAuth } from '@/components/layout/RequireAuth';

/** Account route group: universal chrome behind a client auth gate (#71). */
export default function AccountLayout({ children }: { children: ReactNode }) {
  return (
    <SiteChrome>
      <RequireAuth>{children}</RequireAuth>
    </SiteChrome>
  );
}
