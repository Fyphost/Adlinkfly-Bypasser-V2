/**
 * Shortener module contract. A module declares which hosts it handles and can
 * optionally specialise the generic agent with hints and a per-step decision
 * hook for page states it recognises. Everything not handled by the module
 * falls back to the generic, heuristic agent.
 */
import type { ErrorCode } from '../errors.ts';
import type { PageSnapshot } from '../agent/types.ts';
import type { WeightedPattern } from '../agent/scoring.ts';

export interface ShortenerHints {
  /** Extra label patterns for candidate scoring. */
  positivePatterns?: WeightedPattern[];
  negativePatterns?: WeightedPattern[];
  /** CSS selectors whose matching elements get a scoring boost. */
  preferredSelectors?: string[];
  /** Paths of XHR/fetch JSON endpoints whose `url` field carries the destination. */
  apiPathPatterns?: RegExp[];
}

export interface ModuleContext {
  startUrl: URL;
  step: number;
  elapsedMs: number;
  isShortenerHost: (host: string) => boolean;
  isFlowHost: (host: string) => boolean;
}

export type ModuleDecision =
  | { type: 'destination'; url: string; confidence: number; source: string }
  /** `maxMs`: how long to wait at most; `requiredMs`: the minimum the page itself demands (countdown). */
  | { type: 'wait'; reason: string; maxMs: number; requiredMs?: number }
  | { type: 'click'; agentId: string; reason: string }
  | { type: 'goto'; url: string; reason: string }
  | { type: 'fail'; code: ErrorCode; detail: string };

export interface ShortenerModule {
  /** Stable identifier (used in responses, metrics and DISABLED_SHORTENER_MODULES). */
  id: string;
  name: string;
  /** Underlying platform family, e.g. "adlinkfly". */
  platform: string;
  description: string;
  /** Registrable domains handled by the module (sub-domains match too). */
  domains: string[];
  /** Custom matcher; defaults to domain matching. */
  matches?: (url: URL) => boolean;
  hints?: ShortenerHints;
  limits?: { maxSteps?: number; maxCountdownWaitMs?: number };
  /** Optional per-step hook for recognised page states (runs before generic heuristics). */
  decide?: (snapshot: PageSnapshot, ctx: ModuleContext) => ModuleDecision | null;
}
