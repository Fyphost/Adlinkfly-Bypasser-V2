/**
 * Heuristic scoring of interactive elements.
 *
 * Instead of hardcoded selectors, each visible clickable element is scored
 * from several independent signals:
 *   - its label (text / aria-label / title / alt) against a weighted,
 *     multilingual lexicon of "proceed" vs. "distractor" phrases;
 *   - its attributes (id / class / name / data-*);
 *   - where it points (back into the shortener flow, to an ad network, to itself);
 *   - its context (inside an ad container, navigation, header/footer);
 *   - its geometry (size, whether something covers it);
 *   - how often the agent already tried it without progress.
 * Shortener modules can contribute extra patterns and preferred selectors.
 */
import { isAdHost } from '../browser/adDomains.ts';
import type { RawCandidate } from './types.ts';

export interface WeightedPattern {
  re: RegExp;
  w: number;
  label: string;
}

export interface ScoringHints {
  positivePatterns?: WeightedPattern[];
  negativePatterns?: WeightedPattern[];
}

export interface ScoringContext {
  pageUrl: string;
  isFlowHost: (host: string) => boolean;
  attempts: ReadonlyMap<string, number>;
  hints?: ScoringHints;
}

export const ACTIONABLE_THRESHOLD = 5;
export const STRONG_THRESHOLD = 8;

const POSITIVE: WeightedPattern[] = [
  { re: /\b(get|grab|obtain|copy) (the |your |download |final |destination )?(link|url)\b/, w: 11, label: 'get-link' },
  {
    re: /\b(go|continue|proceed|take me|redirect|jump) (to )?(the |your |final )?(link|destination|url|download|website|site|target|page)\b/,
    w: 10,
    label: 'go-to-link',
  },
  { re: /\bopen (the |your )?(link|destination|url)\b/, w: 9, label: 'open-link' },
  { re: /\b(generate|create|unlock|reveal|show) (the |your |download )?(link|url)\b/, w: 9, label: 'generate-link' },
  { re: /\bclick here to (continue|proceed|get|open|unlock|go|download|verify)\b/, w: 9, label: 'click-here-continue' },
  { re: /\bskip (the )?(ad|ads|advert)\b/, w: 8, label: 'skip-ad' },
  { re: /^skip\b/, w: 6, label: 'skip' },
  { re: /\bcontinue\b/, w: 7, label: 'continue' },
  { re: /\bproceed\b/, w: 7, label: 'proceed' },
  { re: /\bverify\b/, w: 6, label: 'verify' },
  { re: /\bunlock\b/, w: 6, label: 'unlock' },
  { re: /\bnext( step| page)?\b/, w: 5, label: 'next' },
  { re: /^go( now| ahead)?$/, w: 5, label: 'go' },
  { re: /\bstep \d+\b/, w: 3, label: 'step' },
  { re: /\b(i am|i m) ready\b|\blet s go\b/, w: 4, label: 'ready' },
  { re: /\bclick here\b/, w: 3, label: 'click-here' },
  { re: /\bsubmit\b/, w: 3, label: 'submit' },
  { re: /\bget\b/, w: 2, label: 'get' },
  { re: /\bdownload\b/, w: 2, label: 'download' },
  { re: /\bopen\b/, w: 2, label: 'open' },
  // Common non-English variants seen on link shorteners.
  { re: /\b(dapatkan|ambil) (link|tautan)\b/, w: 10, label: 'get-link-id' },
  { re: /\b(lanjut|lanjutkan|teruskan|selanjutnya)\b/, w: 7, label: 'continue-id' },
  { re: /\b(obtener|conseguir|obter) (el |o )?(enlace|link)\b/, w: 10, label: 'get-link-es-pt' },
  { re: /\b(continuar|prosseguir|seguir|siguiente|proximo|próximo)\b/, w: 7, label: 'continue-es-pt' },
  { re: /\bobtenir (le )?lien\b/, w: 10, label: 'get-link-fr' },
  { re: /\b(continuer|suivant)\b/, w: 7, label: 'continue-fr' },
  { re: /\b(weiter|fortfahren)\b/, w: 6, label: 'continue-de' },
  { re: /\b(devam|ileri)\b/, w: 6, label: 'continue-tr' },
  { re: /(получить ссылку)/, w: 10, label: 'get-link-ru' },
  { re: /(продолжить|далее)/, w: 7, label: 'continue-ru' },
  { re: /(लिंक प्राप्त करें)/, w: 10, label: 'get-link-hi' },
  { re: /(जारी रखें|आगे बढ़ें)/, w: 7, label: 'continue-hi' },
  { re: /\b(verifikasi|verificar|vérifier|verifier)\b/, w: 6, label: 'verify-i18n' },
];

