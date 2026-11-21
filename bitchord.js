// Home Mini Pro — integración con BitChord (https://github.com/kushagrasinghx/BitChord).
// BitChord plays the music itself; this only opens it at the right place and hands it the speaker.
// - Android with the BitChord app: opens the app on its search screen (it handles music.youtube.com/search links),
//   falling back to the web player if the app isn't installed.
// - Anywhere else: opens the BitChord web player's search page (/search?q=…).

const BC_WEB = 'https://bitchord.kushagrasingh.in';
const BC_PACKAGE = 'com.music.bitchord';
const IS_ANDROID = /Android/i.test(navigator.userAgent);

function bitchordWebUrl(q) {
  return q ? `${BC_WEB}/search?q=${encodeURIComponent(q)}` : `${BC_WEB}/home`;
}
function bitchordAndroidUrl(q) {
  const path = q ? `music.youtube.com/search?q=${encodeURIComponent(q)}` : 'music.youtube.com/';
  return `intent://${path}#Intent;scheme=https;package=${BC_PACKAGE};S.browser_fallback_url=${encodeURIComponent(bitchordWebUrl(q))};end`;
}

// Pause our own music so BitChord can take over the speaker.
function yieldSpeaker() {
  if (!$('bcPause').checked) return;
  try {
    if (typeof F2 !== 'undefined') F2.announcing = null;
    if (connected() && state.player.isMediaLoaded && !state.player.isPaused) state.controller.playOrPause();
  } catch (e) {}
}

function openBitChord(q) {
  q = (q || '').trim();
  yieldSpeaker();
  if (IS_ANDROID) location.href = bitchordAndroidUrl(q);
  else window.open(bitchordWebUrl(q), '_blank', 'noopener');
  banner(IS_ANDROID
    ? '🎵 Abriendo BitChord. Para que suene en el Home Mini: “Ok Google, conecta Bluetooth” y elige el parlante en el celular.'
    : '🎵 BitChord se abrió en otra pestaña. Para que suene en el Home Mini: menú ⋮ de Chrome → Transmitir → Fuentes → Transmitir pestaña.', 9000);
}

$('bcOpen').onclick = () => openBitChord($('bcQuery').value);
$('bcQuery').addEventListener('keydown', (e) => { if (e.key === 'Enter') openBitChord($('bcQuery').value); });
$('bcHome').onclick = () => openBitChord('');
$('bcHowAndroid').style.display = IS_ANDROID ? '' : 'none';
$('bcHowPc').style.display = IS_ANDROID ? 'none' : '';
