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

  // Some sites (Reuters, for one) put each paragraph in a <div> rather than a
  // <p>. A <div> is such a paragraph when it holds running text directly:
  // a good amount of text of its own, and nothing inside but inline elements.
  const INLINE_TAGS = new Set(['A', 'SPAN', 'EM', 'STRONG', 'B', 'I', 'U', 'BR', 'WBR', 'SUP', 'SUB', 'MARK',
    'SMALL', 'ABBR', 'CITE', 'Q', 'CODE', 'TIME', 'S', 'INS', 'DEL']);
  const MIN_DIV_PARAGRAPH = 60;

  function isDivParagraph(div) {
    let own = 0;
    for (const n of div.childNodes) {
      if (n.nodeType === 3) own += n.nodeValue.trim().length;
      else if (n.nodeType === 1 && !INLINE_TAGS.has(n.tagName)) return false;
    }
    return own >= MIN_DIV_PARAGRAPH;
  }

  // Looks at every paragraph once and works out, for each element on the page,
  // how much article-like text it holds. Returns the best container, a
  // function saying whether an element sits in a boilerplate region, and the
  // <div>s that count as paragraphs on this page (usually none).
  function analysePage() {
    const body = document.body;
    const info = new Map();          // paragraph -> { visible, text }
    const rawLen = new Map();        // element -> text length of all visible paragraphs inside
    let total = 0;

    // Records each element's visible text; returns how much of it is paragraph-sized.
    const measure = (els) => {
      let sum = 0;
      for (const el of els) {
        const visible = isVisible(el);
        const text = visible ? norm(el.innerText) : '';
        info.set(el, { visible, text });
        if (text.length > 30) sum += text.length;
      }
      return sum;
    };

    let ps = [...body.querySelectorAll('p')];
    const pTotal = measure(ps);

    // <div> paragraphs are only used where they carry more of the page's text
    // than its <p>s do, so sites that mark up paragraphs properly are unaffected.
    const divParagraphs = new Set();
    const divs = [];
    for (const div of body.querySelectorAll('div')) {
      if (div.firstChild && !div.closest('a') && isDivParagraph(div)) divs.push(div);
    }
    if (divs.length >= 3 && measure(divs) > pTotal) {
      for (const div of divs) divParagraphs.add(div);
      ps = ps.concat(divs);
    }

    for (const p of ps) {
      const { text } = info.get(p);
      if (text.length > 30) {
        total += text.length;
        for (let e = p.parentElement; e && e !== body; e = e.parentElement) {
          rawLen.set(e, (rawLen.get(e) || 0) + text.length);
        }
      }
    }

    // An element is boilerplate by tag/role, or by name unless it holds a
    // large share of the page's text (e.g. an article wrapper that happens
    // to be called "article-with-sidebar"). A <figure> gets the same
    // allowance: it is normally a picture and its caption, but some sites
    // wrap a whole list-style article in one.
    const boilerCache = new Map();
    const isBoilerplateEl = (e) => {
      let v = boilerCache.get(e);
      if (v === undefined) {
        const role = e.getAttribute('role') || '';
        const name = (typeof e.className === 'string' ? e.className : '') + ' ' + e.id;
        const holdsArticle = (rawLen.get(e) || 0) >= total * 0.4;
        v = e.tagName === 'FIGURE' ? !holdsArticle :
          BOILERPLATE_TAGS.has(e.tagName) || BOILERPLATE_ROLES.test(role) ||
          (BOILERPLATE_NAMES.test(name) && !holdsArticle);
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

    if (!bestEl) bestEl = shortArticleContainer(goodCount);

    return { container: bestEl, info, inBoilerplate, divParagraphs };
  }

  // A story of only one or two paragraphs (a brief, or the opening that a
  // paywall leaves on the page) has too little text to stand out the usual
  // way. It is still an article if the page is laid out as one: its own
  // headline in an <h1>, with the text in the same <article> or <main>.
  // Front pages must not qualify; they are shown as headlines instead.
  function shortArticleContainer(goodCount) {
    if (location.pathname === '/') return null;
    const ogType = document.querySelector('meta[property="og:type"]');
    if (ogType && !/article/i.test(ogType.content || '')) return null;

    for (const h1 of document.body.querySelectorAll('h1')) {
      if (!isVisible(h1) || !looksLikeHeadline(norm(h1.textContent))) continue;
      if (h1.querySelector('a[href]') || h1.closest('a[href]')) continue; // a teaser for another page
      const el = h1.closest('article, main, [role="main"]');
      if (!el || !goodCount.get(el)) continue;
      // Several headline links around the text: a section page with an intro.
      let headlines = 0;
      for (const a of el.querySelectorAll('a[href]')) {
        if (!a.closest('p') && looksLikeHeadline(norm(a.textContent))) headlines++;
      }
      if (headlines < MIN_HEADLINES) return el;
    }
    return null;
  }

  // Pulls the article out of the container, in reading order: paragraphs,
  // plus the subheadings and bullet points that sit between them.
  function extractItems(container, info, inBoilerplate, divParagraphs) {
    const items = [];
    const selector = divParagraphs.size ? 'p, h2, h3, h4, li, div' : 'p, h2, h3, h4, li';

    for (const el of container.querySelectorAll(selector)) {
      const tag = el.tagName;
      if (tag === 'DIV' && !divParagraphs.has(el)) continue;

      if (tag === 'P' || tag === 'DIV') {
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

  // ---------- front pages ----------

  // Front pages and section indexes have no article, only headlines that link
  // to articles. When no article is found, the reader view shows those
  // headlines as a list of links, under the page's own section names.

  const MIN_HEADLINES = 5;
  const INDEX_SKIP_TAGS = new Set(['NAV', 'FOOTER', 'FORM', 'BUTTON', 'DIALOG']);
  const INDEX_SKIP_NAMES = /(^|[^a-z])(cookie|cookies|consent|newsletters?|subscribe|signup|footer|comments?)([^a-z]|$)/i;
  const INDEX_JUNK = /subscribe|sign up|newsletter|log ?in\b|advertis/i;
  const CJK = /[぀-ヿ㐀-鿿가-힯]/;

  const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  // Long enough to be a headline rather than a section name or a menu entry.
  function looksLikeHeadline(text) {
    if (text.length > 300) return false;
    if (CJK.test(text)) return text.length >= 8;
    return text.length >= 25 || text.split(' ').length >= 4;
  }

  function inSiteChrome(el) {
    for (let e = el; e && e !== document.body; e = e.parentElement) {
      const name = (typeof e.className === 'string' ? e.className : '') + ' ' + e.id;
      if (INDEX_SKIP_TAGS.has(e.tagName) || BOILERPLATE_ROLES.test(e.getAttribute('role') || '') || INDEX_SKIP_NAMES.test(name)) {
        return true;
      }
    }
    return false;
  }

  // Where a link goes, if it leads to another page.
  function linkTarget(a) {
    if (!a || !/^https?:$/.test(a.protocol)) return null;
    const here = location.href.split('#')[0];
    return a.href.split('#')[0] === here ? null : a.href;
  }

  function extractHeadlines() {
    const seen = new Set();
    let title = null;
    let count = 0;
    let items = [];

    const addHeadline = (el, text, href) => {
      if (seen.has(href) || seen.has(text) || INDEX_JUNK.test(text)) return;
      seen.add(href);
      seen.add(text);
      items.push({ type: 'li', el, html: `<a href="${escapeHtml(href)}">${escapeHtml(text)}</a>` });
      count++;
    };

    // A section name sits just above its headlines, so they share a nearby
    // ancestor. A short heading elsewhere (a video player's caption, say)
    // must not end up as the title of whatever headlines happen to follow.
    const headsSection = (h, next) => {
      let scope = h.el;
      for (let i = 0; i < 3 && scope.parentElement && scope.parentElement !== document.body; i++) {
        scope = scope.parentElement;
      }
      return !!next && next.type !== 'h' && scope.contains(next.el);
    };

    // Most sites mark headlines up as headings.
    for (const el of document.body.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
      const text = norm(el.textContent);
      if (text.length < 2 || !isVisible(el) || inSiteChrome(el)) continue;
      const href = linkTarget(el.querySelector('a[href]') || el.closest('a[href]'));
      if (href && looksLikeHeadline(text)) {
        addHeadline(el, text, href);
      } else if (text.length <= 40) {
        // A short heading is the site's name (the first <h1>) or a section name.
        if (el.tagName === 'H1' && title === null) title = text;
        else items.push({ type: 'h', el, html: escapeHtml(text) });
      }
    }

    // Others use plain links.
    if (count < MIN_HEADLINES) {
      for (const a of document.body.querySelectorAll('a[href]')) {
        const text = norm(a.textContent);
        const href = linkTarget(a);
        if (!href || !looksLikeHeadline(text) || a.closest('h1, h2, h3, h4, h5, h6')) continue;
        if (!isVisible(a) || inSiteChrome(a)) continue;
        addHeadline(a, text, href);
      }
      // These were not gathered in page order, so the section names no longer fit.
      items = items.filter((it) => it.type !== 'h');
    }
    if (count < MIN_HEADLINES) return null;

    // No section name left without headlines under it.
    items = items.filter((it, i) => it.type !== 'h' || headsSection(it, items[i + 1]));
    return {
      url: location.href,
      title: title || document.title || '',
      items: items.map(({ type, html }) => ({ type, html })),
      textLength: 0
    };
  }

  // Briefly tells the user why clicking "E" changed nothing.
  function notify(text) {
    const old = document.getElementById('x344q-note');
    if (old) old.remove();
    const note = document.createElement('div');
    note.id = 'x344q-note';
    note.setAttribute('role', 'status');
    note.textContent = text;
    note.style.cssText = `
      all: initial !important;
      position: fixed !important;
      z-index: 2147483647 !important;
      top: 16px !important;
      right: 16px !important;
      max-width: calc(100vw - 32px) !important;
      box-sizing: border-box !important;
      padding: 10px 14px !important;
      border: 1px solid #ffffff !important;
      border-radius: 6px !important;
      background: #000000 !important;
      color: #ffffff !important;
      font: 14px/1.4 "Segoe UI", "Helvetica Neue", Arial, sans-serif !important;`;
    document.documentElement.appendChild(note);
    setTimeout(() => note.remove(), 4000);
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
    const { container, info, inBoilerplate, divParagraphs } = analysePage();
    if (container) {
      const { items, textLength } = extractItems(container, info, inBoilerplate, divParagraphs);
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
        #x344q li { display: list-item !important; margin: 0 !important; padding: 4px 0 !important; }
        /* Phones and narrow windows: the wide margins would leave no room for text. */
        @media (max-width: 700px) {
          #x344q { padding: 12px !important; }
          #x344q-title h1 { padding: 16px 22px !important; }
        }`;
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

  // On phones, a page with no viewport setting (or a fixed-width one) is laid
  // out at desktop width and shrunk to fit, which makes the text tiny. The
  // reader view fits any width, so always ask for the device's own width.
  // Desktop browsers ignore this.
  function setMobileViewport() {
    if (!document.head) return;
    for (const el of document.querySelectorAll('meta[name="viewport" i]')) el.remove();
    const meta = document.createElement('meta');
    meta.name = 'viewport';
    meta.content = 'width=device-width, initial-scale=1';
    document.head.appendChild(meta);
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
    if (!best && document.body) best = extractHeadlines(); // not an article: a front page?
    if (!best) {
      notify('Essence: no article or headlines found on this page.');
      return false;
    }

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
    setMobileViewport();
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
