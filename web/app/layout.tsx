import type { Metadata, Viewport } from 'next';
import { Atkinson_Hyperlegible, JetBrains_Mono } from 'next/font/google';
import { ThemeProvider, NO_FLASH_SCRIPT } from '../components/theme/ThemeProvider';
import { AuthProvider } from '../components/auth/AuthProvider';
import './globals.css';

const atkinson = Atkinson_Hyperlegible({
  subsets: ['latin'],
  weight: ['400', '700'],
  variable: '--font-atkinson',
  display: 'swap',
});

const jbMono = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-jb-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Autonomous Sentinel',
  description: 'EAM Watch — Emergency Action Message broadcast catalog.',
  manifest: '/manifest.webmanifest',
  applicationName: 'Autonomous Sentinel',
  appleWebApp: {
    capable: true,
    title: 'Autonomous Sentinel',
    statusBarStyle: 'black-translucent',
  },
};

// Next 15 requires themeColor in the viewport export, not metadata.
export const viewport: Viewport = {
  themeColor: '#0b0f14',
};

/**
 * Inline script that registers the offline-shell service worker once
 * the window load event fires. Kept as a string so it can be injected
 * via `dangerouslySetInnerHTML` — registering inside a client
 * component would defer registration until after hydration and miss
 * a few seconds of first-visit caching opportunity.
 */
const REGISTER_SW = `
if ('serviceWorker' in navigator) {
  window.addEventListener('load', function () {
    navigator.serviceWorker.register('/sw.js').catch(function () { /* no-op */ });
  });
}
`;

/**
 * Dev counterpart: the offline-shell SW is cache-first on `/_next/static`,
 * which is correct in production (immutable content-hashed chunks) but breaks
 * the dev server — after every recompile the SW serves a stale chunk, the
 * loader 404s (`ChunkLoadError`), and the page hard-reloads in a loop. So in
 * development we never register it and actively tear down any SW + caches a
 * prior visit left behind, self-healing the loop.
 */
const UNREGISTER_SW = `
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations().then(function (rs) {
    rs.forEach(function (r) { r.unregister(); });
  });
  if (window.caches) {
    caches.keys().then(function (ks) { ks.forEach(function (k) { caches.delete(k); }); });
  }
}
`;

const IS_PROD = process.env.NODE_ENV === 'production';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${atkinson.variable} ${jbMono.variable}`} suppressHydrationWarning>
      <head>
        <script
          // No-FOUC: set data-theme from localStorage before first paint.
          dangerouslySetInnerHTML={{ __html: NO_FLASH_SCRIPT }}
        />
        <script
          // Register the offline-shell SW in prod; tear it down in dev so its
          // cache-first `/_next/static` handling can't loop the dev server.
          dangerouslySetInnerHTML={{ __html: IS_PROD ? REGISTER_SW : UNREGISTER_SW }}
        />
      </head>
      <body>
        <ThemeProvider>
          <AuthProvider>{children}</AuthProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
