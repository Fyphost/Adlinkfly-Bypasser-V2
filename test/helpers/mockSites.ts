/**
 * High-fidelity local simulation of AdLinkFly-style shortener flows.
 *
 * A single HTTP server answers for several virtual hosts (resolved to
 * 127.0.0.1 by the test DNS resolver):
 *   short.test / arolinks.com   the shortener (AdLinkFly-like pages, /links/go API)
 *   blog-a.test, blog-b.test    "partner blog" intermediate steps
 *   dest.test                   final destinations
 *   ads.test                    advertising / pop-under targets
 *
 * Server-side state enforces the same constraints as real deployments:
 * CSRF cookie + token on /links/go, the countdown elapsed server-side, the flow
 * cookie set on the first visit, and the Referer between blog steps.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import type { LookupAllFn } from '../../src/security/resolver.ts';

export interface MockSites {
  port: number;
  url(host: string, path: string): string;
  /** Number of requests per "host path" (without query). */
  hits: Map<string, number>;
  /** Number of concurrently open shortener flows (for concurrency assertions). */
  stats: { maxConcurrentViews: number; goCalls: number; goRejected: number };
  close(): Promise<void>;
}

export const testLookup: LookupAllFn = async (host) => {
  if (host === 'meta.test') return [{ address: '169.254.169.254', family: 4 }];
  if (host === 'www.popads.net') return [{ address: '127.0.0.1', family: 4 }]; // simulated ad network
  if (host === 'internal.test') return [{ address: '10.0.0.5', family: 4 }];
  if (host === 'mixed.test')
    return [
      { address: '127.0.0.1', family: 4 },
      { address: '192.168.1.10', family: 4 },
    ];
  if (host.endsWith('.test') || host === 'arolinks.com' || host === 'www.arolinks.com') return [{ address: '127.0.0.1', family: 4 }];
  const err = new Error(`getaddrinfo ENOTFOUND ${host}`) as NodeJS.ErrnoException;
  err.code = 'ENOTFOUND';
  throw err;
};

const DEST_PAGE = (title: string, body = '') => `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title></head>
<body><header><a href="/">Home</a> <a href="/about">About</a> <a href="/contact">Contact</a></header>
<main><h1>${title}</h1><p>This is the final destination content. ${body}</p>
<p>Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.</p></main>
<footer><a href="/privacy">Privacy Policy</a></footer></body></html>`;

const LOREM = Array.from(
  { length: 14 },
  (_, i) =>
    `<p>Paragraph ${i + 1}. Investing early, saving consistently and understanding compound interest are the foundations of personal finance. ` +
    `Many readers ask how to start; the answer is to automate savings, track spending and review goals regularly.</p>`,
).join('\n');

