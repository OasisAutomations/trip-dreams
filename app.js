/* Trip Dreams v1.0 — family trip planner. All data stays on this device (IndexedDB). No accounts, no analytics. */
'use strict';
(() => {
const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const STATUSES = ['dream', 'planning', 'booked', 'done'];
const COSTS = [['flights', '✈️ Flights'], ['stay', '🏨 Stay'], ['food', '🍽️ Food'], ['fun', '🎢 Fun'], ['other', '🧩 Other']];
const EMOJIS = ['🏝️', '🏖️', '🏔️', '🏕️', '🗽', '🎢', '🏰', '🌋', '🌴', '🗼', '🌉', '🚢', '✈️', '🚗', '🚂', '🐠', '🐳', '🦒', '🌸', '❄️', '🎄', '🌮', '🍕', '🎡', '⛺', '🌅', '🗺️', '🏟️', '🎆', '🧸'];
const KID_BASICS = ['Stroller or carrier', 'Car seat (or confirm rental has one)', 'Diapers, wipes & changing pad', 'Snacks & sippy cup', 'Favorite toy / lovey for naps', 'Kid meds, thermometer & first-aid', 'Sunscreen, hat & swim diapers', 'Pack-n-play or crib at the stay?', 'Plan around nap times', 'Tablet, headphones & quiet games for travel'];
const money = (n, cents) => (n < 0 ? '-' : '') + '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : 0 });
const money2 = n => money(n, Math.round(n * 100) % 100 !== 0);
const round2 = n => Math.round(n * 100) / 100;

/* ---------- dates & savings math (pure, exposed for testing) ---------- */
const DAY = 86400000;
const parseD = s => { if (!s) return null; const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const fmtISO = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const todayISO = () => fmtISO(new Date());
const daysBetween = (a, b) => Math.round((parseD(b) - parseD(a)) / DAY); // whole calendar days, DST-safe via round
const fmtDate = s => s ? parseD(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : 'No date yet';
const ceilCents = n => Math.ceil(round2(n * 100) - 1e-9) / 100;
/** Savings plan.
 *  weeks     = weekly deposits from today up to (not on) the target date = ceil(days/7)
 *  paychecks = biweekly paydays from today up to (not on) the target date: counted from the
 *              recent-payday anchor if one is set, otherwise ceil(days/14)
 *  per-amounts are rounded UP to the cent so the goal is always reached. */
function plan(goal, saved, target, today = todayISO(), payAnchor = '') {
  goal = Math.max(0, +goal || 0); saved = +saved || 0;
  const left = round2(Math.max(0, goal - saved));
  const pct = goal > 0 ? Math.min(1, Math.max(0, saved / goal)) : 0;
  const reached = goal > 0 && saved >= goal - 0.005;
  if (!target) return { goal, saved, left, pct, reached, days: null, weeks: null, paychecks: null, perWeek: null, perPaycheck: null };
  const days = daysBetween(today, target);
  if (days <= 0) return { goal, saved, left, pct, reached, days, weeks: 0, paychecks: 0, perWeek: left, perPaycheck: left, past: true };
  const weeks = Math.ceil(days / 7);
  let paychecks;
  if (payAnchor) {
    const off = daysBetween(payAnchor, today);                 // days since anchor
    const first = ((14 - (((off % 14) + 14) % 14)) % 14);     // days from today to next payday (0 = today)
    paychecks = first >= days ? 0 : Math.floor((days - 1 - first) / 14) + 1;
  } else paychecks = Math.ceil(days / 14);
  const perWeek = ceilCents(left / weeks);
  const perPaycheck = paychecks > 0 ? ceilCents(left / paychecks) : left;
  return { goal, saved, left, pct, reached, days, weeks, paychecks, perWeek, perPaycheck, noPayday: paychecks === 0 };
}
const total = t => round2(COSTS.reduce((s, [k]) => s + (+t.costs?.[k] || 0), 0));
const savedOf = t => round2((t.deposits || []).reduce((s, d) => s + (+d.amount || 0), 0));

/* ---------- IndexedDB ---------- */
let db;
const idb = () => new Promise((res, rej) => {
  const r = indexedDB.open('trip-dreams', 1);
  r.onupgradeneeded = () => { const d = r.result; d.createObjectStore('trips', { keyPath: 'id' }); d.createObjectStore('meta'); };
  r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
});
const tx = (store, mode, fn) => new Promise((res, rej) => { const t = db.transaction(store, mode); const s = t.objectStore(store); const out = fn(s); t.oncomplete = () => res(out && 'result' in out ? out.result : undefined); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); });
const dbAll = () => tx('trips', 'readonly', s => s.getAll());
const dbPut = t => tx('trips', 'readwrite', s => s.put(t));
const dbDel = id => tx('trips', 'readwrite', s => s.delete(id));
const metaGet = k => tx('meta', 'readonly', s => s.get(k));
const metaSet = (k, v) => tx('meta', 'readwrite', s => s.put(v, k));

/* ---------- state ---------- */
const S = { trips: [], settings: { family: ['Daniel', 'Jackie', 'Ava'], payday: '' }, view: 'home', filter: 'all', cur: null, pickFor: null };
const byDate = (a, b) => (a.date || '9999') < (b.date || '9999') ? -1 : (a.date || '9999') > (b.date || '9999') ? 1 : (a.name || '').localeCompare(b.name || '');
const sorted = () => [...S.trips].sort(byDate);
const getTrip = id => S.trips.find(t => t.id === id);
const planOf = t => plan(total(t), savedOf(t), t.date, todayISO(), S.settings.payday);

function newTrip(extra = {}) {
  return Object.assign({ id: uid(), created: Date.now(), name: '', place: '', lat: null, lng: null, emoji: '🏝️', date: '', status: 'dream',
    who: [...S.settings.family], costs: { flights: 0, stay: 0, food: 0, fun: 0, other: 0 }, deposits: [], checklist: [], notes: '', memory: '', celebrated: false, example: false }, extra);
}
function seedExample() {
  const d = new Date(); d.setMonth(d.getMonth() + 8); d.setDate(15);
  const ago = n => { const x = new Date(); x.setDate(x.getDate() - n); return fmtISO(x); };
  return newTrip({ name: 'Example: San Diego beach week', place: 'San Diego, California', lat: 32.7157, lng: -117.1611, emoji: '🏖️', date: fmtISO(d), status: 'planning', example: true,
    costs: { flights: 0, stay: 900, food: 400, fun: 300, other: 150 },
    deposits: [{ id: uid(), date: ago(21), amount: 100, note: 'Example deposit' }, { id: uid(), date: ago(7), amount: 75, note: 'Example deposit' }],
    checklist: KID_BASICS.slice(0, 5).map((t, i) => ({ id: uid(), text: t, done: i < 2 })),
    notes: 'This is a made-up example so you can see how a trip works. Delete it with the trash can at the top of this screen.\n\nIdeas: tide pools at La Jolla, the zoo, fish tacos.' });
}

let saveTimer = null; const pending = new Set();
function save(t, now) { pending.add(t.id); clearTimeout(saveTimer); const go = () => flush(); if (now) return go(); saveTimer = setTimeout(go, 250); flashSaved(); }
async function flush() { clearTimeout(saveTimer); const ids = [...pending]; pending.clear(); for (const id of ids) { const t = getTrip(id); if (t) await dbPut(t); } }
addEventListener('pagehide', () => { flush(); }); document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); });
function flashSaved() { const e = $('#savedTag'); e.textContent = 'Saving…'; clearTimeout(flashSaved.t); flashSaved.t = setTimeout(() => e.textContent = 'Saved on this device ✓', 400); }
function toast(msg, ms = 2600) { const e = $('#toast'); e.textContent = msg; e.classList.remove('hidden'); clearTimeout(toast.t); toast.t = setTimeout(() => e.classList.add('hidden'), ms); }

