import { describe, it, expect, vi } from 'vitest';
import {
  BACKEND_ENV_VAR,
  DEFAULT_TRANSCRIBE_BACKEND,
  TRANSCRIBE_BACKENDS,
  isTranscribeBackend,
  resolveBackend,
  resolveBackendArn,
} from './selector';

/**
 * Behaviour tests for the transcribe-backend selector (#58).
 *
 * Pins the resolution order (override → config → hard-coded),
 * the typo-fallthrough behaviour, the env-var-driven ARN
 * lookup, and the enum + predicate contract.
 */

describe('isTranscribeBackend predicate', () => {
  it('accepts each enum value', () => {
    for (const v of TRANSCRIBE_BACKENDS) expect(isTranscribeBackend(v)).toBe(true);
  });

  it('rejects unknown strings, null, undefined, non-strings', () => {
    expect(isTranscribeBackend('openai')).toBe(false);
    expect(isTranscribeBackend('WHISPER-LOCAL')).toBe(false); // case-sensitive
    expect(isTranscribeBackend('')).toBe(false);
    expect(isTranscribeBackend(null)).toBe(false);
    expect(isTranscribeBackend(undefined)).toBe(false);
    expect(isTranscribeBackend(42)).toBe(false);
  });
});

describe('resolveBackend — resolution order', () => {
  it('per-recording override wins over config + hard-coded', () => {
    expect(
      resolveBackend(
        { recordingId: 'r1', backendOverride: 'bedrock' },
        { defaultBackend: 'whisper-api' },
      ),
    ).toBe('bedrock');
  });

  it('config defaultBackend wins when no override', () => {
    expect(resolveBackend({ recordingId: 'r1' }, { defaultBackend: 'amazon-transcribe' })).toBe(
      'amazon-transcribe',
    );
  });

  it('falls back to the hard-coded default when neither override nor config is set', () => {
    expect(resolveBackend({ recordingId: 'r1' }, {})).toBe(DEFAULT_TRANSCRIBE_BACKEND);
    expect(DEFAULT_TRANSCRIBE_BACKEND).toBe('whisper-local');
  });

  it('honours an opts.hardcodedDefault override (used for tests)', () => {
    expect(resolveBackend({ recordingId: 'r1' }, {}, { hardcodedDefault: 'bedrock' })).toBe(
      'bedrock',
    );
  });
});

describe('resolveBackend — typo fallthrough', () => {
  it('falls through with a CloudWatch warn when the override is unknown', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(
      resolveBackend(
        { recordingId: 'r1', backendOverride: 'whisper-locol' },
        { defaultBackend: 'whisper-api' },
      ),
    ).toBe('whisper-api');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('falls through to hard-coded when both override + config are unknown', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(
      resolveBackend(
        { recordingId: 'r1', backendOverride: 'banana' },
        { defaultBackend: 'pineapple' },
      ),
    ).toBe(DEFAULT_TRANSCRIBE_BACKEND);
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it('treats null / undefined override as missing (no warn)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(
      resolveBackend({ recordingId: 'r1', backendOverride: null }, { defaultBackend: 'bedrock' }),
    ).toBe('bedrock');
    expect(resolveBackend({ recordingId: 'r1' }, { defaultBackend: 'bedrock' })).toBe('bedrock');
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('treats null / undefined config defaultBackend as missing (no warn)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(resolveBackend({ recordingId: 'r1' }, { defaultBackend: null })).toBe(
      DEFAULT_TRANSCRIBE_BACKEND,
    );
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('resolveBackendArn', () => {
  it('returns the matching env var for each backend', () => {
    const env: Record<string, string> = {
      WHISPER_LOCAL_FN_ARN: 'arn:aws:lambda:us-east-1:1:function:whisper-local',
      WHISPER_API_FN_ARN: 'arn:aws:lambda:us-east-1:1:function:whisper-api',
      AMAZON_TRANSCRIBE_FN_ARN: 'arn:aws:lambda:us-east-1:1:function:amazon-transcribe',
      BEDROCK_TRANSCRIBE_FN_ARN: 'arn:aws:lambda:us-east-1:1:function:bedrock',
    };
    for (const b of TRANSCRIBE_BACKENDS) {
      expect(resolveBackendArn(b, { env })).toBe(env[BACKEND_ENV_VAR[b]]);
    }
  });

  it('throws when the env var for the chosen backend is unset', () => {
    expect(() => resolveBackendArn('bedrock', { env: {} })).toThrow(/BEDROCK_TRANSCRIBE_FN_ARN/);
  });

  it('throws with a useful message identifying both env var + backend', () => {
    try {
      resolveBackendArn('amazon-transcribe', { env: {} });
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      const msg = (err as Error).message;
      expect(msg).toContain('AMAZON_TRANSCRIBE_FN_ARN');
      expect(msg).toContain('amazon-transcribe');
    }
  });
});

describe('selector — env var map', () => {
  it('declares an env var for every backend (no holes)', () => {
    for (const b of TRANSCRIBE_BACKENDS) {
      expect(typeof BACKEND_ENV_VAR[b]).toBe('string');
      expect(BACKEND_ENV_VAR[b].length).toBeGreaterThan(0);
    }
  });
});
