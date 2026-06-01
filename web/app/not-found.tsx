import Link from 'next/link';

/**
 * Root 404 (#71). Rendered inside the root layout (theme + fonts) but
 * outside any route-group chrome, so it stays minimal and self-contained.
 */
export default function NotFound() {
  return (
    <main
      id="main-content"
      style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '1rem',
        padding: '2rem',
        textAlign: 'center',
        fontFamily: 'var(--font-mono)',
        color: 'var(--color-fg)',
        background: 'var(--color-bg)',
      }}
    >
      <p style={{ fontSize: '0.78rem', letterSpacing: '0.18em', color: 'var(--color-fg-faint)' }}>
        ERR · 404
      </p>
      <h1 style={{ fontSize: '1.6rem', margin: 0 }}>No signal on this frequency.</h1>
      <p style={{ color: 'var(--color-fg-faint)', maxWidth: '46ch' }}>
        The page you requested is not in the archive. Legacy v3 URLs do not redirect — use search or
        the navigation to find what you need.
      </p>
      <Link href="/" style={{ color: 'var(--color-accent)' }}>
        Return to the dashboard →
      </Link>
    </main>
  );
}
