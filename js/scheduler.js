import { playCorrectChime, preloadGoogleAudio, speak } from './audio.js';
import { dbPut } from './db.js';
import { bumpDaily, persistBatch, saveMeta } from './persistence.js';
import { flashXP, render, renderDoneForToday } from './render.js';
import { applyBatchOutcomeToSrs, newProgressFor, srsApply } from './srs.js';
import { BATCH_GRADUATE_STREAK, POINTS_MCQ, POINTS_TYPED, S, STICKY_AUTOGRAD_ATTEMPTS } from './state.js';
import { maybeStartTutorial } from './tutorial.js';
import { $, checkTypedAnswer, todayStr } from './util.js';

export function buildPool() {
  if (!S.data) { S.pool = []; return; }
  S.pool = S.data.sentences.filter(r => r.band === S.band);
  if (!S.pool.length) S.pool = S.data.sentences.slice();
}

/* ============================================================
   Spaced repetition scheduler

   Anki-style SM-2 simplified: no manual difficulty rating. We derive
   the implicit difficulty from how the user got it right:
     - typed correctly = "good" (full bump)
     - MCQ correctly  = "hard" (smaller bump — they had hints)
     - wrong (any)    = "again" (back to learning)

   Card states:
     'new'      — never seen; not yet due
     'learning' — recently introduced or recently failed; short reviews
     'review'   — graduated; interval grows by ease factor each success

   Learning steps: 10 min → 1 day → graduates with 3-day initial interval.

   We never "delete" a card. Mastered cards just have intervals so long
   they hardly ever surface (months/years). New cards from the current
   band fill the gap when nothing's due.
   ============================================================ */


/** Build a fresh batch from the current band. Mix of due reviews + new cards,
 *  with the new-card portion capped by S.dailyNewLimit per day. */
export function buildBatch() {
  const now = Date.now();
  const today = todayStr();
  const N = Math.max(1, Math.min(50, S.batchSize | 0));

  // Find due cards (learning + review) in the current band that we haven't
  // already finished today
  const dueIds = [];
  const seenIds = new Set();
  for (const [id, p] of S.progress) {
    if (S.dismissed.has(id)) continue;
    seenIds.add(id);
    const row = S.data.sentences.find(r => r.id === id);
    if (!row || row.band !== S.band) continue;
    if ((p.state === 'learning' || p.state === 'review') && p.due <= now) {
      dueIds.push(row);
    }
  }
  // Sort by due time: most overdue first
  dueIds.sort((a, b) => S.progress.get(a.id).due - S.progress.get(b.id).due);

  // New cards: not yet seen, rarest first
  const newCards = S.pool
    .filter(r => !seenIds.has(r.id) && !S.dismissed.has(r.id))
    .sort((a, b) => a.rank - b.rank);

  // Apply the daily new-card cap. This is the Anki-style throttle: once the
  // user has been *introduced* to dailyNewLimit fresh cards today, we stop
  // pulling new ones until tomorrow. Batches then become all-review until
  // the review pile is cleared too.
  const introducedToday = S.dailyNew.get(today) || 0;
  const newAvailableToday = Math.max(0, S.dailyNewLimit - introducedToday);

  // Mix: aim for half-half when both are plentiful AND the daily new cap
  // hasn't been hit. If reviews are scarce, fill with new (subject to cap).
  // If the cap is hit, the batch is review-only.
  const halfNew = Math.ceil(N / 2);
  const newTarget = Math.min(newCards.length, newAvailableToday, halfNew);
  // Top up with reviews to fill the batch
  const reviewFill = Math.min(dueIds.length, N - newTarget);
  // If still room and we have new cards under the cap, add more
  const extraNew = Math.min(
    newCards.length - newTarget,
    newAvailableToday - newTarget,
    N - newTarget - reviewFill
  );

  const picked = [
    ...dueIds.slice(0, reviewFill),
    ...newCards.slice(0, newTarget + Math.max(0, extraNew)),
  ].slice(0, N);

  // Empty batch and we *should* be done: nothing due, and the daily new
  // cap is hit. Leave S.batch null: advance() will render the "done for
  // today" screen.
  const dailyNewCapHit = newAvailableToday <= 0 && newCards.length > 0;
  if (picked.length === 0 && (dailyNewCapHit || newCards.length === 0)) {
    S.batch = null;
    return;
  }

  // Fallback for the rare case where we have nothing to show: e.g. brand
  // new user with empty pool, or band has zero entries. Surface the
  // soonest-due cards regardless.
  if (picked.length === 0) {
    const everSeen = S.pool
      .filter(r => seenIds.has(r.id))
      .sort((a, b) => S.progress.get(a.id).due - S.progress.get(b.id).due);
    picked.push(...everSeen.slice(0, N));
  }

  // Shuffle so the order isn't predictable
  for (let i = picked.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [picked[i], picked[j]] = [picked[j], picked[i]];
  }

  // Count how many of the picked cards are NEW (no prior progress record).
  // These are being introduced for the first time today, so increment the
  // daily new-card counter. We do this at batch-build time rather than per
  // answer so the cap acts as a true ceiling on introductions.
  const newCount = picked.filter(r => !S.progress.has(r.id)).length;
  if (newCount > 0) {
    S.dailyNew.set(today, (S.dailyNew.get(today) || 0) + newCount);
  }

  S.batch = {
    ids:        picked.map(r => r.id),
    streaks:    Object.fromEntries(picked.map(r => [r.id, 0])),
    attempts:   Object.fromEntries(picked.map(r => [r.id, 0])),
    misses:     Object.fromEntries(picked.map(r => [r.id, 0])),
    graduated:  [],   // ordered list of ids that graduated (kept for stats)
    lastShown:  {},   // id -> timestamp; for "don't immediately re-show same card"
    startedAt:  now,
  };
}

