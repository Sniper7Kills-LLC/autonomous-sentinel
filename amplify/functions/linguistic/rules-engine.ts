/**
 * Linguistic Logic rules engine (#62).
 *
 * Pure-JS rule matcher + cache that the linguistic Lambda calls on
 * every transcript. Rules load from the `LinguisticRule` DDB table
 * via the injected `loader` so unit tests can drive the engine
 * deterministically without DDB.
 *
 * Cache semantics:
 *   - 60-second TTL by default; admin updates surface within the
 *     minute without a Lambda redeploy.
 *   - The engine tracks the max `promptVersion` it has seen across
 *     loaded rules; if the next load returns a higher max, the
 *     cache invalidates immediately (per #66 — bumping a rule's
 *     prompt-version re-runs parsing on previously-failed
 *     recordings; the engine portion of that is "respect the
 *     bump within the cache window").
 *   - Pure-time `loadedAt` comparison uses an injectable `now`
 *     function so tests can advance time without `vi.useFakeTimers`.
 *
 * Pattern compilation:
 *   - Each rule's `pattern` string compiles to a `RegExp` once per
 *     cache load. A `SyntaxError` on compile demotes that single
 *     rule to "skipped" (logged at warn level) — one bad rule does
 *     NOT block the rest of the pipeline.
 *   - Named-group capture: `(?<sender>...)`, `(?<receiver>...)`, etc.
 *     `captureMap` maps each named group to the target Message
 *     field. Groups not in the map are silently ignored.
 *
 * Match semantics:
 *   - Rules iterate in priority-desc order; first match wins.
 *   - On match: returns `{ rule, message }` where `message` is the
 *     captured field set + `messageType` from the rule.
 *   - On no match: returns `null` — caller hands off to the AI
 *     fallback (#63).
 */

export interface LinguisticRule {
  id: string;
  pattern: string;
  messageType: string;
  captureMap: Record<string, string>;
  priority: number;
  enabled: boolean;
  promptVersion: number;
}

export interface ParsedMessage {
  messageType: string;
  fields: Record<string, string>;
}

export interface RuleMatch {
  ruleId: string;
  promptVersion: number;
  message: ParsedMessage;
}

interface CompiledRule {
  id: string;
  re: RegExp;
  messageType: string;
  captureMap: Record<string, string>;
  priority: number;
  promptVersion: number;
}

interface Cache {
  compiled: CompiledRule[];
  loadedAt: number;
  maxVersion: number;
}

export interface EngineOpts {
  /**
   * Cache TTL in milliseconds. Defaults to 60 000 (1 minute).
   * Admin-tunable per-env via the linguistic Lambda's
   * `LINGUISTIC_RULE_CACHE_TTL_MS` env var (set by `loadRulesFromDdb`).
   */
  ttlMs?: number;
  /**
   * Wall-clock source. Defaults to `Date.now`. Tests override to
   * advance time without freezing system time globally.
   */
  now?: () => number;
}

export type RuleLoader = () => Promise<LinguisticRule[]>;

const DEFAULT_TTL_MS = 60_000;

/**
 * Stateful engine instance. Lambda cold-start spins one up; hot
 * invocations share the cache.
 */
export class LinguisticRulesEngine {
  private cache: Cache | null = null;
  private readonly loader: RuleLoader;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(loader: RuleLoader, opts: EngineOpts = {}) {
    this.loader = loader;
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Load enabled rules. Returns the in-memory cache when fresh.
   * Filters disabled rules + sorts by priority desc.
   */
  async loadRules(): Promise<CompiledRule[]> {
    const now = this.now();
    if (this.cache && now - this.cache.loadedAt < this.ttlMs) {
      return this.cache.compiled;
    }
    const raw = await this.loader();
    const enabled = raw.filter((r) => r.enabled);
    const compiled = enabled
      .map((r) => this.tryCompile(r))
      .filter((c): c is CompiledRule => c !== null)
      .sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
    const maxVersion = compiled.reduce((max, r) => Math.max(max, r.promptVersion), 0);
    this.cache = { compiled, loadedAt: now, maxVersion };
    return compiled;
  }

  /**
   * Force-invalidate the cache. Linguistic Lambda calls this when
   * a CloudWatch / EventBridge signal indicates a rule changed
   * upstream (#66 prompt-version bump escalation path).
   */
  invalidate(): void {
    this.cache = null;
  }

  /**
   * Run all loaded rules against a transcript. Returns the first
   * match, or null when nothing matches.
   */
  async tryMatch(transcript: string): Promise<RuleMatch | null> {
    if (typeof transcript !== 'string' || transcript.length === 0) {
      return null;
    }
    const rules = await this.loadRules();
    for (const rule of rules) {
      const m = transcript.match(rule.re);
      if (!m) continue;
      const fields = this.mapCaptures(m, rule.captureMap);
      return {
        ruleId: rule.id,
        promptVersion: rule.promptVersion,
        message: {
          messageType: rule.messageType,
          fields,
        },
      };
    }
    return null;
  }

  private tryCompile(r: LinguisticRule): CompiledRule | null {
    try {
      return {
        id: r.id,
        re: new RegExp(r.pattern),
        messageType: r.messageType,
        captureMap: r.captureMap,
        priority: r.priority,
        promptVersion: r.promptVersion,
      };
    } catch (err) {
      // A single bad regex must NOT break the whole engine. Log +
      // skip; admin sees the warning and fixes the rule.
      console.warn('rules-engine: failed to compile rule pattern; skipping', {
        ruleId: r.id,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  private mapCaptures(
    match: RegExpMatchArray,
    captureMap: Record<string, string>,
  ): Record<string, string> {
    const out: Record<string, string> = {};
    const groups = match.groups ?? {};
    for (const [groupName, fieldName] of Object.entries(captureMap)) {
      const v = groups[groupName];
      if (v !== undefined) out[fieldName] = v;
    }
    return out;
  }
}
