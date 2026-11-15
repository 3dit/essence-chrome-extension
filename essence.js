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
      style.textContent = `
        html, body {
          overflow: auto !important;
          overflow-y: auto !important;
          position: static !important;
          height: auto !important;
          max-height: none !important;
          touch-action: auto !important;
        }
        body { background: black !important; }
        body, body p, body h1, body div { color: white !important; }
        body a { color: #eeee22 !important; }
        #x344q {
          width: 55em;
          display: flex;
          flex-direction: column;
          justify-content: space-around;
          margin-left: auto;
          margin-right: auto;
          padding: 100px;
        }`;
      (document.head || document.documentElement).appendChild(style);
    }
  }

  function apply() {
    if (applied) return true;

    scan(); // one last look, in case something arrived since the last scan
    if (!best) return false;

    applied = true;
    stopScanning();

    const titleWrap = document.createElement('div');
    titleWrap.style.cssText = 'display:flex;justify-content:center;align-items:center;';
    const h1 = document.createElement('h1');
    h1.style.cssText = 'font-weight:bold;font-size:20px;padding:20px;';
    h1.textContent = best.title || document.title || '';
    titleWrap.appendChild(h1);

    const content = document.createElement('div');
    content.id = 'x344q';
    content.innerHTML = best.paragraphs
      .map(p => `<p style="padding:10px;margin:5px;">${p}</p>`)
      .join('');

    document.body.replaceChildren(titleWrap, content);
    unlockScrollingAndStyle();
    window.scrollTo(0, 0);
    return true;
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === 'essence:apply') {
      sendResponse({ ok: apply() });
    }
  });
})();
