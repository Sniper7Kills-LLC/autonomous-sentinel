'use client';

import { useEffect } from 'react';
import { configureAmplifyOnce } from '@/lib/amplifyClient';

/**
 * Runs `Amplify.configure(...)` exactly once on the client. Mount this
 * once near the root of any route that needs Amplify Data / Storage /
 * Auth calls. Hooks `useEffect` to keep it strictly client-only — the
 * config call reads `amplify_outputs.json` synchronously but the import
 * is fine on the server too, only the actual configure() must run after
 * hydration so the underlying SDKs see a consistent window/document.
 */
export function AmplifyConfigure() {
  useEffect(() => {
    configureAmplifyOnce();
  }, []);
  return null;
}
