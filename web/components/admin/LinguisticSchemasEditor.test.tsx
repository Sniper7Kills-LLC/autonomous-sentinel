import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { LinguisticSchemasEditor } from './LinguisticSchemasEditor';
import { MESSAGE_TYPES } from '@/lib/messages/filters';

const getMock = vi.fn<(key: string) => Promise<unknown>>();
const upsertMock = vi.fn<(key: string, value: unknown, notes?: string | null) => Promise<void>>();

vi.mock('@/lib/admin/linguistic', async (importActual) => {
  const actual = await importActual<Record<string, unknown>>();
  return {
    ...actual,
    getLinguisticConfig: (key: string): Promise<unknown> => getMock(key),
    upsertLinguisticConfig: (key: string, value: unknown, notes?: string | null): Promise<void> =>
      upsertMock(key, value, notes),
  };
});

beforeEach(() => {
  getMock.mockReset();
  upsertMock.mockReset();
  getMock.mockResolvedValue(undefined);
  upsertMock.mockResolvedValue(undefined);
});

describe('LinguisticSchemasEditor', () => {
  it('renders one textarea per message type', async () => {
    render(<LinguisticSchemasEditor />);
    await waitFor(() => expect(screen.getByTestId('schemas-list')).toBeInTheDocument());
    for (const type of MESSAGE_TYPES) {
      expect(screen.getByTestId(`schema-textarea-${type}`)).toBeInTheDocument();
    }
  });

  it('seeds and pretty-prints a saved schema', async () => {
    getMock.mockResolvedValue({ SKYKING: { sender: { type: 'string' } } });
    render(<LinguisticSchemasEditor />);
    await waitFor(() => expect(screen.getByTestId('schemas-list')).toBeInTheDocument());
    const ta = screen.getByTestId('schema-textarea-SKYKING');
    expect(ta).toHaveDisplayValue(/"sender"/);
  });

  it('blocks save and shows an error on invalid JSON', async () => {
    render(<LinguisticSchemasEditor />);
    await waitFor(() => expect(screen.getByTestId('schemas-list')).toBeInTheDocument());
    fireEvent.change(screen.getByTestId('schema-textarea-SKYKING'), {
      target: { value: '{ not json' },
    });
    expect(screen.getByTestId('schema-error-SKYKING')).toBeInTheDocument();
    expect(screen.getByText('Save schemas').closest('button')).toBeDisabled();
    fireEvent.click(screen.getByText('Save schemas'));
    expect(upsertMock).not.toHaveBeenCalled();
  });

  it('saves the parsed map when all JSON is valid', async () => {
    render(<LinguisticSchemasEditor />);
    await waitFor(() => expect(screen.getByTestId('schemas-list')).toBeInTheDocument());
    fireEvent.change(screen.getByTestId('schema-textarea-OTHER'), {
      target: { value: '{ "body": { "type": "string" } }' },
    });
    fireEvent.click(screen.getByText('Save schemas'));
    await waitFor(() => expect(upsertMock).toHaveBeenCalledTimes(1));
    const [key, value] = upsertMock.mock.calls[0]! as [string, Record<string, unknown>];
    expect(key).toBe('schemas');
    expect(value.OTHER).toEqual({ body: { type: 'string' } });
    expect(value.SKYKING).toEqual({});
  });

  it('surfaces a save error', async () => {
    upsertMock.mockRejectedValue(new Error('Unauthorized'));
    render(<LinguisticSchemasEditor />);
    await waitFor(() => expect(screen.getByTestId('schemas-list')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Save schemas'));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Unauthorized'));
  });
});
