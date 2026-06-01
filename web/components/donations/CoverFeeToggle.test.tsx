import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CoverFeeToggle } from './CoverFeeToggle';

describe('CoverFeeToggle', () => {
  it('shows the uplift and intended amount in the label', () => {
    render(<CoverFeeToggle intendedAmount={10} checked={false} onChange={() => {}} />);
    // uplift for $10 is $0.61; intended is $10.00
    expect(screen.getByText('$0.61')).toBeInTheDocument();
    expect(screen.getByText('$10.00')).toBeInTheDocument();
  });

  it('reveals the charged total only when checked', () => {
    const { rerender } = render(
      <CoverFeeToggle intendedAmount={10} checked={false} onChange={() => {}} />,
    );
    expect(screen.queryByText(/you’ll be charged/i)).not.toBeInTheDocument();
    rerender(<CoverFeeToggle intendedAmount={10} checked onChange={() => {}} />);
    expect(screen.getByText(/you’ll be charged/i)).toBeInTheDocument();
    expect(screen.getByText('$10.61')).toBeInTheDocument();
  });

  it('fires onChange when toggled', () => {
    const onChange = vi.fn();
    render(<CoverFeeToggle intendedAmount={25} checked={false} onChange={onChange} />);
    fireEvent.click(screen.getByRole('checkbox'));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('always shows the Stripe footnote', () => {
    render(<CoverFeeToggle intendedAmount={0} checked={false} onChange={() => {}} />);
    expect(screen.getByText(/2\.9% \+ \$0\.30/)).toBeInTheDocument();
  });
});
