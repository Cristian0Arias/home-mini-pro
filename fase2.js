// Home Mini Pro — Fase 2: anuncios por voz, rutinas, alarmas, temporizador de apagado y favoritos.
// Uses globals from index.html: $, state, session, loadTrack, playNow, esc, RB, guessType.

const F2 = { favs: [], alarms: [], routines: [], sleep: null, announcing: null, wakeLock: null, fired: {} };
const DAYS = ['D', 'L', 'M', 'X', 'J', 'V', 'S']; // index = JS getDay()
const DAY_NAMES = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

const DEFAULT_ROUTINES = [
  { id: 'r-dias', name: '☀️ Buenos días', src: { kind: 'spec', spec: 'co' }, vol: 0.4, say: 'Buenos días. Son las {hora}. Hoy es {fecha}.', sleep: 0 },
  { id: 'r-trabajo', name: '💻 Modo trabajo', src: { kind: 'spec', spec: 'tag:lofi' }, vol: 0.3, say: '', sleep: 0 },
  { id: 'r-noches', name: '🌙 Buenas noches', src: { kind: 'spec', spec: 'tag:ambient' }, vol: 0.2, say: 'Buenas noches. La música se apagará en 30 minutos.', sleep: 30 },
  { id: 'r-silencio', name: '🔕 Silencio', src: { kind: 'stop' }, vol: null, say: '', sleep: 0 },
];
const SPECS = [
  ['none', '— Nada (solo anuncio/volumen) —'],
  ['co', '📻 Top radios de Colombia'],
  ['tag:lofi', '🎧 Lofi'],
  ['tag:jazz', '🎷 Jazz'],
  ['tag:salsa', '💃 Salsa'],
  ['tag:ambient', '🌙 Ambiental / relajante'],
  ['tag:news', '📰 Noticias'],
  ['stop', '⏹ Detener la música'],
];

// ---------- Storage ----------
function f2save() { try { localStorage.setItem('hmp.f2', JSON.stringify({ favs: F2.favs, alarms: F2.alarms, routines: F2.routines })); } catch (e) {} }
function f2load() {
  try {
    const d = JSON.parse(localStorage.getItem('hmp.f2') || 'null');
    if (d) { F2.favs = d.favs || []; F2.alarms = d.alarms || []; F2.routines = d.routines || DEFAULT_ROUTINES.slice(); }
    else F2.routines = DEFAULT_ROUTINES.slice();
  } catch (e) { F2.routines = DEFAULT_ROUTINES.slice(); }
}

// ---------- Helpers ----------
function banner(msg, ms = 6000) {
  const b = $('banner'); b.textContent = msg; b.classList.add('show');
  clearTimeout(banner.t); if (ms) banner.t = setTimeout(() => b.classList.remove('show'), ms);
}
function connected() { return !!(state.player && state.player.isConnected && session()); }
function needSpeaker() { if (!connected()) { banner('Primero conéctate al parlante con el ícono de Cast (arriba a la derecha).'); return true; } return false; }
function setVol(v) { if (!connected()) return; state.player.volumeLevel = Math.max(0, Math.min(1, v)); state.controller.setVolumeLevel(); }
function expand(text) {
  const now = new Date();
  const h = now.getHours(), h12 = h % 12 || 12, mm = String(now.getMinutes()).padStart(2, '0');
  const hora = `${h12}:${mm} de la ${h < 12 ? 'mañana' : h < 19 ? 'tarde' : 'noche'}`;
  const fecha = `${DAY_NAMES[now.getDay()]} ${now.getDate()} de ${now.toLocaleDateString('es-CO', { month: 'long' })}`;
  return text.replace(/\{hora\}/g, hora).replace(/\{fecha\}/g, fecha);
}
function stationToTrack(s) {
  const codec = (s.codec || '').toUpperCase();
  const type = codec.startsWith('AAC') ? 'audio/aac' : codec === 'OGG' ? 'audio/ogg' : guessType(s.url_resolved, 'audio/mpeg');
  return { url: s.url_resolved, title: s.name.trim(), subtitle: 'Radio en vivo · ' + (s.country || ''), image: s.favicon, type, live: true };
}
async function topStation(params) {
  const qs = new URLSearchParams({ hidebroken: 'true', order: 'clickcount', reverse: 'true', limit: '15', ...params });
  const list = (await (await fetch(`${RB}?${qs}`)).json()).filter(s => s.url_resolved && s.url_resolved.startsWith('https://'));
  if (!list.length) throw new Error('No encontré emisoras');
  return stationToTrack(list[Math.floor(Math.random() * Math.min(5, list.length))]);
}
// src: {kind:'spec', spec} | {kind:'track', track} | {kind:'stop'} | null
async function resolveSource(src) {
  if (!src) return null;
  if (src.kind === 'track') return src.track;
  if (src.kind === 'stop') return 'stop';
  const spec = src.spec;
  if (!spec || spec === 'none') return null;
  if (spec === 'stop') return 'stop';
  if (spec === 'co') return topStation({ countrycode: 'CO' });
  if (spec.startsWith('tag:')) return topStation({ tag: spec.slice(4) });
  return null;
}
function srcLabel(src) {
  if (!src) return 'Sin música';
  if (src.kind === 'track') return '★ ' + src.track.title;
  if (src.kind === 'stop') return 'Detener la música';
  return (SPECS.find(s => s[0] === src.spec) || [0, 'Sin música'])[1];
}

