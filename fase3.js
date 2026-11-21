// Home Mini Pro — Fase 3: asistente con IA (Claude) que entiende lo que pides y controla el parlante.
// Runs entirely in the browser with the user's own API key (stored only on this device).
// Uses globals from index.html / fase2.js: $, state, F2, connected, setVol, topStation, loadTrack, runRoutine,
// startSleep, cancelSleep, f2save, renderAlarms, renderSourceSelects, announce, stopMusic, next, prev,
// srcLabel, daysLabel, DAY_NAMES, banner.
import Anthropic from 'https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@1.5.0/+esm';

const MODEL = 'claude-opus-5-5';
const MAX_TURNS_IN_CONVERSATION = 40; // start fresh after this many messages to keep each request small
const KEY_STORE = 'hmp.anthropicKey';

const SYSTEM = `Eres el asistente de voz de Home Mini Pro, una app que controla un parlante Google Home Mini en Colombia.
El usuario te habla en español. Tus respuestas se leen en voz alta por el parlante: responde en una a tres frases cortas y naturales, sin markdown, listas, emojis ni enlaces.
Usa las herramientas para la música, el volumen, el temporizador, las alarmas y las rutinas. Para música, las radios se buscan en el directorio Radio Browser: los géneros funcionan mejor en inglés (lofi, classical, salsa, reggaeton, rock, jazz, ambient, news).
No puedes reproducir canciones concretas de YouTube o Spotify; en ese caso ofrece una radio del género o estilo parecido.
Si el parlante no está conectado, pide al usuario que toque el ícono de Cast. Después de usar una herramienta, confirma en pocas palabras lo que hiciste.`;

// ---------- Tools ----------
const obj = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const TOOLS = [
  {
    name: 'ver_estado',
    description: 'Devuelve el estado actual: si el parlante está conectado, qué suena, el volumen, el temporizador, los favoritos, las rutinas y las alarmas guardadas. Úsala antes de responder preguntas sobre el estado o cuando necesites nombres exactos.',
    input_schema: obj({}),
  },
  {
    name: 'reproducir_radio',
    description: 'Busca una emisora de radio en vivo y la pone en el parlante.',
    input_schema: obj({
      busqueda: { type: 'string', description: "Género en inglés (p. ej. 'lofi', 'salsa'), nombre de la emisora (p. ej. 'Tropicana') o código ISO de país de 2 letras (p. ej. 'CO')." },
      tipo: { type: 'string', enum: ['genero', 'nombre', 'pais'] },
    }),
  },
  {
    name: 'reproducir_favorito',
    description: 'Pone un favorito guardado por el usuario. Usa ver_estado para conocer los nombres.',
    input_schema: obj({ nombre: { type: 'string' } }),
  },
  {
    name: 'controlar_reproduccion',
    description: 'Pausa, reanuda, detiene o salta en la cola.',
    input_schema: obj({ accion: { type: 'string', enum: ['pausar', 'reanudar', 'detener', 'siguiente', 'anterior'] } }),
  },
  {
    name: 'cambiar_volumen',
    description: 'Ajusta el volumen del parlante.',
    input_schema: obj({ nivel: { type: 'integer', description: 'De 0 a 100.' } }),
  },
  {
    name: 'temporizador_apagado',
    description: 'Apaga la música dentro de N minutos, bajando el volumen suavemente. 0 cancela el temporizador.',
    input_schema: obj({ minutos: { type: 'integer' } }),
  },
  {
    name: 'crear_alarma',
    description: 'Crea una alarma. Solo suena si la app está abierta en el celular o el PC a esa hora.',
    input_schema: obj({
      hora: { type: 'string', description: 'Formato 24 h HH:MM, p. ej. 06:30.' },
      dias: { type: 'array', items: { type: 'integer' }, description: 'Días de la semana: 0=domingo … 6=sábado. Lista vacía = una sola vez.' },
      musica: { type: 'string', description: "'colombia' (top radios de Colombia), 'genero:<género en inglés>', 'favorito:<nombre>' o 'ninguna'." },
      saludo: { type: 'boolean', description: 'Si debe saludar diciendo la hora y la fecha.' },
      volumen: { type: 'integer', description: 'Volumen final de 5 a 100.' },
    }),
  },
  {
    name: 'borrar_alarma',
    description: 'Borra las alarmas de una hora concreta.',
    input_schema: obj({ hora: { type: 'string', description: 'HH:MM' } }),
  },
  {
    name: 'ejecutar_rutina',
    description: 'Ejecuta una rutina guardada (p. ej. Buenos días, Modo trabajo, Buenas noches, Silencio). Usa ver_estado para conocer los nombres.',
    input_schema: obj({ nombre: { type: 'string' } }),
  },
].map(t => ({ ...t, strict: true }));

