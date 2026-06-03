import { describe, it, expect } from 'vitest';
import {
  WRITE_METHODS,
  WRITE_PATH_PREFIXES,
  isWriteRequest,
  writePathStatements,
  writePathStatementsCdk,
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

  it('SDK statements are a FLAT pair of OrStatements (no nested AND)', () => {
    interface ByteMatch {
      ByteMatchStatement: { SearchString: string };
    }
    interface Or {
      OrStatement: { Statements: ByteMatch[] };
    }
    const stmts = writePathStatements() as unknown as [Or, Or];
    // Exactly two statements, neither wrapped in an AndStatement — WAF forbids
    // AND-inside-AND, so callers spread these into their own AND.
    expect(stmts).toHaveLength(2);
    for (const s of stmts) expect(s).not.toHaveProperty('AndStatement');
    const [methodOr, pathOr] = stmts;
    expect(methodOr.OrStatement.Statements.map((m) => m.ByteMatchStatement.SearchString)).toEqual([
      ...WRITE_METHODS,
    ]);
    expect(pathOr.OrStatement.Statements.map((p) => p.ByteMatchStatement.SearchString)).toEqual([
      ...WRITE_PATH_PREFIXES,
    ]);
  });

  it('CDK statements mirror the SDK pair modulo key casing', () => {
    interface ByteMatch {
      byteMatchStatement: { searchString: string };
    }
    interface Or {
      orStatement: { statements: ByteMatch[] };
    }
    const stmts = writePathStatementsCdk() as unknown as [Or, Or];
    expect(stmts).toHaveLength(2);
    for (const s of stmts) expect(s).not.toHaveProperty('andStatement');
    const [methodOr, pathOr] = stmts;
    expect(methodOr.orStatement.statements.map((m) => m.byteMatchStatement.searchString)).toEqual([
      ...WRITE_METHODS,
    ]);
    expect(pathOr.orStatement.statements.map((p) => p.byteMatchStatement.searchString)).toEqual([
      ...WRITE_PATH_PREFIXES,
    ]);
  });
});
