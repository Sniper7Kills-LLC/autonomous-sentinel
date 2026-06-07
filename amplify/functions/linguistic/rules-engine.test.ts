import { describe, it, expect, vi } from 'vitest';
import { LinguisticRulesEngine, type LinguisticRule, type RuleLoader } from './rules-engine';

/**
 * Behaviour tests for the Linguistic Logic rules engine (#62).
 *
 * Drives the engine via an injected loader so DDB is never touched.
 * The cache TTL + version-bump invalidation + bad-regex isolation
 * + priority ordering + capture-group mapping are each pinned by a
 * dedicated test so a regression on any one of them is a CI-visible
 * diff.
 */

function makeRule(overrides: Partial<LinguisticRule>): LinguisticRule {
  return {
    id: 'rule-default',
    pattern: '.*',
    messageType: 'OTHER',
    captureMap: {},
    priority: 10,
    enabled: true,
    promptVersion: 1,
    ...overrides,
  };
}

function stubLoader(rules: LinguisticRule[]): RuleLoader {
  return () => Promise.resolve(rules);
}

describe('LinguisticRulesEngine — per-component composition (#548)', () => {
  it('composes a SENDER component rule onto a TYPE match', async () => {
    const engine = new LinguisticRulesEngine(
      stubLoader([
        makeRule({ id: 't', component: 'TYPE', messageType: 'SKYKING', pattern: 'SKYKING' }),
        makeRule({
          id: 's',
          component: 'SENDER',
          pattern: 'THIS IS (?<sender>\\w+)',
          captureMap: { sender: 'sender' },
        }),
      ]),
    );
    const r = await engine.tryMatch('SKYKING THIS IS MAINSAIL');
    expect(r?.message.messageType).toBe('SKYKING');
    expect(r?.message.fields.sender).toBe('MAINSAIL');
  });

  it('skips a component rule whose appliesToType does not match', async () => {
    const engine = new LinguisticRulesEngine(
      stubLoader([
        makeRule({ id: 't', component: 'TYPE', messageType: 'SKYKING', pattern: 'SKYKING' }),
        makeRule({
          id: 's',
          component: 'SENDER',
          appliesToType: 'ALLSTATIONS',
          pattern: 'THIS IS (?<sender>\\w+)',
          captureMap: { sender: 'sender' },
        }),
      ]),
    );
    const r = await engine.tryMatch('SKYKING THIS IS MAINSAIL');
    expect(r?.message.fields.sender).toBeUndefined();
  });

  it('aggregates confidence to the min across the type + composed components', async () => {
    const engine = new LinguisticRulesEngine(
      stubLoader([
        makeRule({
          id: 't',
          component: 'TYPE',
          messageType: 'SKYKING',
          pattern: 'SKYKING',
          confidence: 0.9,
        }),
        makeRule({
          id: 's',
          component: 'SENDER',
          pattern: 'THIS IS (?<sender>\\w+)',
          captureMap: { sender: 'sender' },
          confidence: 0.4,
        }),
      ]),
    );
    expect((await engine.tryMatch('SKYKING THIS IS MAINSAIL'))?.confidence).toBe(0.4);
  });

  it('leaves fields empty when only a TYPE rule matches (no component rules)', async () => {
    const engine = new LinguisticRulesEngine(
      stubLoader([
        makeRule({
          id: 't',
          component: 'TYPE',
          messageType: 'SKYKING',
          pattern: 'SKYKING',
          captureMap: {},
        }),
      ]),
    );
    const r = await engine.tryMatch('SKYKING THIS IS MAINSAIL');
    expect(r?.message.messageType).toBe('SKYKING');
    expect(r?.message.fields).toEqual({});
  });

  it('a component rule that captures nothing contributes nothing (no whole-match fallback)', async () => {
    const engine = new LinguisticRulesEngine(
      stubLoader([
        makeRule({
          id: 't',
          component: 'TYPE',
          messageType: 'SKYKING',
          pattern: 'SKYKING',
          captureMap: {},
        }),
        // Matches but has no capture group — must NOT set sender to the match.
        makeRule({ id: 's', component: 'SENDER', pattern: 'THIS IS MAINSAIL', captureMap: {} }),
      ]),
    );
    const r = await engine.tryMatch('SKYKING THIS IS MAINSAIL');
    expect(r?.message.fields.sender).toBeUndefined();
  });

  it('does not overwrite a field the TYPE rule already captured', async () => {
    const engine = new LinguisticRulesEngine(
      stubLoader([
        makeRule({
          id: 't',
          component: 'TYPE',
          messageType: 'SKYKING',
          pattern: 'SKYKING THIS IS (?<sender>\\w+)',
          captureMap: { sender: 'sender' },
        }),
        makeRule({
          id: 's',
          component: 'SENDER',
          pattern: 'IS (?<sender>\\w+)',
          captureMap: { sender: 'sender' },
        }),
      ]),
    );
    const r = await engine.tryMatch('SKYKING THIS IS MAINSAIL');
    expect(r?.message.fields.sender).toBe('MAINSAIL'); // from the TYPE rule, not re-extracted
  });
});

