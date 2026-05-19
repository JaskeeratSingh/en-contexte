import { speak } from './audio.js';
import { dismissCurrent, renderReportPopover, submitReport } from './dismiss.js';
import { renderExplainBlock, renderExplainBlockPreview, requestExplain } from './explain.js';
import { iconPlay } from './icons.js';
import { persistBatch, saveMeta } from './persistence.js';
import { advance, buildPool, mcqOpts, recordAnswer, submitMcq, submitTyped } from './scheduler.js';
import { openSettings } from './settings.js';
import { isMasteredP } from './srs.js';
import { BATCH_GRADUATE_STREAK, POINTS_MCQ, POINTS_TYPED, S } from './state.js';
import { ipaForSentence, loadIpa, renderSentence } from './tokenize.js';
import { $, escapeHtml, todayStr } from './util.js';


/** Compact batch progress indicator for the meta row.
 *  Returns " · Batch 3/10 · ✓✓ 2/3" or "" if no batch / card not in batch. */
export function batchMetaHtml(r) {
  if (!S.batch) return '';
  const total = S.batch.ids.length;
  const grad  = S.batch.graduated.length;
  let txt = ` · Batch ${grad}/${total}`;
  if (S.batch.ids.includes(r.id) && !S.batch.graduated.includes(r.id)) {
    const streak = S.batch.streaks[r.id] || 0;
    const ticks = '✓'.repeat(streak) + '·'.repeat(BATCH_GRADUATE_STREAK - streak);
    txt += ` · this card ${ticks}`;
  }
  return `<span class="batch-meta">${txt}</span>`;
}

