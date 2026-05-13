import { dbDelete } from './db.js';
import { persistBatch, saveMeta } from './persistence.js';
import { advance } from './scheduler.js';
import { S } from './state.js';


export async function dismissCurrent() {
  if (!S.current) return;
  const id = S.current.id;
  S.dismissed.add(id);
  S.showDismissPopover = false;
  // Also drop any progress record so it doesn't keep counting toward
  // mastery / due piles
  if (S.progress.has(id)) {
    S.progress.delete(id);
    try { await dbDelete('progress', id); } catch {}
  }
  await saveMeta();
  // Drop the dismissed card from the current batch (if it's in there)
  if (S.batch) {
    const i = S.batch.ids.indexOf(id);
    if (i !== -1) {
      S.batch.ids.splice(i, 1);
      delete S.batch.streaks[id];
      delete S.batch.attempts[id];
      delete S.batch.misses[id];
      delete S.batch.lastShown[id];
      // Don't keep it in graduated either
      S.batch.graduated = S.batch.graduated.filter(x => x !== id);
    }
    await persistBatch();
  }
  advance();
}


/**
 * Build a GitHub-issue URL pre-filled with details about a sentence the user
 * is reporting. Only used if S.repoUrl is set.
 *
 * Format expected for repoUrl: "owner/repo" (e.g. "alice/en-contexte"). The
 * link goes to issues/new with title and body populated.
 */
export function buildReportUrl(r) {
  if (!S.repoUrl) return null;
  // Allow either "owner/repo" or a full URL: strip to owner/repo
  const m = /(?:github\.com\/)?([^\/\s]+\/[^\/\s]+)/.exec(S.repoUrl);
  if (!m) return null;
  const repoSlug = m[1].replace(/\.git$/, '');
  const title = `Bad sentence #${r.id}: "${r.fr.slice(0, 50)}${r.fr.length > 50 ? '…' : ''}"`;
  const body = [
    `**Sentence ID:** ${r.id}`,
    `**French:** ${r.fr}`,
    `**English (current):** ${r.en}`,
    `**Cloze answer:** \`${r.ans}\``,
    `**Band:** ${r.band} (rank #${r.rank})`,
    ``,
    `**What's wrong:** _(describe what's incorrect, awkward, or unhelpful, e.g. mistranslation, vulgar register without warning, ambiguous meaning)_`,
    ``,
    `**Suggested fix:** _(optional, propose a better translation or replacement sentence)_`,
  ].join('\n');
  return `https://github.com/${repoSlug}/issues/new`
       + `?title=${encodeURIComponent(title)}`
       + `&body=${encodeURIComponent(body)}`;
}


export function renderDismissPopover(r) {
  const reportUrl = buildReportUrl(r);
  return `
    <div class="dismiss-popover" id="dismiss-popover">
      <div class="dismiss-popover-title">Hide this sentence?</div>
      <p>It won't show up again on this device. (This is local; other users won't be affected.)</p>
      <div class="dismiss-popover-actions">
        <button class="primary" id="btn-dismiss-confirm">Hide it</button>
        <button id="btn-dismiss-cancel">Cancel</button>
      </div>
      ${reportUrl
        ? `<a class="dismiss-popover-report" href="${reportUrl}" target="_blank" rel="noopener">↗ Also report on GitHub</a>`
        : ''}
    </div>
  `;
}

/** Markdown renderer for explanation text. Supports paragraphs, **bold**,
 *  *italic*, `code`, ### headers, ordered lists (`1. foo`), bulleted lists
 *  (`- foo` or `* foo`), and one level of nested lists. */
