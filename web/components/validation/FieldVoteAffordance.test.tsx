import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { FieldVoteAffordance } from './FieldVoteAffordance';

const listMock = vi.fn<() => Promise<unknown>>();
const castMock = vi.fn<(messageId: string, field: string, value: string) => Promise<unknown>>();

vi.mock('@/lib/votes/query', async (importActual) => {
  const actual = await importActual<Record<string, unknown>>();
  return {
    ...actual,
    listFieldVotes: (): Promise<unknown> => listMock(),
    castFieldVote: (messageId: string, field: string, value: string): Promise<unknown> =>
      castMock(messageId, field, value),
  };
});

describe('FieldVoteAffordance', () => {
  beforeEach(() => {
    listMock.mockReset();
    castMock.mockReset();
    listMock.mockResolvedValue([
      {
        fieldKey: 'm#TYPE#v1',
        messageId: 'm',
        field: 'TYPE',
        value: 'SKYKING',
        voterId: 'v1',
        weightAtVoteTime: 2,
        firstCastAt: null,
        lastCastAt: null,
      },
      {
        fieldKey: 'm#TYPE#v2',
        messageId: 'm',
        field: 'TYPE',
        value: 'SKYBIRD',
        voterId: 'v2',
        weightAtVoteTime: 1,
        firstCastAt: null,
        lastCastAt: null,
      },
    ]);
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockReturnValue({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
      }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it('renders the trigger button collapsed by default', () => {
    render(
      <FieldVoteAffordance messageId="m" field="TYPE" currentValue="SKYKING" signedIn={true} />,
    );
    expect(screen.getByRole('button', { name: /vote on type/i })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('opens the popover + fetches the tally on click', async () => {
    render(
      <FieldVoteAffordance messageId="m" field="TYPE" currentValue="SKYKING" signedIn={true} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /vote on type/i }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    await waitFor(() => {
      expect(listMock).toHaveBeenCalled();
    });
    expect(await screen.findByText(/SKYKING · current/i)).toBeInTheDocument();
    expect(screen.getByText(/weight 2/i)).toBeInTheDocument();
  });

  it('suppresses the tally + form for guests, shows sign-in hint instead', async () => {
    render(
      <FieldVoteAffordance messageId="m" field="SENDER" currentValue="MAINSAIL" signedIn={false} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /vote on sender/i }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText(/sign in to suggest/i)).toBeInTheDocument();
    expect(listMock).not.toHaveBeenCalled();
  });

  it('submits a text vote + refreshes', async () => {
    castMock.mockResolvedValue(undefined);
    render(
      <FieldVoteAffordance messageId="m" field="SENDER" currentValue="MAINSAIL" signedIn={true} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /vote on sender/i }));
    await screen.findByRole('dialog');
    await waitFor(() => {
      expect(listMock).toHaveBeenCalled();
    });
    fireEvent.change(screen.getByLabelText(/suggest value/i), {
      target: { value: 'ANCHOR' },
    });
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: /cast/i }));
    });
    await waitFor(() => {
      expect(castMock).toHaveBeenCalledWith('m', 'SENDER', 'ANCHOR');
    });
  });

  it('one-click endorses an existing suggestion via its row Vote button (#668)', async () => {
    castMock.mockResolvedValue(undefined);
    render(
      <FieldVoteAffordance messageId="m" field="TYPE" currentValue="SKYKING" signedIn={true} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /vote on type/i }));
    await screen.findByRole('dialog');
    await waitFor(() => expect(listMock).toHaveBeenCalled());
    // Endorse the OTHER suggested value without re-typing it.
    const endorse = await screen.findByRole('button', { name: /vote for "SKYBIRD"/i });
    act(() => {
      fireEvent.click(endorse);
    });
    await waitFor(() => {
      expect(castMock).toHaveBeenCalledWith('m', 'TYPE', 'SKYBIRD');
    });
  });

  it('uses a TYPE select instead of free-text for the TYPE field', async () => {
    render(
      <FieldVoteAffordance messageId="m" field="TYPE" currentValue="SKYKING" signedIn={true} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /vote on type/i }));
    await screen.findByRole('dialog');
    const input = await screen.findByLabelText(/suggest value/i);
    expect(input.tagName).toBe('SELECT');
  });

  it('shows the inline error on empty submission', async () => {
    render(
      <FieldVoteAffordance messageId="m" field="SENDER" currentValue={null} signedIn={true} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /vote on sender/i }));
    await screen.findByRole('dialog');
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: /cast/i }));
    });
    expect(await screen.findByRole('alert')).toHaveTextContent(/before submitting/i);
    expect(castMock).not.toHaveBeenCalled();
  });
});