export function render() {
  if (!S.data) {
    $('app').innerHTML = '<div class="loading">loading sentences…</div>';
    return;
  }
  if (!S.current) {
    $('app').innerHTML = '<div class="loading">starting…</div>';
    return;
  }

  const r = S.current;
  const p = S.progress.get(r.id);
  const isMastered = isMasteredP(p);

  // pick rendering for the cloze slot
  let fillWith = null;
  if (S.answered) {
    if (S.lastWasCorrect) {
      fillWith = { text: r.ans, status: 'correct' };
    } else {
      // show what they typed (if typed) struck-through, plus correct
      fillWith = { text: r.ans, status: 'correct' };
    }
  }

  // Use MCQ if always-mcq setting, or user pressed "don't know"
  const useMcq = S.alwaysMcq || S.forceMcqOnce;

  // Band progress bar
  const bandStats = computeBandProgress(S.band);

  $('app').innerHTML = `
    <div class="progress">${recentBar()}</div>

    <div class="card">
      <div class="meta">
        <span>Band ${r.band} · top ${(r.band-1)*1000+1}–${r.band*1000}${batchMetaHtml(r)}</span>
        <div class="right">
          ${isMastered ? '<span class="mastered">★ mastered</span>' : ''}
          <span class="pill">freq #${r.rank}</span>
          <button class="card-report" id="btn-report" title="Report a problem with this sentence">report</button>
        </div>
      </div>

      <div class="sentence">${renderSentence(r, fillWith)}</div>
      ${S.showIpa && S.answered
        ? `<div class="ipa">${escapeHtml(ipaForSentence(r.fr))}</div>`
        : ''}
      <div class="translation">${escapeHtml(r.en)}</div>

      <div class="audio-row">
        <button class="audio-btn" id="btn-play"${S.answered ? '' : ' data-warn="Reveals the answer. Try &quot;I don\'t know&quot; if stuck"'}>${iconPlay()} Play</button>
        <button class="audio-btn" id="btn-half"${S.answered ? '' : ' data-warn="Reveals the answer. Try &quot;I don\'t know&quot; if stuck"'}>${iconPlay()} Slow</button>
        <button class="audio-btn ${S.showIpa ? 'on' : ''}" id="btn-ipa"
                title="Toggle IPA. Only shown after answering">
          /IPA/
        </button>
      </div>

      <div class="input-area">
        ${S.answered
          ? renderAnsweredFeedback(r)
          : useMcq
            ? renderMcqInput(r)
            : renderTypeInput(r)
        }
      </div>

      ${S.answered ? renderExplainBlock(r) : renderExplainBlockPreview()}
      ${S.showDismissPopover ? renderReportPopover(r) : ''}
    </div>

    <div class="controls">
      <div class="band-picker">
        <label>Level</label>
        ${Array.from({length: S.data.bands}, (_, i) => i + 1).map(b => {
          const bs = computeBandProgress(b);
          const cls = (b === S.band ? 'active' : '') + (bs.mastered > 0 ? ' has-progress' : '');
          return `<button data-band="${b}" class="${cls}" title="${bs.mastered}/${bs.total} mastered"><span>${b}</span><span class="dot"></span></button>`;
        }).join('')}
      </div>
      <div class="band-progress">
        <span>${bandStats.mastered}/${bandStats.total} mastered</span>
        <div class="bar"><div style="width:${100*bandStats.mastered/Math.max(1,bandStats.total)}%"></div></div>
      </div>
    </div>

    <p class="hint">
      ${useMcq
        ? '<kbd>1</kbd>–<kbd>4</kbd> answer · <kbd>Enter</kbd> next · <kbd>R</kbd> replay'
        : 'Type the missing word · <kbd>Enter</kbd> submit/next · <kbd>R</kbd> replay'}
    </p>
  `;

  // wire events
  $('btn-play').addEventListener('click', e => speak(r.fr, 1.0, e.currentTarget));
  $('btn-half').addEventListener('click', e => speak(r.fr, 0.6, e.currentTarget));
  $('btn-ipa').addEventListener('click', async () => {
    S.showIpa = !S.showIpa;
    if (S.showIpa) await loadIpa();
    saveMeta();
    render();
  });
  document.querySelectorAll('.band-picker button').forEach(b => {
    b.addEventListener('click', async () => {
      S.band = parseInt(b.dataset.band, 10);
      S.batch = null;          // dissolve current batch — new band, new batch
      await persistBatch();
      buildPool();
      advance();
      saveMeta();
    });
  });

  // Explain button (present after answering)
  const exb = $('btn-explain');
  if (exb) exb.addEventListener('click', () => requestExplain(r.id));
  const exbNeedKey = $('btn-explain-need-key');
  if (exbNeedKey) exbNeedKey.addEventListener('click', openSettings);
  // Explain preview button (present before answering): clicking reveals the
  // answer (counts as giving up) then immediately triggers explain.
  const exbPreview = $('btn-explain-preview');
  if (exbPreview) exbPreview.addEventListener('click', async () => {
    // Record as wrong (the user didn't type an answer)
    S.lastChoice = null;
    await recordAnswer(false, 'type');
    // Now request the explanation
    requestExplain(r.id);
  });

  // Report flow: "report" button in card meta opens the report popover.
  // The popover has: submit (opens GitHub issue), hide for me (local dismiss),
  // and cancel.
  const reportBtn = $('btn-report');
  if (reportBtn) reportBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    S.showDismissPopover = true;
    render();
  });
  const reportSubmit = $('btn-report-submit');
  if (reportSubmit) reportSubmit.addEventListener('click', () => {
    submitReport(r);
    // Also hide the card locally after reporting so the user doesn't see it again
    dismissCurrent();
  });
  const reportHide = $('btn-report-hide');
  if (reportHide) reportHide.addEventListener('click', dismissCurrent);
  const reportCancel = $('btn-report-cancel');
  if (reportCancel) reportCancel.addEventListener('click', () => {
    S.showDismissPopover = false;
    render();
  });
  // Show/hide the translation input based on the selected reason
  const reasonSelect = $('report-reason');
  const translationRow = $('report-translation-row');
  if (reasonSelect && translationRow) {
    const toggleTranslation = () => {
      translationRow.style.display = reasonSelect.value === 'mistranslation' ? 'block' : 'none';
    };
    toggleTranslation();
    reasonSelect.addEventListener('change', toggleTranslation);
  }
  // Click outside the popover closes it
  if (S.showDismissPopover) {
    const closeOnOutside = (ev) => {
      const pop = $('report-popover');
      const rbtn = $('btn-report');
      if (!pop) return;
      if (pop.contains(ev.target)) return;
      if (rbtn && rbtn.contains(ev.target)) return;
      S.showDismissPopover = false;
      document.removeEventListener('click', closeOnOutside, true);
      render();
    };
    setTimeout(() => document.addEventListener('click', closeOnOutside, true), 0);
  }

  if (S.answered) {
    const nb = $('btn-next');
    if (nb) nb.addEventListener('click', advance);
  } else if (useMcq) {
    document.querySelectorAll('.opt').forEach(b => {
      b.addEventListener('click', () => submitMcq(b.dataset.value));
    });
  } else {
    const ti = $('type-input');
    if (ti) {
      ti.focus();
      ti.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          // Critical: stop the same Enter keystroke from bubbling up to the
          // document-level handler, which would see S.answered === true after
          // submitTyped() runs and immediately advance to the next question.
          e.stopPropagation();
          submitTyped();
        }
      });
      // Live colored-overlay feedback: green up to the first wrong char,
      // then everything flips red.
      ti.addEventListener('input', updateTypeOverlay);
      // Initial render in case the input has any value (e.g. browser autofill)
      updateTypeOverlay();
    }
    // Accent-character helper buttons: clicking inserts the char at the
    // cursor position, dispatches input event so the overlay re-renders.
    document.querySelectorAll('.accent-btn').forEach(b => {
      b.addEventListener('mousedown', (e) => {
        // Prevent the click from stealing focus from the input
        e.preventDefault();
      });
      b.addEventListener('click', () => {
        const inp = $('type-input');
        if (!inp) return;
        const ch = b.dataset.char;
        const start = inp.selectionStart ?? inp.value.length;
        const end   = inp.selectionEnd   ?? inp.value.length;
        const v = inp.value;
        inp.value = v.slice(0, start) + ch + v.slice(end);
        inp.selectionStart = inp.selectionEnd = start + ch.length;
        inp.focus();
        inp.dispatchEvent(new Event('input', { bubbles: true }));
      });
    });
    const sb = $('btn-submit');
    if (sb) sb.addEventListener('click', submitTyped);
    const dn = $('btn-dunno');
    if (dn) dn.addEventListener('click', () => {
      S.forceMcqOnce = true; render();
    });
  }

  updateStats();
}