function page(title: string, body: string, head = ''): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title>
<style>.btn{display:inline-block;padding:10px 18px;margin:6px;background:#3a7;color:#fff;border:0;cursor:pointer;font-size:16px;text-decoration:none}
.disabled{opacity:.6;pointer-events:none}.hidden{display:none}</style>${head}</head><body>${body}</body></html>`;
}

function parseCookies(req: http.IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

interface ViewState {
  viewedAt: number;
  counter: number;
  destination: string;
  csrf: string;
}

export async function startMockSites(): Promise<MockSites> {
  const views = new Map<string, ViewState>();
  const hits = new Map<string, number>();
  const stats = { maxConcurrentViews: 0, goCalls: 0, goRejected: 0 };
  let openViews = 0;
  const hanging = new Set<http.ServerResponse>();
  let port = 0;
  const U = (host: string, path: string) => `http://${host}:${port}${path}`;

  /** Renders an AdLinkFly-style link page (countdown → AJAX /links/go → a.get-link released). */
  const adlinkflyPage = (res: http.ServerResponse, destination: string, counter = 2, extra = '') => {
    const token = randomBytes(8).toString('hex');
    const csrf = randomBytes(8).toString('hex');
    views.set(token, { viewedAt: Date.now(), counter, destination, csrf });
    openViews++;
    stats.maxConcurrentViews = Math.max(stats.maxConcurrentViews, openViews);
    setTimeout(() => openViews--, (counter + 2) * 1000).unref();
    const html = page(
      'ShortTest - Get your link',
      `<nav><a href="/">Home</a> <a href="/auth/signin">Login</a> <a href="/auth/signup">Sign Up</a> <a href="/payout-rates">Payout Rates</a></nav>
<div class="banner banner-728x90"><a href="${U('ads.test', '/click?b=1')}"><img alt="advertisement" width="728" height="90" src="${U('ads.test', '/banner.png')}"></a></div>
<div class="box-main">
  <h3>Please wait <span id="timer" class="timer">${counter}</span> seconds</h3>
  ${extra}
  <form method="post" accept-charset="utf-8" id="go-link" action="/links/go">
    <div style="display:none;"><input type="hidden" name="_method" value="POST"><input type="hidden" name="_csrfToken" value="${csrf}"></div>
    <input type="hidden" name="ad_form_data" value="${token}">
    <div style="display:none;"><input type="hidden" name="_Token[fields]" value="x"><input type="hidden" name="_Token[unlocked]" value="adcopy_challenge%7Cadcopy_response%7Cg-recaptcha-response"></div>
  </form>
  <a href="javascript: void(0)" class="btn btn-success btn-lg get-link disabled">Please wait...</a>
</div>
<footer><a href="/pages/privacy">Privacy Policy</a> | <a href="/pages/terms">Terms of Use</a> | <a href="/contact">Contact</a></footer>
<script>
var app_vars = {"counter_value":"${counter}","counter_start":"DOMContentLoaded","get_link":"Get Link","getting_link":"Getting link..."};
(function(){
  var counter = parseInt(app_vars.counter_value, 10);
  var timer = document.getElementById('timer');
  var link = document.querySelector('a.get-link');
  function go(){
    link.textContent = app_vars.getting_link;
    var form = document.getElementById('go-link');
    var body = new URLSearchParams(new FormData(form)).toString();
    fetch(form.getAttribute('action'), {method:'POST', credentials:'same-origin', headers:{'X-Requested-With':'XMLHttpRequest','Content-Type':'application/x-www-form-urlencoded'}, body: body})
      .then(function(r){ return r.json(); })
      .then(function(res){
        if (res.url) { link.setAttribute('href', res.url); link.classList.remove('disabled'); link.textContent = app_vars.get_link; }
        else { alert(res.message || 'Error'); }
      });
  }
  function tick(){ timer.textContent = counter; if (counter <= 0) { go(); return; } counter--; setTimeout(tick, 1000); }
  tick();
})();
</script>`,
    );
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Set-Cookie': `csrfToken=${csrf}; Path=/; HttpOnly` });
    res.end(html);
  };

  const html = (res: http.ServerResponse, body: string, status = 200, headers: Record<string, string> = {}) => {
    res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', ...headers });
    res.end(body);
  };
  const redirect = (res: http.ServerResponse, to: string, status = 302, headers: Record<string, string> = {}) => {
    res.writeHead(status, { Location: to, ...headers });
    res.end();
  };

  const shortener = async (req: http.IncomingMessage, res: http.ServerResponse, host: string, url: URL) => {
    const path = url.pathname;
    const alias = path.slice(1);
    const cookies = parseCookies(req);

    if (path === '/links/go' && req.method === 'POST') {
      stats.goCalls++;
      const form = new URLSearchParams(await readBody(req));
      const view = views.get(form.get('ad_form_data') ?? '');
      const ok =
        !!view &&
        req.headers['x-requested-with'] === 'XMLHttpRequest' &&
        cookies.csrfToken === view.csrf &&
        form.get('_csrfToken') === view.csrf &&
        Date.now() - view.viewedAt >= view.counter * 1000 - 300;
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      if (!ok) {
        stats.goRejected++;
        res.end(JSON.stringify({ status: 'error', message: 'Bad Request.', url: '' }));
        return;
      }
      res.end(JSON.stringify({ status: 'success', message: '', url: view!.destination }));
      return;
    }

    if (path === '/') {
      html(
        res,
        page(
          'ShortTest - Shorten URLs and earn money',
          `<nav><a href="/auth/signin">Login</a> <a href="/auth/signup">Sign Up</a></nav><h1>Shorten URLs and earn money</h1><p>Create an account and start earning.</p>`,
        ),
      );
      return;
    }

    if (alias === 'basic' || alias.startsWith('c-')) {
      adlinkflyPage(res, U('dest.test', `/landing?id=${alias}`), alias === 'basic' ? 2 : 1);
      return;
    }
    if (alias === 'linkview') {
      // AdLinkFly first step with the operator's CAPTCHA disabled: a plain form that POSTs back to the alias.
      if (req.method === 'POST') {
        const form = new URLSearchParams(await readBody(req));
        if (form.get('f_n') !== 'slc') {
          html(res, page('Bad request', '<h1>Bad request</h1>'), 400);
          return;
        }
        adlinkflyPage(res, U('dest.test', '/landing?id=linkview'), 1);
        return;
      }
      html(
        res,
        page(
          'ShortTest',
          `<form method="post" accept-charset="utf-8" id="link-view" action="/linkview"><input type="hidden" name="_csrfToken" value="x"><input type="hidden" name="f_n" value="slc">
<div id="captchaShortlink"></div><button type="submit" class="btn btn-primary btn-captcha" id="invisibleCaptchaShortlink">Click here to continue</button></form>`,
        ),
      );
      return;
    }
    if (alias === 'wrapped') {
      const target = U('dest.test', '/wrapped-target?keep=1&utm_source=short&utm_medium=link&fbclid=abc');
      adlinkflyPage(res, `https://www.google.com/url?q=${encodeURIComponent(target)}&sa=D&ust=1`, 1);
      return;
    }
    if (alias === 'chain') {
      adlinkflyPage(res, U('short.test', '/basic'), 1);
      return;
    }

    if (alias === 'multi') {
      if (url.searchParams.get('step') === 'final') {
        const t = url.searchParams.get('t');
        if (!t || cookies.aro_flow !== t) {
          html(
            res,
            page(
              'Invalid session',
              '<h1>Invalid session</h1><p>Your session is invalid or has expired. Please open the short link again.</p>',
            ),
            403,
          );
          return;
        }
        adlinkflyPage(res, U('dest.test', '/landing?id=multi'), 2);
        return;
      }
      const t = randomBytes(6).toString('hex');
      redirect(res, U('blog-a.test', `/2026/10/money-tips.html?t=${t}&s=${host}`), 302, {
        'Set-Cookie': `aro_flow=${t}; Path=/; HttpOnly; SameSite=Lax`,
      });
      return;
    }

    if (alias === 'layouts') {
      html(
        res,
        page(
          'Step 1',
          `<h2>Your link is almost ready</h2><form method="post" action="/layouts/2"><input type="hidden" name="s" value="1"><input type="submit" class="btn" value="Proceed"></form><a href="/pages/privacy">Privacy</a>`,
        ),
      );
      return;
    }
    if (path === '/layouts/2' && req.method === 'POST') {
      html(
        res,
        page(
          'Step 2',
          `<h2>Tunggu sebentar</h2><p>Klik tombol di bawah untuk melanjutkan.</p><span class="cta" style="cursor:pointer;padding:12px;background:#36c;color:#fff" onclick="location.href='/layouts/3'">Lanjutkan</span>`,
        ),
      );
      return;
    }
    if (path === '/layouts/3') {
      html(
        res,
        page(
          'Step 3',
          `<h2>Your link is ready</h2><a class="x-icon" aria-label="Get Link" href="${U('dest.test', '/layout-target')}" style="display:inline-block;width:48px;height:48px;background:#2a2"><svg width="40" height="40"><circle cx="20" cy="20" r="15"/></svg></a>`,
        ),
      );
      return;
    }

    if (alias === 'popup') {
      html(
        res,
        page(
          'Your link is ready',
          `<h2>Your link is ready</h2><a class="btn" target="_blank" href="${U('dest.test', '/popup-target')}">Open Link</a>`,
        ),
      );
      return;
    }
    if (alias === 'tabunder') {
      html(
        res,
        page(
          'Continue',
          `<h2>Click continue to get your link</h2><button class="btn" id="go">Continue</button>
<script>document.getElementById('go').onclick=function(){ window.open('${U('short.test', '/tabunder-next')}'); location.href='${U('ads.test', '/landing')}'; };</script>`,
        ),
      );
      return;
    }
    if (alias === 'tabunder-next') {
      adlinkflyPage(res, U('dest.test', '/tabunder-target'), 1);
      return;
    }
    if (alias === 'hijack') {
      // First click is hijacked by an ad script that navigates the tab to an ad network.
      html(
        res,
        page(
          'Continue to your link',
          `<h2>Your link is ready</h2><button class="btn" id="go">Continue</button>
<script>document.getElementById('go').onclick=function(){
  if (!sessionStorage.getItem('hijacked')) { sessionStorage.setItem('hijacked','1'); location.href='${U('www.popads.net', '/landing?z=1')}'; return; }
  location.href='${U('dest.test', '/hijack-target')}';
};</script>`,
        ),
      );
      return;
    }
    if (alias === 'disabled') {
      html(
        res,
        page(
          'Preparing',
          `<h2>Preparing your link</h2><button class="btn" id="cont" disabled>Continue</button>
<script>setTimeout(function(){ var b=document.getElementById('cont'); b.disabled=false; b.onclick=function(){ location.href='${U('dest.test', '/disabled-target')}'; }; }, 2000);</script>`,
        ),
      );
      return;
    }
    if (alias === 'meta') {
      html(
        res,
        page(
          'Redirecting',
          '<p>You will be redirected shortly...</p>',
          `<meta http-equiv="refresh" content="1;url=${U('blog-a.test', '/meta-step')}">`,
        ),
      );
      return;
    }
    if (alias === 'jsredirect') {
      html(
        res,
        page(
          'Redirecting',
          `<p>Redirecting...</p><script>setTimeout(function(){ location.replace('${U('dest.test', '/js-target')}'); }, 800);</script>`,
        ),
      );
      return;
    }
    if (alias === 'frame') {
      html(
        res,
        page('Framed step', `<h2>Get your link below</h2><iframe src="/frame-inner" width="400" height="120" style="border:0"></iframe>`),
      );
      return;
    }
    if (alias === 'frame-inner') {
      html(res, page('inner', `<button class="btn" onclick="top.location.href='${U('dest.test', '/frame-target')}'">Continue</button>`));
      return;
    }
    if (alias === 'download') {
      html(
        res,
        page('Your file link', `<h2>Your link is ready</h2><a class="btn" href="${U('dest.test', '/files/report.zip')}">Get Link</a>`),
      );
      return;
    }
    if (alias === 'direct') {
      redirect(res, U('dest.test', '/direct-target'), 301);
      return;
    }

    // ---- error / protection scenarios
    if (alias === 'captcha') {
      html(
        res,
        page(
          'ShortTest',
          `<form method="post" accept-charset="utf-8" id="link-view" action="/captcha"><input type="hidden" name="f_n" value="slc">
<div id="captchaShortlink"><div class="g-recaptcha" data-sitekey="6Lc-test-key" style="width:304px;height:78px"><iframe title="reCAPTCHA" src="https://www.google.com/recaptcha/api2/anchor?ar=1&k=6Lc-test-key&size=normal" width="304" height="78"></iframe></div></div>
<button type="submit" class="btn btn-primary btn-captcha" id="invisibleCaptchaShortlink">Click here to continue</button></form>`,
          '<script src="https://www.google.com/recaptcha/api.js" async defer></script>',
        ),
      );
      return;
    }
    if (alias === 'cf') {
      html(
        res,
        page(
          'Just a moment...',
          `<div id="challenge-running"><h1>Verify you are human by completing the action below.</h1><div class="cf-turnstile" data-sitekey="0x4AAAA" style="width:300px;height:65px"></div></div>`,
        ),
        403,
      );
      return;
    }
    if (alias === 'robot') {
      html(
        res,
        page(
          'Security check',
          `<h2>Security check</h2><button class="btn" onclick="location.href='${U('dest.test', '/robot-target')}'">I'm not a robot</button>`,
        ),
      );
      return;
    }
    if (alias === 'expired') {
      html(res, page('ShortTest', '<h1>Oops!</h1><p>This link has expired and is no longer available.</p><a href="/">Home</a>'));
      return;
    }
    if (alias === 'adblock') {
      html(res, page('ShortTest', '<h1>Adblock Detected!</h1><p>Please disable your adblocker to proceed to the destination page.</p>'));
      return;
    }
    if (alias === 'noaction') {
      html(res, page('ShortTest', '<h1>Welcome</h1><p>Thanks for visiting. Nothing to see here.</p>'));
      return;
    }
    if (alias === 'ssrf') {
      redirect(res, 'http://meta.test/latest/meta-data');
      return;
    }
    if (alias === 'ssrf-ip') {
      redirect(res, 'http://169.254.169.254/latest/meta-data/');
      return;
    }
    if (alias === 'ssrf-internal') {
      html(res, page('Continue', `<h2>Your link is ready</h2><a class="btn" href="http://internal.test:${port}/admin">Get Link</a>`));
      return;
    }
    if (alias === 'redirect-loop') {
      redirect(res, U(host, '/redirect-loop-b'));
      return;
    }
    if (alias === 'redirect-loop-b') {
      redirect(res, U(host, '/redirect-loop'));
      return;
    }
    if (alias === 'endless') {
      const n = Number(url.searchParams.get('n') ?? '0') + 1;
      html(res, page(`Step ${n}`, `<h2>Step ${n}: click continue</h2><a class="btn" href="/endless?n=${n}">Continue</a>`));
      return;
    }
    if (alias === 'slow') {
      html(
        res,
        page(
          'Please wait',
          `<h2>Please wait <span id="countdown">600</span> seconds</h2>
<script>var c=600;setInterval(function(){c--;document.getElementById('countdown').textContent=c;},1000);</script>`,
        ),
      );
      return;
    }
    if (alias === 'hang') {
      hanging.add(res);
      return; // never answers
    }
    if (alias === 'obscure') {
      html(
        res,
        page(
          'Step',
          `<div style="display:flex;gap:20px">
<div class="q1" style="width:120px;height:60px;background:#c33;cursor:pointer" onclick="location.href='${U('ads.test', '/a')}'"></div>
<div class="q7" style="width:120px;height:60px;background:#3c3;cursor:pointer" onclick="location.href='${U('dest.test', '/ai-target')}'"></div>
<div class="q3" style="width:120px;height:60px;background:#33c;cursor:pointer" onclick="location.href='${U('ads.test', '/b')}'"></div></div>`,
        ),
      );
      return;
    }
    if (alias === 'missing' || alias) {
      html(res, page('404 Not Found', '<h1>404 Not Found</h1><p>The link you requested could not be found.</p>'), 404);
      return;
    }
  };

  const blog = (req: http.IncomingMessage, res: http.ServerResponse, host: string, url: URL) => {
    const t = url.searchParams.get('t') ?? '';
    const s = /^[a-z0-9.-]+$/.test(url.searchParams.get('s') ?? '') ? url.searchParams.get('s')! : 'short.test';
    if (host === 'blog-a.test' && url.pathname === '/meta-step') {
      html(
        res,
        page(
          'Almost there',
          `<h2>Your link is ready</h2><a class="btn" href="${U('dest.test', '/meta-target')}">Continue to destination</a>`,
        ),
      );
      return;
    }
    if (host === 'blog-a.test') {
      html(
        res,
        page(
          '10 Money Tips Everyone Should Know - FinanceBlog',
          `<header><nav><a href="/">Home</a> <a href="/category/finance">Finance</a> <a href="/about">About</a> <a href="/contact">Contact</a></nav></header>
<aside class="sidebar"><h4>Related Posts</h4><a href="/2026/09/budget.html">How to budget in 2026: a complete guide for beginners</a></aside>
<div class="ads-box"><a class="btn" href="${U('ads.test', '/click1')}">Download Now</a><a class="btn btn-success" href="${U('ads.test', '/click2')}">Continue</a></div>
<article><h1>10 Money Tips Everyone Should Know</h1>
<p>Scroll down and click the Verify button to continue to your link.</p>
${LOREM}
<div id="step1" class="hidden"><button id="verify-btn" class="btn btn-primary">Verify</button></div>
<p id="wait-msg" class="hidden">Please wait <span id="wait-timer">3</span> seconds...</p>
${LOREM}
<div id="step2" class="hidden"><a id="continue-btn" class="btn" href="${U('blog-b.test', `/post.html?t=${t}&s=${s}`)}">Continue</a></div>
</article>
<footer><a href="/privacy">Privacy Policy</a> <a href="/dmca">DMCA</a></footer>
<script>
var clicks = 0;
window.addEventListener('scroll', function(){ if (window.scrollY > 200) document.getElementById('step1').classList.remove('hidden'); });
document.getElementById('verify-btn').addEventListener('click', function(){
  clicks++;
  if (clicks === 1) { window.open('${U('ads.test', '/pop')}'); return; }
  this.disabled = true;
  var msg = document.getElementById('wait-msg'); msg.classList.remove('hidden');
  var n = 3; var el = document.getElementById('wait-timer');
  var iv = setInterval(function(){ n--; el.textContent = n; if (n <= 0) { clearInterval(iv); msg.textContent = 'Done! Scroll down and click Continue.'; document.getElementById('step2').classList.remove('hidden'); } }, 1000);
});
</script>`,
        ),
      );
      return;
    }
    if (host === 'blog-b.test') {
      const ref = String(req.headers.referer ?? '');
      if (!ref.includes('blog-a.test')) {
        html(res, page('Invalid access', '<h1>Invalid access</h1><p>Direct access is not allowed. Please use the original link.</p>'), 403);
        return;
      }
      html(
        res,
        page(
          'Crypto Basics Explained - TechBlog',
          `<header><a href="/">Home</a> <a href="/tags/crypto">Tags</a></header>
<h1>Crypto Basics Explained</h1><p>Step 2/2 - You are almost there.</p>${LOREM.slice(0, 600)}
<div class="ad-slot"><a class="btn" href="${U('ads.test', '/x')}">Get Link Now</a></div>
<div class="next-step btn" role="button" onclick="go()">Click here to proceed</div>
<a href="/2026/10/next.html">Next Post »</a>
<script>function go(){ location.href='${U(s, `/multi?step=final&t=${t}`)}'; }</script>`,
        ),
      );
      return;
    }
    html(res, page('Not found', 'not found'), 404);
  };

  const server = http.createServer((req, res) => {
    const hostHeader = String(req.headers.host ?? '');
    const host = hostHeader.replace(/:\d+$/, '').toLowerCase();
    const url = new URL(req.url ?? '/', `http://${hostHeader || 'localhost'}`);
    const key = `${host} ${url.pathname}`;
    hits.set(key, (hits.get(key) ?? 0) + 1);
    const run = async () => {
      if (host === 'short.test' || host === 'arolinks.com' || host === 'www.arolinks.com' || host === 'unlisted.test') {
        return shortener(req, res, host, url);
      }
      if (host === 'blog-a.test' || host === 'blog-b.test') return blog(req, res, host, url);
      if (host === 'dest.test') {
        if (url.pathname.startsWith('/files/')) {
          res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename="report.zip"' });
          res.end(Buffer.alloc(2048));
          return;
        }
        html(res, DEST_PAGE('Destination', url.pathname));
        return;
      }
      if (host === 'ads.test' || host === 'www.popads.net') {
        if (url.pathname.endsWith('.png')) {
          res.writeHead(200, { 'Content-Type': 'image/png' });
          res.end();
          return;
        }
        html(res, page('Win a prize!', '<h1>Congratulations! Claim your prize now!</h1><a class="btn" href="/claim">Claim</a>'));
        return;
      }
      html(res, page('Unknown host', 'unknown'), 404);
    };
    run().catch((err: unknown) => {
      res.writeHead(500);
      res.end(String(err));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  port = (server.address() as AddressInfo).port;

  return {
    port,
    url: U,
    hits,
    stats,
    async close() {
      for (const r of hanging) r.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