describe('LinguisticRulesEngine — snapshot (#544b)', () => {
  it('summarizes the active ruleset', async () => {
    const engine = new LinguisticRulesEngine(
      stubLoader([
        makeRule({ id: 't', component: 'TYPE', messageType: 'SKYKING', pattern: 'SKYKING' }),
        makeRule({
          id: 's',
          component: 'SENDER',
          appliesToType: 'SKYKING',
          pattern: 'IS (?<sender>\\w+)',
          confidence: 0.6,
        }),
        makeRule({ id: 'off', pattern: 'x', enabled: false }), // excluded
      ]),
    );
    const snap = await engine.snapshot();
    expect(snap.map((r) => r.id).sort()).toEqual(['s', 't']);
    expect(snap.find((r) => r.id === 's')).toMatchObject({
      component: 'SENDER',
      appliesToType: 'SKYKING',
      confidence: 0.6,
      pattern: 'IS (?<sender>\\w+)',
    });
  });
});

describe('LinguisticRulesEngine — confidence (#543)', () => {
  it('returns the rule confidence on a match', async () => {
    const engine = new LinguisticRulesEngine(
      stubLoader([makeRule({ id: 'c', pattern: 'SKYKING', confidence: 0.42 })]),
    );
    expect((await engine.tryMatch('SKYKING'))?.confidence).toBe(0.42);
  });

  it('defaults to 0.9 when the rule has no confidence', async () => {
    const engine = new LinguisticRulesEngine(stubLoader([makeRule({ pattern: 'SKYKING' })]));
    expect((await engine.tryMatch('SKYKING'))?.confidence).toBe(0.9);
  });

  it('defaults to 0.9 when the rule confidence is out of range', async () => {
    const engine = new LinguisticRulesEngine(
      stubLoader([makeRule({ pattern: 'SKYKING', confidence: 5 })]),
    );
    expect((await engine.tryMatch('SKYKING'))?.confidence).toBe(0.9);
  });
});

describe('LinguisticRulesEngine — basic matching', () => {
  it('returns null when no rule matches', async () => {
    const engine = new LinguisticRulesEngine(
      stubLoader([makeRule({ id: 'sk', pattern: 'SKYKING SKYKING' })]),
    );
    expect(await engine.tryMatch('hello world')).toBeNull();
  });

  it('returns null on empty / non-string transcript without invoking rules', async () => {
    const loader = vi.fn<RuleLoader>(() => Promise.resolve([]));
    const engine = new LinguisticRulesEngine(loader);
    expect(await engine.tryMatch('')).toBeNull();
    expect(loader).not.toHaveBeenCalled();
  });

  it('matches the first rule whose pattern fires', async () => {
    const engine = new LinguisticRulesEngine(
      stubLoader([
        makeRule({
          id: 'skyking-1',
          pattern: 'SKYKING SKYKING (?<body>[A-Z0-9 ]+)',
          messageType: 'SKYKING',
          captureMap: { body: 'body' },
        }),
      ]),
    );
    const result = await engine.tryMatch('SKYKING SKYKING DELTA OSCAR 12345');
    expect(result).not.toBeNull();
    expect(result?.ruleId).toBe('skyking-1');
    expect(result?.promptVersion).toBe(1);
    expect(result?.message.messageType).toBe('SKYKING');
    expect(result?.message.fields.body).toBe('DELTA OSCAR 12345');
  });
});

