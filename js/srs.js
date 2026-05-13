import { BATCH_GRADUATE_STREAK, DAY_MS, MASTERY_INTERVAL_DAYS, SRS_EASE_DEFAULT, SRS_EASE_FLOOR, SRS_EASE_PENALTY, SRS_GRADUATE_DAYS, SRS_LEARNING_STEPS_MS, SRS_MCQ_PENALTY, STICKY_AUTOGRAD_ATTEMPTS } from './state.js';

export function isMasteredP(p) { return p && p.state === 'review' && p.interval >= MASTERY_INTERVAL_DAYS; }

/** Compact batch progress indicator for the meta row.
 *  Returns " · Batch 3/10 · ✓✓ 2/3" or "" if no batch / card not in batch. */


export function newProgressFor(id) {
  return {
    id,
    state: 'new',
    seen: 0,
    correct: 0,
    streak: 0,           // consecutive correct
    lapses: 0,           // total times we got it wrong after graduating
    interval: 0,         // days; relevant for state='review'
    ease: SRS_EASE_DEFAULT,
    step: 0,             // index into SRS_LEARNING_STEPS_MS
    due: 0,              // ms timestamp; 0 = never due, fetch as new
    lastSeen: 0,
  };
}

/** Update a progress record after an answer. Mutates in place; returns it. */


/** Update a progress record after an answer. Mutates in place; returns it. */
export function srsApply(p, correct, mode) {
  const now = Date.now();
  p.seen += 1;
  p.lastSeen = now;
  if (correct) {
    p.correct += 1;
    p.streak += 1;
  } else {
    p.streak = 0;
  }

  if (!correct) {
    // Failed answer: kick back to learning.
    if (p.state === 'review') {
      p.lapses += 1;
      p.ease = Math.max(SRS_EASE_FLOOR, p.ease - SRS_EASE_PENALTY);
    }
    p.state = 'learning';
    p.step = 0;
    p.due = now + SRS_LEARNING_STEPS_MS[0];
    return p;
  }

  // Correct answer
  if (p.state === 'new' || p.state === 'learning') {
    p.step = (p.state === 'new') ? 0 : p.step + 1;
    p.state = 'learning';
    if (p.step >= SRS_LEARNING_STEPS_MS.length) {
      // graduate
      p.state = 'review';
      // First graduation interval; MCQ shrinks it slightly.
      const days = (mode === 'mcq')
        ? Math.max(1, Math.round(SRS_GRADUATE_DAYS * SRS_MCQ_PENALTY))
        : SRS_GRADUATE_DAYS;
      p.interval = days;
      p.due = now + days * DAY_MS;
    } else {
      p.due = now + SRS_LEARNING_STEPS_MS[p.step];
    }
    return p;
  }

  // Already in review: apply ease multiplier
  let mult = p.ease;
  if (mode === 'mcq') mult *= SRS_MCQ_PENALTY;
  // Cap at 365 days; nothing useful beyond that
  p.interval = Math.min(365, Math.max(1, Math.round(p.interval * mult)));
  p.due = now + p.interval * DAY_MS;
  return p;
}

/* ============================================================
   Batch-based scheduler

   Replaces the simple session queue with Duolingo-style batches.

   How a batch works:
   - Pick N cards (S.batchSize, default 10), mixed: half due reviews +
     half new cards from the current band, in priority order.
   - Within a batch, the user must demonstrate mastery on EVERY card before
     a new batch is introduced. Mastery within a batch = 3 typed-correct in
     a row. (MCQ correct keeps the streak but doesn't advance graduation.)
   - Wrong answer resets the card's batch-streak to 0.
   - When every card in the batch is graduated, the batch dissolves and the
     SRS state for each card gets updated based on how the batch went:
       0–1 misses, ≤ 4 attempts → clean run → 3-day interval
       2 misses or 5–7 attempts → some struggle → 1-day interval
       3+ misses or 8+ attempts → struggled → 10-min learning step
   - The batch can also stall on a sticky card (impossible to type, etc).
     After SRS_STICKY_AUTOGRAD_ATTEMPTS attempts the card auto-graduates
     so the batch can continue, but its SRS gets the shortest interval.
   - Batch state is persisted so closing the tab doesn't lose progress.
   ============================================================ */


/** Apply a batch's outcome to a card's underlying SRS state.
 *  Called when the card graduates from the batch (or batch ends).
 *  - Clean run (few attempts, no misses) → 3-day interval, ease unchanged
 *  - Some struggle → 1-day interval, ease drops slightly
 *  - Lots of struggle → 10-min learning step, ease drops more
 *  Also handles cards that were already in 'review' before this batch:
 *  successful batch graduation grows their interval by ease.
 */
export function applyBatchOutcomeToSrs(p, attempts, misses) {
  const now = Date.now();
  p.seen   = (p.seen || 0) + attempts;
  p.lastSeen = now;

  if (p.state === 'review') {
    // Was a review card. Graduating from the batch counts as a successful
    // review; misses inside the batch reduce ease.
    if (misses > 0) {
      p.lapses = (p.lapses || 0) + 1;
      p.ease = Math.max(SRS_EASE_FLOOR, p.ease - SRS_EASE_PENALTY * misses);
    }
    // Grow interval if clean, hold if mild struggle, shrink if rough
    let mult;
    if (misses === 0)      mult = p.ease;
    else if (misses === 1) mult = 1.0;       // hold
    else                   mult = 0.5;       // shrink
    p.interval = Math.min(365, Math.max(1, Math.round((p.interval || 1) * mult)));
    p.due = now + p.interval * DAY_MS;
    return p;
  }

  // New or learning card graduating from its first batch: set initial interval
  p.correct = (p.correct || 0) + Math.max(0, attempts - misses);

  // Quality of the batch run:
  //   clean   = no misses, ≤ 4 attempts (so streak = 3 with no resets)
  //   struggled = at least 1 miss or > 7 attempts
  //   bad   = 3+ misses or auto-graduated for stickiness
  const clean    = misses === 0 && attempts <= BATCH_GRADUATE_STREAK + 1;
  const bad      = misses >= 3 || attempts >= STICKY_AUTOGRAD_ATTEMPTS;

  if (clean) {
    p.state = 'review';
    p.interval = SRS_GRADUATE_DAYS;       // 3 days
    p.due = now + p.interval * DAY_MS;
  } else if (bad) {
    // Reset to short learning step so we see it again very soon
    p.state = 'learning';
    p.step = 0;
    p.due = now + SRS_LEARNING_STEPS_MS[0];   // 10 min
    p.lapses = (p.lapses || 0) + 1;
    p.ease = Math.max(SRS_EASE_FLOOR, p.ease - SRS_EASE_PENALTY);
  } else {
    // Mild struggle: graduate but to 1-day initial interval, drop ease a little
    p.state = 'review';
    p.interval = 1;
    p.due = now + DAY_MS;
    p.ease = Math.max(SRS_EASE_FLOOR, p.ease - 0.1);
  }
  return p;
}

/** Persist the in-memory batch object alongside other meta. */
