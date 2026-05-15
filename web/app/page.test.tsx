import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import HomePage from './page';

describe('HomePage', () => {
  it('renders the project codename', () => {
    render(<HomePage />);
    expect(screen.getByRole('heading', { name: /autonomous sentinel/i })).toBeInTheDocument();
  });

  it('flags scaffolding state', () => {
    render(<HomePage />);
    expect(screen.getByText(/scaffolding in progress/i)).toBeInTheDocument();
  });
});
