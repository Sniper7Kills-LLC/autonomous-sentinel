'use client';

import { useMemo, useState } from 'react';
import { testPattern } from '@/lib/admin/regexMatch';
import styles from './AdminLinguistic.module.css';

interface RegexTesterProps {
  pattern: string;
  /** Optional seed sample (e.g. a transcript snippet). */
  initialSample?: string;
}

/**
 * Inline regex rule tester (#546).
 *
 * Lets an admin paste sample transcript text and see whether a rule's
 * `pattern` matches — with the matched span(s) highlighted and any named
 * capture groups listed — using the exact case-insensitive/global
 * compilation the Linguistic Logic engine uses. Invalid patterns surface
 * the SyntaxError, the same failure the engine reports per-rule.
 */
export function RegexTester({ pattern, initialSample = '' }: RegexTesterProps) {
  const [sample, setSample] = useState(initialSample);
  const result = useMemo(() => testPattern(pattern, sample), [pattern, sample]);

  return (
    <div className={styles.regexTester} data-testid="regex-tester">
      <label className={styles.fieldLabel} htmlFor="regex-sample">
        Test against sample text
      </label>
      <textarea
        id="regex-sample"
        className={styles.textarea}
        value={sample}
        onChange={(e) => setSample(e.target.value)}
        rows={3}
        spellCheck={false}
        placeholder="Paste a transcript snippet to test this pattern"
      />

      {!result.ok ? (
        <p className={styles.hintBad} role="alert" data-testid="regex-error">
          {result.error}
        </p>
      ) : sample.trim() === '' ? (
        <p className={styles.muted}>Enter sample text to see matches.</p>
      ) : (
        <>
          <p
            className={result.matchCount > 0 ? styles.hintOk : styles.hintBad}
            data-testid="regex-count"
          >
            {result.matchCount > 0
              ? `${result.matchCount} match${result.matchCount === 1 ? '' : 'es'}`
              : 'No match'}
          </p>
          <p className={styles.regexHighlight} data-testid="regex-highlight">
            {result.segments.map((seg, i) =>
              seg.match ? (
                <mark key={i} className={styles.regexMark}>
                  {seg.text}
                </mark>
              ) : (
                <span key={i}>{seg.text}</span>
              ),
            )}
          </p>
          {Object.keys(result.groups).length > 0 && (
            <ul className={styles.groupList} data-testid="regex-groups">
              {Object.entries(result.groups).map(([name, value]) => (
                <li key={name}>
                  <span className={styles.tag}>{name}</span>
                  <code className={styles.mdInlineCode}>{value}</code>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
