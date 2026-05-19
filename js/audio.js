import { S } from './state.js';

export function ensureVoices() {
  return new Promise(resolve => {
    const synth = window.speechSynthesis;
    if (!synth) return resolve([]);
    let v = synth.getVoices();
    if (v.length) return resolve(v);
    let tries = 0;
    const t = setInterval(() => {
      v = synth.getVoices();
      if (v.length || ++tries > 20) { clearInterval(t); resolve(v); }
    }, 100);
  });
}


export async function pickFrenchVoice() {
  const voices = await ensureVoices();
  if (!voices.length) return null;
  const fr = voices.filter(v => /^fr/i.test(v.lang));
  const prefer = ['Thomas', 'Amélie', 'Audrey', 'Aurélie', 'Daniel', 'Marie',
                  'Google français', 'Microsoft Denise', 'Microsoft Henri'];
  for (const name of prefer) {
    const found = fr.find(v => v.name.includes(name));
    if (found) return found;
  }
  return fr.find(v => /fr-FR/i.test(v.lang)) || fr[0] || null;
}


/* ============================================================
   Playback engine

   All audio playback goes through speak(). It enforces a single-playback
   rule: clicking Play while audio is already playing stops the current
   audio and restarts from the beginning. This prevents the browser's
   audio pipeline from choking when the user spam-clicks.

   Google TTS can rate-limit after rapid requests. When that happens we
   fall back to browser TTS silently. A cooldown flag prevents hammering
   the Google endpoint repeatedly during the rate-limit window.
   ============================================================ */

// Global playback state: at most one audio stream at a time.
let _currentAudio = null;      // Audio element (Google TTS) or null
let _speaking = false;         // true while any playback is in progress
let _speakAbort = null;        // resolve() for the current speak() promise

// Google TTS rate-limit cooldown
let _googleCooldownUntil = 0;  // timestamp; if Date.now() < this, skip Google

export let googleAudio = null; // kept for backward compat (some modules reference it)


export function speakBrowser(text, rate = 1.0) {
  return new Promise((resolve) => {
    const synth = window.speechSynthesis;
    if (!synth) return resolve();
    // Always cancel before speaking to clear any stuck utterances
    synth.cancel();
    const u = new SpeechSynthesisUtterance(text);
    if (S.voiceFr) { u.voice = S.voiceFr; u.lang = S.voiceFr.lang; }
    else u.lang = 'fr-FR';
    u.rate = rate; u.pitch = 1.0;
    u.onend = () => resolve();
    u.onerror = () => resolve();
    synth.speak(u);
    // Chrome bug: speechSynthesis can get stuck if the tab is backgrounded.
    // A periodic nudge with resume() keeps it going.
    const nudge = setInterval(() => {
      if (!synth.speaking) { clearInterval(nudge); return; }
      synth.pause();
      synth.resume();
    }, 5000);
    u.onend = () => { clearInterval(nudge); resolve(); };
    u.onerror = () => { clearInterval(nudge); resolve(); };
  });
}


// Pre-warmed Audio element for the current sentence. Fetched in background
// on card render so clicks play instantly.
let preloadedAudio = null;
let preloadedText = null;

export function preloadGoogleAudio(text) {
  if (S.voicePref !== 'google') return;
  if (preloadedText === text) return;
  if (preloadedAudio) { try { preloadedAudio.pause(); } catch {} }
  preloadedAudio = null;
  preloadedText = null;
  // Don't preload during cooldown
  if (Date.now() < _googleCooldownUntil) return;
  const url = 'https://translate.google.com/translate_tts'
            + '?ie=UTF-8&client=tw-ob&tl=fr'
            + '&q=' + encodeURIComponent(text);
  const a = new Audio(url);
  a.crossOrigin = 'anonymous';
  a.preload = 'auto';
  preloadedAudio = a;
  preloadedText = text;
}


