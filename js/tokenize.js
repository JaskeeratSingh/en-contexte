import { S, TOKEN_RE } from './state.js';
import { escapeHtml } from './util.js';

export function tokensWithSpans(s) {
  const segs = [];
  let last = 0, wi = 0;
  for (const m of s.matchAll(TOKEN_RE)) {
    if (m.index > last) segs.push({ text: s.slice(last, m.index), isWord: false });
    segs.push({ text: m[0], isWord: true, wordIndex: wi++ });
    last = m.index + m[0].length;
  }
  if (last < s.length) segs.push({ text: s.slice(last), isWord: false });
  return segs;
}


export function renderSentence(row, fillWith /* {text, status} | null */) {
  const segs = tokensWithSpans(row.fr);
  const out = [];
  for (const seg of segs) {
    if (seg.isWord && seg.wordIndex === row.idx) {
      if (fillWith) {
        const cls = `cloze filled ${fillWith.status || ''}`;
        out.push(`<span class="${cls}">${escapeHtml(fillWith.text)}</span>`);
      } else {
        out.push(`<span class="cloze">\u00a0\u00a0\u00a0\u00a0</span>`);
      }
    } else {
      out.push(escapeHtml(seg.text));
    }
  }
  return out.join('');
}

/* ============================================================
   Audio
   ============================================================ */


export async function loadIpa() {
  if (S.ipa) return S.ipa;
  try {
    const res = await fetch('data/ipa.json');
    if (!res.ok) throw new Error('data/ipa.json not found');
    S.ipa = await res.json();
    return S.ipa;
  } catch {
    S.ipa = {};  // empty dict; lookups will all miss but feature won't crash
    return S.ipa;
  }
}


export function ipaLookup(word) {
  if (!S.ipa) return null;
  const w = word.toLowerCase().replace('’', "'");
  if (S.ipa[w]) return S.ipa[w];
  // hyphen-split fallback (covers cases the build script missed)
  if (w.includes('-')) {
    const parts = w.split('-').map(p => S.ipa[p]).filter(Boolean);
    if (parts.length === w.split('-').length) return parts.join('');
  }
  return null;
}


export function ipaForSentence(s) {
  // Walk the sentence. When we encounter a sequence of word-tokens connected
  // by apostrophes (aujourd'hui, qu'est-ce, jusqu'à...), try the joined form
  // first: many compound forms have a dictionary entry as a unit. Fall back
  // to per-token IPA lookup. Non-word characters pass through unchanged.
  const out = [];
  let last = 0;

  // Find all word-token matches up front so we can scan ahead for apostrophes.
  const matches = [...s.matchAll(TOKEN_RE)];

  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    if (m.index > last) out.push(s.slice(last, m.index));

    // Try to find the longest apostrophe-joined run starting at i
    let j = i;
    while (j + 1 < matches.length) {
      const between = s.slice(matches[j].index + matches[j][0].length, matches[j+1].index);
      // an apostrophe-only span (possibly with whitespace) connects them
      if (/^['']\s*$/.test(between)) j++;
      else break;
    }

    // Try longest joined first, then shorter
    let consumed = -1;
    let ipaText = null;
    for (let span = j; span >= i; span--) {
      const joinedRaw = s.slice(matches[i].index, matches[span].index + matches[span][0].length);
      const joined = joinedRaw.toLowerCase().replace('’', "'");
      const hit = S.ipa && S.ipa[joined];
      if (hit) { ipaText = hit; consumed = span; break; }
    }

    if (consumed === -1) {
      // No apostrophe-joined form matched; just emit IPA for this single token
      const single = ipaLookup(m[0]);
      out.push(single || m[0]);
      last = m.index + m[0].length;
    } else {
      out.push(ipaText);
      last = matches[consumed].index + matches[consumed][0].length;
      i = consumed;
    }
  }
  if (last < s.length) out.push(s.slice(last));
  return out.join('');
}
