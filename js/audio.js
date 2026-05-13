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


export function speakBrowser(text, rate = 1.0) {
  return new Promise((resolve) => {
    const synth = window.speechSynthesis;
    if (!synth) return resolve();
    synth.cancel();
    const u = new SpeechSynthesisUtterance(text);
    if (S.voiceFr) { u.voice = S.voiceFr; u.lang = S.voiceFr.lang; }
    else u.lang = 'fr-FR';
    u.rate = rate; u.pitch = 1.0;
    u.onend = () => resolve();
    u.onerror = () => resolve();
    synth.speak(u);
  });
}


export let googleAudio = null;

// A pre-warmed Audio element for the current French sentence. When we render
// a new card we start fetching its TTS audio in the background, so by the
// time the user clicks Play or finishes typing, the audio is ready and plays
// instantly instead of pausing for the network round-trip.
let preloadedAudio = null;
let preloadedText = null;

export function preloadGoogleAudio(text) {
  if (S.voicePref !== 'google') return;       // only useful for Google TTS
  if (preloadedText === text) return;          // already cached
  // Drop the old one
  if (preloadedAudio) { try { preloadedAudio.pause(); } catch {} preloadedAudio = null; }
  const url = 'https://translate.google.com/translate_tts'
            + '?ie=UTF-8&client=tw-ob&tl=fr'
            + '&q=' + encodeURIComponent(text);
  const a = new Audio(url);
  a.crossOrigin = 'anonymous';
  a.preload = 'auto';
  // The Audio element starts downloading as soon as src is set. We don't
  // call play(): that would actually play sound. Just prime the cache.
  preloadedAudio = a;
  preloadedText = text;
}

export function speakGoogle(text, rate = 1.0) {
  return new Promise((resolve) => {
    if (googleAudio) { googleAudio.pause(); googleAudio = null; }
    // Reuse the preloaded element if it matches: avoids a fresh network round trip
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
    a.onended = () => { googleAudio = null; resolve(); };
    a.onerror = () => {
      googleAudio = null;
      speakBrowser(text, rate).then(resolve);
    };
    googleAudio = a;
    a.play().catch(() => {
      googleAudio = null;
      speakBrowser(text, rate).then(resolve);
    });
  });
}


export async function speak(text, rate, btnEl) {
  const fn = S.voicePref === 'google' ? speakGoogle : speakBrowser;
  if (btnEl) btnEl.classList.add('playing');
  try { await fn(text, rate); }
  finally { if (btnEl) btnEl.classList.remove('playing'); }
}

/* ============================================================
   Sound effects (Web Audio API — generated, no files)
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
  // Two short sine notes: E5 then B5: small, pleasant, not jarring
  const notes = [
    { freq: 659.25, start: 0,    dur: 0.10 },  // E5
    { freq: 987.77, start: 0.08, dur: 0.14 },  // B5
  ];
  for (const n of notes) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = n.freq;
    // Tiny attack/release envelope to avoid clicks
    gain.gain.setValueAtTime(0, now + n.start);
    gain.gain.linearRampToValueAtTime(0.12, now + n.start + 0.01);
    gain.gain.linearRampToValueAtTime(0, now + n.start + n.dur);
    osc.connect(gain).connect(ctx.destination);
    osc.start(now + n.start);
    osc.stop(now + n.start + n.dur);
  }
}

/* ============================================================
   Answer normalization for typing mode
   ============================================================ */