function stopCurrentAudio() {
  // Stop Google TTS audio
  if (_currentAudio) {
    try { _currentAudio.pause(); _currentAudio.currentTime = 0; } catch {}
    _currentAudio.onended = null;
    _currentAudio.onerror = null;
    _currentAudio = null;
  }
  googleAudio = null;
  // Stop browser TTS
  if (window.speechSynthesis) {
    window.speechSynthesis.cancel();
  }
  // Resolve any pending speak() promise so it doesn't hang
  if (_speakAbort) {
    _speakAbort();
    _speakAbort = null;
  }
  _speaking = false;
}


function speakGoogleInner(text, rate = 1.0) {
  return new Promise((resolve) => {
    // Reuse preloaded element if it matches
    let a;
    if (preloadedAudio && preloadedText === text) {
      a = preloadedAudio;
      preloadedAudio = null;
      preloadedText = null;
      a.currentTime = 0;
    } else {
      const url = 'https://translate.google.com/translate_tts'
                + '?ie=UTF-8&client=tw-ob&tl=fr'
                + '&q=' + encodeURIComponent(text);
      a = new Audio(url);
      a.crossOrigin = 'anonymous';
    }
    a.playbackRate = rate;
    a.onended = () => { _currentAudio = null; googleAudio = null; resolve(); };
    a.onerror = () => {
      _currentAudio = null;
      googleAudio = null;
      // Google TTS failed (likely rate-limited). Set a 2-minute cooldown
      // so we don't keep hammering the endpoint.
      _googleCooldownUntil = Date.now() + 120_000;
      // Fall back to browser TTS for this request
      speakBrowser(text, rate).then(resolve);
    };
    _currentAudio = a;
    googleAudio = a;
    a.play().catch(() => {
      _currentAudio = null;
      googleAudio = null;
      _googleCooldownUntil = Date.now() + 120_000;
      speakBrowser(text, rate).then(resolve);
    });
  });
}


/** Main entry point for all audio playback. Enforces single-playback:
 *  if audio is already playing, stops it first, then starts the new one.
 *  Safe to call rapidly (spam-clicking Play). */
export async function speak(text, rate, btnEl) {
  // Stop anything currently playing
  stopCurrentAudio();

  _speaking = true;
  if (btnEl) btnEl.classList.add('playing');

  // Choose engine: Google TTS unless in cooldown or user prefers browser
  const useGoogle = S.voicePref === 'google' && Date.now() >= _googleCooldownUntil;

  try {
    // Wrap in an abortable promise so stopCurrentAudio can cancel us
    await new Promise((resolve, reject) => {
      _speakAbort = resolve;
      const fn = useGoogle ? speakGoogleInner : speakBrowser;
      fn(text, rate).then(resolve).catch(resolve);
    });
  } finally {
    _speaking = false;
    _speakAbort = null;
    if (btnEl) btnEl.classList.remove('playing');
  }
}


/* ============================================================
   Sound effects (Web Audio API, no external files)
   ============================================================ */

let _audioCtx = null;
function audioCtx() {
  if (!_audioCtx) {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return null;
    _audioCtx = new Ctor();
  }
  return _audioCtx;
}

/** Subtle ascending two-note chime for correct answers. ~200ms total. */
export function playCorrectChime() {
  const ctx = audioCtx();
  if (!ctx) return;
  const now = ctx.currentTime;
  const notes = [
    { freq: 659.25, start: 0,    dur: 0.10 },  // E5
    { freq: 987.77, start: 0.08, dur: 0.14 },  // B5
  ];
  for (const n of notes) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = n.freq;
    gain.gain.setValueAtTime(0, now + n.start);
    gain.gain.linearRampToValueAtTime(0.12, now + n.start + 0.01);
    gain.gain.linearRampToValueAtTime(0, now + n.start + n.dur);
    osc.connect(gain).connect(ctx.destination);
    osc.start(now + n.start);
    osc.stop(now + n.start + n.dur);
  }
}