const NEGATIVE: WeightedPattern[] = [
  { re: /\b(close|cancel|dismiss|no thanks|not now|maybe later|decline|reject)\b|^(x|×|✕)$/, w: -9, label: 'dismiss' },
  { re: /\b(log ?in|sign ?in|sign ?up|register|create (an )?account|join now|subscribe|newsletter)\b/, w: -9, label: 'account' },
  {
    re: /\b(share|tweet|facebook|twitter|whatsapp|telegram|pinterest|linkedin|reddit|instagram|youtube|discord)\b/,
    w: -7,
    label: 'social',
  },
  {
    re: /\b(privacy|terms|policy|contact|about( us)?|dmca|disclaimer|cookies?|faq|help|support|advertise|payout|rates|referral|api)\b/,
    w: -8,
    label: 'site-chrome',
  },
  { re: /\b(home|menu|search|categor(y|ies)|tags?|archives?|comments?|reply|leave a reply|author)\b/, w: -6, label: 'blog-nav' },
  { re: /\b(previous|prev|back|older|newer)\b/, w: -6, label: 'back' },
  { re: /\b(related|recent|popular|latest|trending) (posts?|articles?|stories)\b|\bnext (post|article|story)\b/, w: -8, label: 'related' },
  { re: /\b(allow|notifications?|install|app store|google play|add to chrome|extension)\b/, w: -7, label: 'notification-install' },
  { re: /\b(advertisement|sponsored|ads by|ad choices|report( ad)?|remove ads)\b/, w: -9, label: 'ad-label' },
  { re: /\b(play|watch|stream|live|casino|bet|dating|win|prize|claim|bonus)\b/, w: -4, label: 'ad-bait' },
  { re: /\b(download now|fast download|start download|direct download|download file|free download)\b/, w: -4, label: 'download-bait' },
  { re: /\bread more\b|\bcontinue reading\b|\bkeep reading\b/, w: -10, label: 'read-more' },
  { re: /\b(i m not a robot|i am not a robot|i am human|i m human|not a robot)\b/, w: -40, label: 'human-attestation' },
];

const ATTR_POSITIVE: WeightedPattern[] = [
  {
    re: /get[-_]?link|go[-_]?link|final[-_]?link|link[-_]?btn|btn[-_]?link|download[-_]?link|getlink|golink/,
    w: 6,
    label: 'attr-get-link',
  },
  { re: /continue|proceed|verify|next[-_]?(btn|step|button)|skip|unlock|redirect|btn[-_]?go\b|go[-_]?btn/, w: 3, label: 'attr-proceed' },
  { re: /(^|[\s_-])(btn|button)([\s_-]|$)/, w: 1, label: 'attr-button' },
  { re: /btn-(success|primary)/, w: 1, label: 'attr-primary' },
];

const ATTR_NEGATIVE =
  /(^|[\s_-])(ad|ads|advert|adsbygoogle|banner|sponsor|sponsored|popup|social|share|nav|navbar|menu|footer|header|sidebar|widget|cookie|close|comment|comments|related|tag|tags|category|search|login|signup|subscribe|newsletter)([\s_\d-]|$)/g;

