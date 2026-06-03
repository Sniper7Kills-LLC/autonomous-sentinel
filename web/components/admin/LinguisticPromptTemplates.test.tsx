import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { LinguisticPromptTemplates } from './LinguisticPromptTemplates';
import type { DisplayTemplate } from '@/lib/admin/linguistic';

const listMock = vi.fn<() => Promise<DisplayTemplate[]>>();
const saveMock = vi.fn<(input: unknown) => Promise<DisplayTemplate>>();
const activateMock = vi.fn<(id: string) => Promise<DisplayTemplate>>();

vi.mock('@/lib/admin/linguistic', async (importActual) => {
  const actual = await importActual<Record<string, unknown>>();
  return {
    ...actual,
    listPromptTemplates: (): Promise<DisplayTemplate[]> => listMock(),
    saveNewTemplateVersion: (input: unknown): Promise<DisplayTemplate> => saveMock(input),
    activateTemplate: (id: string): Promise<DisplayTemplate> => activateMock(id),
  };
});

function tpl(p: Partial<DisplayTemplate>): DisplayTemplate {
  return {
    id: 'a',
    promptId: 'linguistic-parse-bedrock',
    version: 1,
    body: 'body {{TRANSCRIPT}}',
    isActive: false,
    notes: null,
    createdBy: null,
    createdAt: null,
    ...p,
  };
}

beforeEach(() => {
  listMock.mockReset();
  saveMock.mockReset();
  activateMock.mockReset();
  saveMock.mockResolvedValue(tpl({ id: 'new', version: 3 }));
  activateMock.mockResolvedValue(tpl({ id: 'b', version: 1, isActive: true }));
});

describe('LinguisticPromptTemplates', () => {
  it('lists versions and marks the active one', async () => {
    listMock.mockResolvedValue([
      tpl({ id: 'a', version: 2, isActive: true }),
      tpl({ id: 'b', version: 1, isActive: false }),
    ]);
    render(<LinguisticPromptTemplates />);
    await waitFor(() => expect(screen.getByTestId('template-list')).toBeInTheDocument());
    expect(screen.getByText('ACTIVE')).toBeInTheDocument();
    expect(screen.getByText('v2')).toBeInTheDocument();
  });

  it('copies the system default into the editor', async () => {
    listMock.mockResolvedValue([]);
    render(<LinguisticPromptTemplates />);
    await waitFor(() => expect(screen.getByTestId('template-list')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Copy the system default'));
    const textarea = screen.getByLabelText('Prompt body');
    expect(textarea).toHaveDisplayValue(/\{\{TRANSCRIPT\}\}/);
    expect(textarea).toHaveDisplayValue(/EAM Parser/);
  });

  it('saving calls saveNewTemplateVersion with the draft body', async () => {
    listMock.mockResolvedValue([tpl({ id: 'a', version: 2, isActive: true })]);
    render(<LinguisticPromptTemplates />);
    await waitFor(() => expect(screen.getByTestId('template-list')).toBeInTheDocument());
    const textarea = screen.getByLabelText('Prompt body');
    fireEvent.change(textarea, { target: { value: 'edited body {{TRANSCRIPT}}' } });
    fireEvent.click(screen.getByText('Save new version'));
    await waitFor(() => expect(saveMock).toHaveBeenCalledTimes(1));
    const arg = saveMock.mock.calls[0]![0] as { body: string };
    expect(arg.body).toBe('edited body {{TRANSCRIPT}}');
  });

  it('disables save when the placeholder is missing', async () => {
    listMock.mockResolvedValue([]);
    render(<LinguisticPromptTemplates />);
    await waitFor(() => expect(screen.getByTestId('template-list')).toBeInTheDocument());
    const textarea = screen.getByLabelText('Prompt body');
    fireEvent.change(textarea, { target: { value: 'no placeholder here' } });
    expect(screen.getByText('Save new version').closest('button')).toBeDisabled();
    expect(saveMock).not.toHaveBeenCalled();
  });

  it('activates an inactive version via the atomic mutation and reports success', async () => {
    listMock.mockResolvedValue([
      tpl({ id: 'a', version: 2, isActive: true }),
      tpl({ id: 'b', version: 1, isActive: false }),
    ]);
    render(<LinguisticPromptTemplates />);
    await waitFor(() => expect(screen.getByTestId('template-list')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Activate'));
    await waitFor(() => expect(activateMock).toHaveBeenCalledWith('b'));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/Activated/));
  });

  it('surfaces an activation error', async () => {
    listMock.mockResolvedValue([
      tpl({ id: 'a', version: 2, isActive: true }),
      tpl({ id: 'b', version: 1, isActive: false }),
    ]);
    activateMock.mockRejectedValue(new Error('conditional check failed'));
    render(<LinguisticPromptTemplates />);
    await waitFor(() => expect(screen.getByTestId('template-list')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Activate'));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(/conditional check failed/),
    );
  });

  it('surfaces a load error', async () => {
    listMock.mockRejectedValue(new Error('Unauthorized'));
    render(<LinguisticPromptTemplates />);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Unauthorized'));
  });
});
