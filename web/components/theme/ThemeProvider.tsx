'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

export type Theme = 'light' | 'dark' | 'auto';

interface ThemeCtx {
  theme: Theme;
  setTheme: (t: Theme) => void;
}

const Ctx = createContext<ThemeCtx | null>(null);

export const THEME_STORAGE_KEY = 'as-theme';

function applyTheme(theme: Theme) {
  const root = document.documentElement;
  if (theme === 'auto') {
    root.removeAttribute('data-theme');
  } else {
    root.dataset.theme = theme;
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>('auto');

  // Hydrate from localStorage on mount; the no-FOUC inline script in
  // <head> has already set data-theme, so this just syncs React state.
  useEffect(() => {
    try {
      const stored = localStorage.getItem(THEME_STORAGE_KEY) as Theme | null;
      if (stored === 'light' || stored === 'dark' || stored === 'auto') {
        setThemeState(stored);
      }
    } catch {
      /* localStorage unavailable — leave at default */
    }
  }, []);

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      /* swallow — user has storage disabled */
    }
    applyTheme(next);
  }, []);

  const value = useMemo(() => ({ theme, setTheme }), [theme, setTheme]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTheme(): ThemeCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useTheme must be used inside <ThemeProvider>');
  return ctx;
}

/**
 * Inline script content for <head>. Runs before paint and sets
 * data-theme based on stored preference, falling back to OS. Prevents
 * FOUC on hard refresh.
 *
 * The localStorage key is hard-coded as a literal — not interpolated from
 * THEME_STORAGE_KEY — so that this string is fully static at build time
 * and never carries any future value that might shadow it. If you rename
 * the constant, update the literal here in lockstep.
 */
export const NO_FLASH_SCRIPT = `
(function () {
  try {
    var s = localStorage.getItem('as-theme');
    if (s === 'light' || s === 'dark') {
      document.documentElement.setAttribute('data-theme', s);
    }
  } catch (_) {}
})();
`;
