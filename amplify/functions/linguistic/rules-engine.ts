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

/**
 * Which component of the parsed message a rule fills (#548). `TYPE`
 * rules detect the message type (and may also extract fields via their
 * `captureMap`, whole-message style); `SENDER`/`RECEIVER`/`BODY` rules
 * extract that one field and are composed onto a type match.
 */
export type RuleComponent = 'TYPE' | 'SENDER' | 'RECEIVER' | 'BODY';

export interface LinguisticRule {
  id: string;
  pattern: string;
  messageType: string;
  captureMap: Record<string, string>;
  priority: number;
  enabled: boolean;
  promptVersion: number;
  /** Per-rule match confidence in [0,1] (#543). Defaults to 0.9 when absent. */
  confidence?: number;
  /** Component this rule fills (#548). Defaults to `TYPE`. */
  component?: RuleComponent;
  /**
   * For a component rule (SENDER/RECEIVER/BODY): the message type it
   * extracts from. Empty/absent = applies to every type. Ignored for
   * TYPE rules (they assign `messageType`).
   */
  appliesToType?: string | null;
}

/** Default confidence for a rule that doesn't carry one. */
export const DEFAULT_RULE_CONFIDENCE = 0.9;

/** Component → parsed-message field name. */
const COMPONENT_FIELD: Record<Exclude<RuleComponent, 'TYPE'>, string> = {
  SENDER: 'sender',
  RECEIVER: 'receiver',
  BODY: 'body',
};

export interface ParsedMessage {
  messageType: string;
  fields: Record<string, string>;
}

export interface RuleMatch {
  ruleId: string;
  promptVersion: number;
  /** The matched rule's confidence (#543) — the parse confidence. */
  confidence: number;
  message: ParsedMessage;
}

interface CompiledRule {
  id: string;
  re: RegExp;
  messageType: string;
  captureMap: Record<string, string>;
  priority: number;
  promptVersion: number;
  confidence: number;
  component: RuleComponent;
  appliesToType: string | null;
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
    const rules = await this.loadRules(); // priority-desc

    // 1. Type detection — first matching TYPE rule wins.
    let typeRule: CompiledRule | undefined;
    let typeM: RegExpMatchArray | undefined;
    for (const rule of rules) {
      if (rule.component !== 'TYPE') continue;
      const m = transcript.match(rule.re);
      if (m) {
        typeRule = rule;
        typeM = m;
        break;
      }
    }
    if (!typeRule || !typeM) return null;

    const messageType = typeRule.messageType;
    // The TYPE rule may also extract fields (whole-message style); those
    // seed the result and are not overwritten by component rules.
    const fields = this.mapCaptures(typeM, typeRule.captureMap);
    const confidences = [typeRule.confidence];

    // 2. Compose each missing field from its component rules (those that
    //    apply to this type), first match wins.
    for (const component of ['SENDER', 'RECEIVER', 'BODY'] as const) {
      const field = COMPONENT_FIELD[component];
      if (fields[field]) continue; // TYPE rule already filled it
      for (const rule of rules) {
        if (rule.component !== component) continue;
        if (rule.appliesToType && rule.appliesToType !== messageType) continue;
        const m = transcript.match(rule.re);
        if (!m) continue;
        const value = this.extractComponentValue(m, rule.captureMap, field);
        if (value) {
          fields[field] = value;
          confidences.push(rule.confidence);
          break;
        }
      }
    }

    return {
      ruleId: typeRule.id,
      promptVersion: typeRule.promptVersion,
      // Aggregate: a shaky component drags the whole parse down so the
      // #540 gate can route it to the AI.
      confidence: Math.min(...confidences),
      message: { messageType, fields },
    };
  }

  /**
   * Value a component rule contributes: the mapped field if its
   * `captureMap` names one, else the first capture group, else the whole
   * match. Trimmed; empty → no contribution.
   */
  private extractComponentValue(
    match: RegExpMatchArray,
    captureMap: Record<string, string>,
    field: string,
  ): string {
    const mapped = this.mapCaptures(match, captureMap);
    if (mapped[field]) return mapped[field];
    return (match[1] ?? match[0] ?? '').trim();
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
        confidence:
          typeof r.confidence === 'number' && r.confidence >= 0 && r.confidence <= 1
            ? r.confidence
            : DEFAULT_RULE_CONFIDENCE,
        component: r.component ?? 'TYPE',
        appliesToType: r.appliesToType ?? null,
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
