(() => {
  'use strict';

  // Runs as a content script from document_start on every page. It keeps
  // scanning the page for article content while it loads and changes, and
  // remembers the largest snapshot it has seen. When the "E" button is clicked,
  // background.js sends 'essence:apply' and the remembered snapshot is rendered.
  //
  // If a later scan finds LESS content (paywall truncation, lazy unloading,
  // overlays hiding paragraphs, etc.) the earlier, larger snapshot is kept.

  const MIN_SCAN_GAP_MS = 1000;   // at most one scan per second...
  const MAX_SCAN_GAP_MS = 8000;   // ...slowing to one per 8s when nothing changes
  const BACKSTOP_SCAN_MS = 2000;  // periodic scan in case no mutations fire

  let best = null;       // { url, title, items: [{ type: 'p'|'h'|'li', html }], textLength }
  let scanGap = MIN_SCAN_GAP_MS;
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

  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();

  function isVisible(el) {
    const style = window.getComputedStyle(el);
    return style && style.display !== 'none' && style.visibility !== 'hidden' && el.offsetHeight > 0;
  }

  // Parts of a page that are never article text, whatever they contain.
  const BOILERPLATE_TAGS = new Set(['NAV', 'FOOTER', 'ASIDE', 'FIGURE', 'FIGCAPTION', 'FORM', 'BUTTON', 'DIALOG']);
  const BOILERPLATE_ROLES = /^(navigation|complementary|contentinfo|dialog|alertdialog|search)$/;
  // Class/id words that usually mean "not the article" (matched as whole
  // words, e.g. "related-links" but not "unrelated").
  const BOILERPLATE_NAMES = /(^|[^a-z])(comments?|related|newsletters?|promo|promos|footer|recirc|recirculation|share|sharing|social|sidebar|subscribe|signup|copyright|outbrain|taboola|trending|popular|recommended|recommendations|cookie|cookies|consent|sponsor|sponsored|byline|author-bio|bio|caption|credits?|disclaimer|tags|breadcrumbs?)([^a-z]|$)/i;

  // Text that marks a short paragraph as site chrome rather than article text.
  const JUNK_TEXT = /cookie|advert|subscribe|sign up|signing up|log ?in\b|newsletter|all rights reserved|©|copyright|your email address|privacy policy|terms of (use|service)|required fields/i;
  const JUNK_HEADING = /related|recommended|more (stories|from|on|in)\b|read (more|next)|subscribe|newsletter|trending|most (read|popular)|share|comments?|advertis|sign up|follow us|topics|^watch\b|^listen\b|^see also|^latest/i;
  const ENDS_LIKE_SENTENCE = /[.?!:"”’…)]$/;

  // Share of an element's text that sits inside links.
  function linkRatio(el, textLength) {
    if (!textLength) return 0;
    let linked = 0;
    for (const a of el.querySelectorAll('a')) linked += norm(a.textContent).length;
    return linked / textLength;
  }

  // Keep only <a> tags from an element's HTML.
  function cleanHtml(el) {
    return el.innerHTML.trim().replace(/<(?!\/?a(?=>|\s.*>))\/?.*?>/gi, '');
  }

  // Looks at every paragraph once and works out, for each element on the page,
  // how much article-like text it holds. Returns the best container and a
  // function saying whether an element sits in a boilerplate region.
  function analysePage() {
    const body = document.body;
    const info = new Map();          // p -> { visible, text }
    const rawLen = new Map();        // element -> text length of all visible paragraphs inside
    let total = 0;

    const ps = body.querySelectorAll('p');
    for (const p of ps) {
      const visible = isVisible(p);
      const text = visible ? norm(p.innerText) : '';
      info.set(p, { visible, text });
      if (text.length > 30) {
        total += text.length;
        for (let e = p.parentElement; e && e !== body; e = e.parentElement) {
          rawLen.set(e, (rawLen.get(e) || 0) + text.length);
        }
      }
    }

    // An element is boilerplate by tag/role, or by name unless it holds a
    // large share of the page's text (e.g. an article wrapper that happens
    // to be called "article-with-sidebar").
    const boilerCache = new Map();
    const isBoilerplateEl = (e) => {
      let v = boilerCache.get(e);
      if (v === undefined) {
        const role = e.getAttribute('role') || '';
        const name = (typeof e.className === 'string' ? e.className : '') + ' ' + e.id;
        v = BOILERPLATE_TAGS.has(e.tagName) || BOILERPLATE_ROLES.test(role) ||
          (BOILERPLATE_NAMES.test(name) && (rawLen.get(e) || 0) < total * 0.4);
        boilerCache.set(e, v);
      }
      return v;
    };
    const inBoilerplate = (el) => {
      for (let e = el.parentElement; e && e !== body; e = e.parentElement) {
        if (isBoilerplateEl(e)) return true;
      }
      return false;
    };

    // Score containers by the article-like paragraphs they hold.
    const goodLen = new Map();
    const goodCount = new Map();
    for (const p of ps) {
      const { text } = info.get(p);
      if (text.length <= 30 || inBoilerplate(p)) continue;
      for (let e = p.parentElement; e && e !== body; e = e.parentElement) {
        goodLen.set(e, (goodLen.get(e) || 0) + text.length);
        goodCount.set(e, (goodCount.get(e) || 0) + 1);
      }
    }

    const CONTAINER_TAGS = new Set(['DIV', 'ARTICLE', 'SECTION', 'MAIN']);
    const candidates = [];
    for (const [el, count] of goodCount) {
      if (count < 3 || !CONTAINER_TAGS.has(el.tagName)) continue;
      // Cheap first estimate (textContent needs no layout).
      const rough = (goodLen.get(el) / (el.textContent.length + 1)) * count;
      candidates.push({ el, count, rough });
    }
    candidates.sort((a, b) => b.rough - a.rough);

    // Exact score (visible text only) for the front-runners.
    let bestEl = null;
    let bestScore = 0;
    for (const c of candidates.slice(0, 8)) {
      if (!isVisible(c.el)) continue;
      const score = (goodLen.get(c.el) / (c.el.innerText.length + 1)) * c.count;
      if (score > bestScore) {
        bestScore = score;
        bestEl = c.el;
      }
    }

    return { container: bestEl, info, inBoilerplate };
  }

  // Pulls the article out of the container, in reading order: paragraphs,
  // plus the subheadings and bullet points that sit between them.
  function extractItems(container, info, inBoilerplate) {
    const items = [];

    for (const el of container.querySelectorAll('p, h2, h3, h4, li')) {
      const tag = el.tagName;

      if (tag === 'P') {
        const { visible, text } = info.get(el) || { visible: false, text: '' };
        if (!visible || text.length < 20 || inBoilerplate(el)) continue;
        if (text.length < 200 && linkRatio(el, text.length) >= 0.8) continue; // a link dressed as a paragraph
        if (text.length < 160 && JUNK_TEXT.test(text)) continue;
        if (text.length > 50) {
          items.push({ type: 'p', text, html: cleanHtml(el) });
        } else if (ENDS_LIKE_SENTENCE.test(text)) {
          items.push({ type: 'p', short: true, text, html: cleanHtml(el) });
        }
        continue;
      }

      if (!isVisible(el) || inBoilerplate(el)) continue;
      const text = norm(el.textContent);

      if (tag === 'LI') {
        if (text.length < 15 || el.querySelector('p, ul, ol')) continue;
        if (linkRatio(el, text.length) >= 0.5) continue; // menus and related-story lists
        if (text.length < 160 && JUNK_TEXT.test(text)) continue;
        items.push({ type: 'li', text, html: cleanHtml(el) });
      } else {
        if (text.length < 3 || text.length > 120) continue;
        if (JUNK_HEADING.test(text) || JUNK_TEXT.test(text)) continue;
        if (linkRatio(el, text.length) >= 0.8) continue; // a teaser for another story
        items.push({ type: 'h', text, html: text.replace(/&/g, '&amp;').replace(/</g, '&lt;') });
      }
    }

    // The article runs from its first to its last full paragraph. Headings,
    // bullets and short lines outside that range are page furniture.
    const isFull = (it) => it.type === 'p' && !it.short;
    const first = items.findIndex(isFull);
    if (first === -1) return { items: [], textLength: 0 };
    let last = items.length - 1;
    while (!isFull(items[last])) last--;
    let kept = items.slice(first, last + 1);

    // No repeats, and no heading left without text under it.
    const seen = new Set();
    kept = kept.filter((it) => {
      if (it.type === 'h') return true;
      if (seen.has(it.text)) return false;
      seen.add(it.text);
      return true;
    });
    kept = kept.filter((it, i) => it.type !== 'h' || (kept[i + 1] && kept[i + 1].type !== 'h'));

    let textLength = 0;
    for (const it of kept) if (it.type !== 'h') textLength += it.text.length;
    return { items: kept.map(({ type, html }) => ({ type, html })), textLength };
  }

  function getLikelyTitle() {
    const candidates = [];

    ['h1', 'h2', 'h3'].forEach(tag => {
      document.querySelectorAll(tag).forEach(el => {
        if (!isVisible(el)) return;
        // textContent, not innerText: keeps the real capitalisation when the
        // site shows its headline in forced upper case.
        const text = norm(el.textContent);
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
    if (best && best.url !== location.href) {
      best = null;
      scanGap = MIN_SCAN_GAP_MS;
    }

    let improved = false;
    const { container, info, inBoilerplate } = analysePage();
    if (container) {
      const { items, textLength } = extractItems(container, info, inBoilerplate);
      if (items.length > 0 && (!best || textLength > best.textLength)) {
        best = {
          url: location.href,
          title: getLikelyTitle() || (best && best.title) || document.title || '',
          items,
          textLength
        };
        improved = true;
      }
    }

    // Scan less often while nothing new turns up, so busy pages (tickers,
    // rotating ads) don't keep the extension working for no benefit.
    scanGap = improved ? MIN_SCAN_GAP_MS : Math.min(scanGap * 2, MAX_SCAN_GAP_MS);
  }

  function scheduleScan() {
    if (applied || pendingScan) return;
    const wait = Math.max(0, lastScan + scanGap - Date.now());
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
        #x344q p { display: block !important; margin: 5px !important; padding: 10px !important; }
        #x344q h2 {
          display: block !important;
          font-size: ${Math.round(size.px * 1.15)}px !important;
          font-weight: bold !important;
          margin: 20px 5px 0 !important;
          padding: 10px !important;
        }
        #x344q ul { display: block !important; list-style: disc outside !important; margin: 5px !important; padding: 0 10px 0 40px !important; }
        #x344q li { display: list-item !important; margin: 0 !important; padding: 4px 0 !important; }`;
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
    // Paragraphs, subheadings and bullet points, in reading order.
    let html = '';
    let inList = false;
    for (const it of best.items) {
      if ((it.type === 'li') !== inList) {
        html += inList ? '</ul>' : '<ul>';
        inList = !inList;
      }
      html += it.type === 'h' ? `<h2>${it.html}</h2>` : it.type === 'li' ? `<li>${it.html}</li>` : `<p>${it.html}</p>`;
    }
    if (inList) html += '</ul>';
    content.innerHTML = html;
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