const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N} ]/gu, '').trim();
const findByName = (list, name, key) => { const n = norm(name); return list.find(x => norm(x[key]) === n) || list.find(x => norm(x[key]).includes(n) || n.includes(norm(x[key]))); };
const NOT_CONNECTED = 'Error: el parlante no está conectado. El usuario debe tocar el ícono de Cast y elegir su Home Mini.';

function musicaToSource(m) {
  m = String(m || '').trim();
  if (!m || m === 'ninguna') return null;
  if (m === 'colombia') return { kind: 'spec', spec: 'co' };
  if (m.startsWith('genero:')) return { kind: 'spec', spec: 'tag:' + m.slice(7).trim().toLowerCase() };
  if (m.startsWith('favorito:')) {
    const f = findByName(F2.favs, m.slice(9), 'title');
    if (!f) throw new Error(`no encontré el favorito "${m.slice(9)}"`);
    return { kind: 'track', track: f };
  }
  return { kind: 'spec', spec: 'tag:' + m.toLowerCase() };
}

const runners = {
  ver_estado() {
    const p = state.player;
    return JSON.stringify({
      conectado: connected(),
      sonando: connected() && p.isMediaLoaded ? (state.current?.title || p.mediaInfo?.metadata?.title || 'algo') : null,
      pausado: connected() ? !!p.isPaused : null,
      volumen: connected() ? Math.round(p.volumeLevel * 100) : null,
      temporizador_minutos_restantes: F2.sleep ? Math.ceil((F2.sleep.end - Date.now()) / 60000) : null,
      favoritos: F2.favs.map(f => f.title),
      rutinas: F2.routines.map(r => r.name),
      alarmas: F2.alarms.map(a => ({ hora: a.time, dias: daysLabel(a.days), musica: srcLabel(a.src), activa: a.on })),
    });
  },
  async reproducir_radio({ busqueda, tipo }) {
    if (!connected()) return NOT_CONNECTED;
    const params = tipo === 'pais' ? { countrycode: busqueda.toUpperCase() } : tipo === 'nombre' ? { name: busqueda } : { tag: busqueda.toLowerCase() };
    const track = await topStation(params);
    await loadTrack(track);
    return `Sonando: ${track.title}`;
  },
  async reproducir_favorito({ nombre }) {
    if (!connected()) return NOT_CONNECTED;
    const f = findByName(F2.favs, nombre, 'title');
    if (!f) return `Error: no hay un favorito llamado "${nombre}". Favoritos: ${F2.favs.map(x => x.title).join(', ') || 'ninguno'}.`;
    await loadTrack({ ...f });
    return `Sonando el favorito: ${f.title}`;
  },
  controlar_reproduccion({ accion }) {
    if (!connected()) return NOT_CONNECTED;
    const p = state.player, c = state.controller;
    if (accion === 'pausar') { if (!p.isPaused) c.playOrPause(); return 'Pausado.'; }
    if (accion === 'reanudar') { if (p.isPaused) c.playOrPause(); return 'Reanudado.'; }
    if (accion === 'detener') { stopMusic(); return 'Detenido.'; }
    if (accion === 'siguiente') { next(); return 'Siguiente de la cola.'; }
    if (accion === 'anterior') { prev(); return 'Anterior de la cola.'; }
    return 'Acción desconocida.';
  },
  cambiar_volumen({ nivel }) {
    if (!connected()) return NOT_CONNECTED;
    const v = Math.max(0, Math.min(100, Math.round(nivel)));
    setVol(v / 100);
    return `Volumen en ${v}%.`;
  },
  temporizador_apagado({ minutos }) {
    if (!minutos || minutos <= 0) { cancelSleep(true); return 'Temporizador cancelado.'; }
    if (!connected()) return NOT_CONNECTED;
    startSleep(Math.min(600, Math.round(minutos)));
    return `La música se apagará en ${minutos} minutos.`;
  },
  crear_alarma({ hora, dias, musica, saludo, volumen }) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(hora).trim());
    if (!m || +m[1] > 23 || +m[2] > 59) return 'Error: la hora debe tener formato HH:MM (24 h).';
    const time = m[1].padStart(2, '0') + ':' + m[2];
    const days = [...new Set((dias || []).filter(d => Number.isInteger(d) && d >= 0 && d <= 6))];
    const src = musicaToSource(musica);
    F2.alarms.push({ id: 'a-' + Date.now(), time, days, src, vol: Math.max(5, Math.min(100, volumen || 40)) / 100, ramp: true, say: !!saludo, on: true });
    F2.alarms.sort((a, b) => a.time.localeCompare(b.time));
    f2save(); renderAlarms();
    return `Alarma creada: ${time}, ${daysLabel(days)}, ${srcLabel(src)}. Recuerda al usuario que la app debe quedar abierta (modo mesita de noche).`;
  },
  borrar_alarma({ hora }) {
    const before = F2.alarms.length;
    const t = String(hora).trim().padStart(5, '0');
    F2.alarms = F2.alarms.filter(a => a.time !== t);
    f2save(); renderAlarms();
    return before === F2.alarms.length ? `No había alarmas a las ${t}.` : `Borré ${before - F2.alarms.length} alarma(s) de las ${t}.`;
  },
  async ejecutar_rutina({ nombre }) {
    if (!connected()) return NOT_CONNECTED;
    const r = findByName(F2.routines, nombre, 'name');
    if (!r) return `Error: no hay una rutina llamada "${nombre}". Rutinas: ${F2.routines.map(x => x.name).join(', ')}.`;
    await runRoutine(r);
    return `Rutina "${r.name}" ejecutada. Esta rutina ya incluye su propio anuncio si tiene uno; confirma muy brevemente.`;
  },
};

