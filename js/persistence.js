import { ensureVoices } from './audio.js';
import { dbAll, dbGet, dbPut } from './db.js';
import { S } from './state.js';
import { todayStr, yesterdayStr } from './util.js';


export function bumpDaily(xpDelta) {
  const today = todayStr();
  const cur = S.daily.get(today) || 0;
  const wasAtGoal = cur >= S.dailyGoal;
  const newXP = cur + xpDelta;
  S.daily.set(today, newXP);

  // Streak rollover logic:
  //   - If today was already at goal, nothing changes (streak set on the
  //     transition from below-goal → at-goal).
  //   - If we just crossed the goal, see what yesterday was:
  //     - yesterday at goal → streak += 1
  //     - yesterday not at goal (or doesn't exist) → streak = 1
  if (!wasAtGoal && newXP >= S.dailyGoal) {
    if (S.lastActiveDate === yesterdayStr(today) &&
        (S.daily.get(S.lastActiveDate) || 0) >= S.dailyGoal) {
      S.dayStreak += 1;
    } else if (S.lastActiveDate === today) {
      // already today; nothing
    } else {
      S.dayStreak = 1;
    }
    S.lastActiveDate = today;
  } else if (S.lastActiveDate !== today) {
    S.lastActiveDate = today;
  }
}

/** Called once at boot — if the user missed a day, the streak resets. */


/** Called once at boot — if the user missed a day, the streak resets. */
export function reconcileStreakAtBoot() {
  const today = todayStr();
  if (!S.lastActiveDate) return;
  if (S.lastActiveDate === today) return;
  // Last active was yesterday and they hit the goal? Streak survives.
  // Otherwise, streak is broken on next day's first answer.
  // We don't reset to 0 here yet: that'd be misleading until they engage.
  // The next bumpDaily call will recompute correctly.
  if (S.lastActiveDate !== yesterdayStr(today)) {
    // gap of 2+ days → streak is dead
    S.dayStreak = 0;
  } else if ((S.daily.get(S.lastActiveDate) || 0) < S.dailyGoal) {
    // yesterday existed but they missed the goal → streak is dead
    S.dayStreak = 0;
  }
}

/* ============================================================
   Sentence rendering
   ============================================================ */


/** Persist the in-memory batch object alongside other meta. */
export async function persistBatch() {
  await dbPut('meta', { key: 'batch', data: S.batch });
}


export async function loadBatch() {
  const row = await dbGet('meta', 'batch');
  if (row?.data && row.data.ids?.length) {
    S.batch = row.data;
  }
}

export async function saveMeta() {
  await dbPut('meta', { key: 'meta', data: {
    band: S.band,
    alwaysMcq: S.alwaysMcq,
    voicePref: S.voicePref,
    voiceName: S.voiceFr?.name || null,
    apiKey: S.apiKey,
    geminiKey: S.geminiKey,
    explainProvider: S.explainProvider,
    explainModel: S.explainModel,
    totalXP: S.totalXP,
    showIpa: S.showIpa,
    dailyGoal: S.dailyGoal,
    daily: Array.from(S.daily.entries()),
    dailyNew: Array.from(S.dailyNew.entries()),
    dailyNewLimit: S.dailyNewLimit,
    dayStreak: S.dayStreak,
    lastActiveDate: S.lastActiveDate,
    dismissed: Array.from(S.dismissed),  // Set → Array for JSON
    repoUrl: S.repoUrl,
    fontSize: S.fontSize,
    batchSize: S.batchSize,
    tutorialDone: S.tutorialDone,
  }});
}


export async function loadMeta() {
  const row = await dbGet('meta', 'meta');
  if (!row?.data) return;
  const m = row.data;
  S.band           = m.band ?? 1;
  S.alwaysMcq      = !!m.alwaysMcq;
  S.voicePref      = m.voicePref || 'browser';
  S.apiKey         = m.apiKey || '';
  S.geminiKey      = m.geminiKey || '';
  S.explainProvider= m.explainProvider || 'gemini';
  S.explainModel   = m.explainModel || 'claude-haiku-4-5-20251001';
  S.totalXP        = m.totalXP || 0;
  S.showIpa        = (m.showIpa === undefined) ? true : !!m.showIpa;
  S.dailyGoal      = m.dailyGoal || 100;
  S.daily          = new Map(m.daily || []);
  S.dailyNew       = new Map(m.dailyNew || []);
  S.dailyNewLimit  = (m.dailyNewLimit && m.dailyNewLimit >= 5 && m.dailyNewLimit <= 200) ? m.dailyNewLimit : 20;
  S.dayStreak      = m.dayStreak || 0;
  S.lastActiveDate = m.lastActiveDate || null;
  S.dismissed      = new Set(m.dismissed || []);
  S.repoUrl        = m.repoUrl || '';
  S.fontSize       = m.fontSize || 'md';
  S.batchSize      = (m.batchSize && m.batchSize >= 5 && m.batchSize <= 30) ? m.batchSize : 10;
  S.tutorialDone   = !!m.tutorialDone;
  // voice name is restored after voices load
  if (m.voiceName) {
    const voices = await ensureVoices();
    const v = voices.find(x => x.name === m.voiceName);
    if (v) S.voiceFr = v;
  }
}


export async function loadProgress() {
  const all = await dbAll('progress');
  S.progress = new Map(all.map(p => [p.id, p]));
}
