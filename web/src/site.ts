// The 3D site view (Edward's site3d, issue #24) embedded for the current workspace. It is its
// own static app, deployed from the same repo; we pass the database so it follows the switcher.
import { DB } from './store';
import { view, onView } from './view';

const SITE_URL = (import.meta as any).env?.VITE_SITE_URL || 'https://shift-memory-site.vercel.app/';
const host = document.getElementById('site') as HTMLElement;
let frame: HTMLIFrameElement | null = null; let lastSrc = '';

export function renderSite() {
  const active = view.mode === 'site'; host.hidden = !active; if (!active) return;
  const src = `${SITE_URL}${SITE_URL.includes('?') ? '&' : '?'}db=${encodeURIComponent(DB)}`;
  if (!frame) { frame = document.createElement('iframe'); frame.title = '3D site view'; frame.allow = 'fullscreen'; frame.referrerPolicy = 'no-referrer'; host.appendChild(frame); }
  if (src !== lastSrc) { frame.src = src; lastSrc = src; }
}
onView(() => renderSite());