/* ---------- maps ---------- */
const TILE = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
const maps = {};
function makeMap(id, noteId) {
  if (typeof L === 'undefined') { $('#' + noteId).textContent = 'The map could not load. Your trips are all still here in the list.'; $('#' + noteId).classList.remove('hidden'); return null; }
  const m = L.map(id, { worldCopyJump: true, zoomControl: true, attributionControl: true }).setView([30, -40], 2);
  const layer = L.tileLayer(TILE, { attribution: ATTR, maxZoom: 19, crossOrigin: false });
  let bad = 0, good = 0;
  layer.on('tileerror', () => { bad++; if (bad >= 3 && good === 0) { const n = $('#' + noteId); n.textContent = '🛰️ Map pictures can\'t load right now (offline?). Pins and trips still work; the map fills in when you\'re back online.'; n.classList.remove('hidden'); } });
  layer.on('tileload', () => { good++; $('#' + noteId).classList.add('hidden'); });
  layer.addTo(m);
  const grp = L.layerGroup().addTo(m);
  maps[id] = { m, grp, fitted: false };
  return maps[id];
}
const statusColor = s => getComputedStyle(document.documentElement).getPropertyValue('--' + s).trim() || '#2fb7a6';
function pinIcon(t) { return L.divIcon({ className: '', html: `<div class="pin" style="background:${statusColor(t.status)}"><span>${esc(t.emoji || '📍')}</span></div>`, iconSize: [34, 34], iconAnchor: [17, 36], popupAnchor: [0, -34] }); }
function drawPins(id) {
  const M = maps[id]; if (!M) return; M.grp.clearLayers();
  const pts = [];
  for (const t of S.trips) {
    if (t.lat == null || t.lng == null) continue;
    pts.push([t.lat, t.lng]);
    const p = plan(total(t), savedOf(t), t.date, todayISO(), S.settings.payday);
    const mk = L.marker([t.lat, t.lng], { icon: pinIcon(t), title: t.name || t.place, riseOnHover: true }).addTo(M.grp);
    mk.bindPopup(`<div class="pop"><b>${esc(t.emoji)} ${esc(t.name || 'Untitled trip')}</b><br>${esc(t.place)}<br><span class="pill ${t.status}">${t.status}</span> ${esc(fmtDate(t.date))}<br>${total(t) ? Math.round(p.pct * 100) + '% saved' : ''}<br><button class="btn small" data-open="${t.id}">Open trip</button></div>`);
  }
  if (!M.fitted || id === 'mapHome') {
    if (pts.length === 1) M.m.setView(pts[0], 5); else if (pts.length > 1) M.m.fitBounds(pts, { padding: [40, 40], maxZoom: 6 });
    M.fitted = true;
  }
}
function legend() { return STATUSES.map(s => `<span><i style="background:var(--${s})"></i>${s}</span>`).join(''); }

