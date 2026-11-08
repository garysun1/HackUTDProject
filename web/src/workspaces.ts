// Workspaces: one per dataset database, with the words that organization uses. The structure
// (moments, sessions, people, places, tracked things, readings, changes, flags, marks, notes,
// questions) is the same everywhere; only the vocabulary and the registry change.
import { DB, DIRECTORY_DB, WS_ID } from './store';

export type Vocab = { session: string; sessions: string; tracked: string; trackeds: string; flag: string; flags: string; note: string; notes: string };
/** A workspace is a dataset database plus the words that organisation uses. `overlay` names a
 *  static dataset (built by demo/weekend/src/build.mjs) that is laid over the live database:
 *  the weekend workspace is the live capture database plus the team's own weekend on top. */
export type Workspace = {
  id: string; db: string; name: string; subtitle: string; sample: boolean; vocab: Vocab; types: Record<string, string>;
  tag?: string;            // small label in the switcher instead of "sample"
  overlay?: string;        // URL of a store-ready JSON overlay (see demo/weekend/MANIFEST_SCHEMA.md)
  allShifts?: boolean;     // the map and its panel cover every tracked session, not only the latest
  campus?: boolean;        // draw the wider campus (web/src/site3d/data/campus.json) around ECSW
  tileRadius?: number;     // imagery tiles each way from the site centre (default 4)
  badge?: string;          // text pinned on live photos that arrive after the overlay ends (the judging beat)
};

const DC_TYPES = { pdu: 'power distribution unit', rack: 'server rack', crac: 'cooling unit', switch: 'network switch', ups: 'battery backup', panel: 'electrical panel', generator: 'generator', chiller: 'chiller' };
const V = (session: string, sessions: string, tracked: string, trackeds: string, flag: string, flags: string): Vocab => ({ session, sessions, tracked, trackeds, flag, flags, note: 'Note', notes: 'Notes' });

export const WORKSPACES: Workspace[] = [
  { id: 'live', db: DIRECTORY_DB, name: 'UTD field test', subtitle: 'Live capture · Ray-Ban Meta glasses · Richardson, TX', sample: false, vocab: V('Shift', 'Shifts', 'Equipment', 'Equipment', 'Issue', 'Issues'), types: DC_TYPES },
  // The team's own weekend, through the same memory: the live database plus a curated overlay of
  // the photos Edward took on the glasses from Saturday morning on. Replay covers all of it; a
  // photo taken during judging lands at the end of the record with its badge (decision 0033).
  { id: 'weekend', db: DIRECTORY_DB, name: 'HackUTD 2026', subtitle: 'Our weekend · ECSW and campus · Nov 7–8', sample: false, tag: 'this weekend', overlay: '/weekend/weekend.json', allShifts: true, campus: true, tileRadius: 7, badge: 'Judged by another amazing judge',
    vocab: V('Shift', 'Shifts', 'Gear', 'Gear', 'Problem', 'Problems'), types: { laptop: 'laptop', glasses: 'smart glasses', phone: 'phone', table: 'team table', projector: 'projector', badge: 'badge', snack: 'snack' } },
  { id: 'nmc2', db: 'wm-nmc2', name: 'Northstar Data Center', subtitle: 'Night shift · Hall A', sample: true, vocab: V('Shift', 'Shifts', 'Equipment', 'Equipment', 'Issue', 'Issues'), types: DC_TYPES },
  { id: 'plant', db: 'wm-plant', name: 'Arlington Assembly Plant', subtitle: 'Maintenance shift · Cell 3', sample: true, vocab: V('Shift', 'Shifts', 'Machine', 'Machines', 'Alarm', 'Alarms'), types: { cnc: 'machining center', press: 'hydraulic press', conveyor: 'conveyor', robot: 'robot cell', compressor: 'air compressor' } },
  { id: 'hospital', db: 'wm-hospital', name: 'Mercy General Biomed', subtitle: 'Equipment rounds · Ward 5', sample: true, vocab: V('Rounds', 'Rounds', 'Device', 'Devices', 'Alarm', 'Alarms'), types: { fridge: 'blood bank refrigerator', refrigerator: 'refrigerator', pump: 'infusion pump', monitor: 'patient monitor', ventilator: 'ventilator', defibrillator: 'defibrillator' } },
  { id: 'substation', db: 'wm-substation', name: 'Plano East Substation', subtitle: 'Switching round · 138 kV yard', sample: true, vocab: V('Round', 'Rounds', 'Apparatus', 'Apparatus', 'Trip', 'Trips'), types: { breaker: 'circuit breaker', transformer: 'transformer', relay: 'protection relay', bus: 'bus section', disconnect: 'disconnect switch' } },
  { id: 'warehouse', db: 'wm-warehouse', name: 'DFW Distribution Center', subtitle: 'Pick wave · Dock 4', sample: true, vocab: V('Pick wave', 'Pick waves', 'Asset', 'Assets', 'Hazard', 'Hazards'), types: { racking: 'storage racking', freezer: 'freezer', forklift: 'forklift', dock: 'loading dock', door: 'dock door', conveyor: 'conveyor' } },
];
const GENERIC: Workspace = { id: 'other', db: '', name: 'Workspace', subtitle: '', sample: false, vocab: V('Session', 'Sessions', 'Tracked item', 'Tracked items', 'Needs attention', 'Needs attention'), types: {} };

export function current(): Workspace {
  // several workspaces can share a database (the weekend overlays the live one): the chosen id wins, then the first match on the database
  return (WS_ID && WORKSPACES.find(w => w.id === WS_ID && w.db === DB)) || WORKSPACES.find(w => w.db === DB) || { ...GENERIC, db: DB, name: DB };
}
export function vocab(): Vocab { return current().vocab; }
/** Plain words for a registry type: the workspace's own word, else the type humanized. */
export function typeWords(assetType: string): string {
  const k = (assetType || '').toLowerCase().trim(); if (!k) return '';
  return current().types[k] ?? k.replace(/[_-]+/g, ' ');
}