/** Lower-cases and strips punctuation/emoji while keeping non-Latin letters. */
export function normalizeLabel(s: string): string {
  return (
    s
      .toLowerCase()
      .normalize('NFKC')
      .replace(/[’'`]/g, ' ')
      // Keep combining marks (\p{M}) so scripts such as Devanagari keep their vowel signs.
      .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

export function candidateLabel(c: Pick<RawCandidate, 'text' | 'ariaLabel' | 'title' | 'alt'>): string {
  return c.text || c.ariaLabel || c.title || c.alt || '';
}

export function hostOf(url: string | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.hostname.toLowerCase();
  } catch {
    return null;
  }
}

function sameDocument(a: string, b: string): boolean {
  try {
    const x = new URL(a);
    const y = new URL(b);
    x.hash = '';
    y.hash = '';
    return x.href === y.href;
  } catch {
    return false;
  }
}

export function candidateSignature(c: Pick<RawCandidate, 'tag' | 'text' | 'href' | 'id' | 'ariaLabel'>): string {
  return `${c.tag}|${normalizeLabel(c.text || c.ariaLabel || '').slice(0, 60)}|${c.href ?? ''}|${c.id ?? ''}`;
}

export function isHumanAttestation(label: string): boolean {
  return /\b(i m not a robot|i am not a robot|i am human|i m human|not a robot|verify you are human|confirm you are human)\b/.test(
    normalizeLabel(label),
  );
}

export interface ScoreResult {
  score: number;
  reasons: string[];
}

export function scoreCandidate(c: RawCandidate, ctx: ScoringContext): ScoreResult {
  const reasons: string[] = [];
  let score = 0;
  const add = (w: number, label: string) => {
    score += w;
    reasons.push(`${label}(${w > 0 ? '+' : ''}${w})`);
  };

  const label = normalizeLabel(candidateLabel(c));
  const positives = [...(ctx.hints?.positivePatterns ?? []), ...POSITIVE];
  const negatives = [...(ctx.hints?.negativePatterns ?? []), ...NEGATIVE];

  if (label) {
    // Use the strongest positive match plus a small bonus for additional distinct matches.
    let best = 0;
    let bestLabel = '';
    let extra = 0;
    for (const p of positives) {
      if (p.re.test(label)) {
        if (p.w > best) {
          if (best > 0) extra++;
          best = p.w;
          bestLabel = p.label;
        } else {
          extra++;
        }
      }
    }
    if (best > 0) add(best, bestLabel);
    if (extra > 0) add(Math.min(extra, 2), 'multi-match');
    for (const n of negatives) if (n.re.test(label)) add(n.w, n.label);
    if (label.length > 120) add(-8, 'long-text');
    else if (label.length > 60) add(-4, 'long-text');
  } else {
    add(-2, 'unlabeled');
  }

  const attrs = `${c.id ?? ''} ${c.className} ${c.name ?? ''} ${c.dataAttrs}`.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
  if (attrs.trim()) {
    for (const p of ATTR_POSITIVE) if (p.re.test(attrs)) add(p.w, p.label);
    const neg = attrs.match(ATTR_NEGATIVE);
    if (neg && neg.length > 0) add(Math.max(-6, -3 * neg.length), 'attr-distractor');
  }

  const tag = c.tag;
  if (tag === 'button' || (tag === 'input' && ['submit', 'button', 'image'].includes((c.type ?? '').toLowerCase()))) {
    add(1, 'button-element');
  } else if (c.role === 'button') {
    add(1, 'role-button');
  }

  const host = hostOf(c.href);
  if (c.href) {
    if (host && isAdHost(host)) add(-15, 'ad-network-link');
    else if (host && ctx.isFlowHost(host) && !sameDocument(c.href, ctx.pageUrl)) add(4, 'links-into-flow');
    else if (host && sameDocument(c.href, ctx.pageUrl) && !/^#|^javascript:/i.test(c.rawHref ?? '')) add(-3, 'self-link');
  }

  if (c.inAdContainer) add(-8, 'in-ad-container');
  if (c.chrome) add(-4, `in-${c.chrome}`);
  if (c.obscured) add(-1, 'obscured');
  const area = c.rect.w * c.rect.h;
  if (area >= 3000) add(1, 'prominent');
  else if (area < 150) add(-2, 'tiny');
  if (c.hintMatch) add(6, 'module-hint');

  const tries = ctx.attempts.get(candidateSignature(c)) ?? 0;
  if (tries > 0) add(-4 * tries, 'already-tried');

  return { score, reasons };
}
