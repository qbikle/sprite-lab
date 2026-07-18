import './ui/tokens.css';
import { App } from './app/app';

const THEME_KEY = 'sprite-lab:v2:theme';

const saved = localStorage.getItem(THEME_KEY);
const theme = saved === 'light' || saved === 'dark'
  ? saved
  : (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
document.documentElement.dataset['theme'] = theme;

const root = document.getElementById('app');
if (!root) throw new Error('missing #app root');

/** DEV-only icon gallery (`?gallery`) — the critique surface for the icon set. */
async function mountGallery(host: HTMLElement): Promise<void> {
  const { ICON_NAMES, icon } = await import('./ui/icons');
  host.style.cssText =
    'padding:24px;background:var(--bg);color:var(--text);font:12px/1.4 monospace;' +
    'display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:12px;' +
    'align-content:start;min-height:100vh;box-sizing:border-box';
  for (const name of ICON_NAMES) {
    const cell = document.createElement('div');
    cell.style.cssText =
      'display:flex;flex-direction:column;align-items:center;gap:6px;' +
      'padding:10px 4px;border:1px solid var(--border, #4444);border-radius:4px';
    const pair = document.createElement('div');
    pair.style.cssText = 'display:flex;align-items:center;gap:10px';
    pair.append(icon(name, 16), icon(name, 32));
    const label = document.createElement('span');
    label.textContent = name;
    label.style.opacity = '0.7';
    cell.append(pair, label);
    host.appendChild(cell);
  }
}

if (import.meta.env.DEV && new URLSearchParams(location.search).has('gallery')) {
  void mountGallery(root);
} else {
  new App(root).mount();
}

/** PWA offline: PROD-only so dev/HMR stays SW-free. Failure is non-fatal. */
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}
