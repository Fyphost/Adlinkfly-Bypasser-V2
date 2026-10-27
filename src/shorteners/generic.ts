/**
 * Fallback module for hosts not covered by a dedicated module. Only active when
 * ALLOW_UNLISTED_SHORTENERS=true. It relies entirely on the heuristic agent and
 * auto-detects AdLinkFly page structures at run time.
 */
import type { ShortenerModule } from './types.ts';
import { ADLINKFLY_HINTS, adlinkflyDecide } from './adlinkfly.ts';

export const genericModule: ShortenerModule = {
  id: 'generic',
  name: 'Generic shortener',
  platform: 'auto',
  description: 'Heuristic agent for unlisted shorteners (AdLinkFly structures are auto-detected)',
  domains: [],
  matches: () => true,
  hints: { apiPathPatterns: ADLINKFLY_HINTS.apiPathPatterns, preferredSelectors: ADLINKFLY_HINTS.preferredSelectors },
  decide: adlinkflyDecide,
};
