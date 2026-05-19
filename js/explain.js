import { render } from './render.js';
import { S } from './state.js';
import { $, escapeHtml } from './util.js';

export function renderExplainBlock(r) {
  const cached = S.explanations.get(r.id);
  if (cached) {
    return `<div class="explain">
      <div class="explain-body">${renderExplainMarkdown(cached)}</div>
    </div>`;
  }
  const haveKey = currentExplainKey();
  if (!haveKey) {
    return `<div class="explain">
      <button class="explain-toggle" id="btn-explain-need-key" title="Open settings to add an API key">
        Explain (add key)
      </button>
    </div>`;
  }
  return `<div class="explain">
    <button class="explain-toggle" id="btn-explain">
      Explain
    </button>
  </div>`;
}

/** Pre-answer preview: the Explain button is visible but disabled with a
 *  tooltip warning that clicking it would reveal the answer. This ensures
 *  the button is always visible in the UI (important for the tutorial). */
export function renderExplainBlockPreview() {
  const haveKey = currentExplainKey();
  const label = haveKey ? 'Explain' : 'Explain (add key)';
  return `<div class="explain">
    <button class="explain-toggle explain-preview" id="btn-explain-preview"
            data-warn="Reveals the answer. Try &quot;I don't know&quot; if stuck">
      ${label}
    </button>
  </div>`;
}


export function currentExplainKey() {
  return S.explainProvider === 'gemini' ? S.geminiKey : S.apiKey;
}

/**
 * Build a GitHub-issue URL pre-filled with details about a sentence the user
 * is reporting. Only used if S.repoUrl is set.
 *
 * Format expected for repoUrl: "owner/repo" (e.g. "alice/en-contexte"). The
 * link goes to issues/new with title and body populated.
 */


/** Markdown renderer for explanation text. Supports paragraphs, **bold**,
 *  *italic*, `code`, ### headers, ordered lists (`1. foo`), bulleted lists
 *  (`- foo` or `* foo`), and one level of nested lists. */
export function renderExplainMarkdown(md) {
  // Normalize line endings, escape first, then introduce HTML
  let t = escapeHtml(md.replace(/\r\n/g, '\n'));

  // Inline formatting
  t = t.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<em>$1</em>');
  t = t.replace(/`([^`\n]+)`/g, '<code>$1</code>');

  // Build block-level structure line by line, tracking list contexts.
  const lines = t.split('\n');
  const out = [];
  // stack[N] = type of list at indent level N: 'ol' | 'ul' | undefined
  let listStack = [];

  function closeListsTo(targetDepth) {
    while (listStack.length > targetDepth) {
      const t = listStack.pop();
      out.push(`</li></${t}>`);
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) {
      // blank line: close any open lists; emit gap
      closeListsTo(0);
      continue;
    }

    // Header
    const hMatch = /^###\s+(.+)$/.exec(line);
    if (hMatch) {
      closeListsTo(0);
      out.push(`<h4>${hMatch[1]}</h4>`);
      continue;
    }

    // List item: "1. text" or "- text" or "* text", with optional indent
    const liMatch = /^(\s*)(\d+\.\s+|[-*]\s+)(.*)$/.exec(line);
    if (liMatch) {
      const indent = liMatch[1].length;
      const depth = indent < 2 ? 1 : 2;       // 0..1 spaces = depth 1, 2+ = depth 2
      const isOrdered = /^\d+\./.test(liMatch[2]);
      const tag = isOrdered ? 'ol' : 'ul';
      // Close any lists deeper than where we are now (but NOT the list at our
      // own depth: sibling items must stay inside the same list).
      closeListsTo(depth);
      // If no list exists yet at this depth, open one
      if (listStack.length < depth) {
        out.push(`<${tag}>`);
        listStack.push(tag);
      } else if (listStack[depth - 1] !== tag) {
        // Same depth but different list type (ul vs ol): close old, open new
        const old = listStack.pop();
        out.push(`</li></${old}><${tag}>`);
        listStack.push(tag);
      } else {
        // Same depth, same type: this is a sibling item. Close previous <li>.
        out.push('</li>');
      }
      out.push(`<li>${liMatch[3]}`);
      continue;
    }

    // Continuation of the previous list item (indented but no marker)?
    if (listStack.length && /^\s+/.test(raw)) {
      out.push(' ' + line.trim());
      continue;
    }

    // Plain paragraph
    closeListsTo(0);
    // gather adjacent non-blank lines into one paragraph
    let para = line;
    while (i + 1 < lines.length && lines[i + 1].trim() &&
           !/^###\s/.test(lines[i + 1]) &&
           !/^(\s*)(\d+\.\s+|[-*]\s+)/.test(lines[i + 1])) {
      i++;
      para += ' ' + lines[i].trim();
    }
    out.push(`<p>${para}</p>`);
  }
  closeListsTo(0);
  return out.join('\n');
}


export async function requestExplain(sentenceId) {
  const r = S.data.sentences.find(x => x.id === sentenceId);
  if (!r) return;
  const key = currentExplainKey();
  if (!key) return;

  const btn = $('btn-explain');
  if (btn) {
    btn.classList.add('loading');
    btn.textContent = 'thinking';
  }

  const provider = S.explainProvider;
  try {
    const prompt = buildExplainPrompt(r);
    const text = (provider === 'gemini')
      ? await callGemini(key, prompt)
      : await callClaude(key, prompt);
    S.explanations.set(r.id, text);
    render();
  } catch (err) {
    const wrap = document.querySelector('.explain');
    const label = (provider === 'gemini') ? 'Gemini' : 'Anthropic';
    if (wrap) {
      wrap.innerHTML += `<div class="explain-error">Couldn't reach ${label} API: ${escapeHtml(String(err.message || err))}</div>`;
    }
    if (btn) {
      btn.classList.remove('loading');
      btn.textContent = 'Try again';
    }
  }
}


