// Themes for the Essence reader view. Shared by the content script
// (essence.js) and the settings page (options.js).
// To add a theme, add an entry here; it appears in settings automatically.
globalThis.ESSENCE_DEFAULT_THEME = 'black';

globalThis.ESSENCE_THEMES = {
  black: { name: 'Black', bg: '#000000', text: '#ffffff', link: '#eeee22' },
  dim:   { name: 'Dim',   bg: '#1e1f22', text: '#d7d9dc', link: '#8ab4f8' },
  sepia: { name: 'Sepia', bg: '#f4ecd8', text: '#5b4636', link: '#9a4a12' },
  gray:  { name: 'Gray',  bg: '#e4e4e4', text: '#222222', link: '#0645ad' },
  light: { name: 'Light', bg: '#ffffff', text: '#1a1a1a', link: '#0b57d0' }
};

// Fonts for the reader view. These are fonts already on the computer; the
// page's own font is never used. Each stack ends in a generic fallback.
globalThis.ESSENCE_DEFAULT_FONT = 'sans';

globalThis.ESSENCE_FONTS = {
  sans:    { name: 'Sans-serif',      stack: '"Segoe UI", "Helvetica Neue", Arial, sans-serif' },
  serif:   { name: 'Serif (Georgia)', stack: 'Georgia, "Times New Roman", serif' },
  times:   { name: 'Times',           stack: '"Times New Roman", Times, serif' },
  verdana: { name: 'Verdana',         stack: 'Verdana, Geneva, sans-serif' },
  mono:    { name: 'Monospace',       stack: 'Consolas, Menlo, "Courier New", monospace' }
};

// Text sizes for the reader view, in pixels. The title is 1.25x this size.
globalThis.ESSENCE_DEFAULT_SIZE = 'medium';

globalThis.ESSENCE_SIZES = {
  small:  { name: 'Small',       px: 14 },
  medium: { name: 'Medium',      px: 16 },
  large:  { name: 'Large',       px: 18 },
  xlarge: { name: 'Extra large', px: 21 },
  huge:   { name: 'Huge',        px: 24 }
};