// ---------- Announcements ----------
function ttsUrl(text) {
  return 'https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=es&q=' + encodeURIComponent(text.slice(0, 200));
}
// then: 'resume' | track | null
async function announce(text, then = 'resume') {
  if (needSpeaker()) return;
  text = expand(text).trim();
  if (!text) return;
  const p = state.player;
  let after = null;
  if (then === 'resume') {
    if (p.isMediaLoaded && state.current && p.playerState !== 'IDLE') after = { track: state.current, time: p.currentTime };
  } else if (then) after = { track: then, time: 0 };
  const job = { after, started: false };
  F2.announcing = job;
  try {
    await loadTrack({ url: ttsUrl(text), title: '📢 Anuncio', subtitle: text, type: 'audio/mpeg', announce: true });
  } catch (e) {
    // The voice failed to load: still play what should come next.
    if (F2.announcing === job) finishAnnouncement();
    return;
  }
  // Safety net: if the speaker never reports the end of the announcement, continue anyway.
  setTimeout(() => { if (F2.announcing === job) finishAnnouncement(); }, text.length * 110 + 6000);
}
// Called by index.html on every player state change.
window.hmpOnState = (p) => {
  const a = F2.announcing;
  if (a && !a.started && p.playerState === 'PLAYING' && String(p.mediaInfo?.contentId || '').includes('translate_tts')) a.started = true;
};
// Called by index.html when a track ends. Only counts once the announcement actually played.
window.hmpOnFinished = () => {
  if (!F2.announcing) return false;
  if (!F2.announcing.started) return true; // an older track was interrupted by the announcement
  finishAnnouncement();
  return true;
};
function finishAnnouncement() {
  if (!F2.announcing) return;
  const { after } = F2.announcing; F2.announcing = null;
  if (after) {
    loadTrack(after.track).then(() => {
      if (!after.track.live && after.time > 2) setTimeout(() => { state.player.currentTime = after.time; state.controller.seek(); }, 1200);
    }).catch(() => {});
  } else renderNowIdle();
}
function stopMusic() { F2.announcing = null; state.userStopped = true; state.controller.stop(); }
function renderNowIdle() { $('nowTitle').textContent = 'Nada sonando'; $('nowSub').textContent = 'Listo para el siguiente anuncio o canción'; $('art').style.backgroundImage = ''; }

$('btnSay').onclick = () => { announce($('sayText').value, $('sayResume').checked ? 'resume' : null); };
$('sayText').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btnSay').click(); });
$('sayChips').addEventListener('click', (e) => { const t = e.target.dataset.say; if (t) announce(t, $('sayResume').checked ? 'resume' : null); });

