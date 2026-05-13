

/* =================================================================
   cloze.fr  —  Stage 3
   - Typing mode (default) + MCQ fallback
   - Differentiated points: typed=10, MCQ=3
   - IndexedDB persistence
   - Per-band progress + mastery tracking
   - Audio: Browser TTS or Google Translate TTS
   ================================================================= */

// French tokenizer. Apostrophes are word boundaries (so "l'arbre" → ["l","arbre"])
// while hyphens stay inside words ("grand-mère", "peux-tu" stay as one token).
// Must match the Python regex in build_data.py exactly.
export const TOKEN_RE = /[A-Za-zÀ-ÖØ-öø-ÿœŒæÆ\-]+/gu;

export const POINTS_TYPED = 10;

export const POINTS_MCQ   = 3;

export const MASTERY_INTERVAL_DAYS = 21;  // review interval >= 21 days = "mastered"

export const S = {
  data: null,                  // sentences.json
  ipa: null,                   // ipa.json (lazy loaded on first toggle)
  pool: [],                    // sentences in current band
  current: null,               // current sentence object
  answered: false,
  lastWasCorrect: false,
  lastChoice: null,
  lastMode: 'type',            // 'type' | 'mcq' — how the user actually answered
  forceMcqOnce: false,         // user clicked "I don't know"

  // Batch-based scheduler state ("Duolingo-style" pacing)
  // A batch is N cards we focus on until each is graduated. Within a batch
  // each card needs a streak of typed-correct answers (BATCH_GRADUATE_STREAK)
  // to graduate. Only at graduation does the underlying SRS interval update.
  // This guarantees real repetition before introducing more new cards.
  batch: null,                 // { ids, streaks, attempts, graduated, lastShown, startedAt } or null
  batchSize: 10,               // setting, persisted — cards per batch

  // settings (persisted)
  band: 1,
  alwaysMcq: false,            // setting: always use MCQ
  voicePref: 'browser',        // 'browser' | 'google'
  apiKey: '',                  // Anthropic API key, stored locally only
  geminiKey: '',               // Gemini API key, stored locally only
  explainProvider: 'gemini',   // 'gemini' | 'anthropic' — Gemini default since it's free
  explainModel: 'claude-haiku-4-5-20251001',  // Anthropic model when provider=anthropic
  voiceFr: null,               // SpeechSynthesisVoice
  showIpa: true,               // toggle: show IPA below sentence (after answer)
  dailyGoal: 100,              // daily XP target

  // session stats (in-memory only)
  seen: 0,
  correct: 0,
  streak: 0,                   // session streak, not daily
  recent: [],                  // last 12 results

  // persistent stats
  totalXP: 0,
  progress: new Map(),         // sentenceId -> {seen, correct, lastSeen, ...}
  dismissed: new Set(),        // sentenceIds the user has hidden locally
  daily:   new Map(),          // YYYY-MM-DD -> XP earned that day
  dailyNew: new Map(),         // YYYY-MM-DD -> # new cards introduced that day
  dailyNewLimit: 20,           // setting; matches Anki default. Configurable in settings.
  dayStreak: 0,                // consecutive days hitting goal
  lastActiveDate: null,        // YYYY-MM-DD

  // optional: repository URL for the "report" link to point at.
  // Empty by default: user can set it in settings if they're hosting a fork.
  repoUrl: '',

  // text size: 'sm' | 'md' | 'lg'
  fontSize: 'md',

  // explain cache (in-memory; cheap because few clicks per session)
  explanations: new Map(),     // sentenceId -> markdown text

  // dismiss popover state
  showDismissPopover: false,

  // First-use tutorial: once dismissed, never auto-shown again.
  // Can be replayed from settings → "Show tutorial again".
  tutorialDone: false,
};

/* ============================================================
   Date helpers
   ============================================================ */


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

export const SRS_LEARNING_STEPS_MS = [10 * 60 * 1000, 24 * 60 * 60 * 1000];  // 10 min, 1 day

export const SRS_GRADUATE_DAYS    = 3;     // first review interval after graduating

export const SRS_EASE_DEFAULT     = 2.5;

export const SRS_EASE_FLOOR       = 1.3;

export const SRS_EASE_PENALTY     = 0.20;  // drop on wrong answer

export const SRS_MCQ_PENALTY      = 0.70;  // multiplier on MCQ correct (vs typing)

export const DAY_MS               = 24 * 60 * 60 * 1000;


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

export const BATCH_GRADUATE_STREAK    = 3;   // typed-correct in a row to graduate from batch

export const STICKY_AUTOGRAD_ATTEMPTS = 6;   // safety valve for impossible cards

/** Build a fresh batch from the current band. Mix of due reviews + new cards. */