// French accent characters not on a US/UK keyboard, surfaced as click-to-insert
// buttons so users without a French keyboard can type accurately. Order:
// most common first (é before é-è-ê etc).
const ACCENT_CHARS = ['é', 'è', 'ê', 'ë', 'à', 'â', 'ç', 'î', 'ï', 'ô', 'ö', 'ù', 'û', 'ü', 'œ', 'æ'];

export function renderTypeInput(r) {
  return `
    <div class="type-row">
      <div class="type-input-wrap">
        <div class="type-input-overlay" id="type-overlay" aria-hidden="true"></div>
        <input type="text" id="type-input" class="type-input" autocomplete="off"
               autocorrect="off" autocapitalize="off" spellcheck="false"
               placeholder="type the missing word…">
      </div>
      <button class="dunno-btn" id="btn-submit" title="Submit">⏎</button>
      <button class="dunno-btn" id="btn-dunno" title="Press ? to switch to multiple choice">I don't know <kbd class="kbd-hint">?</kbd></button>
    </div>
    <div class="accent-row" id="accent-row">
      ${ACCENT_CHARS.map(c => `<button class="accent-btn" data-char="${c}" type="button" tabindex="-1">${c}</button>`).join('')}
    </div>
    <div class="feedback">
      <span>Type to earn ${POINTS_TYPED} pts · "I don't know" gives ${POINTS_MCQ} pts</span>
    </div>
  `;
}

/** Sync the colored overlay to the current input value, comparing char-by-char
 *  against the correct answer. The rule:
 *    - All chars match so far → render in green (matched-so-far state).
 *    - Any mismatch → ALL characters flip to red (whole-word-wrong state).
 *      The user can keep typing; nothing is blocked.
 *  Comparison is case-insensitive but diacritic-strict (é ≠ e). */