/** Choose the next card from the current batch. Prefer cards with the
 *  lowest streak (struggling), tiebreak by least-recently-shown-in-batch. */


/** Choose the next card from the current batch. Prefer cards with the
 *  lowest streak (struggling), tiebreak by least-recently-shown-in-batch. */
export function pickFromBatch() {
  if (!S.batch) return null;
  const ungrad = S.batch.ids.filter(id => !S.batch.graduated.includes(id));
  if (ungrad.length === 0) return null;
  if (ungrad.length === 1) {
    // Only one left: must show it even if just-shown
    return S.data.sentences.find(r => r.id === ungrad[0]);
  }
  // Sort by: 1) lowest streak first, 2) least-recently-shown, 3) random
  const lastShown = S.batch.lastShown;
  const currentId = S.current?.id;
  const sorted = ungrad
    .filter(id => id !== currentId)  // never immediately repeat the same card
    .map(id => ({
      id,
      streak: S.batch.streaks[id] || 0,
      shown:  lastShown[id] || 0,
      jitter: Math.random(),
    }))
    .sort((a, b) =>
      a.streak - b.streak ||
      a.shown - b.shown ||
      a.jitter - b.jitter
    );
  if (sorted.length === 0) {
    // We filtered out the only remaining card (the current one). Show it again.
    return S.data.sentences.find(r => r.id === currentId);
  }
  return S.data.sentences.find(r => r.id === sorted[0].id);
}

/** Apply a batch's outcome to a card's underlying SRS state.
 *  Called when the card graduates from the batch (or batch ends).
 *  - Clean run (few attempts, no misses) → 3-day interval, ease unchanged
 *  - Some struggle → 1-day interval, ease drops slightly
 *  - Lots of struggle → 10-min learning step, ease drops more
 *  Also handles cards that were already in 'review' before this batch:
 *  successful batch graduation grows their interval by ease.
 */


export function advance() {
  // Make sure we have a batch
  if (!S.batch || S.batch.ids.length === 0
      || S.batch.graduated.length >= S.batch.ids.length) {
    // Previous batch (if any) has fully graduated: start fresh
    buildBatch();
    persistBatch();
  }
  // If buildBatch left S.batch null, the user is done for today: nothing
  // is due and the daily new-card cap has been hit. Show a clear end-state
  // instead of trying to surface stale cards.
  if (!S.batch) {
    renderDoneForToday();
    return;
  }
  S.current = pickFromBatch();
  if (!S.current) {
    $('app').innerHTML = '<div class="loading">no cards available in this level. try another level</div>';
    return;
  }
  if (S.batch.lastShown) S.batch.lastShown[S.current.id] = Date.now();
  S.answered = false;
  S.lastChoice = null;
  S.lastMode = (S.alwaysMcq) ? 'mcq' : 'type';
  S.forceMcqOnce = false;
  S.showDismissPopover = false;
  delete S.current._mcq;
  render();
  // Preload Google TTS for this sentence in the background so clicks/auto-play
  // feel instant. No-op when using browser TTS.
  preloadGoogleAudio(S.current.fr);
  // First-card tutorial (no-op if already dismissed or user has progress).
  maybeStartTutorial();
  // No autoplay: audio plays only when the user clicks Play/Slow,
  // or automatically once after the answer is revealed (see recordAnswer).
}


