import { ensureVoices } from './audio.js';
import { dbClear } from './db.js';
import { persistBatch, saveMeta } from './persistence.js';
import { computeBandProgress, render } from './render.js';
import { advance, buildPool } from './scheduler.js';
import { isMasteredP } from './srs.js';
import { S } from './state.js';
import { $, escapeHtml, todayStr } from './util.js';

export function openSettings() {
  $('modal-content').innerHTML = `
    <h3>Practice mode</h3>
    <div class="modal-row">
      <label>
        Always use multiple choice
        <span class="desc">Skip typing. Choose from 4 options every time. (3 XP per correct answer)</span>
      </label>
      <label class="tog"><input type="checkbox" id="set-alwaysmcq" ${S.alwaysMcq?'checked':''}><span class="slider"></span></label>
    </div>

    <h3>Batch size</h3>
    <div class="modal-row">
      <label>Cards per batch
        <span class="desc">How many cards you focus on at once. Smaller = tighter repetition before introducing new vocab. Larger = more variety per batch.</span>
      </label>
      <select id="set-batchsize">
        ${[5, 8, 10, 15, 20, 30].map(n =>
          `<option value="${n}" ${S.batchSize===n?'selected':''}>${n} cards</option>`
        ).join('')}
      </select>
    </div>

    <h3>Daily new cards</h3>
    <div class="modal-row">
      <label>New cards introduced per day
        <span class="desc">Anki-style cap. Once you've been introduced to this many new cards today, batches only pull from reviews. Lower = better retention, slower progress. Higher = faster progress, more review burden later.</span>
      </label>
      <select id="set-dailynewlimit">
        ${[5, 10, 15, 20, 30, 50, 100].map(n =>
          `<option value="${n}" ${S.dailyNewLimit===n?'selected':''}>${n} new cards</option>`
        ).join('')}
      </select>
    </div>

    <h3>Daily goal</h3>
    <div class="modal-row">
      <label>XP target per day
        <span class="desc">Hit this each day to keep your streak alive.</span>
      </label>
      <select id="set-dailygoal">
        ${[20, 50, 100, 200, 300, 500].map(n =>
          `<option value="${n}" ${S.dailyGoal===n?'selected':''}>${n} XP</option>`
        ).join('')}
      </select>
    </div>

    <h3>Audio</h3>
    <div class="modal-row">
      <label>Voice source
        <span class="desc">Google sounds smoother but rate-limits. Browser uses your OS voices.</span>
      </label>
      <select id="set-voice">
        <option value="browser" ${S.voicePref==='browser'?'selected':''}>Browser TTS</option>
        <option value="google"  ${S.voicePref==='google'?'selected':''}>Google Translate</option>
      </select>
    </div>
    <div class="modal-row">
      <label>French voice</label>
      <select id="set-voicename"></select>
    </div>

    <h3 id="settings-ai">AI Explain</h3>
    <div class="modal-row">
      <label>Provider
        <span class="desc">Gemini's free tier (1500 calls/day) needs no payment. Anthropic charges per call but is more polished.</span>
      </label>
      <select id="set-provider">
        <option value="gemini"    ${S.explainProvider==='gemini'?'selected':''}>Google Gemini (free)</option>
        <option value="anthropic" ${S.explainProvider==='anthropic'?'selected':''}>Anthropic Claude</option>
      </select>
    </div>
    <div class="modal-row" id="row-anthropic-key" ${S.explainProvider==='gemini'?'hidden':''}>
      <label>Anthropic API key
        <span class="desc">Get one at console.anthropic.com.</span>
      </label>
      <input type="password" id="set-apikey" placeholder="sk-ant-..." value="${escapeHtml(S.apiKey || '')}">
    </div>
    <div class="modal-row" id="row-anthropic-model" ${S.explainProvider==='gemini'?'hidden':''}>
      <label>Anthropic model
        <span class="desc">Haiku ~$0.002/click. Sonnet ~$0.012/click.</span>
      </label>
      <select id="set-model">
        <option value="claude-haiku-4-5-20251001"   ${S.explainModel==='claude-haiku-4-5-20251001'?'selected':''}>Claude Haiku 4.5</option>
        <option value="claude-sonnet-4-6"           ${S.explainModel==='claude-sonnet-4-6'?'selected':''}>Claude Sonnet 4.6</option>
      </select>
    </div>
    <div class="modal-row" id="row-gemini-key" ${S.explainProvider!=='gemini'?'hidden':''}>
      <label>Gemini API key
        <span class="desc">Free at aistudio.google.com/apikey. No credit card.</span>
      </label>
      <input type="password" id="set-geminikey" placeholder="AIza..." value="${escapeHtml(S.geminiKey || '')}">
    </div>

    <h3>Display</h3>
    <div class="modal-row">
      <label>Text size
        <span class="desc">Adjust the size of the French sentence and translation.</span>
      </label>
      <select id="set-fontsize">
        <option value="sm" ${S.fontSize==='sm'?'selected':''}>Small</option>
        <option value="md" ${S.fontSize==='md'?'selected':''}>Medium</option>
        <option value="lg" ${S.fontSize==='lg'?'selected':''}>Large</option>
      </select>
    </div>

    <h3>Contributions</h3>
    <div class="modal-row">
      <label>Repository (optional)
        <span class="desc">If you set this to <code>owner/repo</code> on GitHub, the dismiss popover gets a "Report on GitHub" link that opens a pre-filled issue.</span>
      </label>
      <input type="text" id="set-repourl" placeholder="alice/en-contexte" value="${escapeHtml(S.repoUrl || '')}">
    </div>
    <div class="modal-row">
      <label>Hidden sentences
        <span class="desc">${S.dismissed.size} sentence${S.dismissed.size === 1 ? '' : 's'} hidden on this device.</span>
      </label>
      <button class="danger" id="btn-clear-dismissed" ${S.dismissed.size === 0 ? 'disabled' : ''}>Clear list</button>
    </div>

    <h3>Data</h3>
    <div class="modal-row">
      <label>Tutorial
        <span class="desc">A quick walkthrough of the typing UI, accent buttons, and how progress works.</span>
      </label>
      <button id="btn-show-tutorial">Show tutorial again</button>
    </div>
    <div class="modal-row">
      <label>Stored locally
        <span class="desc">${S.progress.size} sentences seen · ${S.totalXP.toLocaleString()} total XP · ${S.dayStreak}d streak</span>
      </label>
      <button class="danger" id="btn-reset">Reset progress</button>
    </div>

    <button class="modal-close" id="btn-close">Done</button>
  `;

  // populate voice list
  ensureVoices().then(voices => {
    const fr = voices.filter(v => /^fr/i.test(v.lang));
    const sel = $('set-voicename');
    if (!sel) return;
    if (!fr.length) {
      sel.innerHTML = '<option>(no French voices on this device)</option>';
      sel.disabled = true;
      return;
    }
    sel.innerHTML = fr.map(v =>
      `<option value="${escapeHtml(v.name)}" ${S.voiceFr && S.voiceFr.name===v.name ? 'selected':''}>${escapeHtml(v.name)} · ${v.lang}</option>`
    ).join('');
    sel.addEventListener('change', () => {
      const found = fr.find(v => v.name === sel.value);
      if (found) S.voiceFr = found;
      saveMeta();
    });
  });

  $('set-alwaysmcq').addEventListener('change', e => {
    S.alwaysMcq = e.target.checked; saveMeta(); render();
  });
  $('set-voice').addEventListener('change', e => {
    S.voicePref = e.target.value; saveMeta(); render();
  });
  $('set-apikey').addEventListener('input', e => {
    S.apiKey = e.target.value.trim(); saveMeta();
  });
  $('set-model').addEventListener('change', e => {
    S.explainModel = e.target.value; saveMeta();
  });
  $('set-geminikey').addEventListener('input', e => {
    S.geminiKey = e.target.value.trim(); saveMeta();
  });
  $('set-provider').addEventListener('change', e => {
    S.explainProvider = e.target.value;
    // Show/hide the provider-specific rows without re-rendering the whole modal
    const useGemini = S.explainProvider === 'gemini';
    $('row-anthropic-key').hidden   = useGemini;
    $('row-anthropic-model').hidden = useGemini;
    $('row-gemini-key').hidden      = !useGemini;
    saveMeta();
    render();
  });
  $('set-dailygoal').addEventListener('change', e => {
    S.dailyGoal = parseInt(e.target.value, 10);
    saveMeta(); render();
  });
  $('set-batchsize').addEventListener('change', e => {
    S.batchSize = parseInt(e.target.value, 10);
    saveMeta();
    // The change applies to the *next* batch. The current one runs to
    // completion at its original size so we don't strand the user mid-progress.
  });
  $('set-dailynewlimit').addEventListener('change', e => {
    S.dailyNewLimit = parseInt(e.target.value, 10);
    saveMeta();
    // Change applies on next batch: if the user has hit the new old cap and
    // is on the done-today screen, raising the cap won't help until they
    // close settings and the next advance() fires (which it will when
    // settings closes).
  });
  $('set-fontsize').addEventListener('change', e => {
    S.fontSize = e.target.value;
    document.body.dataset.fontsize = S.fontSize;
    saveMeta();
  });
  $('set-repourl').addEventListener('input', e => {
    S.repoUrl = e.target.value.trim();
    saveMeta();
  });
  $('btn-clear-dismissed').addEventListener('click', async () => {
    if (!confirm(`Restore all ${S.dismissed.size} hidden sentences?`)) return;
    S.dismissed = new Set();
    S.batch = null;          // rebuild on next advance
    await saveMeta();
    await persistBatch();
    closeSettings();
    advance();
  });
  $('btn-reset').addEventListener('click', async () => {
    if (!confirm('Reset all progress? This cannot be undone.')) return;
    await dbClear('progress');
    S.progress = new Map();
    S.explanations = new Map();
    S.totalXP = 0;
    S.seen = 0; S.correct = 0; S.streak = 0; S.recent = [];
    S.daily = new Map();
    S.dailyNew = new Map();
    S.dayStreak = 0;
    S.lastActiveDate = null;
    S.batch = null;
    await saveMeta();
    await persistBatch();
    closeSettings();
    advance();
  });
  $('btn-show-tutorial').addEventListener('click', async () => {
    closeSettings();
    // Defer slightly so the modal close animation finishes before the
    // tutorial overlay appears
    setTimeout(() => {
      import('./tutorial.js').then(m => m.startTutorial());
    }, 150);
  });
  $('btn-close').addEventListener('click', closeSettings);
  $('modal-bg').classList.add('show');
}