export function updateTypeOverlay() {
  const inp = $('type-input');
  const overlay = $('type-overlay');
  if (!inp || !overlay || !S.current) return;
  const typed = inp.value;
  const correct = S.current.ans;
  // Compare per char with same normalization the submit check uses (case-insensitive,
  // diacritics-strict). We compare lowercased forms but render the user's actual chars.
  let anyWrong = false;
  for (let i = 0; i < typed.length; i++) {
    const t = typed[i].toLowerCase();
    const c = (correct[i] || '').toLowerCase();
    if (t !== c) { anyWrong = true; break; }
  }
  // Also flag wrong if user has typed MORE chars than the answer (extra char counts as wrong)
  if (!anyWrong && typed.length > correct.length) anyWrong = true;
  const cls = anyWrong ? 'wrong-all' : 'matching';
  // Render each typed character as a span
  const spans = [];
  for (let i = 0; i < typed.length; i++) {
    spans.push(`<span>${escapeHtml(typed[i])}</span>`);
  }
  overlay.className = 'type-input-overlay ' + cls;
  overlay.innerHTML = spans.join('');
}


export function renderMcqInput(r) {
  const opts = mcqOpts(r);
  return `
    <div class="options">
      ${opts.map((o, i) => `
        <button class="opt" data-value="${escapeHtml(o)}">
          <span class="key">${i+1}</span>${escapeHtml(o)}
        </button>
      `).join('')}
    </div>
    <div class="feedback">
      <span>Pick the missing word · ${POINTS_MCQ} pts each</span>
    </div>
  `;
}


export function renderAnsweredFeedback(r) {
  const correct = S.lastWasCorrect;
  const mode = S.lastMode;
  const pts = correct ? (mode === 'type' ? POINTS_TYPED : POINTS_MCQ) : 0;
  const verdictText = correct
    ? (mode === 'type' ? '✓ correct (typed)' : '✓ correct')
    : `✗ answer: ${escapeHtml(r.ans)}` + (S.lastChoice ? ` · you wrote: "${escapeHtml(S.lastChoice)}"` : '');

  // If they answered via MCQ, show the option grid revealed; if typed, show their answer
  let body;
  if (mode === 'mcq') {
    const opts = mcqOpts(r);
    body = `
      <div class="options">
        ${opts.map(o => {
          let cls = 'opt revealed';
          if (o === r.ans) cls += ' correct';
          else if (!correct && o === S.lastChoice) cls += ' wrong';
          return `<button class="${cls}" disabled>
            <span class="key">·</span>${escapeHtml(o)}
          </button>`;
        }).join('')}
      </div>
    `;
  } else {
    const inputCls = correct ? 'right' : 'wrong';
    body = `
      <div class="type-row">
        <input type="text" class="type-input ${inputCls}" disabled
               value="${escapeHtml(S.lastChoice || '')}">
      </div>
    `;
  }

  return `
    ${body}
    <div class="feedback">
      <span class="verdict ${correct ? 'right' : 'wrong'}">${verdictText}</span>
      <span style="display:flex; gap:10px; align-items:center;">
        ${correct ? `<span class="pts">+${pts} XP</span>` : ''}
        <button class="next-btn" id="btn-next">Next  →</button>
      </span>
    </div>
  `;
}

/* ============================================================
   Explain (Anthropic API call from the browser)
   ============================================================ */


export function recentBar() {
  return Array.from({length: 12}, (_, i) => {
    const v = S.recent[i] || null;
    if (!v) return '<div></div>';
    return `<div class="done ${v === 'r' ? 'right' : 'wrong'}"></div>`;
  }).reverse().join('');
}


export function computeBandProgress(b) {
  const bandIds = new Set(
    (S.data?.sentences || []).filter(r => r.band === b).map(r => r.id)
  );
  let mastered = 0;
  let learning = 0;  // unique cards in learning or review-but-short-interval
  for (const [id, p] of S.progress) {
    if (!bandIds.has(id)) continue;
    if (isMasteredP(p)) mastered++;
    else if (p.state === 'learning' || p.state === 'review') learning++;
  }
  return { total: bandIds.size, mastered, learning };
}


/** End-of-day screen: nothing's due AND daily new-card cap is hit.
 *  Tells the user they've done their work for today, lets them either
 *  raise the cap, switch bands, or wait until tomorrow. */