// ---------- Sleep timer ----------
function startSleep(min) {
  if (needSpeaker()) return;
  cancelSleep(true);
  F2.sleep = { end: Date.now() + min * 60000, fadeFrom: null, lastVol: null };
  $('sleepCancel').disabled = false;
  banner(`La música se apagará en ${min} minutos.`, 3000);
  tickSleep();
}
function cancelSleep(silent) {
  if (F2.sleep && F2.sleep.fadeFrom != null) setVol(F2.sleep.fadeFrom);
  F2.sleep = null; $('sleepLeft').textContent = '--:--'; $('sleepCancel').disabled = true;
  if (!silent) banner('Temporizador cancelado.', 2500);
}
function tickSleep() {
  const s = F2.sleep; if (!s) return;
  const left = s.end - Date.now();
  $('sleepLeft').textContent = fmt(Math.max(0, left) / 1000);
  if (left <= 30000 && left > 0 && connected()) {
    if (s.fadeFrom == null) s.fadeFrom = state.player.volumeLevel;
    const v = Math.round(s.fadeFrom * (left / 30000) * 100) / 100;
    if (s.lastVol == null || Math.abs(s.lastVol - v) >= 0.02) { s.lastVol = v; setVol(v); }
  }
  if (left <= 0) {
    const restore = s.fadeFrom;
    F2.sleep = null; $('sleepLeft').textContent = '--:--'; $('sleepCancel').disabled = true;
    if (connected()) { stopMusic(); if (restore != null) setTimeout(() => setVol(restore), 1500); }
    banner('😴 Temporizador terminado: música detenida.', 5000);
  }
}
document.querySelectorAll('[data-sleep]').forEach(b => b.onclick = () => startSleep(+b.dataset.sleep));
$('sleepCancel').onclick = () => cancelSleep(false);

// ---------- Volume ramp ----------
function rampVolume(target, seconds) {
  clearInterval(rampVolume.t);
  const start = 0.08, steps = Math.max(1, Math.round(seconds / 5)); let i = 0;
  setVol(start);
  rampVolume.t = setInterval(() => { i++; setVol(start + (target - start) * (i / steps)); if (i >= steps) clearInterval(rampVolume.t); }, 5000);
}

// ---------- Routines ----------
async function runRoutine(r) {
  if (needSpeaker()) return;
  banner(`▶︎ ${r.name}`, 2500);
  try {
    const src = await resolveSource(r.src);
    if (r.vol != null) setVol(r.vol);
    if (src === 'stop') {
      stopMusic();
      if (r.say) setTimeout(() => announce(r.say, null), 800);
    } else if (r.say) await announce(r.say, src || 'resume');
    else if (src) await loadTrack(src);
    if (r.sleep > 0) startSleep(r.sleep);
  } catch (e) { banner('No pude ejecutar la rutina: ' + e.message); }
}
function renderRoutines() {
  $('routineGrid').innerHTML = F2.routines.map((r, i) => `
    <button class="routine" data-run="${i}">
      <span class="x" data-delr="${i}" title="Eliminar">✕</span>
      <b>${esc(r.name)}</b>
      <small>${esc(srcLabel(r.src))}${r.vol != null ? ' · ' + Math.round(r.vol * 100) + '%' : ''}${r.sleep ? ' · ⏲ ' + r.sleep + ' min' : ''}</small>
    </button>`).join('');
}
$('routineGrid').addEventListener('click', (e) => {
  const del = e.target.closest('[data-delr]');
  if (del) { e.stopPropagation(); const i = +del.dataset.delr; if (confirm(`¿Eliminar la rutina "${F2.routines[i].name}"?`)) { F2.routines.splice(i, 1); f2save(); renderRoutines(); } return; }
  const run = e.target.closest('[data-run]'); if (run) runRoutine(F2.routines[+run.dataset.run]);
});
$('rVol').oninput = (e) => { $('rVolTxt').textContent = e.target.value; $('rVolOn').checked = true; };
$('rSave').onclick = () => {
  const name = $('rName').value.trim(); if (!name) { alert('Ponle un nombre a la rutina.'); return; }
  F2.routines.push({
    id: 'r-' + Date.now(), name, src: readSource($('rSource').value),
    vol: $('rVolOn').checked ? $('rVol').value / 100 : null, say: $('rSay').value.trim(), sleep: Math.max(0, +$('rSleep').value || 0),
  });
  f2save(); renderRoutines();
  $('rName').value = ''; $('rSay').value = ''; $('rSleep').value = '';
  banner('Rutina guardada.', 2500);
};

