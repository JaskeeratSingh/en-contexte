import { dbDelete } from './db.js';
import { persistBatch, saveMeta } from './persistence.js';
import { advance } from './scheduler.js';
import { S } from './state.js';
import { escapeHtml } from './util.js';

const REPO = 'JaskeeratSingh/en-contexte';

export async function dismissCurrent() {
  if (!S.current) return;
  const id = S.current.id;
  S.dismissed.add(id);
  S.showDismissPopover = false;
  if (S.progress.has(id)) {
    S.progress.delete(id);
    try { await dbDelete('progress', id); } catch {}
  }
  await saveMeta();
  if (S.batch) {
    const i = S.batch.ids.indexOf(id);
    if (i !== -1) {
      S.batch.ids.splice(i, 1);
      delete S.batch.streaks[id];
      delete S.batch.attempts[id];
      delete S.batch.misses[id];
      delete S.batch.lastShown[id];
      S.batch.graduated = S.batch.graduated.filter(x => x !== id);
    }
    await persistBatch();
  }
  advance();
}


/** Build the report popover HTML. Shows a small inline form:
 *  1. What's wrong? (dropdown: mistranslation, bad sentence, other)
 *  2. If mistranslation: text field for the correct translation
 *  3. Optional notes
 *  4. "Report" button that opens a pre-filled GitHub issue
 *  5. "Cancel" to close
 *  Also includes "Hide for me" to dismiss locally without reporting. */
export function renderReportPopover(r) {
  return `
    <div class="report-popover" id="report-popover">
      <div class="report-title">Report this card</div>
      <p class="report-sentence">
        <span class="report-fr">${escapeHtml(r.fr)}</span>
        <span class="report-en">${escapeHtml(r.en)}</span>
      </p>

      <label class="report-label">What's wrong?</label>
      <select class="report-select" id="report-reason">
        <option value="mistranslation">Bad or wrong translation</option>
        <option value="awkward">Awkward or unnatural sentence</option>
        <option value="vulgar">Vulgar or offensive without warning</option>
        <option value="wrong-cloze">Wrong word used as the blank</option>
        <option value="other">Other</option>
      </select>

      <div id="report-translation-row">
        <label class="report-label">Correct translation (if you know it)</label>
        <input type="text" class="report-input" id="report-translation"
               placeholder="e.g. He is a private detective.">
      </div>

      <label class="report-label">Notes (optional)</label>
      <input type="text" class="report-input" id="report-notes"
             placeholder="Any extra context">

      <div class="report-actions">
        <button class="report-btn primary" id="btn-report-submit">Report on GitHub</button>
        <button class="report-btn" id="btn-report-hide">Just hide for me</button>
        <button class="report-btn" id="btn-report-cancel">Cancel</button>
      </div>

      <p class="report-hint">
        Reporting opens a pre-filled GitHub issue. You'll need a free GitHub
        account to submit (one click).
      </p>
    </div>
  `;
}


/** Build and open the pre-filled GitHub issue URL from the form data. */
export function submitReport(r) {
  const reason = document.getElementById('report-reason')?.value || 'other';
  const translation = document.getElementById('report-translation')?.value?.trim() || '';
  const notes = document.getElementById('report-notes')?.value?.trim() || '';

  const reasonLabels = {
    'mistranslation': 'Bad or wrong translation',
    'awkward': 'Awkward or unnatural sentence',
    'vulgar': 'Vulgar or offensive without warning',
    'wrong-cloze': 'Wrong word used as the blank',
    'other': 'Other',
  };

  const title = `Report: "${r.fr.slice(0, 60)}${r.fr.length > 60 ? '…' : ''}"`;

  const bodyParts = [
    `### Reported sentence`,
    ``,
    `| Field | Value |`,
    `|---|---|`,
    `| **Sentence ID** | ${r.id} |`,
    `| **French** | ${r.fr} |`,
    `| **English (current)** | ${r.en} |`,
    `| **Cloze answer** | \`${r.ans}\` |`,
    `| **Band** | ${r.band} (rank #${r.rank}) |`,
    ``,
    `### Issue`,
    ``,
    `**Type:** ${reasonLabels[reason] || reason}`,
  ];

  if (translation) {
    bodyParts.push(``, `**Suggested translation:** ${translation}`);
  }
  if (notes) {
    bodyParts.push(``, `**Notes:** ${notes}`);
  }

  const body = bodyParts.join('\n');
  const url = `https://github.com/${REPO}/issues/new`
            + `?title=${encodeURIComponent(title)}`
            + `&body=${encodeURIComponent(body)}`
            + `&labels=${encodeURIComponent('bad-sentence')}`;

  window.open(url, '_blank', 'noopener');
}