export function renderDoneForToday() {
  const today = todayStr();
  const introducedToday = S.dailyNew.get(today) || 0;
  const xpToday = S.daily.get(today) || 0;
  const hitGoal = xpToday >= S.dailyGoal;

  // Count cards still in pool for current band so we can tell the user
  // how much vocabulary remains at this level
  let bandTotal = 0, bandSeen = 0;
  for (const r of S.pool) {
    bandTotal++;
    if (S.progress.has(r.id)) bandSeen++;
  }
  const bandRemaining = bandTotal - bandSeen;

  $('app').innerHTML = `
    <div class="done-today">
      <div class="done-mark">${hitGoal ? '✓' : '⏸'}</div>
      <h2>${hitGoal ? "You're done for today." : 'All caught up for now.'}</h2>
      <p class="done-sub">
        You've introduced <b>${introducedToday}</b> new ${introducedToday === 1 ? 'card' : 'cards'} today
        and cleared all the reviews.
        ${hitGoal
          ? `You hit your daily goal: <b>${xpToday}</b> XP.`
          : `You're at <b>${xpToday}</b>/${S.dailyGoal} XP today.`}
      </p>
      <p class="done-sub">
        ${bandRemaining > 0
          ? `Band ${S.band} has <b>${bandRemaining}</b> ${bandRemaining === 1 ? 'card' : 'cards'} you haven't seen yet. They'll come tomorrow at your current pace.`
          : `You've now seen every card in band ${S.band}. Try a higher band when you're ready.`}
      </p>
      <div class="done-actions">
        <button class="done-action primary" id="done-raise-cap">
          + raise today's limit by 10
        </button>
      </div>
      <div class="done-bands">
        <div class="done-bands-label">Or switch to another band</div>
        <div class="band-picker">
          ${Array.from({length: S.data.bands}, (_, i) => i + 1).map(b => {
            const bs = computeBandProgress(b);
            const cls = (b === S.band ? 'active' : '') + (bs.mastered > 0 ? ' has-progress' : '');
            return `<button data-band="${b}" class="${cls}" title="${bs.mastered}/${bs.total} mastered"><span>${b}</span><span class="dot"></span></button>`;
          }).join('')}
        </div>
      </div>
      <p class="done-hint">
        Spaced repetition works best when you stop. Come back tomorrow.
        The cards you just learned will be waiting.
      </p>
    </div>
  `;
  $('done-raise-cap').addEventListener('click', () => {
    S.dailyNewLimit += 10;
    saveMeta();
    advance();
  });
  // Wire up the band-picker buttons — clicking switches band, dissolves the
  // current batch (so the new band gets a fresh one), and advances.
  // We also raise the daily new-card cap by 10 because switching bands here
  // is an explicit "I want to keep going with something different" signal —
  // otherwise the global cap would just re-trigger the done screen for the
  // new band too.
  document.querySelectorAll('.done-bands .band-picker button').forEach(b => {
    b.addEventListener('click', async () => {
      const newBand = parseInt(b.dataset.band, 10);
      if (newBand === S.band) return;
      S.band = newBand;
      S.batch = null;
      S.dailyNewLimit += 10;
      await persistBatch();
      buildPool();
      advance();
      saveMeta();
    });
  });
  updateStats();
}


export function updateStats() {
  $('stat-xp').textContent = S.totalXP.toLocaleString();
  $('stat-acc').textContent = S.seen ? Math.round(100 * S.correct / S.seen) + '%' : '—';
  $('stat-streak').textContent = S.streak;
  $('stat-day-streak').textContent = S.dayStreak;

  // Daily progress ring
  const today = todayStr();
  const todayXP = S.daily.get(today) || 0;
  const goal = Math.max(1, S.dailyGoal);
  const pct = Math.min(1, todayXP / goal);
  const circumference = 44;  // 2π·7
  const ringFill = $('daily-ring-fill');
  if (ringFill) {
    ringFill.setAttribute('stroke-dashoffset', String(circumference * (1 - pct)));
    ringFill.style.stroke = pct >= 1 ? 'var(--accent-2)' : 'var(--accent)';
  }
  const chip = $('streak-chip');
  if (chip) {
    if (pct >= 1) chip.classList.add('live');
    else chip.classList.remove('live');
  }
}


export function flashXP(pts) {
  const target = $('stat-xp');
  if (!target) return;
  const rect = target.getBoundingClientRect();
  const el = document.createElement('div');
  el.className = 'xp-bump';
  el.textContent = `+${pts}`;
  el.style.left = (rect.right - 30) + 'px';
  el.style.top  = (rect.top + window.scrollY - 4) + 'px';
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 700);
}