export function buildExplainPrompt(r) {
  return `You are a friendly French tutor explaining a sentence to an English-speaking learner. Be thorough and warm; this is a teaching moment, not a quiz answer.

French: "${r.fr}"
English: "${r.en}"
Word being tested (the cloze answer): "${r.ans}"

Structure your response exactly like this:

Open with one short friendly intro line that confirms the translation. Example:
The French sentence "${r.fr}" translates to "${r.en}" in English. Let's break it down:

Then a numbered list, **one item per French word or tightly-connected word group**, going left-to-right through the sentence. For each item:
- Bold the French word/phrase (e.g. **mangé**)
- Explain what it means and what role it plays in the sentence
- For verbs: give the infinitive, the tense, and the person/number
- For pronouns: say what they refer to and what kind they are (subject, object, reflexive, etc.)
- For articles/contractions: explain the contraction and what they modify
- If a word is a multi-part construction (e.g. "tous les", "ne...pas", "qu'est-ce que"), use a sub-bullet for each component

After the numbered list, write **"Putting it all together:"** as a short paragraph, followed by an indented bullet list that maps each chunk of French to English (e.g. * "Il" (He) +). End with a complete summary sentence.

Finally, add **one short paragraph** about the grammar context: what tense or construction this sentence demonstrates, when learners encounter it, and any note about the cloze word "${r.ans}" specifically (e.g. is it tricky, is it irregular, common pitfalls).

Formatting rules:
- Use **bold** for all French words and phrases
- Use \`backticks\` only for grammatical terms (e.g. \`passé composé\`, \`subjunctive\`)
- Plain text for English translations and explanations
- No section headers; the structure above is enough
- Aim for around 250–400 words. Be complete but don't pad.`;
}


export async function callClaude(apiKey, prompt) {
  const model = S.explainModel || 'claude-haiku-4-5-20251001';
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model,
      max_tokens: 1200,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const j = await res.json();
      if (j.error?.message) msg += ': ' + j.error.message;
    } catch {}
    throw new Error(msg);
  }
  const data = await res.json();
  // content is an array of blocks; concatenate text blocks
  return (data.content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('\n')
    .trim();
}


export async function callGemini(apiKey, prompt) {
  // Free-tier endpoint. The 2.5 Flash model is generous on the free tier
  // (1500 requests/day, no credit card). The endpoint is the native Gemini
  // generateContent API, NOT the OpenAI-compatibility shim: that one has
  // CORS issues from browsers.
  //
  // CRITICAL: Gemini 2.5 Flash has "thinking" enabled by default, and those
  // thinking tokens count against maxOutputTokens. Without thinkingBudget=0,
  // the model burns 800+ tokens silently reasoning before producing visible
  // output, which truncates explanations mid-sentence. Explaining a sentence
  // is not a reasoning task; we don't need thinking. Disable it explicitly.
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/'
            + 'gemini-2.5-flash:generateContent';
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        // Bumped from 1200 → 2048 as a safety net even with thinking off
        maxOutputTokens: 2048,
        temperature: 0.4,
        thinkingConfig: {
          thinkingBudget: 0,  // disable thinking — this is not a reasoning task
        },
      },
    }),
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const j = await res.json();
      if (j.error?.message) msg += ': ' + j.error.message;
    } catch {}
    throw new Error(msg);
  }
  const data = await res.json();
  // Response shape: { candidates: [{ content: { parts: [{ text: '...' }] }, finishReason }] }
  const candidate = (data.candidates || [])[0];
  if (!candidate) {
    throw new Error('no candidates in response');
  }
  const parts = candidate.content?.parts || [];
  const text = parts.map(p => p.text || '').join('').trim();

  // Detect known truncation modes so the user gets a clear message instead
  // of a mid-sentence cutoff.
  const fr = candidate.finishReason;
  if (fr === 'MAX_TOKENS') {
    if (!text) {
      throw new Error('response was truncated before any text was produced. This is usually thinking mode eating the token budget. If you keep seeing this, try the Anthropic provider in settings.');
    }
    // Append a visible note so the user knows the answer is incomplete
    return text + '\n\n*(Response was cut off at the token limit. Try regenerating, or switch to the Anthropic provider for longer answers.)*';
  }
  if (fr === 'SAFETY' || fr === 'RECITATION' || fr === 'BLOCKLIST') {
    throw new Error(`Gemini blocked the response (${fr.toLowerCase()})`);
  }
  if (!text) {
    throw new Error(`empty response (finish reason: ${fr || 'unknown'})`);
  }
  return text;
}