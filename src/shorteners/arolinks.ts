/**
 * AroLinks (arolinks.com) — an AdLinkFly-based shortener. Links may pass
 * through one or more partner "blog" pages (verify / countdown / continue
 * steps) before returning to the AdLinkFly get-link page. The blog steps are
 * handled by the generic agent heuristics; the final step by the AdLinkFly
 * platform logic. Site-specific hints can be added here without touching the
 * agent.
 */
import { createAdlinkflyModule } from './adlinkfly.ts';

export const arolinksModule = createAdlinkflyModule({
  id: 'arolinks',
  name: 'AroLinks',
  domains: ['arolinks.com'],
  description: 'AroLinks (AdLinkFly platform, optional partner blog steps)',
});
