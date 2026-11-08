// Event selection and HTML escaping, shared by the map, the floor, the drawer and the panel. The
// console's timeline column was removed on 2026-11-08: the shift-memory panel beside the map is the
// one event feed (git history has the list if it comes back).
import { state, notify } from './store';

export function select(id: string | null) { state.selected = id; notify(); document.dispatchEvent(new CustomEvent('select', { detail: id })); }
export function esc(s: string) { return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string)); }
