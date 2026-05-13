import { pickFrenchVoice, speak } from './audio.js';
import { showCover } from './cover.js';
import { openDB } from './db.js';
import { loadBatch, loadMeta, loadProgress, reconcileStreakAtBoot } from './persistence.js';
import { advance, mcqOpts, submitMcq } from './scheduler.js';
import { closeModal, openSettings, openStats } from './settings.js';
import { S } from './state.js';
import { loadIpa } from './tokenize.js';
import { $, escapeHtml } from './util.js';

/* ============================================================
   Global keyboard handling
   ============================================================ */

document.addEventListener('keydown', e => {
  if ($('modal-bg').classList.contains('show')) return;
  if (!S.current) return;
  if (S.answered) {
    if (e.key === 'Enter' || e.key === ' ') {
      // Don't double-handle Enter inside an input; the input's own listener
      // takes priority and calls stopPropagation.
      if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
      e.preventDefault();
      advance();
    }
    return;
  }

  // "?" → switch to MCQ for this one card (same effect as the "I don't know" button).
  // Handled BEFORE the input-field guard so users can trigger it while typing.
  if (e.key === '?') {
    e.preventDefault();
    S.forceMcqOnce = true;
    // Blur the input so subsequent number keys land on the global handler
    if (e.target && typeof e.target.blur === 'function') e.target.blur();
    // Need to re-render so MCQ options appear. The MCQ-mode flag is checked
    // each render() call.
    import('./render.js').then(m => m.render());
    return;
  }

  // From here on, if the user is typing into an input field, let the field
  // handle the key itself.
  if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) {
    return;
  }

  const useMcq = S.alwaysMcq || S.forceMcqOnce;

  if (e.key === 'r' || e.key === 'R') {
    e.preventDefault();
    speak(S.current.fr, 1.0, $('btn-play'));
    return;
  }

  if (useMcq) {
    if (e.key >= '1' && e.key <= '4') {
      const opts = mcqOpts(S.current);
      const i = parseInt(e.key, 10) - 1;
      if (opts[i] != null) { e.preventDefault(); submitMcq(opts[i]); }
    }
  }
});

/* ============================================================
   Boot
   ============================================================ */

export async function load() {
  // load sentences
  try {
    const res = await fetch('data/sentences.json');
    if (!res.ok) throw new Error('fetch failed: ' + res.status);
    S.data = await res.json();
  } catch (err) {
    $('app').innerHTML = `
      <div class="error">
        <strong>Couldn't load <code>data/sentences.json</code>.</strong><br><br>
        Make sure <code>data/sentences.json</code> exists next to this
        <code>index.html</code> file, and you're opening this page through a
        local server (browsers block <code>fetch()</code> on <code>file://</code>).<br><br>
        Quick start:<br>
        &nbsp;&nbsp;<code>python3 -m http.server 8000</code>
        <br>
        &nbsp;&nbsp;then open <code>http://localhost:8000</code><br><br>
        <span style="color:var(--ink-soft)">${escapeHtml(String(err))}</span>
      </div>`;
    return;
  }

  await openDB();
  await loadMeta();
  await loadProgress();
  await loadBatch();
  reconcileStreakAtBoot();

  // Apply user's font-size preference to <body> (CSS rules read it via [data-fontsize])
  document.body.dataset.fontsize = S.fontSize || 'md';

  if (!S.voiceFr) S.voiceFr = await pickFrenchVoice();

  // Lazy-load IPA dictionary in background
  loadIpa().catch(() => {});

  // Show cover on every fresh page load. The brand link or a back gesture can
  // return here later; the gameplay state is preserved in IndexedDB regardless.
  showCover();

  $('btn-settings').addEventListener('click', openSettings);
  $('btn-stats').addEventListener('click', openStats);
  $('brand-link').addEventListener('click', (e) => { e.preventDefault(); showCover(); });
  $('modal-bg').addEventListener('click', e => {
    if (e.target.id === 'modal-bg') closeModal();
  });
}

// Kick everything off
load();