describe('LinguisticRulesEngine — priority + tie-break', () => {
  it('runs higher-priority rules before lower-priority rules', async () => {
    const engine = new LinguisticRulesEngine(
      stubLoader([
        makeRule({
          id: 'low',
          pattern: 'SKYKING.*',
          messageType: 'OTHER',
          priority: 5,
        }),
        makeRule({
          id: 'high',
          pattern: 'SKYKING.*',
          messageType: 'SKYKING',
          priority: 50,
        }),
      ]),
    );
    const result = await engine.tryMatch('SKYKING SKYKING abc');
    expect(result?.ruleId).toBe('high');
    expect(result?.message.messageType).toBe('SKYKING');
  });

  it('ties on priority resolve by id lex order so iteration is deterministic', async () => {
    const engine = new LinguisticRulesEngine(
      stubLoader([
        makeRule({ id: 'zzz', pattern: '.*', messageType: 'Z', priority: 10 }),
        makeRule({ id: 'aaa', pattern: '.*', messageType: 'A', priority: 10 }),
      ]),
    );
    const result = await engine.tryMatch('anything');
    expect(result?.ruleId).toBe('aaa');
    expect(result?.message.messageType).toBe('A');
  });
});

describe('LinguisticRulesEngine — disabled rules', () => {
  it('skips disabled rules at cache-load time', async () => {
    const engine = new LinguisticRulesEngine(
      stubLoader([
        makeRule({ id: 'on', pattern: 'HELLO', messageType: 'GREETING' }),
        makeRule({ id: 'off', pattern: 'WORLD', messageType: 'PLANET', enabled: false }),
      ]),
    );
    const result = await engine.tryMatch('WORLD');
    expect(result).toBeNull();
  });
});

