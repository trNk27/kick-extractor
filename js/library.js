// Library tab: every sample saved with "+LP", whether or not it is on a pad right now.
import { preview, download } from './audio.js';
import { state, subscribe, padOf, deleteItem, clearPad } from './store.js';
import { CATEGORIES, catOf, openPadPicker, escapeHtml } from './launchpad.js';

const $ = (s) => document.querySelector(s);
let filter = 'all';

const safe = (s) => String(s).replace(/[^\w\-]+/g, '_').replace(/_+/g, '_').slice(0, 60);

function render() {
  const list = $('#libList');
  const items = state.items.filter((it) => filter === 'all' || it.category === filter);
  const total = state.items.length;
  $('#libCount').textContent = total ? `${total} sample${total > 1 ? 's' : ''}` : '';
  $('#libEmpty').hidden = total > 0;

  // filter row: only categories that exist in the library
  const used = Object.keys(CATEGORIES).filter((k) => state.items.some((it) => it.category === k));
  if (filter !== 'all' && !used.includes(filter)) filter = 'all';
  const fr = $('#libFilter');
  fr.hidden = used.length < 2;
  fr.innerHTML = '';
  for (const k of ['all', ...used]) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'filter';
    b.setAttribute('aria-pressed', filter === k);
    if (k !== 'all') b.style.setProperty('--pc', CATEGORIES[k].color);
    b.innerHTML = k === 'all' ? 'All' : `<i></i>${CATEGORIES[k].label}`;
    b.onclick = () => { filter = k; render(); };
    fr.appendChild(b);
  }

  list.innerHTML = '';
  for (const it of items) {
    const cat = catOf(it.category);
    const pad = padOf(it.id);
    const li = document.createElement('li');
    li.className = 'lib-row';
    li.style.setProperty('--pc', cat.color);
    const secs = (it.channels[0].length / it.sr).toFixed(2);
    li.innerHTML =
      `<button class="play small" aria-label="Play ${escapeHtml(it.name)}">▶</button>` +
      `<div class="lib-main">` +
        `<span class="lib-name">${escapeHtml(it.name)}</span>` +
        `<span class="lib-facts"><span class="lib-cat"><i></i>${cat.label}${it.loop && it.category !== 'loop' ? ', looped' : ''}</span>` +
        `<span>${secs} s</span>${it.song ? `<span class="lib-song">${escapeHtml(it.song)}</span>` : ''}</span>` +
      `</div>` +
      `<span class="lib-pad${pad >= 0 ? ' on' : ''}">${pad >= 0 ? `Pad ${pad + 1}` : 'No pad'}</span>` +
      `<span class="lib-actions"></span>`;
    li.querySelector('.play').onclick = (e) => preview(it.channels, it.sr, e.currentTarget);
    const acts = li.querySelector('.lib-actions');
    const btn = (label, cls, fn, title) => {
      const b = document.createElement('button');
      b.className = 'btn small ' + cls;
      b.textContent = label;
      if (title) b.title = title;
      b.onclick = fn;
      acts.appendChild(b);
      return b;
    };
    btn(pad >= 0 ? 'Move' : 'Put on pad', 'primary', () => openPadPicker({ item: it }));
    if (pad >= 0) btn('Take off pad', '', () => clearPad(pad));
    const base = `${safe(it.song || 'kick-extractor')}_${safe(it.name)}`;
    btn('WAV', '', () => download(it.channels, it.sr, base, 'wav'), 'Download WAV');
    btn('MP3', '', () => download(it.channels, it.sr, base, 'mp3'), 'Download MP3 (adds ~25 ms of silence at the start)');
    const del = btn('Delete', 'danger', () => {
      if (!del.classList.contains('confirm')) {
        del.classList.add('confirm');
        del.textContent = 'Sure?';
        setTimeout(() => { del.classList.remove('confirm'); del.textContent = 'Delete'; }, 2500);
        return;
      }
      deleteItem(it.id);
    });
    list.appendChild(li);
  }
}

export function initLibrary() {
  subscribe(render);
  render();
}
