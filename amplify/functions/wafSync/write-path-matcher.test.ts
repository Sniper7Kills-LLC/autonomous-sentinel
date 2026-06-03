import { describe, it, expect } from 'vitest';
import {
  WRITE_METHODS,
  WRITE_PATH_PREFIXES,
  isWriteRequest,
  buildWritePathStatement,
  buildWritePathStatementCdk,
} from './write-path-matcher';

describe('wafSync write-path matcher (#201)', () => {
  describe('isWriteRequest', () => {
    it('blocks write methods on write surfaces', () => {
      expect(isWriteRequest('POST', '/api/recordings')).toBe(true);
      expect(isWriteRequest('put', '/api/foo')).toBe(true);
      expect(isWriteRequest('DELETE', '/stripe/checkout')).toBe(true);
      expect(isWriteRequest('PATCH', '/STRIPE/x')).toBe(true); // path lowercased
    });

    it('allows reads and non-write surfaces (browse stays open)', () => {
      expect(isWriteRequest('GET', '/api/recordings')).toBe(false);
      expect(isWriteRequest('HEAD', '/stripe/x')).toBe(false);
      // GraphQL is POST but NOT under /api or /stripe → not matched, so
      // anonymous browse (AppSync queries) is never blocked by write scope.
      expect(isWriteRequest('POST', '/graphql')).toBe(false);
      expect(isWriteRequest('POST', '/')).toBe(false);
      expect(isWriteRequest('GET', '/messages')).toBe(false);
    });
  });

  it('exposes the canonical method + prefix source-of-truth', () => {
    expect([...WRITE_METHODS]).toEqual(['POST', 'PUT', 'DELETE', 'PATCH']);
    expect([...WRITE_PATH_PREFIXES]).toEqual(['/api/', '/stripe/']);
  });

  it('SDK statement ORs every method and every path prefix under an AND', () => {
    interface ByteMatch {
      ByteMatchStatement: { SearchString: string };
    }
    interface Or {
      OrStatement: { Statements: ByteMatch[] };
    }
    interface And {
      AndStatement: { Statements: [Or, Or] };
    }
    const s = buildWritePathStatement() as unknown as And;
    const [methodOr, pathOr] = s.AndStatement.Statements;
    expect(methodOr.OrStatement.Statements.map((m) => m.ByteMatchStatement.SearchString)).toEqual([
      ...WRITE_METHODS,
    ]);
    expect(pathOr.OrStatement.Statements.map((p) => p.ByteMatchStatement.SearchString)).toEqual([
      ...WRITE_PATH_PREFIXES,
    ]);
  });

  it('CDK statement mirrors the SDK statement modulo key casing', () => {
    interface ByteMatch {
      byteMatchStatement: { searchString: string };
    }
    interface Or {
      orStatement: { statements: ByteMatch[] };
    }
    interface And {
      andStatement: { statements: [Or, Or] };
    }
    const cdk = buildWritePathStatementCdk() as unknown as And;
    const [methodOr, pathOr] = cdk.andStatement.statements;
    expect(methodOr.orStatement.statements.map((m) => m.byteMatchStatement.searchString)).toEqual([
      ...WRITE_METHODS,
    ]);
    expect(pathOr.orStatement.statements.map((p) => p.byteMatchStatement.searchString)).toEqual([
      ...WRITE_PATH_PREFIXES,
    ]);
  });
});
