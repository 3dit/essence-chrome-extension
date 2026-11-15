(() => {
  'use strict';

  // Runs as a content script from document_start on every page. It keeps
  // scanning the page for article content while it loads and changes, and
  // remembers the largest snapshot it has seen. When the "E" button is clicked,
  // background.js sends 'essence:apply' and the remembered snapshot is rendered.
  //
  // If a later scan finds LESS content (paywall truncation, lazy unloading,
  // overlays hiding paragraphs, etc.) the earlier, larger snapshot is kept.

  const MIN_SCAN_GAP_MS = 1000;   // at most one scan per second
  const BACKSTOP_SCAN_MS = 2000;  // periodic scan in case no mutations fire

  let best = null;       // { url, title, paragraphs: [html], textLength }
  let applied = false;
  let lastScan = 0;
  let pendingScan = null;

  // ---------- theme (chosen on the extension's settings page) ----------

  const THEMES = globalThis.ESSENCE_THEMES || {
    black: { name: 'Black', bg: '#000000', text: '#ffffff', link: '#eeee22' }
  };
  const DEFAULT_THEME = THEMES[globalThis.ESSENCE_DEFAULT_THEME] ? globalThis.ESSENCE_DEFAULT_THEME : Object.keys(THEMES)[0];
  let theme = THEMES[DEFAULT_THEME];

  // Fonts are always our own; the page's original font is never used.
  const FONTS = globalThis.ESSENCE_FONTS || {
    sans: { name: 'Sans-serif', stack: '"Segoe UI", "Helvetica Neue", Arial, sans-serif' }
  };
  const DEFAULT_FONT = FONTS[globalThis.ESSENCE_DEFAULT_FONT] ? globalThis.ESSENCE_DEFAULT_FONT : Object.keys(FONTS)[0];
  let font = FONTS[DEFAULT_FONT];

  // Text size is always our own too, not the page's.
  const SIZES = globalThis.ESSENCE_SIZES || { medium: { name: 'Medium', px: 16 } };
  const DEFAULT_SIZE = SIZES[globalThis.ESSENCE_DEFAULT_SIZE] ? globalThis.ESSENCE_DEFAULT_SIZE : Object.keys(SIZES)[0];
  let size = SIZES[DEFAULT_SIZE];

  function setLook(themeId, fontId, sizeId) {
    if (themeId !== undefined) theme = THEMES[themeId] || THEMES[DEFAULT_THEME];
    if (fontId !== undefined) font = FONTS[fontId] || FONTS[DEFAULT_FONT];
    if (sizeId !== undefined) size = SIZES[sizeId] || SIZES[DEFAULT_SIZE];
    // If the reader view is already showing, restyle it.
    const style = document.getElementById('x344q-style');
    if (style) {
      style.remove();
      unlockScrollingAndStyle();
    }
  }

  if (globalThis.chrome && chrome.storage && chrome.storage.sync) {
    chrome.storage.sync.get({ theme: DEFAULT_THEME, font: DEFAULT_FONT, size: DEFAULT_SIZE }, (stored) => {
      if (!chrome.runtime.lastError && stored) setLook(stored.theme, stored.font, stored.size);
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync') return;
      if (changes.theme) setLook(changes.theme.newValue, undefined);
      if (changes.font) setLook(undefined, changes.font.newValue);
      if (changes.size) setLook(undefined, undefined, changes.size.newValue);
    });
  }

  // ---------- content detection ----------

  function isVisible(el) {
    const style = window.getComputedStyle(el);
    return style && style.display !== 'none' && style.visibility !== 'hidden' && el.offsetHeight > 0;
  }

  // Per-scan cache so each <p> is measured once, not once per ancestor div.
  function makeParagraphInfo() {
    const cache = new Map();
    return (p) => {
      let info = cache.get(p);
      if (!info) {
        const visible = isVisible(p);
        info = { visible, text: visible ? p.innerText.trim() : '' };
        cache.set(p, info);
      }
      return info;
    };
  }

  function getTextDensityScore(el, pInfo) {
    const ps = el.querySelectorAll('p');
    if (ps.length === 0) return 0;

    let textLength = 0;
    let visibleCount = 0;

    ps.forEach(p => {
      const { visible, text } = pInfo(p);
      if (visible && text.length > 30) {
        textLength += text.length;
        visibleCount++;
      }
    });

    return (textLength / (el.innerText.length + 1)) * visibleCount;
  }

  function findBestContentContainer(pInfo) {
    let bestEl = null;
    let bestScore = 0;

    for (const div of document.querySelectorAll('div')) {
      if (div.querySelectorAll('p').length < 3) continue;
      if (!isVisible(div)) continue;

      const score = getTextDensityScore(div, pInfo);
      if (score > bestScore) {
        bestScore = score;
        bestEl = div;
      }
    }
    return bestEl;
  }

  function extractCleanParagraphsWithLinks(container, pInfo) {
    const paragraphs = [];
    let textLength = 0;

    container.querySelectorAll('p').forEach(p => {
      const { visible, text } = pInfo(p);
      if (!visible) return;
      if (text.length > 50 && !/cookie|advert|subscribe|sign up|login/i.test(text)) {
        const cleaned = p.innerHTML.trim().replace(/<(?!\/?a(?=>|\s.*>))\/?.*?>/gi, ''); // keep only <a>
        paragraphs.push(cleaned);
        textLength += text.length;
      }
    });

    return { paragraphs, textLength };
  }

  function getLikelyTitle() {
    const candidates = [];

    ['h1', 'h2', 'h3'].forEach(tag => {
      document.querySelectorAll(tag).forEach(el => {
        if (!isVisible(el)) return;
        const text = el.innerText.trim();
        if (text.length < 5 || text.length > 150) return;
        if (/subscribe|cookie|login|advert/i.test(text)) return;

        let score = 0;
        if (tag === 'h1') score += 10;
        if (el.closest('header')) score += 8;
        if (el.closest('article')) score += 4;
        if (el.closest('main')) score += 2;
        if (el.offsetTop < 600) score += 5;

        candidates.push({ text, score });
      });
    });

    candidates.sort((a, b) => b.score - a.score);
    return candidates.length > 0 ? candidates[0].text : null;
  }

  // ---------- continuous scanning ----------

  function scan() {
    lastScan = Date.now();
    if (applied || !document.body) return;

    // Single-page apps: a new URL means a new article, so forget the old one.
    if (best && best.url !== location.href) best = null;

    const pInfo = makeParagraphInfo();
    const container = findBestContentContainer(pInfo);
    if (!container) return;

    const { paragraphs, textLength } = extractCleanParagraphsWithLinks(container, pInfo);
    if (paragraphs.length === 0) return;

    if (!best || textLength > best.textLength) {
      best = {
        url: location.href,
        title: getLikelyTitle() || (best && best.title) || document.title || '',
        paragraphs,
        textLength
      };
    }
  }

  function scheduleScan() {
    if (applied || pendingScan) return;
    const wait = Math.max(0, lastScan + MIN_SCAN_GAP_MS - Date.now());
    pendingScan = setTimeout(() => {
      pendingScan = null;
      scan();
    }, wait);
  }

  const observer = new MutationObserver(scheduleScan);
  observer.observe(document, { childList: true, subtree: true, characterData: true });
  const backstop = setInterval(scheduleScan, BACKSTOP_SCAN_MS);
  document.addEventListener('DOMContentLoaded', scheduleScan);
  window.addEventListener('load', scheduleScan);
  scheduleScan();

  function stopScanning() {
    observer.disconnect();
    clearInterval(backstop);
    clearTimeout(pendingScan);
    pendingScan = null;
  }

  // ---------- rendering ----------

  // Sites often lock scrolling on <html>/<body> (e.g. "modal open"/overlay
  // classes or inline overflow:hidden while a popup is shown). Since we replace
  // the body content those popups are gone, but the lock would remain.
  function unlockScrollingAndStyle() {
    for (const el of [document.documentElement, document.body]) {
      el.removeAttribute('class');
      el.removeAttribute('style');
    }

    if (!document.getElementById('x344q-style')) {
      const style = document.createElement('style');
      style.id = 'x344q-style';
      // The site's own stylesheets are removed (see removeSiteStyles), so
      // these rules are the only thing deciding how the page looks. That is
      // what makes every site render identically.
      style.textContent = `
        html, body {
          display: block !important;
          margin: 0 !important;
          padding: 0 !important;
          overflow: auto !important;
          overflow-y: auto !important;
          position: static !important;
          width: auto !important;
          height: auto !important;
          max-height: none !important;
          touch-action: auto !important;
        }
        /* Hide anything the site adds next to our content (popups, overlays, ads). */
        body > :not(#x344q):not(#x344q-title),
        html > :not(head):not(body) {
          display: none !important;
        }
        body { background: ${theme.bg} !important; }
        body, body * {
          box-sizing: border-box !important;
          color: ${theme.text} !important;
          font-family: ${font.stack} !important;
          font-style: normal !important;
          font-weight: normal !important;
          letter-spacing: normal !important;
          word-spacing: normal !important;
          text-transform: none !important;
          text-align: left !important;
          text-indent: 0 !important;
        }
        body a { color: ${theme.link} !important; text-decoration: underline !important; }
        #x344q, #x344q * { font-size: ${size.px}px !important; line-height: 1.5 !important; }
        #x344q-title {
          display: flex !important;
          justify-content: center !important;
          align-items: center !important;
          margin: 0 !important;
          padding: 0 !important;
        }
        #x344q-title h1 {
          font-size: ${Math.round(size.px * 1.25)}px !important;
          line-height: 1.3 !important;
          font-weight: bold !important;
          text-align: center !important;
          margin: 0 !important;
          padding: 20px !important;
        }
        #x344q {
          width: 55em !important;
          max-width: 100% !important;
          display: flex !important;
          flex-direction: column !important;
          justify-content: space-around !important;
          margin: 0 auto !important;
          padding: 100px !important;
        }
        #x344q p { display: block !important; margin: 5px !important; padding: 10px !important; }`;
      (document.head || document.documentElement).appendChild(style);
    }
  }

  // The site's scripts keep running after we replace the page, and can still
  // add popups, overlays and ads, or re-lock scrolling. Once applied, the page
  // is ours: remove anything added beside our content and undo class/style
  // changes on <html>/<body>. (Removal, not just hiding, because a modal
  // <dialog> makes the rest of the page unclickable even when hidden.)
  // Remove the site's CSS so it can't affect the reader view. Without this the
  // same article text looks different from site to site (spacing, margins,
  // underlines, box sizing and so on leak through).
  function removeSiteStyles() {
    for (const el of document.querySelectorAll('style, link[rel~="stylesheet"]')) {
      if (el.id !== 'x344q-style') el.remove();
    }
    try {
      if (document.adoptedStyleSheets && document.adoptedStyleSheets.length) {
        document.adoptedStyleSheets = [];
      }
    } catch { /* not supported or not allowed: nothing to do */ }
  }

  function guardPage() {
    const isOurs = (el) =>
      el.id === 'x344q' || el.id === 'x344q-title';

    const clean = () => {
      const html = document.documentElement;
      const body = document.body;
      if (!body) return;

      for (const el of [...body.children]) {
        if (!isOurs(el)) el.remove();
      }
      for (const el of [...html.children]) {
        if (el !== body && el !== document.head) el.remove();
      }
      for (const el of [html, body]) {
        if (el.hasAttribute('class')) el.removeAttribute('class');
        if (el.hasAttribute('style')) el.removeAttribute('style');
      }
      removeSiteStyles();
      // Our stylesheet must survive, even if the site rewrites <head>.
      if (!document.getElementById('x344q-style')) unlockScrollingAndStyle();
    };

    clean();
    const guard = new MutationObserver(clean);
    const opts = { childList: true, attributes: true, attributeFilter: ['class', 'style'] };
    guard.observe(document.documentElement, opts);
    guard.observe(document.body, opts);
    if (document.head) guard.observe(document.head, { childList: true });
  }

  function apply() {
    if (applied) return true;

    scan(); // one last look, in case something arrived since the last scan
    if (!best) return false;

    applied = true;
    stopScanning();

    const titleWrap = document.createElement('div');
    titleWrap.id = 'x344q-title';
    const h1 = document.createElement('h1');
    h1.textContent = best.title || document.title || '';
    titleWrap.appendChild(h1);

    const content = document.createElement('div');
    content.id = 'x344q';
    content.innerHTML = best.paragraphs
      .map(p => `<p>${p}</p>`)
      .join('');
    // Links keep only their destination; site classes and inline styles go.
    for (const a of content.querySelectorAll('a')) {
      const href = a.getAttribute('href');
      for (const attr of [...a.attributes]) a.removeAttribute(attr.name);
      if (href) a.setAttribute('href', href);
    }

    document.body.replaceChildren(titleWrap, content);
    unlockScrollingAndStyle();
    guardPage();
    window.scrollTo(0, 0);
    return true;
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === 'essence:apply') {
      sendResponse({ ok: apply() });
    }
  });
})();