// ---------- Chat UI ----------
const AI = { messages: [], busy: false };
const log = $('chatLog');
function addMsg(kind, text) {
  const d = document.createElement('div');
  d.className = 'msg ' + kind; d.textContent = text;
  log.appendChild(d); log.scrollTop = log.scrollHeight;
  return d;
}
function getKey() { try { return localStorage.getItem(KEY_STORE) || ''; } catch (e) { return ''; } }
$('aiKey').value = getKey() ? '••••••••••••' : '';
if (!getKey()) $('aiSettings').open = true;
$('aiKeySave').onclick = () => {
  const k = $('aiKey').value.trim();
  if (!k.startsWith('sk-ant-')) { alert('La clave debe empezar por "sk-ant-".'); return; }
  try { localStorage.setItem(KEY_STORE, k); } catch (e) {}
  $('aiKey').value = '••••••••••••'; $('aiSettings').open = false;
  banner('Clave guardada en este dispositivo.', 2500);
};
$('aiKeyDel').onclick = () => { try { localStorage.removeItem(KEY_STORE); } catch (e) {} $('aiKey').value = ''; banner('Clave borrada.', 2500); };
$('aiReset').onclick = () => { AI.messages = []; log.innerHTML = ''; addMsg('bot', 'Conversación nueva. ¿Qué hacemos?'); };

const TOOL_LABELS = {
  ver_estado: '🔎 revisando el estado', reproducir_radio: '📻 buscando radio', reproducir_favorito: '★ poniendo favorito',
  controlar_reproduccion: '⏯ controlando', cambiar_volumen: '🔊 volumen', temporizador_apagado: '⏲ temporizador',
  crear_alarma: '⏰ creando alarma', borrar_alarma: '🗑 borrando alarma', ejecutar_rutina: '⚡ ejecutando rutina',
};

