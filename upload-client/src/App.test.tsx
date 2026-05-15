import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import App from './App';

describe('upload-client App', () => {
  it('renders the project codename', () => {
    render(<App />);
    expect(
      screen.getByRole('heading', { name: /autonomous sentinel — upload client/i }),
    ).toBeInTheDocument();
  });
});
