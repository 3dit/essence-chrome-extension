(async () => {
  'use strict';

  const THEMES = globalThis.ESSENCE_THEMES;
  const FONTS = globalThis.ESSENCE_FONTS;
  const status = document.getElementById('status');

  const stored = await chrome.storage.sync.get({
    theme: globalThis.ESSENCE_DEFAULT_THEME,
    font: globalThis.ESSENCE_DEFAULT_FONT,
    size: globalThis.ESSENCE_DEFAULT_SIZE
  });

  let statusTimer = null;
  function saved(name) {
    status.textContent = `Saved: ${name}`;
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => { status.textContent = ''; }, 1500);
  }

  // Builds one group of radio cards. makePreview(item) returns the preview box.
  function buildGroup({ containerId, key, items, fallback, makePreview }) {
    const container = document.getElementById(containerId);
    const current = items[stored[key]] ? stored[key] : fallback;

    for (const [id, item] of Object.entries(items)) {
      const label = document.createElement('label');
      label.className = 'theme';

      const pick = document.createElement('div');
      pick.className = 'pick';
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = key;
      radio.value = id;
      radio.checked = id === current;
      radio.addEventListener('change', async () => {
        await chrome.storage.sync.set({ [key]: id });
        saved(item.name);
      });
      pick.append(radio, item.name);

      label.append(makePreview(item), pick);
      container.appendChild(label);
    }
  }

  buildGroup({
    containerId: 'themes',
    key: 'theme',
    items: THEMES,
    fallback: globalThis.ESSENCE_DEFAULT_THEME,
    makePreview(t) {
      const preview = document.createElement('div');
      preview.className = 'preview';
      preview.style.background = t.bg;
      preview.style.color = t.text;
      const title = document.createElement('b');
      title.textContent = 'Article title';
      const link = document.createElement('u');
      link.textContent = 'a link';
      link.style.color = t.link;
      preview.append(title, 'Article text looks like this, with ', link, ' in it.');
      return preview;
    }
  });

  buildGroup({
    containerId: 'fonts',
    key: 'font',
    items: FONTS,
    fallback: globalThis.ESSENCE_DEFAULT_FONT,
    makePreview(f) {
      const sample = document.createElement('div');
      sample.className = 'sample';
      sample.style.fontFamily = f.stack;
      sample.textContent = 'The quick brown fox jumps over the lazy dog.';
      return sample;
    }
  });

  buildGroup({
    containerId: 'sizes',
    key: 'size',
    items: globalThis.ESSENCE_SIZES,
    fallback: globalThis.ESSENCE_DEFAULT_SIZE,
    makePreview(z) {
      const sample = document.createElement('div');
      sample.className = 'sample';
      sample.style.fontSize = z.px + 'px';
      sample.textContent = `Article text (${z.px}px)`;
      return sample;
    }
  });
})();
