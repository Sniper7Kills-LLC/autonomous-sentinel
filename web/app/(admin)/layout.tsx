import type { ReactNode } from 'react';
import { AdminChrome } from '@/components/layout/AdminChrome';

/** Admin route group: chrome + role-gated sidebar nav (#71). */
export default function AdminLayout({ children }: { children: ReactNode }) {
  return <AdminChrome>{children}</AdminChrome>;
}
