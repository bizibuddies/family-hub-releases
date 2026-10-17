// Family Hub · phone page for the kids' tasks. Reads and writes the same
// Firestore data the Family Hub screen syncs with, so changes show up there
// within a second or two (and the kids' check-offs show up here).
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import { getAuth, GoogleAuthProvider, signInWithPopup, onAuthStateChanged, signOut } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import { getFirestore, collection, doc, onSnapshot, setDoc, deleteDoc, deleteField } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';
import { firebaseConfig } from './config.js';

const EMOJIS = ['🪥', '🛏️', '👕', '🎒', '📚', '✏️', '🎹', '🎻', '⚽', '🏊', '🧹', '🧺', '🍽️', '🐶', '🐱', '🌱', '🗑️', '🚿', '🦷', '💊',
  '🥣', '🍎', '💧', '📖', '🧮', '🔬', '🎨', '🧩', '💻', '📝', '🏃', '🚲', '🧘', '😴', '🙏', '💌', '🛁', '🧦', '⭐', '🎯'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const $app = document.getElementById('app');

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const uid = () => Math.random().toString(36).slice(2, 10);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Same rules as the Family Hub screen.
function appliesOn(t, date) {
  const r = t.repeat || { type: 'daily' }; const dow = date.getDay();
  switch (r.type) {
    case 'once': return r.date === ymd(date);
    case 'weekdays': return dow >= 1 && dow <= 5;
    case 'weekends': return dow === 0 || dow === 6;
    case 'days': return (r.days || []).includes(dow);
    default: return true;
  }
}
// Time goal: set on the task, or read from its name ("Read for 20 minutes").
function requiredMinutes(t) {
  if (t.minutes != null) return Number(t.minutes) || 0;
  const m = /(\d+)\s*(?:m|min|mins|minute|minutes)\b/i.exec(t.title || '');
  if (m) return Number(m[1]);
  const hr = /(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hour|hours)\b/i.exec(t.title || '');
  return hr ? Math.round(Number(hr[1]) * 60) : 0;
}
const timerMs = (tm) => (tm?.ms || 0) + (tm?.since ? Math.max(0, Date.now() - tm.since) : 0);
const mins = (ms) => Math.floor(ms / 60000);

function repeatLabel(r) {
  switch (r?.type) {
    case 'once': return 'Just this day';
    case 'weekdays': return 'School days';
    case 'weekends': return 'Weekends';
    case 'days': return (r.days || []).map((d) => DAYS[d]).join(', ');
    default: return 'Every day';
  }
}

let toastTimer;
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.className = 'show';
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.className = ''; }, 2600);
}

const state = { user: null, kids: [], tasks: [], done: {}, timers: {}, date: new Date(), unsubs: [], unsubDone: null, unsubTimers: null, denied: false };

function friendlyError(e) {
  if (e?.code === 'permission-denied') return 'denied';
  return e?.message || String(e);
}

// ---------- sign in ----------
function renderSignIn(msg = '') {
  $app.innerHTML = `<div class="center"><div class="box">
    <div style="font-size:3rem">✅</div>
    <h1 style="margin:.2em 0">Kids' Tasks</h1>
    <p class="muted">See and add Amelia and Claire's tasks on the Family Hub screen.</p>
    ${msg ? `<p style="color:var(--danger)">${esc(msg)}</p>` : ''}
    <button class="big" id="signin">Sign in with Google</button>
  </div></div>`;
  document.getElementById('signin').onclick = async () => {
    try { await signInWithPopup(auth, new GoogleAuthProvider()); } catch (e) {
      if (e.code !== 'auth/popup-closed-by-user') renderSignIn(e.code === 'auth/popup-blocked' ? 'Your browser blocked the sign-in window. Allow pop-ups for this site, or open this page in Safari.' : (e.message || String(e)));
    }
  };
}

function renderDenied() {
  $app.innerHTML = `<div class="center"><div class="box">
    <div style="font-size:3rem">🔒</div>
    <h1 style="margin:.2em 0">Not allowed yet</h1>
    <p class="muted">${esc(state.user?.email)} isn't on the list. On the Family Hub screen, open Settings → Phone access to tasks and add it under "Google accounts allowed".</p>
    <button class="big" id="out">Use a different account</button>
  </div></div>`;
  document.getElementById('out').onclick = () => signOut(auth);
}

// ---------- live data ----------
function stopListening() {
  for (const u of state.unsubs) u();
  state.unsubs = [];
  if (state.unsubDone) { state.unsubDone(); state.unsubDone = null; }
  if (state.unsubTimers) { state.unsubTimers(); state.unsubTimers = null; }
}

function onErr(e) {
  if (friendlyError(e) === 'denied') { state.denied = true; stopListening(); renderDenied(); } else toast(friendlyError(e));
}

