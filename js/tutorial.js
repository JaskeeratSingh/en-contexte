import { saveMeta } from './persistence.js';
import { S } from './state.js';
import { $ } from './util.js';

/* ============================================================
   First-use tutorial

   Spotlight + tooltip walkthrough on the user's first card. Each step
   highlights one element (a "cutout" in a dimmed backdrop) and shows a
   tooltip next to it.

   Lifecycle:
     - maybeStartTutorial() is called once on the first card render after
       boot. It bails out unless this is a brand-new user (no progress)
       and the tutorial hasn't been dismissed before.
     - startTutorial() can also be triggered manually from settings
       ("show tutorial again").
   ============================================================ */

const STEPS = [
  {
    selector: null,
    title: 'Welcome to En Contexte',
    body:  "Quick 60-second tour. Skip anytime.",
    cta:   "Show me",
  },
  {
    selector: '.sentence',
    title: 'The sentence',
    body:  'Each card has one word missing. Read the French, glance at the English below it for context.',
  },
  {
    selector: '.type-input-wrap',
    title: 'Type the missing word',
    body:  'Press Enter to submit. As you type, each letter lights up green if right. Any wrong letter and the whole word turns red.',
  },
  {
    selector: '#accent-row',
    title: 'No French keyboard? No problem.',
    body:  "Click these to insert accented characters. Accents matter: typing 'e' instead of 'é' counts as wrong.",
  },
  {
    selector: '#btn-dunno',
    title: 'Stuck?',
    body:  'Click here (or press ?) to switch to multiple choice for this card. Then press 1–4 to pick. You earn fewer points than typing, but you keep moving.',
  },
  {
    selector: '#btn-play',
    title: 'Listen, but careful',
    body:  "Plays the French sentence. Useful for pronunciation, but the audio will reveal the missing word. Save it for after you've answered.",
  },
  {
    selector: '.batch-meta',
    title: 'How progress works',
    body:  "Type each card correctly 3 times in a row to graduate it from this batch. Only then do new cards appear. Wrong answers reset the streak.",
  },
  {
    selector: '#btn-explain-preview',
    title: 'Free AI tutor',
    body:  "After answering, click Explain for a tutor-style breakdown of the sentence: grammar, conjugation, idioms. Google's Gemini gives you 1500 free explanations per day. Grab a key at aistudio.google.com/apikey (no credit card) and paste it in settings whenever you're ready.",
  },
  {
    selector: '#btn-settings',
    title: 'Settings',
    body:  "Batch size, daily new-card cap, voice preference, AI Explain key, and more. Stats are next to it.",
  },
  {
    selector: null,
    title: "That's it",
    body:  "Today's cards will come back tomorrow for review, then in 3 days, then further out as you remember them. Real spaced repetition, which works best if you keep showing up.",
    cta:   "Start learning",
  },
];

let _stepIndex = 0;
let _resizeHandler = null;

export function maybeStartTutorial() {
  if (S.tutorialDone) return;
  if (S.progress && S.progress.size > 0) return;
  setTimeout(() => startTutorial(), 350);
}

export function startTutorial() {
  _stepIndex = 0;
  ensureOverlay();
  showStep(0);
  _resizeHandler = () => showStep(_stepIndex);
  window.addEventListener('resize', _resizeHandler);
}

function ensureOverlay() {
  if ($('tut-overlay')) return;
  const overlay = document.createElement('div');
  overlay.id = 'tut-overlay';
  overlay.className = 'tut-overlay';
  overlay.innerHTML = `
    <div class="tut-cutout" id="tut-cutout"></div>
    <div class="tut-tip" id="tut-tip">
      <div class="tut-step" id="tut-step"></div>
      <h4 id="tut-title"></h4>
      <p id="tut-body"></p>
      <div class="tut-actions">
        <button class="tut-skip" id="tut-skip">Skip tutorial</button>
        <div style="flex:1"></div>
        <button class="tut-prev" id="tut-prev">← Back</button>
        <button class="tut-next" id="tut-next">Next →</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  $('tut-skip').addEventListener('click', endTutorial);
  $('tut-prev').addEventListener('click', () => { if (_stepIndex > 0) showStep(_stepIndex - 1); });
  $('tut-next').addEventListener('click', () => {
    if (_stepIndex >= STEPS.length - 1) endTutorial();
    else showStep(_stepIndex + 1);
  });
}

function showStep(i) {
  _stepIndex = i;
  const step = STEPS[i];
  const cutout = $('tut-cutout');
  const tip    = $('tut-tip');

  $('tut-step').textContent = `${i + 1} of ${STEPS.length}`;
  $('tut-title').textContent = step.title;
  $('tut-body').textContent  = step.body;

  const nextBtn = $('tut-next');
  const prevBtn = $('tut-prev');
  nextBtn.textContent = step.cta
    || (i === STEPS.length - 1 ? 'Done' : 'Next →');
  prevBtn.style.visibility = i === 0 ? 'hidden' : 'visible';

  if (step.selector) {
    const el = document.querySelector(step.selector);
    if (el) {
      const r = el.getBoundingClientRect();
      const pad = 8;
      cutout.style.display = 'block';
      cutout.style.left   = `${Math.max(0, r.left - pad)}px`;
      cutout.style.top    = `${Math.max(0, r.top - pad)}px`;
      cutout.style.width  = `${r.width  + pad * 2}px`;
      cutout.style.height = `${r.height + pad * 2}px`;
      positionTip(tip, r);
      return;
    }
  }
  cutout.style.display = 'none';
  tip.style.left = '50%';
  tip.style.top  = '50%';
  tip.style.transform = 'translate(-50%, -50%)';
}

function positionTip(tip, r) {
  tip.style.transform = 'none';
  tip.style.left = '0px';
  tip.style.top  = '0px';
  const tipRect = tip.getBoundingClientRect();
  const margin = 16;
  const viewportW = window.innerWidth;
  const viewportH = window.innerHeight;
  let top;
  if (r.bottom + margin + tipRect.height < viewportH) {
    top = r.bottom + margin;
  } else if (r.top - margin - tipRect.height > 0) {
    top = r.top - tipRect.height - margin;
  } else {
    top = Math.max(margin, viewportH - tipRect.height - margin);
  }
  let left = r.left + r.width / 2 - tipRect.width / 2;
  left = Math.max(margin, Math.min(left, viewportW - tipRect.width - margin));
  tip.style.left = `${left}px`;
  tip.style.top  = `${top}px`;
}

function endTutorial() {
  const overlay = $('tut-overlay');
  if (overlay) overlay.remove();
  if (_resizeHandler) {
    window.removeEventListener('resize', _resizeHandler);
    _resizeHandler = null;
  }
  S.tutorialDone = true;
  saveMeta();
}