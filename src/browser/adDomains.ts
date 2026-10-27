/**
 * Well-known advertising / pop-under / tracking networks. Used for two things:
 *  1. candidate scoring: links to these hosts are never "the next step";
 *  2. optional request blocking (BLOCK_AD_DOMAINS=true).
 * Matching is suffix based (a.b.example.com matches example.com).
 */
export const AD_NETWORK_DOMAINS: readonly string[] = [
  'doubleclick.net',
  'googlesyndication.com',
  'googleadservices.com',
  'adservice.google.com',
  'adnxs.com',
  'adsrvr.org',
  'taboola.com',
  'outbrain.com',
  'mgid.com',
  'revcontent.com',
  'propellerads.com',
  'propellerclick.com',
  'popads.net',
  'popcash.net',
  'adsterra.com',
  'adsterratech.com',
  'highperformanceformat.com',
  'effectivegatecpm.com',
  'profitablegatecpm.com',
  'hilltopads.net',
  'exoclick.com',
  'exosrv.com',
  'juicyads.com',
  'trafficjunky.net',
  'clickadu.com',
  'adcash.com',
  'a-ads.com',
  'monetag.com',
  'onclickads.net',
  'onclkds.com',
  'adskeeper.co.uk',
  'adskeeper.com',
  'bidvertiser.com',
  'yllix.com',
  'admaven.com',
  'ad-maven.com',
  'galaksion.com',
  'clickaine.com',
  'richpush.co',
  'pushhouse.io',
  'evadav.com',
  'zeropark.com',
  'trafficstars.com',
  'tsyndicate.com',
  'realsrv.com',
  'ad.plus',
  'infolinks.com',
  'media.net',
  'amazon-adsystem.com',
  'criteo.com',
  'criteo.net',
  'pubmatic.com',
  'rubiconproject.com',
  'openx.net',
  'smartadserver.com',
];

export function isAdHost(host: string): boolean {
  const h = host.toLowerCase();
  return AD_NETWORK_DOMAINS.some((d) => h === d || h.endsWith(`.${d}`));
}
