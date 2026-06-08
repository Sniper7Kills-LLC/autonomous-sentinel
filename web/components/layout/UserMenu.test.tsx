import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { UserMenu } from './UserMenu';

interface AuthShape {
  loading: boolean;
  signedIn: boolean;
  username: string | null;
  sub: string | null;
  groups: string[];
}

let auth: AuthShape;
vi.mock('@/components/auth/AuthProvider', () => ({
  useAuth: () => auth,
}));

let theme = 'auto';
const setTheme = vi.fn((t: string) => {
  theme = t;
});
vi.mock('@/components/theme/ThemeProvider', () => ({
  useTheme: () => ({ theme, setTheme }),
}));

const signedInAuth: AuthShape = {
  loading: false,
  signedIn: true,
  username: 'sentinel@example.com',
  sub: 'sub-123',
  groups: [],
};

describe('UserMenu', () => {
  beforeEach(() => {
    auth = { ...signedInAuth };
    theme = 'auto';
    setTheme.mockClear();
  });

  it('renders nothing when signed out', () => {
    auth = { ...signedInAuth, signedIn: false, username: null, sub: null };
    const { container } = render(<UserMenu />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders a collapsed menu trigger when signed in', () => {
    render(<UserMenu />);
    const trigger = screen.getByRole('button', { name: /account menu/i });
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('shows a monogram from the username', () => {
    render(<UserMenu />);
    expect(screen.getByText('S')).toBeInTheDocument();
  });

  it('opens the menu on click and shows the account items', () => {
    render(<UserMenu />);
    fireEvent.click(screen.getByRole('button', { name: /account menu/i }));

    expect(screen.getByRole('menu', { name: /account/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /account menu/i })).toHaveAttribute(
      'aria-expanded',
      'true',
    );

    const viewProfile = screen.getByRole('menuitem', { name: /view profile/i });
    expect(viewProfile).toHaveAttribute('href', '/users/view?id=sub-123');
    expect(screen.getByRole('menuitem', { name: /^settings$/i })).toHaveAttribute(
      'href',
      '/settings',
    );
    expect(screen.getByRole('menuitem', { name: /sign out/i })).toBeInTheDocument();
  });

  it('exposes a three-way theme picker reflecting the active theme', () => {
    theme = 'dark';
    render(<UserMenu />);
    fireEvent.click(screen.getByRole('button', { name: /account menu/i }));

    const dark = screen.getByRole('menuitemradio', { name: /dark/i });
    expect(dark).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('menuitemradio', { name: /light/i })).toHaveAttribute(
      'aria-checked',
      'false',
    );

    fireEvent.click(screen.getByRole('menuitemradio', { name: /light/i }));
    expect(setTheme).toHaveBeenCalledWith('light');
  });

  it('closes on Escape', () => {
    render(<UserMenu />);
    fireEvent.click(screen.getByRole('button', { name: /account menu/i }));
    expect(screen.getByRole('menu')).toBeInTheDocument();

    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('closes on outside click', () => {
    render(
      <div>
        <UserMenu />
        <button type="button">outside</button>
      </div>,
    );
    fireEvent.click(screen.getByRole('button', { name: /account menu/i }));
    expect(screen.getByRole('menu')).toBeInTheDocument();

    fireEvent.mouseDown(screen.getByRole('button', { name: /outside/i }));
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('signs out via aws-amplify and redirects home', async () => {
    const signOut = vi.fn().mockResolvedValue(undefined);
    vi.doMock('aws-amplify/auth', () => ({ signOut }));
    const assign = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, assign },
    });

    render(<UserMenu />);
    fireEvent.click(screen.getByRole('button', { name: /account menu/i }));
    fireEvent.click(screen.getByRole('menuitem', { name: /sign out/i }));

    await vi.waitFor(() => expect(signOut).toHaveBeenCalled());
    await vi.waitFor(() => expect(assign).toHaveBeenCalledWith('/'));
  });
});
