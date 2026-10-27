/** Shared data structures produced by page analysis and consumed by the agent. */
import type { Frame } from 'playwright';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** An interactive element as observed in the page (raw, before scoring). */
export interface RawCandidate {
  agentId: string;
  tag: string;
  type: string | null;
  role: string | null;
  text: string;
  ariaLabel: string | null;
  title: string | null;
  alt: string | null;
  id: string | null;
  className: string;
  name: string | null;
  href: string | null;
  rawHref: string | null;
  target: string | null;
  hasOnclick: boolean;
  formId: string | null;
  formAction: string | null;
  formMethod: string | null;
  disabled: boolean;
  inViewport: boolean;
  obscured: boolean;
  rect: Rect;
  pointer: boolean;
  inAdContainer: boolean;
  chrome: string | null;
  hintMatch: boolean;
  dataAttrs: string;
}

export interface CountdownReading {
  key: string;
  value: number;
  source: 'element' | 'text';
  /** The reading carried a time unit or wait context ("10 seconds", "0:30", "wait 5s"). */
  hasUnit: boolean;
}

export interface IframeInfo {
  src: string;
  visible: boolean;
  w: number;
  h: number;
  title: string;
}

export interface ChallengeSignals {
  providers: string[];
  visibleWidgets: string[];
  invisibleBound: boolean;
  /** A widget was rendered from script via grecaptcha/hcaptcha/turnstile.render (init-script hook). */
  scriptBound: boolean;
  cloudflareInterstitial: boolean;
  captchaInputs: number;
  captchaImages: number;
  textCues: string[];
}

export interface GetLinkMarker {
  href: string | null;
  rawHref: string | null;
  disabled: boolean;
  text: string;
  visible: boolean;
  agentId: string | null;
}

export interface PlatformMarkers {
  goLinkForm: boolean;
  /** Absolute action URL of `form#go-link` (the platform API endpoint), when present. */
  goLinkAction: string | null;
  linkViewForm: boolean;
  adFormData: boolean;
  captchaShortlink: boolean;
  getLink: GetLinkMarker | null;
  counterValue: number | null;
}

export interface FormInfo {
  id: string | null;
  action: string;
  method: string;
  hiddenInputs: number;
  fields: number;
  visible: boolean;
  hasSubmit: boolean;
}

export interface ProbeResult {
  url: string;
  title: string;
  readyState: string;
  text: string;
  textLength: number;
  candidates: RawCandidate[];
  hiddenStrongCandidates: number;
  countdowns: CountdownReading[];
  iframes: IframeInfo[];
  challenge: ChallengeSignals;
  markers: PlatformMarkers;
  metaRefresh: { delay: number; url: string | null } | null;
  forms: FormInfo[];
  linkHosts: Record<string, number>;
  scroll: { y: number; height: number; viewport: number };
}

export interface ScoredCandidate extends RawCandidate {
  frame: Frame;
  frameUrl: string;
  score: number;
  reasons: string[];
  /** Stable identity across observations (text + href + tag). */
  signature: string;
  hrefHost: string | null;
}

export interface PageSnapshot {
  url: string;
  host: string;
  title: string;
  text: string;
  textLength: number;
  probe: ProbeResult;
  candidates: ScoredCandidate[];
  countdowns: CountdownReading[];
  challenge: ChallengeSignals;
  markers: PlatformMarkers;
  /** HTTP status of the main document, when known. */
  status: number | null;
  takenAt: number;
}

export type AgentAction =
  | { type: 'click'; candidate: ScoredCandidate; reason: string }
  | { type: 'goto'; url: string; reason: string }
  /** `requiredMs`: the part of the wait the page actually demands (checked against the wait budget). */
  | { type: 'wait'; ms: number; reason: string; requiredMs?: number }
  | { type: 'scroll'; reason: string };

export interface TraceStep {
  step: number;
  url: string;
  title: string;
  action: string;
  detail?: string;
  score?: number;
  at: number;
}
