import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { RegexTester } from './RegexTester';

describe('RegexTester', () => {
  it('highlights matches and reports the count', () => {
    render(<RegexTester pattern="skyking" initialSample="skyking skyking do not answer" />);
    expect(screen.getByTestId('regex-count')).toHaveTextContent('2 matches');
    const highlight = screen.getByTestId('regex-highlight');
    const marks = highlight.querySelectorAll('mark');
    expect(marks).toHaveLength(2);
  });

  it('shows named capture groups', () => {
    render(
      <RegexTester
        pattern="this is (?<sender>[a-z]+), out"
        initialSample="this is mainsail, out"
      />,
    );
    const groups = screen.getByTestId('regex-groups');
    expect(groups).toHaveTextContent('sender');
    expect(groups).toHaveTextContent('mainsail');
  });

  it('reports no match', () => {
    render(<RegexTester pattern="mainsail" initialSample="skyking do not answer" />);
    expect(screen.getByTestId('regex-count')).toHaveTextContent('No match');
  });

  it('surfaces an invalid pattern error', () => {
    render(<RegexTester pattern="(unclosed" initialSample="anything" />);
    expect(screen.getByTestId('regex-error')).toBeInTheDocument();
  });

  it('updates matches when the sample text changes', () => {
    render(<RegexTester pattern="skyking" initialSample="" />);
    const textarea = screen.getByLabelText('Test against sample text');
    fireEvent.change(textarea, { target: { value: 'SKYKING' } });
    expect(screen.getByTestId('regex-count')).toHaveTextContent('1 match');
  });
});
