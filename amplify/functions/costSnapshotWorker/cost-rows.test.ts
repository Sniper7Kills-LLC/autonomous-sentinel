import { describe, it, expect } from 'vitest';
import {
  categorizeS3Key,
  accumulateS3Prefixes,
  mapCostExplorerRows,
  mapLambdaMetricRows,
  mapS3PrefixRows,
  previousUtcDate,
} from './cost-rows';

describe('cost-rows pure helpers (#303)', () => {
  describe('categorizeS3Key', () => {
    it('routes the most-specific prefix first', () => {
      expect(categorizeS3Key('recordings/originals/abc.wav')).toBe('recordings/originals/');
      expect(categorizeS3Key('recordings/web/abc.opus')).toBe('recordings/web/');
      // Bare recordings/ key that is neither originals nor web.
      expect(categorizeS3Key('recordings/index.json')).toBe('recordings/');
      expect(categorizeS3Key('pipeline-temp/x.tmp')).toBe('pipeline-temp/');
      expect(categorizeS3Key('exports/bundle.zip')).toBe('exports/');
      expect(categorizeS3Key('sidecars/x.json')).toBe('sidecars/');
    });

    it('falls back to other for unknown keys', () => {
      expect(categorizeS3Key('random/path.txt')).toBe('other');
    });
  });

  describe('accumulateS3Prefixes', () => {
    it('sums bytes + counts objects per prefix bucket', () => {
      const acc = accumulateS3Prefixes([
        { key: 'recordings/originals/a.wav', size: 100 },
        { key: 'recordings/originals/b.wav', size: 200 },
        { key: 'recordings/web/a.opus', size: 50 },
        { key: 'weird.bin', size: 5 },
      ]);
      const byPrefix = Object.fromEntries(acc.map((a) => [a.prefix, a]));
      expect(byPrefix['recordings/originals/']).toEqual({
        prefix: 'recordings/originals/',
        bytes: 300,
        objects: 2,
      });
      expect(byPrefix['recordings/web/']).toEqual({
        prefix: 'recordings/web/',
        bytes: 50,
        objects: 1,
      });
      expect(byPrefix['other']).toEqual({ prefix: 'other', bytes: 5, objects: 1 });
    });

    it('returns empty for no objects', () => {
      expect(accumulateS3Prefixes([])).toEqual([]);
    });
  });

  describe('mapCostExplorerRows', () => {
    it('emits one AWS_SERVICE row per positive-cost service', () => {
      const rows = mapCostExplorerRows('2026-05-31', [
        { service: 'AWS Lambda', amount: '1.2345678', unit: 'USD' },
        { service: 'Amazon DynamoDB', amount: '0.5', unit: 'USD' },
      ]);
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({
        snapshotDate: '2026-05-31',
        subject: 'AWS Lambda',
        category: 'AWS_SERVICE',
        usdAmount: 1.2346,
        unit: 'USD',
      });
    });

    it('skips zero / non-finite cost rows', () => {
      const rows = mapCostExplorerRows('2026-05-31', [
        { service: 'Free Service', amount: '0' },
        { service: 'Bad', amount: 'not-a-number' },
        { service: 'Real', amount: '0.01' },
      ]);
      expect(rows.map((r) => r.subject)).toEqual(['Real']);
      expect(rows[0]!.unit).toBe('USD');
    });
  });

  describe('mapLambdaMetricRows', () => {
    it('emits LAMBDA_FUNCTION rows with metrics in meta and zero usd', () => {
      const rows = mapLambdaMetricRows('2026-05-31', [
        { functionName: 'preprocess', invocations: 10, durationGbSeconds: 4.56789 },
      ]);
      expect(rows[0]).toMatchObject({
        subject: 'preprocess',
        category: 'LAMBDA_FUNCTION',
        usdAmount: 0,
        unit: 'GB-seconds',
        meta: { invocations: 10, durationGbSeconds: 4.5679 },
      });
    });

    it('drops functions with no activity', () => {
      const rows = mapLambdaMetricRows('2026-05-31', [
        { functionName: 'idle', invocations: 0, durationGbSeconds: 0 },
      ]);
      expect(rows).toEqual([]);
    });
  });

  describe('mapS3PrefixRows', () => {
    it('emits S3_PREFIX rows with bytes + objects in meta', () => {
      const rows = mapS3PrefixRows('2026-05-31', [
        { prefix: 'recordings/originals/', bytes: 300, objects: 2 },
      ]);
      expect(rows[0]).toMatchObject({
        subject: 'recordings/originals/',
        category: 'S3_PREFIX',
        usdAmount: 0,
        unit: 'bytes',
        meta: { bytes: 300, objects: 2 },
      });
    });
  });

  describe('previousUtcDate', () => {
    it('returns the prior UTC day as YYYY-MM-DD', () => {
      expect(previousUtcDate(new Date('2026-06-01T05:00:00.000Z'))).toBe('2026-05-31');
      // Crosses month boundary correctly.
      expect(previousUtcDate(new Date('2026-03-01T00:30:00.000Z'))).toBe('2026-02-28');
    });
  });
});