/* ---------- geocoding (Nominatim; only the typed words are sent) ---------- */
async function geocode(q) {
  const ll = q.match(/^\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (ll) return [{ name: `${(+ll[1]).toFixed(4)}, ${(+ll[2]).toFixed(4)}`, full: 'Coordinates', lat: +ll[1], lng: +ll[2] }];
  const ctl = new AbortController(), to = setTimeout(() => ctl.abort(), 8000);
  try {
    const r = await fetch('https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&accept-language=en&q=' + encodeURIComponent(q), { signal: ctl.signal, headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    return j.map(x => ({ name: x.name || x.display_name.split(',')[0], full: x.display_name, lat: +x.lat, lng: +x.lon }));
  } finally { clearTimeout(to); }
}
async function reverse(lat, lng) {
  const ctl = new AbortController(), to = setTimeout(() => ctl.abort(), 6000);
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=10&accept-language=en&lat=${lat}&lon=${lng}`, { signal: ctl.signal });
    if (!r.ok) return null; const j = await r.json(); if (!j || j.error) return null;
    const a = j.address || {}; const city = a.city || a.town || a.village || a.county || j.name; const region = a.state || a.country;
    return [city, region].filter(Boolean).join(', ') || j.display_name;
  } catch { return null; } finally { clearTimeout(to); }
}
const coordName = (lat, lng) => `${lat.toFixed(3)}, ${lng.toFixed(3)}`;
async function runSearch(q, box, onPick) {
  q = q.trim(); if (!q) return;
  box.classList.remove('hidden'); box.innerHTML = '<div class="msg">Searching…</div>';
  try {
    const res = await geocode(q);
    if (!res.length) { box.innerHTML = '<div class="msg">No places found. Try a city or landmark name, or tap the map to drop a pin.</div>'; return; }
    box.innerHTML = res.map((r, i) => `<button type="button" data-i="${i}"><b>${esc(r.name)}</b><br><small class="muted">${esc(r.full)}</small></button>`).join('');
    box.querySelectorAll('button').forEach(b => b.onclick = () => { box.classList.add('hidden'); onPick(res[+b.dataset.i]); });
  } catch (e) {
    box.innerHTML = '<div class="msg">Place search isn\'t reachable right now. You can tap the map to drop a pin, or type coordinates like <b>20.8, -156.3</b>.</div>';
  }
}

/* ---------- rendering ---------- */
function tripRow(t) {
  const p = planOf(t), tot = total(t);
  const when = t.date ? (t.status === 'done' ? fmtDate(t.date) : (p.days > 0 ? `${fmtDate(t.date)} · in ${p.days} day${p.days === 1 ? '' : 's'}` : `${fmtDate(t.date)}`)) : 'No date yet';
  return `<button class="trip-row" data-open="${t.id}"><span class="em">${esc(t.emoji)}</span><span class="mid"><span class="nm">${esc(t.name || 'Untitled trip')}${t.example ? '<span class="ex">EXAMPLE</span>' : ''}</span>
  <span class="sub" style="display:block">${esc(t.place || 'No place yet')} · ${esc(when)}</span>
  <span class="sub" style="display:block">${tot ? `${money(p.saved)} of ${money(tot)} saved` : 'No cost estimate yet'}</span>
  ${tot ? `<span class="bar"><i style="width:${Math.round(p.pct * 100)}%"></i></span>` : ''}</span><span class="pill ${t.status}">${t.status}</span></button>`;
}
function renderHome() {
  const list = sorted();
  const upcoming = list.filter(t => t.status !== 'done' && t.date && daysBetween(todayISO(), t.date) >= 0);
  const nx = upcoming[0];
  const h = $('#nextAdv');
  if (nx) {
    const d = daysBetween(todayISO(), nx.date), p = planOf(nx);
    h.dataset.open = nx.id;
    h.innerHTML = `<div class="em">${esc(nx.emoji)}</div><div class="k">Next adventure</div><div class="t">${esc(nx.name || 'Untitled trip')}</div><div>${esc(nx.place || '')}${nx.place ? ' · ' : ''}${esc(fmtDate(nx.date))}</div>
    <div class="cd"><div><b>${d}</b><span>${d === 1 ? 'day' : 'days'} to go</span></div><div><b>${Math.floor(d / 7)}</b><span>weeks</span></div>${total(nx) ? `<div><b>${Math.round(p.pct * 100)}%</b><span>saved</span></div>` : ''}</div>`;
  } else {
    delete h.dataset.open;
    h.innerHTML = `<div class="em">🌍</div><div class="k">Next adventure</div><div class="t">Where to next?</div><div>Add a trip with a date to start the countdown.</div>`;
  }
  const saved = round2(S.trips.reduce((s, t) => s + savedOf(t), 0));
  const left = round2(S.trips.filter(t => t.status !== 'done').reduce((s, t) => s + planOf(t).left, 0));
  $('#stSaved').textContent = money2(saved); $('#stLeft').textContent = money2(left); $('#stCount').textContent = S.trips.length;
  $('#listHome').innerHTML = list.length ? list.map(tripRow).join('') : '<div class="empty">No trips yet. Tap <b>＋ New trip</b> or tap the map.</div>';
  $('#legendHome').innerHTML = legend();
  if (!maps.mapHome) makeMap('mapHome', 'noteHome');
  if (maps.mapHome) { maps.mapHome.m.invalidateSize(); drawPins('mapHome'); }
}
function renderTrips() {
  $('#filters').innerHTML = ['all', ...STATUSES].map(s => `<button data-f="${s}" class="${S.filter === s ? 'on' : ''}">${s === 'all' ? 'All' : s[0].toUpperCase() + s.slice(1)} (${s === 'all' ? S.trips.length : S.trips.filter(t => t.status === s).length})</button>`).join('');
  const list = sorted().filter(t => S.filter === 'all' || t.status === S.filter);
  $('#listTrips').innerHTML = list.length ? list.map(tripRow).join('') : '<div class="empty">Nothing here yet.</div>';
}
function renderMap() {
  if (!maps.mapBig) { const M = makeMap('mapBig', 'noteBig'); if (M) M.m.on('click', onMapTap); }
  if (maps.mapBig) { setTimeout(() => maps.mapBig.m.invalidateSize(), 0); drawPins('mapBig'); }
  $('#pickBanner').classList.toggle('hidden', !S.pickFor);
}
function renderMem() {
  const done = S.trips.filter(t => t.status === 'done').sort((a, b) => byDate(b, a));
  $('#memWall').innerHTML = done.length ? done.map(t => `<div class="mem" data-open="${t.id}"><div class="art">${esc(t.emoji)}</div><h3>${esc(t.name || 'Untitled trip')}</h3>
  <div class="when">${esc(t.place || '')}${t.place ? ' · ' : ''}${esc(fmtDate(t.date))}</div>${t.memory ? `<p>“${esc(t.memory)}”</p>` : ''}${t.notes ? `<p>${esc(t.notes.length > 220 ? t.notes.slice(0, 220) + '…' : t.notes)}</p>` : ''}
  ${t.who?.length ? `<div class="who">With ${esc(t.who.join(', '))}</div>` : ''}</div>`).join('') : '<div class="empty">No finished trips yet. When you get home from one, set its status to <b>Done</b> and it’ll be pinned here. ✨</div>';
}
function render() {
  ({ home: renderHome, trips: renderTrips, map: renderMap, mem: renderMem })[S.view]();
}
function show(v) {
  S.view = v; $$('.view').forEach(e => e.classList.toggle('hidden', e.id !== 'v-' + v)); $$('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.v === v));
  render(); scrollTo(0, 0);
}

/* ---------- trip sheet ---------- */
function ring(p) {
  const R = 52, C = 2 * Math.PI * R, pct = p.pct;
  return `<svg viewBox="0 0 130 130" role="img" aria-label="${Math.round(pct * 100)} percent saved"><defs><linearGradient id="rg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2fb7a6"/><stop offset="1" stop-color="#f6c453"/></linearGradient></defs>
  <circle cx="65" cy="65" r="${R}" fill="none" stroke="#2a3a49" stroke-width="13"/><circle cx="65" cy="65" r="${R}" fill="none" stroke="${p.reached ? '#ff8a5b' : 'url(#rg)'}" stroke-width="13" stroke-linecap="round" stroke-dasharray="${(C * pct).toFixed(2)} ${C.toFixed(2)}" transform="rotate(-90 65 65)"/>
  <text x="65" y="63" text-anchor="middle" fill="#eef3f5" font-size="26" font-weight="800" font-family="system-ui">${Math.floor(pct * 100)}%</text><text x="65" y="84" text-anchor="middle" fill="#9fb0bc" font-size="12" font-family="system-ui">${p.reached ? 'goal hit! 🎉' : 'saved'}</text></svg>`;
}
function renderPlan(t) {
  const p = planOf(t); $('#ringBox').innerHTML = ring(p);
  let h = `<div class="line"><span>Saved</span><b id="pSaved">${money2(p.saved)}</b></div><div class="line"><span>Goal (total cost)</span><b>${money2(p.goal)}</b></div><div class="line"><span>Left to save</span><b id="pLeft">${money2(p.left)}</b></div>`;
  if (!p.goal) h += `<p class="tiny">Add estimated costs above to set the goal.</p>`;
  else if (p.reached) h += `<p class="goal-hit">You did it! The trip is fully saved. 🎉</p>`;
  else if (p.days == null) h += `<p class="tiny">Set a target date to see how much to save each week.</p>`;
  else if (p.past) h += `<p class="tiny">The target date is here. ${money2(p.left)} still to cover, or move the date.</p>`;
  else h += `<div class="line"><span>Per week <small class="muted">(${p.weeks} wk)</small></span><b id="pWeek">${money(p.perWeek, true)}</b></div>
    <div class="line"><span>Per paycheck <small class="muted">(${p.paychecks} biweekly)</small></span><b id="pPay">${p.noPayday ? 'no payday before trip' : money(p.perPaycheck, true)}</b></div>`;
  $('#tPlan').innerHTML = h;
  return p;
}
function renderDeps(t) {
  const deps = [...t.deposits].sort((a, b) => a.date < b.date ? 1 : -1);
  $('#tDeps').innerHTML = deps.map(d => `<div class="dep-row"><span class="amt ${d.amount < 0 ? 'neg' : ''}">${money(d.amount, true)}</span><span class="d">${esc(fmtDate(d.date))}${d.note ? ' · ' + esc(d.note) : ''}</span><button data-deldep="${d.id}" aria-label="Remove deposit">✕</button></div>`).join('') || '<p class="tiny">No deposits yet.</p>';
}
function renderCheck(t) {
  $('#tCheck').innerHTML = t.checklist.map(c => `<label class="ck-row ${c.done ? 'done' : ''}"><input type="checkbox" data-ck="${c.id}" ${c.done ? 'checked' : ''}><span>${esc(c.text)}</span><button class="x" type="button" data-delck="${c.id}" aria-label="Remove item">✕</button></label>`).join('') || '<p class="tiny">Nothing on the list yet. Tap “＋ Toddler basics” for a starter list.</p>';
}
function renderWho(t) {
  const names = [...new Set([...S.settings.family, ...t.who])];
  $('#tWho').innerHTML = names.map(n => `<span class="chip ${t.who.includes(n) ? 'on' : ''}" data-who="${esc(n)}" role="checkbox" aria-checked="${t.who.includes(n)}" tabindex="0">${t.who.includes(n) ? '✓ ' : ''}${esc(n)}${S.settings.family.includes(n) ? '' : `<button class="x" data-unwho="${esc(n)}" aria-label="Remove ${esc(n)}">✕</button>`}</span>`).join('');
}
function renderSheetHeader(t) {
  $('#tEmojiBtn').textContent = t.emoji; $('#tPlace').textContent = t.place ? '📍 ' + t.place : 'No place yet'; $('#tPlace').classList.toggle('muted', !t.place);
  $('#tStatus').innerHTML = STATUSES.map(s => `<button type="button" data-st="${s}" class="${s} ${t.status === s ? 'on' : ''}">${s}</button>`).join('');
  $('#memSec').classList.toggle('hidden', t.status !== 'done');
  $('#exampleTag').classList.toggle('hidden', !t.example);
}
function openTrip(id) {
  const t = getTrip(id); if (!t) return; S.cur = t;
  $('#tName').value = t.name; $('#tDate').value = t.date; $('#tNotes').value = t.notes; $('#tMemory').value = t.memory || '';
  $('#tCosts').innerHTML = COSTS.map(([k, l]) => `<div><label for="c-${k}">${l}</label><div class="in"><input id="c-${k}" data-cost="${k}" type="number" inputmode="decimal" min="0" step="1" value="${+t.costs[k] || ''}" placeholder="0"></div></div>`).join('');
  $('#tTotal').textContent = money2(total(t));
  $('#depDate').value = todayISO(); $('#depAmt').value = ''; $('#depNote').value = '';
  $('#emojiGrid').classList.add('hidden'); $('#placeResults').classList.add('hidden'); $('#placeQ').value = '';
  $('#savedTag').textContent = 'Saved on this device ✓';
  renderSheetHeader(t); renderWho(t); renderPlan(t); renderDeps(t); renderCheck(t);
  $('#sheetWrap').classList.remove('hidden'); $('#sheet').scrollTop = 0; document.body.style.overflow = 'hidden';
}
async function closeTrip() {
  const t = S.cur; S.cur = null; $('#sheetWrap').classList.add('hidden'); document.body.style.overflow = '';
  if (t && !t.name.trim() && !t.place && !t.date && !total(t) && !t.deposits.length && !t.notes.trim() && !t.checklist.length) { await dbDel(t.id); S.trips = S.trips.filter(x => x !== t); }
  await flush(); render();
}
async function createTrip(extra) { const t = newTrip(extra); S.trips.push(t); await dbPut(t); openTrip(t.id); return t; }
function setPlace(t, name, lat, lng) {
  t.place = name; t.lat = lat; t.lng = lng; if (!t.name.trim()) { t.name = name.split(',')[0]; $('#tName').value = t.name; }
  save(t); renderSheetHeader(t);
}
function edited(t) { save(t); renderPlan(t); }
function checkCelebrate(t, before) {
  const p = planOf(t);
  if (p.reached && !before.reached && !t.celebrated) { t.celebrated = true; save(t, true); confetti(); toast(`🎉 ${t.name || 'Trip'} is fully saved!`, 3500); }
  if (!p.reached && t.celebrated) { t.celebrated = false; save(t); }
}

/* ---------- confetti ---------- */
function confetti() {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const c = $('#confetti'), x = c.getContext('2d'), dpr = devicePixelRatio || 1;
  c.width = innerWidth * dpr; c.height = innerHeight * dpr; x.scale(dpr, dpr);
  const cols = ['#ff8a5b', '#f6c453', '#2fb7a6', '#a991f7', '#f27b8c', '#ffffff'];
  const P = Array.from({ length: 160 }, () => ({ x: innerWidth / 2 + (Math.random() - .5) * 80, y: innerHeight * .45, vx: (Math.random() - .5) * 14, vy: -Math.random() * 15 - 5, r: Math.random() * 6 + 4, a: Math.random() * 6, va: (Math.random() - .5) * .4, c: cols[Math.random() * cols.length | 0] }));
  window.__confettiRuns = (window.__confettiRuns || 0) + 1;
  const t0 = performance.now();
  (function f(now) {
    x.clearRect(0, 0, innerWidth, innerHeight);
    for (const p of P) { p.vy += .35; p.vx *= .99; p.x += p.vx; p.y += p.vy; p.a += p.va; x.save(); x.translate(p.x, p.y); x.rotate(p.a); x.fillStyle = p.c; x.fillRect(-p.r / 2, -p.r / 4, p.r, p.r / 2); x.restore(); }
    if (now - t0 < 3200) requestAnimationFrame(f); else x.clearRect(0, 0, innerWidth, innerHeight);
  })(t0);
}

/* ---------- map tap / pick ---------- */
async function onMapTap(e) {
  const { lat, lng } = e.latlng.wrap();
  if (S.pickFor) {
    const t = getTrip(S.pickFor); S.pickFor = null; $('#pickBanner').classList.add('hidden');
    if (!t) return;
    openTrip(t.id); setPlace(t, coordName(lat, lng), lat, lng); drawPins('mapBig');
    const nm = await reverse(lat, lng); if (nm && t.lat === lat) { const wasAuto = t.name === coordName(lat, lng).split(',')[0]; t.place = nm; if (wasAuto) { t.name = nm.split(',')[0]; if (S.cur === t) $('#tName').value = t.name; } save(t); if (S.cur === t) renderSheetHeader(t); }
    return;
  }
  const pop = L.popup().setLatLng([lat, lng]).setContent(`<div class="pop"><b>📍 ${coordName(lat, lng)}</b><br><span id="revName" class="muted">Looking up place…</span><br><button class="btn small" id="newHere">＋ New trip here</button></div>`).openOn(maps.mapBig.m);
  let name = coordName(lat, lng);
  const bind = () => { const b = document.getElementById('newHere'); if (b) b.onclick = () => { maps.mapBig.m.closePopup(); createTrip({ place: name, lat, lng, name: name.includes(',') && !/^-?\d/.test(name) ? name.split(',')[0] : '' }); }; };
  bind();
  const nm = await reverse(lat, lng); const s = document.getElementById('revName');
  if (nm) name = nm; if (s) s.textContent = nm || 'Place name unavailable (offline?)';
}

/* ---------- backup ---------- */
async function backup() {
  await flush();
  const data = { app: 'trip-dreams', version: 1, exported: new Date().toISOString(), settings: S.settings, trips: S.trips };
  const blob = new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `trip-dreams-backup-${todayISO()}.json`; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  $('#bkMsg').textContent = `Saved ${S.trips.length} trip${S.trips.length === 1 ? '' : 's'} to your downloads.`;
}
async function restore(file) {
  try {
    const j = JSON.parse(await file.text());
    if (j.app !== 'trip-dreams' || !Array.isArray(j.trips)) throw new Error('not a Trip Dreams backup');
    if (!confirm(`Replace the ${S.trips.length} trip(s) on this device with the ${j.trips.length} trip(s) in this backup?`)) return;
    const clean = j.trips.filter(t => t && t.id).map(t => Object.assign(newTrip(), t, { costs: Object.assign({ flights: 0, stay: 0, food: 0, fun: 0, other: 0 }, t.costs || {}), deposits: Array.isArray(t.deposits) ? t.deposits : [], checklist: Array.isArray(t.checklist) ? t.checklist : [], who: Array.isArray(t.who) ? t.who : [] }));
    await tx('trips', 'readwrite', s => { s.clear(); clean.forEach(t => s.put(t)); });
    S.trips = clean;
    if (j.settings) { S.settings = Object.assign(S.settings, j.settings); await metaSet('settings', S.settings); fillSettings(); }
    $('#bkMsg').textContent = `Restored ${clean.length} trip${clean.length === 1 ? '' : 's'}.`; render(); toast('Backup restored ✓');
  } catch (e) { $('#bkMsg').textContent = 'That file couldn\'t be restored: ' + e.message; }
}
function fillSettings() { $('#sFamily').value = S.settings.family.join(', '); $('#sPayday').value = S.settings.payday || ''; }

/* ---------- events ---------- */
function wire() {
  document.addEventListener('click', e => {
    const o = e.target.closest('[data-open]'); if (o && !e.target.closest('#sheet')) { if (maps.mapBig) maps.mapBig.m.closePopup(); if (maps.mapHome) maps.mapHome.m.closePopup(); openTrip(o.dataset.open); return; }
    if (e.target.closest('[data-new]')) { createTrip(); return; }
    const f = e.target.closest('[data-f]'); if (f) { S.filter = f.dataset.f; renderTrips(); }
  });
  $('#tabs').onclick = e => { const b = e.target.closest('button'); if (b) { S.pickFor = null; show(b.dataset.v); } };
  $('#sheetClose').onclick = closeTrip;
  $('#sheetWrap').addEventListener('click', e => { if (e.target.id === 'sheetWrap') closeTrip(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') { if (!$('#sheetWrap').classList.contains('hidden')) closeTrip(); else if (!$('#setWrap').classList.contains('hidden')) closeSettings(); } });
  $('#tripDelete').onclick = async () => {
    const t = S.cur; if (!t) return;
    if (!confirm(`Delete “${t.name || 'this trip'}”? This can't be undone (unless you have a backup).`)) return;
    pending.delete(t.id); await dbDel(t.id); S.trips = S.trips.filter(x => x !== t); S.cur = null;
    $('#sheetWrap').classList.add('hidden'); document.body.style.overflow = ''; render(); toast('Trip deleted');
  };
  $('#tName').oninput = e => { S.cur.name = e.target.value; save(S.cur); };
  $('#tDate').onchange = e => { S.cur.date = e.target.value; edited(S.cur); };
  $('#tNotes').oninput = e => { S.cur.notes = e.target.value; save(S.cur); };
  $('#tMemory').oninput = e => { S.cur.memory = e.target.value; save(S.cur); };
  $('#tEmojiBtn').onclick = () => { const g = $('#emojiGrid'); g.innerHTML = EMOJIS.map(x => `<button type="button" data-em="${x}">${x}</button>`).join(''); g.classList.toggle('hidden'); };
  $('#emojiGrid').onclick = e => { const b = e.target.closest('[data-em]'); if (!b) return; S.cur.emoji = b.dataset.em; save(S.cur); renderSheetHeader(S.cur); $('#emojiGrid').classList.add('hidden'); };
  $('#tStatus').onclick = e => { const b = e.target.closest('[data-st]'); if (!b) return; S.cur.status = b.dataset.st; save(S.cur); renderSheetHeader(S.cur); if (b.dataset.st === 'done') toast('Pinned to your memory wall 📸'); };
  $('#tCosts').oninput = e => { const k = e.target.dataset.cost; if (!k) return; const before = planOf(S.cur); S.cur.costs[k] = Math.max(0, +e.target.value || 0); $('#tTotal').textContent = money2(total(S.cur)); edited(S.cur); checkCelebrate(S.cur, before); };
  $('#tWho').onclick = e => {
    const x = e.target.closest('[data-unwho]'); if (x) { S.cur.who = S.cur.who.filter(n => n !== x.dataset.unwho); save(S.cur); renderWho(S.cur); return; }
    const c = e.target.closest('[data-who]'); if (!c) return; const n = c.dataset.who;
    S.cur.who = S.cur.who.includes(n) ? S.cur.who.filter(v => v !== n) : [...S.cur.who, n]; save(S.cur); renderWho(S.cur);
  };
  $('#tWho').onkeydown = e => { if ((e.key === ' ' || e.key === 'Enter') && e.target.dataset.who) { e.preventDefault(); e.target.click(); } };
  $('#whoAdd').onsubmit = e => { e.preventDefault(); const n = $('#whoNew').value.trim(); if (!n) return; if (!S.cur.who.includes(n)) S.cur.who.push(n); $('#whoNew').value = ''; save(S.cur); renderWho(S.cur); };
  $('#depAdd').onsubmit = e => {
    e.preventDefault(); const amt = round2(+$('#depAmt').value);
    if (!amt) { toast('Enter an amount first'); return; }
    const before = planOf(S.cur);
    S.cur.deposits.push({ id: uid(), date: $('#depDate').value || todayISO(), amount: amt, note: $('#depNote').value.trim() });
    $('#depAmt').value = ''; $('#depNote').value = ''; save(S.cur, true); renderPlan(S.cur); renderDeps(S.cur); checkCelebrate(S.cur, before);
  };
  $('#tDeps').onclick = e => { const b = e.target.closest('[data-deldep]'); if (!b) return; S.cur.deposits = S.cur.deposits.filter(d => d.id !== b.dataset.deldep); save(S.cur); renderPlan(S.cur); renderDeps(S.cur); checkCelebrate(S.cur, planOf(S.cur)); };
  $('#tCheck').onchange = e => { const id = e.target.dataset.ck; if (!id) return; const c = S.cur.checklist.find(x => x.id === id); c.done = e.target.checked; save(S.cur); renderCheck(S.cur); };
  $('#tCheck').onclick = e => { const b = e.target.closest('[data-delck]'); if (!b) return; e.preventDefault(); S.cur.checklist = S.cur.checklist.filter(c => c.id !== b.dataset.delck); save(S.cur); renderCheck(S.cur); };
  $('#ckAdd').onsubmit = e => { e.preventDefault(); const v = $('#ckNew').value.trim(); if (!v) return; S.cur.checklist.push({ id: uid(), text: v, done: false }); $('#ckNew').value = ''; save(S.cur); renderCheck(S.cur); };
  $('#ckDefaults').onclick = () => { const have = new Set(S.cur.checklist.map(c => c.text)); let n = 0; for (const k of KID_BASICS) if (!have.has(k)) { S.cur.checklist.push({ id: uid(), text: k, done: false }); n++; } save(S.cur); renderCheck(S.cur); toast(n ? `Added ${n} toddler basics` : 'Already on your list'); };
  $('#placeSearch').onsubmit = e => { e.preventDefault(); const t = S.cur; runSearch($('#placeQ').value, $('#placeResults'), async r => {
    const isCoord = r.full === 'Coordinates'; setPlace(t, isCoord ? r.name : r.full.split(',').slice(0, 2).join(',').trim(), r.lat, r.lng); $('#placeQ').value = '';
    if (isCoord) { const nm = await reverse(r.lat, r.lng); if (nm && t.place === r.name) { if (t.name === r.name.split(',')[0]) { t.name = nm.split(',')[0]; if (S.cur === t) $('#tName').value = t.name; } t.place = nm; save(t); if (S.cur === t) renderSheetHeader(t); } }
  }); };
  $('#pickOnMap').onclick = () => { S.pickFor = S.cur.id; flush(); S.cur = null; $('#sheetWrap').classList.add('hidden'); document.body.style.overflow = ''; show('map'); };
  $('#pickCancel').onclick = () => { const id = S.pickFor; S.pickFor = null; $('#pickBanner').classList.add('hidden'); if (id) openTrip(id); };
  $('#mapSearch').onsubmit = e => { e.preventDefault(); runSearch($('#mapQ').value, $('#mapResults'), r => {
    if (!maps.mapBig) return; maps.mapBig.m.setView([r.lat, r.lng], 9);
    const nm = r.full && r.full !== 'Coordinates' ? r.full.split(',').slice(0, 2).join(',').trim() : r.name;
    if (S.pickFor) { const t = getTrip(S.pickFor); S.pickFor = null; $('#pickBanner').classList.add('hidden'); openTrip(t.id); setPlace(t, nm, r.lat, r.lng); return; }
    L.popup().setLatLng([r.lat, r.lng]).setContent(`<div class="pop"><b>📍 ${esc(nm)}</b><br><button class="btn small" id="newHere2">＋ New trip here</button></div>`).openOn(maps.mapBig.m);
    document.getElementById('newHere2').onclick = () => { maps.mapBig.m.closePopup(); createTrip({ place: nm, lat: r.lat, lng: r.lng, name: nm.split(',')[0] }); };
  }); };
  $('#btnSettings').onclick = () => { fillSettings(); $('#bkMsg').textContent = ''; $('#setWrap').classList.remove('hidden'); };
  $('#setClose').onclick = closeSettings; $('#setWrap').addEventListener('click', e => { if (e.target.id === 'setWrap') closeSettings(); });
  $('#sFamily').onchange = async e => { const f = e.target.value.split(',').map(s => s.trim()).filter(Boolean); S.settings.family = f.length ? [...new Set(f)] : ['Daniel', 'Jackie', 'Ava']; await metaSet('settings', S.settings); };
  $('#sPayday').onchange = async e => { S.settings.payday = e.target.value; await metaSet('settings', S.settings); };
  $('#bkSave').onclick = backup;
  $('#bkLoad').onchange = e => { const f = e.target.files[0]; e.target.value = ''; if (f) restore(f); };
}
function closeSettings() { $('#setWrap').classList.add('hidden'); render(); }

/* ---------- boot ---------- */
async function boot() {
  wire();
  try { db = await idb(); } catch (e) { toast('Storage is blocked in this browser, so trips won\'t be saved.', 6000); throw e; }
  const st = await metaGet('settings'); if (st) S.settings = Object.assign(S.settings, st);
  S.trips = await dbAll();
  if (!(await metaGet('seeded'))) { if (!S.trips.length) { const ex = seedExample(); S.trips.push(ex); await dbPut(ex); } await metaSet('seeded', true); }
  if (navigator.storage?.persist) navigator.storage.persist().catch(() => { });
  show('home');
  window.TD.ready = true;
}
window.TD = { plan, total, savedOf, daysBetween, S, flush, ready: false, todayISO };
boot();

if (/^https?:$/.test(location.protocol) && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(reg => { reg.update().catch(() => { }); document.addEventListener('visibilitychange', () => { if (!document.hidden) reg.update().catch(() => { }); }); }).catch(() => { });
  let reloaded = false; const hadCtrl = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (!hadCtrl || reloaded || S.cur) return; reloaded = true; flush().then(() => location.reload()); });
}
})();