// ---------- Source selectors ----------
function readSource(v) {
  if (v.startsWith('fav:')) return { kind: 'track', track: F2.favs[+v.slice(4)] };
  if (v === 'stop') return { kind: 'stop' };
  return { kind: 'spec', spec: v };
}
function renderSourceSelects() {
  const opts = SPECS.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('') +
    (F2.favs.length ? `<optgroup label="Favoritos">${F2.favs.map((f, i) => `<option value="fav:${i}">★ ${esc(f.title)}</option>`).join('')}</optgroup>` : '');
  document.querySelectorAll('.srcSelect').forEach(s => { const prev = s.value; s.innerHTML = opts; if (prev) s.value = prev; });
  if (!$('aSource').value || $('aSource').value === 'none') $('aSource').value = 'co';
}

// ---------- Favorites ----------
$('btnFav').onclick = () => {
  const t = state.current;
  if (!t) { banner('No hay nada sonando para guardar.', 3000); return; }
  if (F2.favs.some(f => f.url === t.url)) { banner('Ya está en favoritos.', 2500); return; }
  F2.favs.push({ url: t.url, title: t.title, subtitle: t.subtitle, image: t.image, type: t.type, live: !!t.live });
  f2save(); renderFavs(); renderSourceSelects(); banner('★ Guardado en favoritos.', 2500);
};
function renderFavs() {
  const ul = $('favList');
  if (!F2.favs.length) { ul.innerHTML = '<li><small class="hint">Pon algo a sonar y pulsa “★ Guardar” para tenerlo aquí y usarlo en rutinas y alarmas.</small></li>'; return; }
  ul.innerHTML = F2.favs.map((f, i) => `
    <li><img src="${esc(f.image || '')}" alt="" onerror="this.style.visibility='hidden'">
      <div class="meta"><div>${esc(f.title)}</div><small>${esc(f.subtitle || '')}</small></div>
      <button data-fplay="${i}">▶︎</button><button data-fdel="${i}">✕</button></li>`).join('');
}
$('favList').addEventListener('click', (e) => {
  const p = e.target.dataset.fplay, d = e.target.dataset.fdel;
  if (p !== undefined && !needSpeaker()) playNow({ ...F2.favs[+p] });
  if (d !== undefined) { F2.favs.splice(+d, 1); f2save(); renderFavs(); renderSourceSelects(); }
});