function listen() {
  stopListening();
  state.denied = false;
  state.unsubs.push(onSnapshot(doc(db, 'meta/kids'), (s) => { state.kids = s.data()?.kids || []; render(); }, onErr));
  state.unsubs.push(onSnapshot(collection(db, 'tasks'), (s) => { state.tasks = s.docs.map((d) => ({ ...d.data(), id: d.id })); render(); }, onErr));
  listenDone();
}

function listenDone() {
  if (state.unsubDone) state.unsubDone();
  const key = ymd(state.date);
  state.unsubDone = onSnapshot(doc(db, `done/${key}`), (s) => { state.done = { [key]: s.data() || {} }; render(); }, onErr);
  if (state.unsubTimers) state.unsubTimers();
  // Timer progress is extra: if it can't be read (older Family Hub version), just leave it out.
  state.unsubTimers = onSnapshot(doc(db, `timers/${key}`), (s) => { state.timers = { [key]: s.data() || {} }; render(); }, () => { state.timers = {}; });
}

// Keep running timers' minutes fresh.
setInterval(() => { if (Object.values(state.timers).some((m) => Object.values(m).some((tm) => tm?.since))) render(); }, 20000);

function timerLabel(t, key, isDone) {
  const need = requiredMinutes(t);
  if (!need) return '';
  const tm = state.timers[key]?.[t.id];
  const ms = timerMs(tm);
  if (isDone) return ms ? ` · ⏱ Did ${mins(ms)} min` : ` · ⏱ ${need} min`;
  return ` · ⏱ ${mins(ms)} of ${need} min${tm?.since ? ' (running)' : ''}`;
}

// ---------- main view ----------
function render() {
  if (state.denied || !state.user) return;
  const key = ymd(state.date);
  const today = ymd(new Date()) === key;
  const done = state.done[key] || {};
  const heading = today ? 'Today' : state.date.toLocaleDateString([], { weekday: 'long' });
  const sub = state.date.toLocaleDateString([], { weekday: today ? 'long' : undefined, month: 'long', day: 'numeric' });
  const kidsHtml = state.kids.map((k) => {
    const list = state.tasks.filter((t) => t.kidId === k.id && appliesOn(t, state.date)).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    const n = list.filter((t) => done[t.id]).length;
    return `<section class="kid" style="--kc:${esc(k.color)}">
      <div class="kid-head"><span class="em">${esc(k.emoji)}</span><span class="nm">${esc(k.name)}</span><span class="ct">${n}/${list.length}</span></div>
      ${list.length ? list.map((t) => `<div class="task ${done[t.id] ? 'done' : ''} ${t.byKid ? 'mine' : ''}">
          <button class="tap" data-toggle="${esc(t.id)}"><span class="em">${esc(t.emoji || '⭐')}</span>
            <span class="tt">${esc(t.title)}<small>${esc(repeatLabel(t.repeat))}${esc(timerLabel(t, key, !!done[t.id]))}</small></span>
            <span class="chk">${done[t.id] ? '✓' : ''}</span></button>
          <button class="edit" data-edit="${esc(t.id)}" aria-label="Edit">✎</button>
        </div>`).join('') : '<div class="empty">No tasks on this day.</div>'}
      <button class="add" data-add="${esc(k.id)}">＋ Add task for ${esc(k.name)}</button>
    </section>`;
  }).join('');
  $app.innerHTML = `<header>
      <div class="grow"><h1>${esc(heading)}</h1><small>${esc(sub)}</small></div>
      <button class="nav" id="prev" aria-label="Previous day">‹</button>
      <button class="pill" id="today">Today</button>
      <button class="nav" id="next" aria-label="Next day">›</button>
    </header>
    <main>${kidsHtml || '<div class="empty">Waiting for the Family Hub screen to connect…</div>'}
      <p class="muted" style="text-align:center;font-size:.85rem">Signed in as ${esc(state.user.email)} · <a href="#" id="out" style="color:inherit">Sign out</a></p>
    </main>`;
  const shift = (n) => { state.date = new Date(state.date.getFullYear(), state.date.getMonth(), state.date.getDate() + n); listenDone(); render(); };
  document.getElementById('prev').onclick = () => shift(-1);
  document.getElementById('next').onclick = () => shift(1);
  document.getElementById('today').onclick = () => { state.date = new Date(); listenDone(); render(); };
  document.getElementById('out').onclick = (e) => { e.preventDefault(); signOut(auth); };
  for (const b of $app.querySelectorAll('[data-toggle]')) b.onclick = () => toggle(b.dataset.toggle);
  for (const b of $app.querySelectorAll('[data-edit]')) b.onclick = () => editTask(state.tasks.find((t) => t.id === b.dataset.edit));
  for (const b of $app.querySelectorAll('[data-add]')) b.onclick = () => editTask(null, b.dataset.add);
}