async function ask(text) {
  text = text.trim();
  if (!text || AI.busy) return;
  const key = getKey();
  if (!key) { $('aiSettings').open = true; alert('Primero guarda tu clave de API de Claude en ⚙️ Configurar el asistente.'); return; }
  AI.busy = true; $('aiSend').disabled = true;
  addMsg('user', text);
  $('aiInput').value = '';
  const thinking = addMsg('tool', 'Pensando…');

  if (AI.messages.length > MAX_TURNS_IN_CONVERSATION) AI.messages = [];
  const now = new Date();
  AI.messages.push({
    role: 'user',
    content: [{ type: 'text', text: `[Ahora: ${DAY_NAMES[now.getDay()]} ${now.toLocaleString('es-CO')}]\n${text}` }],
  });

  const client = new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true });
  let reply = '';
  let ranRoutine = false;
  try {
    for (let i = 0; i < 8; i++) {
      const response = await client.beta.messages.create({
        model: MODEL,
        max_tokens: 16000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: { effort: 'low' },
        system: SYSTEM,
        tools: TOOLS,
        messages: AI.messages,
      });
      // Keep the full assistant turn (thinking, fallback and tool blocks) so the history stays valid.
      AI.messages.push({ role: 'assistant', content: response.content });
      const texts = response.content.filter(b => b.type === 'text').map(b => b.text).join(' ').trim();

      if (response.stop_reason === 'refusal') { reply = texts || 'Lo siento, no puedo ayudar con eso.'; break; }
      if (response.stop_reason === 'pause_turn') continue;
      if (response.stop_reason === 'max_tokens') { reply = texts || 'La respuesta quedó incompleta. ¿Puedes pedirlo de otra forma?'; break; }
      if (response.stop_reason !== 'tool_use') { reply = texts; break; }

      const results = [];
      for (const block of response.content.filter(b => b.type === 'tool_use')) {
        thinking.textContent = TOOL_LABELS[block.name] || block.name;
        let content, isError = false;
        try {
          const fn = runners[block.name];
          if (!fn) throw new Error('herramienta desconocida');
          content = String(await fn(block.input || {}));
          if (block.name === 'ejecutar_rutina' && !content.startsWith('Error')) ranRoutine = true;
          if (content.startsWith('Error')) isError = true;
        } catch (e) { content = 'Error: ' + e.message; isError = true; }
        addMsg('tool', `${TOOL_LABELS[block.name] || block.name} → ${content.length > 120 ? content.slice(0, 120) + '…' : content}`);
        results.push({ type: 'tool_result', tool_use_id: block.id, content, ...(isError ? { is_error: true } : {}) });
      }
      AI.messages.push({ role: 'user', content: results });
    }
  } catch (e) {
    thinking.remove();
    addMsg('err', explainError(e));
    // Drop the unanswered user turn so the next attempt starts from a valid history.
    AI.messages = [];
    AI.busy = false; $('aiSend').disabled = false;
    return;
  }
  thinking.remove();
  if (!reply) reply = 'Listo.';
  addMsg('bot', reply);
  // Speak the reply on the speaker (a routine already speaks its own announcement).
  if ($('aiSpeak').checked && connected() && !ranRoutine) announce(reply, 'resume');
  AI.busy = false; $('aiSend').disabled = false;
}

function explainError(e) {
  if (e instanceof Anthropic.AuthenticationError) return 'La clave de API no es válida. Revísala en ⚙️ Configurar el asistente.';
  if (e instanceof Anthropic.PermissionDeniedError) return 'Tu clave no tiene permiso para usar este modelo. Revisa tu cuenta en console.anthropic.com.';
  if (e instanceof Anthropic.RateLimitError) return 'Demasiadas solicitudes o sin saldo. Espera un momento o revisa tu saldo en console.anthropic.com.';
  if (e instanceof Anthropic.BadRequestError) return 'La solicitud fue rechazada: ' + (e.message || 'error desconocido') + '. Si dice que no hay saldo, recarga créditos en console.anthropic.com.';
  if (e instanceof Anthropic.APIConnectionError) return 'No pude conectarme con el servicio de IA. Revisa tu internet.';
  if (e instanceof Anthropic.APIError) return `Error del servicio de IA (${e.status || '?'}): ${e.message}`;
  return 'Error inesperado: ' + (e?.message || e);
}

$('aiSend').onclick = () => ask($('aiInput').value);
$('aiInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') ask($('aiInput').value); });

// ---------- Voice input (Chrome / Edge) ----------
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
if (!SR) { $('aiMic').disabled = true; $('aiMic').title = 'Este navegador no permite dictado por voz'; }
else {
  let rec = null;
  $('aiMic').onclick = () => {
    if (rec) { rec.stop(); return; }
    rec = new SR();
    rec.lang = 'es-CO'; rec.interimResults = true; rec.maxAlternatives = 1;
    $('aiMic').classList.add('rec');
    let finalText = '';
    rec.onresult = (ev) => {
      let interim = '';
      for (const r of ev.results) { if (r.isFinal) finalText = r[0].transcript; else interim += r[0].transcript; }
      $('aiInput').value = finalText || interim;
    };
    rec.onerror = (ev) => { if (ev.error === 'not-allowed') banner('Permite el uso del micrófono para hablarle al asistente.'); };
    rec.onend = () => { $('aiMic').classList.remove('rec'); rec = null; if (finalText) ask(finalText); };
    rec.start();
  };
}

window.hmpAsk = ask; // handy for testing from the console