describe('LinguisticRulesEngine — bad regex isolation', () => {
  it('skips a rule with an invalid regex pattern without breaking the rest', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const engine = new LinguisticRulesEngine(
      stubLoader([
        // Invalid regex — unclosed bracket.
        makeRule({ id: 'broken', pattern: '(?<bad', messageType: 'OTHER' }),
        makeRule({ id: 'ok', pattern: 'HELLO', messageType: 'GREETING' }),
      ]),
    );
    const result = await engine.tryMatch('HELLO');
    expect(result?.ruleId).toBe('ok');
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe('LinguisticRulesEngine — capture-group mapping', () => {
  it('maps named groups via captureMap onto Message fields', async () => {
    const engine = new LinguisticRulesEngine(
      stubLoader([
        makeRule({
          id: 'tuple',
          pattern: '(?<from>[A-Z]+) DE (?<to>[A-Z]+) (?<bod>.+)',
          messageType: 'BACKEND',
          captureMap: { from: 'sender', to: 'receiver', bod: 'body' },
        }),
      ]),
    );
    const result = await engine.tryMatch('ALPHA DE BRAVO mission control');
    expect(result?.message.fields).toEqual({
      sender: 'ALPHA',
      receiver: 'BRAVO',
      body: 'mission control',
    });
  });

  it('silently ignores capture groups not declared in captureMap', async () => {
    const engine = new LinguisticRulesEngine(
      stubLoader([
        makeRule({
          id: 'extra',
          pattern: '(?<a>A)(?<b>B)(?<c>C)',
          messageType: 'OTHER',
          captureMap: { a: 'first', b: 'second' }, // `c` not mapped
        }),
      ]),
    );
    const result = await engine.tryMatch('ABC');
    expect(result?.message.fields).toEqual({ first: 'A', second: 'B' });
  });

  it('skips undefined capture-group values (optional groups)', async () => {
    const engine = new LinguisticRulesEngine(
      stubLoader([
        makeRule({
          id: 'opt',
          pattern: '(?<x>X)(?<y>Y)?',
          messageType: 'OTHER',
          captureMap: { x: 'xx', y: 'yy' },
        }),
      ]),
    );
    const result = await engine.tryMatch('X');
    expect(result?.message.fields).toEqual({ xx: 'X' });
  });
});

describe('LinguisticRulesEngine — cache TTL', () => {
  it('serves the cached rules within the TTL window', async () => {
    let invocations = 0;
    const loader: RuleLoader = () => {
      invocations += 1;
      return Promise.resolve([makeRule({ id: 'a', pattern: 'HI' })]);
    };
    const engine = new LinguisticRulesEngine(loader, {
      ttlMs: 1000,
      now: () => 0,
    });
    await engine.tryMatch('HI');
    await engine.tryMatch('HI');
    expect(invocations).toBe(1);
  });

  it('reloads rules once the TTL window expires', async () => {
    let invocations = 0;
    let clock = 0;
    const loader: RuleLoader = () => {
      invocations += 1;
      return Promise.resolve([makeRule({ id: 'a', pattern: 'HI' })]);
    };
    const engine = new LinguisticRulesEngine(loader, {
      ttlMs: 1000,
      now: () => clock,
    });
    await engine.tryMatch('HI');
    clock = 2000;
    await engine.tryMatch('HI');
    expect(invocations).toBe(2);
  });

  it('invalidate() forces a reload on the next call regardless of TTL', async () => {
    let invocations = 0;
    const loader: RuleLoader = () => {
      invocations += 1;
      return Promise.resolve([makeRule({ id: 'a', pattern: 'HI' })]);
    };
    const engine = new LinguisticRulesEngine(loader, {
      ttlMs: 60_000,
      now: () => 0,
    });
    await engine.tryMatch('HI');
    engine.invalidate();
    await engine.tryMatch('HI');
    expect(invocations).toBe(2);
  });
});

describe('LinguisticRulesEngine — tryMatchTraced (#744)', () => {
  it('records an evaluation for EVERY loaded rule (matched + unmatched)', async () => {
    const engine = new LinguisticRulesEngine(
      stubLoader([
        makeRule({ id: 't', component: 'TYPE', messageType: 'SKYKING', pattern: 'SKYKING' }),
        makeRule({ id: 'miss', component: 'TYPE', messageType: 'SKYBIRD', pattern: 'SKYBIRD' }),
        makeRule({
          id: 's',
          component: 'SENDER',
          pattern: 'THIS IS (?<sender>\\w+)',
          captureMap: { sender: 'sender' },
        }),
      ]),
    );
    const { match, evaluations } = await engine.tryMatchTraced('SKYKING THIS IS MAINSAIL');

    expect(evaluations).toHaveLength(3);
    const byId = new Map(evaluations.map((e) => [e.ruleId, e]));
    expect(byId.get('t')?.matched).toBe(true);
    expect(byId.get('t')?.matchedText).toBe('SKYKING');
    expect(byId.get('miss')?.matched).toBe(false);
    expect(byId.get('miss')?.matchedText).toBeNull();
    expect(byId.get('s')?.matched).toBe(true);
    expect(byId.get('s')?.captures).toEqual({ sender: 'MAINSAIL' });
    // Winner is unchanged from the lazy tryMatch path.
    expect(match?.message.messageType).toBe('SKYKING');
    expect(match?.message.fields.sender).toBe('MAINSAIL');
  });

  it('returns a null match with full evaluations when no TYPE rule matches', async () => {
    const engine = new LinguisticRulesEngine(
      stubLoader([
        makeRule({ id: 't', component: 'TYPE', messageType: 'SKYKING', pattern: 'SKYKING' }),
      ]),
    );
    const { match, evaluations } = await engine.tryMatchTraced('nothing relevant here');
    expect(match).toBeNull();
    expect(evaluations).toHaveLength(1);
    expect(evaluations[0]?.matched).toBe(false);
  });

  it('tryMatch returns the same winner tryMatchTraced derives', async () => {
    const rules = [
      makeRule({ id: 't', component: 'TYPE', messageType: 'SKYKING', pattern: 'SKYKING' }),
      makeRule({
        id: 's',
        component: 'SENDER',
        pattern: 'THIS IS (?<sender>\\w+)',
        captureMap: { sender: 'sender' },
      }),
    ];
    const engineA = new LinguisticRulesEngine(stubLoader(rules));
    const engineB = new LinguisticRulesEngine(stubLoader(rules));
    const lazy = await engineA.tryMatch('SKYKING THIS IS MAINSAIL');
    const traced = (await engineB.tryMatchTraced('SKYKING THIS IS MAINSAIL')).match;
    expect(traced).toEqual(lazy);
  });
});