async function toggle(taskId) {
  const key = ymd(state.date);
  const isDone = !!state.done[key]?.[taskId];
  try { await setDoc(doc(db, `done/${key}`), { [taskId]: isDone ? deleteField() : Date.now() }, { merge: true }); } catch (e) { onErr(e); }
}

// ---------- add / edit sheet ----------
function editTask(task, kidId) {
  const t = task ? JSON.parse(JSON.stringify(task)) : { id: uid(), kidId, title: '', emoji: '⭐', repeat: { type: 'daily' } };
  const bg = document.createElement('div');
  bg.className = 'sheet-bg';
  const close = () => bg.remove();
  bg.onclick = (e) => { if (e.target === bg) close(); };
  const draw = () => {
    const r = t.repeat;
    bg.innerHTML = `<div class="sheet">
      <h2>${task ? 'Edit task' : 'New task'}</h2>
      <label class="f">Task</label><input class="in" id="title" maxlength="60" placeholder="e.g. Brush teeth" value="${esc(t.title)}">
      <label class="f">Who</label><div class="chips">${state.kids.map((k) => `<button class="chip ${t.kidId === k.id ? 'on' : ''}" data-kid="${esc(k.id)}">${esc(k.emoji)} ${esc(k.name)}</button>`).join('')}</div>
      <label class="f">When</label><div class="chips">${[['daily', 'Every day'], ['weekdays', 'School days'], ['weekends', 'Weekends'], ['days', 'Pick days'], ['once', 'One day']].map(([v, l]) => `<button class="chip ${r.type === v ? 'on' : ''}" data-rep="${v}">${l}</button>`).join('')}</div>
      ${r.type === 'days' ? `<div class="chips" style="margin-top:6px">${DAYS.map((d, i) => `<button class="chip ${(r.days || []).includes(i) ? 'on' : ''}" data-day="${i}">${d}</button>`).join('')}</div>` : ''}
      ${r.type === 'once' ? `<input class="in" type="date" id="date" style="margin-top:6px" value="${esc(r.date || ymd(state.date))}">` : ''}
      <label class="f">Picture</label><div class="emojis">${EMOJIS.map((e) => `<button class="${t.emoji === e ? 'on' : ''}" data-emoji="${e}">${e}</button>`).join('')}</div>
      <div class="acts">${task ? '<button class="danger" id="del">Delete</button>' : ''}<button id="cancel">Cancel</button><button class="primary" id="save">Save</button></div>
    </div>`;
    const title = bg.querySelector('#title');
    title.oninput = () => { t.title = title.value; };
    for (const b of bg.querySelectorAll('[data-kid]')) b.onclick = () => { t.kidId = b.dataset.kid; draw(); };
    for (const b of bg.querySelectorAll('[data-rep]')) b.onclick = () => { t.repeat = { type: b.dataset.rep, days: t.repeat.days || [state.date.getDay()], date: t.repeat.date || ymd(state.date) }; draw(); };
    for (const b of bg.querySelectorAll('[data-day]')) b.onclick = () => { const s = new Set(t.repeat.days || []); const i = +b.dataset.day; if (s.has(i)) s.delete(i); else s.add(i); t.repeat.days = [...s].sort(); draw(); };
    for (const b of bg.querySelectorAll('[data-emoji]')) b.onclick = () => { t.emoji = b.dataset.emoji; draw(); };
    const date = bg.querySelector('#date'); if (date) date.onchange = () => { t.repeat.date = date.value; };
    bg.querySelector('#cancel').onclick = close;
    bg.querySelector('#save').onclick = async () => {
      t.title = title.value.trim();
      if (!t.title) { title.focus(); toast('Type what the task is first.'); return; }
      if (!task) t.order = Math.max(-1, ...state.tasks.filter((x) => x.kidId === t.kidId).map((x) => x.order ?? 0)) + 1;
      const rep = { type: t.repeat.type };
      if (rep.type === 'days') rep.days = t.repeat.days || [];
      if (rep.type === 'once') rep.date = t.repeat.date || ymd(state.date);
      t.repeat = rep;
      try { await setDoc(doc(db, `tasks/${t.id}`), JSON.parse(JSON.stringify(t))); close(); toast(task ? 'Saved' : 'Added'); } catch (e) { onErr(e); }
    };
    const del = bg.querySelector('#del');
    if (del) del.onclick = async () => {
      if (!confirm(`Delete "${t.title}"?`)) return;
      try { await deleteDoc(doc(db, `tasks/${t.id}`)); close(); toast('Deleted'); } catch (e) { onErr(e); }
    };
  };
  draw();
  document.body.append(bg);
  if (!task) setTimeout(() => bg.querySelector('#title')?.focus(), 50);
}

onAuthStateChanged(auth, (user) => {
  state.user = user;
  if (!user) { stopListening(); renderSignIn(); return; }
  $app.innerHTML = '<div class="center"><div class="box muted">Loading tasks…</div></div>';
  listen();
});
