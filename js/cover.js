import { iconArrow, iconExplain, iconSparkle, iconSpeak, iconType } from './icons.js';
import { advance, buildPool } from './scheduler.js';
import { isMasteredP } from './srs.js';
import { S } from './state.js';
import { $ } from './util.js';


export function showCover() {
  $('header').hidden = true;
  // Stop any audio that's playing
  try { window.speechSynthesis?.cancel(); } catch {}
  // Friendly greeting that adapts to whether the user has prior progress.
  const seenAny = S.progress.size > 0;
  const totalMastered = Array.from(S.progress.values())
    .filter(isMasteredP).length;
  const ctaLabel = seenAny ? 'Continue learning' : 'Start learning';
  const subhead  = seenAny
    ? `Welcome back. You've mastered <b>${totalMastered}</b> ${totalMastered === 1 ? 'sentence' : 'sentences'} · <b>${S.totalXP.toLocaleString()}</b> XP earned.`
    : 'Real French sentences. Real frequency-ranked vocabulary. Type the missing word, hear the audio, see the grammar.';

  $('app').innerHTML = `
    <div class="cover">
      <div class="cover-mark"><b>·</b> En Contexte <b>·</b></div>
      <h1>French vocabulary,<br><em>in context.</em></h1>
      <p class="cover-tagline">
        ${seenAny ? subhead : 'Like Anki, but every word lives inside a real sentence, with audio, IPA, and a tutor on call.'}
      </p>

      <div class="cover-features">
        <div class="cover-feat">
          <div class="cover-feat-icon">${iconSparkle()}</div>
          <div>
            <p class="cover-feat-title">15,000 real sentences</p>
            <p class="cover-feat-desc">From Tatoeba, ranked into 10 levels of 1,500 sentences each. Level 1 uses only the top 1,000 most-common words; level 10 uses up to 10,000.</p>
          </div>
        </div>
        <div class="cover-feat">
          <div class="cover-feat-icon">${iconType()}</div>
          <div>
            <p class="cover-feat-title">Type, don't guess</p>
            <p class="cover-feat-desc">Active recall with full credit (+10 XP) for typed answers. Multiple choice is there as a fallback for words you don't know yet (+3 XP).</p>
          </div>
        </div>
        <div class="cover-feat">
          <div class="cover-feat-icon">${iconSpeak()}</div>
          <div>
            <p class="cover-feat-title">Audio &amp; IPA</p>
            <p class="cover-feat-desc">Native-sounding TTS at full or slow speed. Phonetic transcription on demand for the whole sentence.</p>
          </div>
        </div>
        <div class="cover-feat">
          <div class="cover-feat-icon">${iconExplain()}</div>
          <div>
            <p class="cover-feat-title">Tutor on call</p>
            <p class="cover-feat-desc">One click sends the sentence to Gemini or Claude for a word-by-word breakdown: grammar, conjugation, idiom notes. Gemini's free tier covers 1500/day.</p>
          </div>
        </div>
      </div>

      <div class="cover-cta-row">
        <button class="cover-cta" id="cta-start">
          ${ctaLabel} ${iconArrow()}
        </button>
        ${seenAny
          ? `<span class="cover-cta-note">${S.dayStreak > 0 ? `🔥 ${S.dayStreak}-day streak alive` : 'No active streak. Answer one to start'}</span>`
          : '<span class="cover-cta-note">No signup · runs entirely in your browser</span>'
        }
      </div>

      <p class="cover-footer">
        Sentences from <a href="https://tatoeba.org" target="_blank" rel="noopener">Tatoeba</a>, CC&nbsp;BY&nbsp;2.0&nbsp;FR.<br>
        IPA from <a href="https://github.com/open-dict-data/ipa-dict" target="_blank" rel="noopener">open-dict-data/ipa-dict</a>.
      </p>
    </div>
  `;
  $('cta-start').addEventListener('click', enterPractice);
}


export function enterPractice() {
  $('header').hidden = false;
  buildPool();
  advance();
}
