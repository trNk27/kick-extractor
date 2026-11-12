// Library + pad assignments, persisted in IndexedDB.
// items: every saved sample. pads: 16 slots holding an item id (or null).
// Removing a sample from a pad keeps it in the library; deleting it from the library frees its pad.

export const state = { items: [], pads: new Array(16).fill(null) };
const listeners = new Set();

export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function changed(what) { for (const fn of listeners) fn(what); save(); }

function idb() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open('kick-extractor', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function get(db, key) {
  return new Promise((res, rej) => {
    const r = db.transaction('kv').objectStore('kv').get(key);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function save() {
  try {
    const db = await idb();
    db.transaction('kv', 'readwrite').objectStore('kv').put({ items: state.items, pads: state.pads }, 'library');
  } catch { /* private mode etc.: nothing survives a reload, everything else works */ }
}

export async function load() {
  try {
    const db = await idb();
    const lib = await get(db, 'library');
    if (lib && Array.isArray(lib.items) && Array.isArray(lib.pads)) {
      state.items = lib.items;
      state.pads = lib.pads;
    } else {
      // v3 stored whole sounds directly on the pads -> move them into the library
      const old = await get(db, 'pads');
      if (Array.isArray(old)) {
        old.forEach((p, i) => {
          if (!p) return;
          const item = { ...p, song: p.song || null, addedAt: Date.now() + i };
          state.items.push(item);
          state.pads[i] = item.id;
        });
        save();
      }
    }
  } catch { /* ignore */ }
  for (const fn of listeners) fn('load');
}

const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

export function addItem(sound) {
  const item = {
    id: newId(),
    name: sound.name,
    category: sound.category,
    loop: !!sound.loop,
    sr: sound.sr,
    bpm: sound.bpm || null,
    loopLen: sound.loopLen || null,
    song: sound.song || null,
    channels: sound.channels,
    addedAt: Date.now(),
  };
  state.items.unshift(item);
  changed('items');
  return item;
}

export const itemById = (id) => state.items.find((it) => it.id === id) || null;
export const padItem = (i) => (state.pads[i] ? itemById(state.pads[i]) : null);
export const padOf = (id) => state.pads.indexOf(id);

export function updateItem(id, patch) {
  const it = itemById(id);
  if (!it) return;
  Object.assign(it, patch);
  changed('items');
}

// put an item on a pad (an item lives on at most one pad: assigning moves it)
export function assignPad(i, id) {
  const prev = padOf(id);
  if (prev >= 0) state.pads[prev] = null;
  state.pads[i] = id;
  changed('pads');
}

export function clearPad(i) {
  state.pads[i] = null;
  changed('pads');
}

export function clearPads() {
  state.pads = new Array(16).fill(null);
  changed('pads');
}

export function deleteItem(id) {
  const p = padOf(id);
  if (p >= 0) state.pads[p] = null;
  state.items = state.items.filter((it) => it.id !== id);
  changed('items');
}