export function closeSettings() { closeModal(); }

export function closeModal() { $('modal-bg').classList.remove('show'); }

/* ============================================================
   Stats modal — mastery breakdown per band, last-14-days heatmap, totals
   ============================================================ */

export function openStats() {
  // Compute totals
  let totalSeen = 0, totalCorrect = 0, totalMastered = 0, totalUnique = 0;
  let dueNow = 0;
  const now = Date.now();
  for (const [, p] of S.progress) {
    totalSeen   += p.seen;
    totalCorrect += p.correct;
    if (isMasteredP(p)) totalMastered++;
    if ((p.state === 'learning' || p.state === 'review') && p.due <= now) dueNow++;
    totalUnique++;
  }
  const acc = totalSeen ? Math.round(100 * totalCorrect / totalSeen) : 0;

  // Band breakdown
  const bandRows = [];
  for (let b = 1; b <= S.data.bands; b++) {
    const stats = computeBandProgress(b);
    const pct = stats.total ? Math.round(100 * stats.mastered / stats.total) : 0;
    bandRows.push(`
      <div class="band-bar">
        <span>Band ${b}</span>
        <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>
        <span class="count">${stats.mastered} / ${stats.total}</span>
      </div>`);
  }

  // 14-day heatmap (today on the right). XP buckets:
  //  level 0 = 0 XP, 1 = 1..goal/2, 2 = goal/2..goal, 3 = goal..2*goal, 4 = 2*goal+
  const today = todayStr();
  const heat = [];
  const goal = Math.max(1, S.dailyGoal);
  for (let i = 13; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const ds = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    const xp = S.daily.get(ds) || 0;
    let lvl = 0;
    if (xp > 0)         lvl = 1;
    if (xp >= goal/2)   lvl = 2;
    if (xp >= goal)     lvl = 3;
    if (xp >= goal*2)   lvl = 4;
    heat.push(`<div class="heat-cell" data-level="${lvl}" title="${ds}: ${xp} XP"></div>`);
  }

  $('modal-content').innerHTML = `
    <h3>Overview</h3>
    <div class="stats-grid">
      <div class="stats-card">
        <div class="label">Total XP</div>
        <div class="value">${S.totalXP.toLocaleString()}</div>
      </div>
      <div class="stats-card">
        <div class="label">Day Streak</div>
        <div class="value">${S.dayStreak} ${S.dayStreak === 1 ? 'day' : 'days'}</div>
        <div class="sub">${(S.daily.get(today) || 0)}/${S.dailyGoal} XP today</div>
      </div>
      <div class="stats-card">
        <div class="label">Due now</div>
        <div class="value">${dueNow.toLocaleString()}</div>
        <div class="sub">cards waiting for review</div>
      </div>
      <div class="stats-card">
        <div class="label">Accuracy</div>
        <div class="value">${acc}%</div>
        <div class="sub">${totalCorrect.toLocaleString()} / ${totalSeen.toLocaleString()} correct</div>
      </div>
      <div class="stats-card">
        <div class="label">Mastered</div>
        <div class="value">${totalMastered.toLocaleString()}</div>
        <div class="sub">of ${totalUnique.toLocaleString()} seen</div>
      </div>
    </div>

    <h3>Last 14 days</h3>
    <div class="heat">${heat.join('')}</div>

    <h3>Mastery by band</h3>
    <div class="band-bars">${bandRows.join('')}</div>

    <button class="modal-close" id="btn-close">Done</button>
  `;
  $('btn-close').addEventListener('click', closeModal);
  $('modal-bg').classList.add('show');
}

/* ============================================================
   Persistence
   ============================================================ */