// Workspaces: one per dataset database, with the words that organization uses. The structure
// (moments, sessions, people, places, tracked things, readings, changes, flags, marks, notes,
// questions) is the same everywhere; only the vocabulary and the registry change.
import { DB, DIRECTORY_DB } from './store';

export type Vocab = { session: string; sessions: string; tracked: string; trackeds: string; flag: string; flags: string; note: string; notes: string };
export type Workspace = { id: string; db: string; name: string; subtitle: string; sample: boolean; vocab: Vocab; types: Record<string, string> };

const DC_TYPES = { pdu: 'power distribution unit', rack: 'server rack', crac: 'cooling unit', switch: 'network switch', ups: 'battery backup', panel: 'electrical panel', generator: 'generator', chiller: 'chiller' };
const V = (session: string, sessions: string, tracked: string, trackeds: string, flag: string, flags: string): Vocab => ({ session, sessions, tracked, trackeds, flag, flags, note: 'Note', notes: 'Notes' });

export const WORKSPACES: Workspace[] = [
  { id: 'live', db: DIRECTORY_DB, name: 'UTD field test', subtitle: 'Live capture · Ray-Ban Meta glasses · Richardson, TX', sample: false, vocab: V('Shift', 'Shifts', 'Equipment', 'Equipment', 'Issue', 'Issues'), types: DC_TYPES },
  { id: 'nmc2', db: 'wm-nmc2', name: 'Northstar Data Center', subtitle: 'Night shift · Hall A', sample: true, vocab: V('Shift', 'Shifts', 'Equipment', 'Equipment', 'Issue', 'Issues'), types: DC_TYPES },
  { id: 'plant', db: 'wm-plant', name: 'Arlington Assembly Plant', subtitle: 'Maintenance shift · Cell 3', sample: true, vocab: V('Shift', 'Shifts', 'Machine', 'Machines', 'Alarm', 'Alarms'), types: { cnc: 'machining center', press: 'hydraulic press', conveyor: 'conveyor', robot: 'robot cell', compressor: 'air compressor' } },
  { id: 'hospital', db: 'wm-hospital', name: 'Mercy General Biomed', subtitle: 'Equipment rounds · 4 West and the lab', sample: true, vocab: V('Rounds', 'Rounds', 'Device', 'Devices', 'Alarm', 'Alarms'), types: { fridge: 'blood bank refrigerator', refrigerator: 'refrigerator', pump: 'infusion pump', monitor: 'patient monitor', ventilator: 'ventilator', defibrillator: 'defibrillator', 'med-gas': 'medical gas valve', ats: 'transfer switch', generator: 'generator' } },
  { id: 'substation', db: 'wm-substation', name: 'Northlake Substation', subtitle: 'Inspection round · 138 kV yard · Plano, TX', sample: true, vocab: V('Round', 'Rounds', 'Apparatus', 'Apparatus', 'Trip', 'Trips'), types: { breaker: 'circuit breaker', transformer: 'transformer', relay: 'protection relay', bus: 'bus section', disconnect: 'disconnect switch', battery: 'station battery' } },
  { id: 'warehouse', db: 'wm-warehouse', name: 'DFW Distribution Center', subtitle: 'Early shift · Docks 11–20 · Aisle 22', sample: true, vocab: V('Pick wave', 'Pick waves', 'Asset', 'Assets', 'Hazard', 'Hazards'), types: { racking: 'storage racking', freezer: 'freezer', forklift: 'forklift', dock: 'loading dock', door: 'dock door', conveyor: 'conveyor', charger: 'forklift charger' } },
];
const GENERIC: Workspace = { id: 'other', db: '', name: 'Workspace', subtitle: '', sample: false, vocab: V('Session', 'Sessions', 'Tracked item', 'Tracked items', 'Needs attention', 'Needs attention'), types: {} };

export function current(): Workspace { return WORKSPACES.find(w => w.db === DB) ?? { ...GENERIC, db: DB, name: DB }; }
export function vocab(): Vocab { return current().vocab; }
/** Plain words for a registry type: the workspace's own word, else the type humanized. */
export function typeWords(assetType: string): string {
  const k = (assetType || '').toLowerCase().trim(); if (!k) return '';
  return current().types[k] ?? k.replace(/[_-]+/g, ' ');
}
