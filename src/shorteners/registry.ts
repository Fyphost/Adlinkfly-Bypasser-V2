/**
 * Registry of shortener modules. To add a platform, create a module file that
 * exports a {@link ShortenerModule} and add it to BUILTIN_MODULES (or register
 * it programmatically through `ShortenerRegistry.register`).
 */
import type { AppConfig } from '../config.ts';
import { hostMatches } from '../security/urlPolicy.ts';
import type { ShortenerModule } from './types.ts';
import { arolinksModule } from './arolinks.ts';
import { createAdlinkflyModule } from './adlinkfly.ts';
import { genericModule } from './generic.ts';

export const BUILTIN_MODULES: ShortenerModule[] = [arolinksModule];

export interface ShortenerInfo {
  id: string;
  name: string;
  platform: string;
  description: string;
  domains: string[];
}

export class ShortenerRegistry {
  private readonly modules: ShortenerModule[] = [];
  private fallback: ShortenerModule | null = null;

  register(module: ShortenerModule): void {
    if (this.modules.some((m) => m.id === module.id)) throw new Error(`Duplicate shortener module id "${module.id}"`);
    this.modules.push(module);
  }

  setFallback(module: ShortenerModule | null): void {
    this.fallback = module;
  }

  /** Finds the module responsible for a URL (explicit modules first, then the fallback). */
  match(url: URL): ShortenerModule | null {
    const host = url.hostname.toLowerCase();
    for (const m of this.modules) {
      if (m.matches ? m.matches(url) : m.domains.some((d) => hostMatches(host, d))) return m;
    }
    return this.fallback;
  }

  /** True when `host` belongs to the given module's own domains. */
  static ownsHost(module: ShortenerModule, host: string): boolean {
    return module.domains.some((d) => hostMatches(host.toLowerCase(), d));
  }

  /** True when any explicitly registered module claims the host (used for chained short links). */
  isKnownShortenerHost(host: string): boolean {
    return this.modules.some((m) => m.domains.some((d) => hostMatches(host.toLowerCase(), d)));
  }

  list(): ShortenerInfo[] {
    const all = this.fallback ? [...this.modules, this.fallback] : this.modules;
    return all.map((m) => ({ id: m.id, name: m.name, platform: m.platform, description: m.description, domains: [...m.domains] }));
  }
}

export function buildRegistry(config: AppConfig['shorteners'], extraModules: ShortenerModule[] = []): ShortenerRegistry {
  const registry = new ShortenerRegistry();
  const disabled = new Set(config.disabledModules);
  for (const m of [...BUILTIN_MODULES, ...extraModules]) if (!disabled.has(m.id)) registry.register(m);
  if (config.adlinkflyExtraDomains.length > 0 && !disabled.has('adlinkfly')) {
    registry.register(
      createAdlinkflyModule({
        id: 'adlinkfly',
        name: 'AdLinkFly (configured domains)',
        domains: config.adlinkflyExtraDomains.map((d) => d.replace(/^\./, '')),
        description: 'AdLinkFly-based shorteners configured through ADLINKFLY_EXTRA_DOMAINS',
      }),
    );
  }
  if (config.allowUnlisted && !disabled.has('generic')) registry.setFallback(genericModule);
  return registry;
}
