import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { LinguisticRulesQueue } from './LinguisticRulesQueue';
import type { AdminRule } from '@/lib/admin/linguistic';

const listMock = vi.fn<() => Promise<AdminRule[]>>();
const setEnabledMock = vi.fn<(id: string, enabled: boolean) => Promise<void>>();
const deleteMock = vi.fn<(id: string) => Promise<void>>();

vi.mock('@/lib/admin/linguistic', async (importActual) => {
  const actual = await importActual<Record<string, unknown>>();
  return {
    ...actual,
    listRules: () => listMock(),
    setRuleEnabled: (id: string, enabled: boolean) => setEnabledMock(id, enabled),
    deleteRule: (id: string) => deleteMock(id),
  };
});

function rule(p: Partial<AdminRule>): AdminRule {
  return {
    id: 'r1',
    component: 'TYPE',
    pattern: 'sky ?king',
    confidence: 0.9,
    enabled: true,
    messageType: 'SKYKING',
    appliesToType: null,
    priority: 1,
    notes: null,
    ...p,
  };
}

beforeEach(() => {
  listMock.mockReset();
  setEnabledMock.mockReset();
  deleteMock.mockReset();
  setEnabledMock.mockResolvedValue(undefined);
  deleteMock.mockResolvedValue(undefined);
});

describe('LinguisticRulesQueue', () => {
  it('lists rules with component, type, confidence and pattern', async () => {
    listMock.mockResolvedValue([rule({ id: 'r1', confidence: 0.5, enabled: false })]);
    render(<LinguisticRulesQueue />);
    await waitFor(() => expect(screen.getByTestId('rule-list')).toBeInTheDocument());
    expect(screen.getByText('sky ?king')).toBeInTheDocument();
    expect(screen.getByText('conf 0.50')).toBeInTheDocument();
    expect(screen.getByText('DISABLED')).toBeInTheDocument();
  });

  it('toggling an enabled rule calls setRuleEnabled(false)', async () => {
    listMock.mockResolvedValue([rule({ id: 'r1', enabled: true })]);
    render(<LinguisticRulesQueue />);
    await waitFor(() => expect(screen.getByTestId('rule-list')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Deactivate'));
    await waitFor(() => expect(setEnabledMock).toHaveBeenCalledWith('r1', false));
  });

  it('toggling a disabled rule calls setRuleEnabled(true)', async () => {
    listMock.mockResolvedValue([rule({ id: 'r1', enabled: false })]);
    render(<LinguisticRulesQueue />);
    await waitFor(() => expect(screen.getByTestId('rule-list')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Activate'));
    await waitFor(() => expect(setEnabledMock).toHaveBeenCalledWith('r1', true));
  });

  it('deleting a rule calls deleteRule and removes it from the list', async () => {
    listMock.mockResolvedValue([rule({ id: 'r1' })]);
    render(<LinguisticRulesQueue />);
    await waitFor(() => expect(screen.getByTestId('rule-list')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Delete'));
    await waitFor(() => expect(deleteMock).toHaveBeenCalledWith('r1'));
    await waitFor(() => expect(screen.getByText('No rules yet.')).toBeInTheDocument());
  });

  it('the "only disabled" filter hides enabled rules', async () => {
    listMock.mockResolvedValue([
      rule({ id: 'r1', enabled: true, pattern: 'enabled-pat' }),
      rule({ id: 'r2', enabled: false, pattern: 'disabled-pat' }),
    ]);
    render(<LinguisticRulesQueue />);
    await waitFor(() => expect(screen.getByTestId('rule-list')).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText('Show only disabled (review queue)'));
    expect(screen.queryByText('enabled-pat')).not.toBeInTheDocument();
    expect(screen.getByText('disabled-pat')).toBeInTheDocument();
  });

  it('surfaces a load error', async () => {
    listMock.mockRejectedValue(new Error('Unauthorized'));
    render(<LinguisticRulesQueue />);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Unauthorized'));
  });
});
