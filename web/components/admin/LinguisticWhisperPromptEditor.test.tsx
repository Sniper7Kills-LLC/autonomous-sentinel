import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import {
  LinguisticWhisperPromptEditor,
  WHISPER_INITIAL_PROMPT_KEY,
} from './LinguisticWhisperPromptEditor';

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

describe('LinguisticWhisperPromptEditor (#771)', () => {
  it('loads the saved prompt from the WHISPER_INITIAL_PROMPT config row', async () => {
    getMock.mockResolvedValue('SKYKING do not answer. Alfa Bravo Charlie.');
    render(<LinguisticWhisperPromptEditor />);
    await waitFor(() =>
      expect(screen.getByTestId('whisper-prompt-textarea')).toHaveValue(
        'SKYKING do not answer. Alfa Bravo Charlie.',
      ),
    );
    expect(getMock).toHaveBeenCalledWith(WHISPER_INITIAL_PROMPT_KEY);
  });

  it('shows an empty textarea when no prompt row exists yet', async () => {
    getMock.mockResolvedValue(undefined);
    render(<LinguisticWhisperPromptEditor />);
    await waitFor(() => expect(screen.getByTestId('whisper-prompt-textarea')).toHaveValue(''));
  });

  it('saves the edited prompt under the config key', async () => {
    getMock.mockResolvedValue('old');
    render(<LinguisticWhisperPromptEditor />);
    await waitFor(() => expect(screen.getByTestId('whisper-prompt-textarea')).toHaveValue('old'));
    fireEvent.change(screen.getByTestId('whisper-prompt-textarea'), {
      target: { value: 'new EAM prompt' },
    });
    fireEvent.click(screen.getByRole('button', { name: /save prompt/i }));
    await waitFor(() =>
      expect(upsertMock).toHaveBeenCalledWith(
        WHISPER_INITIAL_PROMPT_KEY,
        'new EAM prompt',
        expect.any(String),
      ),
    );
    expect(await screen.findByRole('status')).toHaveTextContent(/saved/i);
  });

  it('surfaces a load error', async () => {
    getMock.mockRejectedValue(new Error('unauthorized'));
    render(<LinguisticWhisperPromptEditor />);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/unauthorized/i));
  });
});