// ---------- Alarms ----------
$('aDays').innerHTML = [1, 2, 3, 4, 5, 6, 0].map(d => `<label title="${DAY_NAMES[d]}"><input type="checkbox" value="${d}"><span>${DAYS[d]}</span></label>`).join('');
$('aVol').oninput = (e) => { $('aVolTxt').textContent = e.target.value; };
$('aSave').onclick = () => {
  const time = $('aTime').value; if (!time) { alert('Elige una hora.'); return; }
  const days = [...$('aDays').querySelectorAll('input:checked')].map(i => +i.value);
  F2.alarms.push({ id: 'a-' + Date.now(), time, days, src: readSource($('aSource').value), vol: $('aVol').value / 100, ramp: $('aRamp').checked, say: $('aSay').checked, on: true });
  F2.alarms.sort((a, b) => a.time.localeCompare(b.time));
  f2save(); renderAlarms(); banner(`⏰ Alarma guardada para las ${time}.`, 3000);
  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {});
};
function daysLabel(days) {
  if (!days.length) return 'Una vez';
  const k = [...days].sort().join(',');
  if (k === '1,2,3,4,5') return 'Lunes a viernes';
  if (k === '0,6') return 'Fines de semana';
  if (days.length === 7) return 'Todos los días';
  return [1, 2, 3, 4, 5, 6, 0].filter(d => days.includes(d)).map(d => DAYS[d]).join(' ');
}
function renderAlarms() {
  const ul = $('alarmList');
  if (!F2.alarms.length) { ul.innerHTML = '<li><small class="hint">No tienes alarmas.</small></li>'; return; }
  ul.innerHTML = F2.alarms.map((a, i) => `
    <li style="${a.on ? '' : 'opacity:.5'}">
      <div class="big" style="font-size:22px;min-width:74px">${esc(a.time)}</div>
      <div class="meta"><div>${esc(daysLabel(a.days))}</div><small>${esc(srcLabel(a.src))} · ${Math.round(a.vol * 100)}%${a.ramp ? ' · gradual' : ''}${a.say ? ' · saludo' : ''}</small></div>
      <button data-atog="${i}">${a.on ? 'Apagar' : 'Activar'}</button><button data-adel="${i}">✕</button>
    </li>`).join('');
}
$('alarmList').addEventListener('click', (e) => {
  const t = e.target.dataset.atog, d = e.target.dataset.adel;
  if (t !== undefined) { F2.alarms[+t].on = !F2.alarms[+t].on; f2save(); renderAlarms(); }
  if (d !== undefined) { F2.alarms.splice(+d, 1); f2save(); renderAlarms(); }
});
async function fireAlarm(a) {
  const msg = `⏰ Alarma de las ${a.time}`;
  if (!connected()) {
    banner(msg + ': conéctate al parlante para que suene.', 0);
    try { if (Notification.permission === 'granted') new Notification('Home Mini Pro', { body: msg + ' — toca para conectar el parlante.' }); } catch (e) {}
    if (navigator.vibrate) navigator.vibrate([400, 200, 400, 200, 400]);
    return;
  }
  banner(msg, 8000);
  try {
    const src = await resolveSource(a.src);
    const track = src && src !== 'stop' ? src : null;
    if (a.ramp) rampVolume(a.vol, 120); else setVol(a.vol);
    if (a.say) await announce('Buenos días. Son las {hora}. Hoy es {fecha}.', track);
    else if (track) await loadTrack(track);
  } catch (e) { banner('La alarma no pudo reproducir la música: ' + e.message); }
}
function checkAlarms() {
  const now = new Date();
  const hhmm = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
  const key = now.toDateString() + ' ' + hhmm;
  F2.alarms.forEach(a => {
    if (!a.on || a.time !== hhmm) return;
    if (a.days.length && !a.days.includes(now.getDay())) return;
    if (F2.fired[a.id] === key) return;
    F2.fired[a.id] = key;
    if (!a.days.length) { a.on = false; f2save(); renderAlarms(); } // one-shot
    fireAlarm(a);
  });
}

// ---------- Bedside mode (screen wake lock) ----------
async function setWake(on) {
  try {
    if (on) { F2.wakeLock = await navigator.wakeLock.request('screen'); F2.wakeLock.addEventListener('release', () => { if (F2.wantWake) return; $('btnWake').textContent = 'Activar'; }); }
    else if (F2.wakeLock) { await F2.wakeLock.release(); F2.wakeLock = null; }
    F2.wantWake = on; $('btnWake').textContent = on ? 'Desactivar' : 'Activar';
    $('btnWake').classList.toggle('primary', on);
  } catch (e) { banner('Este navegador no permite mantener la pantalla encendida.'); }
}
$('btnWake').onclick = () => setWake(!F2.wantWake);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && F2.wantWake) setWake(true); checkAlarms(); });

// ---------- Boot ----------
f2load(); renderRoutines(); renderFavs(); renderSourceSelects(); renderAlarms();
setInterval(() => { tickSleep(); checkAlarms(); }, 1000);