export function mcqOpts(r) {
  if (!r._mcq) {
    const opts = [r.ans, ...r.opts];
    for (let i = opts.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [opts[i], opts[j]] = [opts[j], opts[i]];
    }
    r._mcq = opts;
  }
  return r._mcq;
}


export async function recordAnswer(correct, mode) {
  S.answered = true;
  S.lastWasCorrect = correct;
  S.lastMode = mode;
  S.seen++;
  if (correct) { S.correct++; S.streak++; }
  else { S.streak = 0; }
  S.recent.unshift(correct ? 'r' : 'w');
  if (S.recent.length > 12) S.recent.pop();

  // points
  let earned = 0;
  if (correct) {
    earned = (mode === 'type') ? POINTS_TYPED : POINTS_MCQ;
    S.totalXP += earned;
    flashXP(earned);
  }

  bumpDaily(earned);

  // ---- Batch progress update ----
  const id = S.current.id;
  const b  = S.batch;
  if (b && b.ids.includes(id) && !b.graduated.includes(id)) {
    b.attempts[id] = (b.attempts[id] || 0) + 1;
    if (correct) {
      // MCQ correct: counts as right (XP, accuracy), but doesn't advance batch
      // graduation: typed correct does. The streak in the batch only counts
      // typed-correct in a row.
      if (mode === 'type') {
        b.streaks[id] = (b.streaks[id] || 0) + 1;
      }
    } else {
      b.misses[id]  = (b.misses[id] || 0) + 1;
      b.streaks[id] = 0;
    }

    // Graduation check: reached streak target, OR auto-graduated due to
    // stickiness (too many attempts without progress).
    const reachedStreak = (b.streaks[id] || 0) >= BATCH_GRADUATE_STREAK;
    const stuck         = (b.attempts[id] || 0) >= STICKY_AUTOGRAD_ATTEMPTS;
    if (reachedStreak || stuck) {
      // Commit SRS state for this card based on the batch outcome
      const prev = S.progress.get(id) || newProgressFor(id);
      const updated = applyBatchOutcomeToSrs(prev, b.attempts[id], b.misses[id]);
      S.progress.set(id, updated);
      await dbPut('progress', updated);
      b.graduated.push(id);
    }
    await persistBatch();
  } else if (!b) {
    // Fallback: if we somehow have no batch, write SRS the old way so the
    // user's progress isn't lost.
    const prev = S.progress.get(id) || newProgressFor(id);
    const updated = srsApply(prev, correct, mode);
    S.progress.set(id, updated);
    await dbPut('progress', updated);
  }

  await saveMeta();
  render();

  // Audio feedback on reveal:
  //   1. If correct: play a short pleasant chime first (encouraging feedback).
  //   2. Then immediately speak the French sentence so the user hears the
  //      target word and the surrounding context with correct pronunciation.
  // The TTS playback was previously delayed by 250ms; we drop that: users
  // wanted it to feel instantaneous. Audio preloading on card render
  // (preloadGoogleAudio) keeps the click-to-play latency near zero too.
  if (correct) playCorrectChime();
  speak(S.current.fr, 1.0, $('btn-play'));
}


export async function submitTyped() {
  const inputEl = $('type-input');
  if (!inputEl) return;
  const typed = inputEl.value;
  if (!typed.trim()) return;
  const status = checkTypedAnswer(typed, S.current.ans);
  S.lastChoice = typed;
  await recordAnswer(status === 'right', 'type');
}


export async function submitMcq(choice) {
  S.lastChoice = choice;
  await recordAnswer(choice === S.current.ans, 'mcq');
}


export function nextOrRetry() {
  // After answering, "next" advances. Before answering, no-op.
  if (!S.answered) return;
  advance();
}

/* ============================================================
   Render
   ============================================================ */
