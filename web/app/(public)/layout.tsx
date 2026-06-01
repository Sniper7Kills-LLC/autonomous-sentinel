import type { ReactNode } from 'react';
import { SiteChrome } from '@/components/layout/SiteChrome';

/** Public route group: universal chrome, no auth gate (#71). */
export default function PublicLayout({ children }: { children: ReactNode }) {
  return <SiteChrome>{children}</SiteChrome>;
}
