import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import AdminLinguisticPage from './page';

vi.mock('@/components/admin/AdminGate', () => ({
  AdminGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('@/components/layout/PageHeader', () => ({
  PageHeader: ({ title }: { title: string }) => <h1>{title}</h1>,
}));
vi.mock('@/components/admin/LinguisticPromptTemplates', () => ({
  LinguisticPromptTemplates: () => <div>PROMPT PANEL</div>,
}));
vi.mock('@/components/admin/LinguisticWhisperPromptEditor', () => ({
  LinguisticWhisperPromptEditor: () => <div>WHISPER PANEL</div>,
}));
vi.mock('@/components/admin/LinguisticThresholdsEditor', () => ({
  LinguisticThresholdsEditor: () => <div>THRESHOLDS PANEL</div>,
}));
vi.mock('@/components/admin/LinguisticSchemasEditor', () => ({
  LinguisticSchemasEditor: () => <div>SCHEMAS PANEL</div>,
}));
vi.mock('@/components/admin/LinguisticRulesQueue', () => ({
  LinguisticRulesQueue: () => <div>RULES PANEL</div>,
}));

describe('AdminLinguisticPage tabs (#546)', () => {
  it('renders a tab per section, prompt active first', () => {
    render(<AdminLinguisticPage />);
    expect(screen.getAllByRole('tab')).toHaveLength(5);
    expect(screen.getByRole('tab', { name: /prompt templates/i })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    // The active panel is visible; others are hidden (not their tab).
    expect(screen.getByText('PROMPT PANEL').closest('[role="tabpanel"]')).not.toHaveAttribute(
      'hidden',
    );
    expect(screen.getByText('RULES PANEL').closest('[role="tabpanel"]')).toHaveAttribute('hidden');
  });

  it('switches the visible panel on tab click', () => {
    render(<AdminLinguisticPage />);
    fireEvent.click(screen.getByRole('tab', { name: /rules queue/i }));
    expect(screen.getByRole('tab', { name: /rules queue/i })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByText('RULES PANEL').closest('[role="tabpanel"]')).not.toHaveAttribute(
      'hidden',
    );
    expect(screen.getByText('PROMPT PANEL').closest('[role="tabpanel"]')).toHaveAttribute('hidden');
  });
});
