# En Contexte

**Learn French vocabulary in real sentences. Free. No login. No paywall. Data stored locally only.**


Anki is one of the most popular vocabulary learning tools through spaced repetition. However, often, it lacks context. En-contexte teaches you vocab in sentences, teaching you words in the context in which you would use them.

Open the app → see a French sentence with one word missing → type it. Each
letter lights up green if right, red if wrong. After answering you hear the
sentence, see the English translation, see the IPA pronunciation, and can
ask an AI tutor to break down the grammar. The next card comes back
tomorrow, then in three days, then further out as your memory holds.

That's the whole product.

---

## Why this exists

I love the *idea* behind [Clozemaster](https://www.clozemaster.com/) —
clozes drilled with spaced repetition, every word in a real sentence, no
flashcards floating in a vacuum. But Clozemaster gates the useful parts of
the app behind a subscription you have to pay for. So I built a clean-room replacement.

This isn't a direct Clozemaster clone. The data pipeline is different, the scheduler is different (more Anki inspired) and, I think, better overall. The interactions are different and the hosting
model is different (static files, your data lives in your browser, never
on a server, no one but you can access it).

It's free, it's open source, and you can host your own copy.

## What it does

- **Cloze drills** on 8,000+ French sentences ranked into 10 difficulty bands
  by word frequency, so vocabulary grows in a sensible order.
- **Type or multiple choice.** Typing earns more XP. `?` shortcut switches
  to multiple choice for one card if you're stuck.
- **Live typing feedback.** Each letter turns green as you type if it's
  right; any wrong letter flips the whole word red.
- **Strict accents.** `école` ≠ `ecole`. Click the accent buttons (é è ê
  ç ô œ etc.) if your keyboard doesn't have them.
- **Audio.** Hear every sentence in French. Browser TTS by default; toggle
  Google TTS in settings for better voices.
- **IPA.** Phonetic transcription of the sentence, shown after answering so
  it doesn't spoil the answer.
- **AI Explain.** One-click sends the sentence to Gemini (free tier, 1500
  requests/day) or Claude for a tutor-style breakdown of grammar, the cloze
  word, and pronunciation notes. Bring your own API key; it's stored in your
  browser and the request goes directly to the provider.
- **Spaced repetition.** A real implementation (more below).
- **Stats.** XP, daily streak, accuracy, mastery per band, last 14 days
  heatmap.
- **Tutorial.** A 9-step walkthrough on first use. Skippable. Replayable
  from settings.

## How the spaced repetition works

This app uses an Anki-inspired batch system:

1. **Each session is a batch of N cards** (default 10, configurable).
2. **You graduate each card from the batch only by typing it correctly 3
   times in a row.** Multiple choice correct keeps your streak but doesn't
   count toward graduation — typing is what unlocks progress. Wrong answer
   resets the streak.
3. **No new cards until the current batch is fully graduated.** You can't
   outrun the system.
4. **Daily new-card cap** (default 20, configurable up to 100). Once you've
   been introduced to your daily quota, batches only pull from review cards.
   When those are cleared, you get a "done for today" screen instead of being
   allowed to grind endlessly.
5. **Batch outcome determines SRS interval.** Clean run (no misses) ->
   3-day interval. Some struggle -> 1-day interval. Lots of misses or sticky
   cards -> back to 10-minute learning step.
6. **Reviews come back at growing intervals.** A card mastered today comes
   back in 3 days, then about 8 days, then 20, then 50, doubling-ish each
   success. A card you miss drops back into the relearning queue.

The result: you'll genuinely see each new card multiple times before moving
on, struggling cards get more repetition, and the schedule paces itself so
you can't accidentally introduce 50 new words and forget half of them by
tomorrow. This is how Anki has worked for years, but applied to clozes
inside real sentences instead of isolated flashcards.

## Quick start

```bash
git clone https://github.com/jaskeeratsingh/en-contexte.git
cd en-contexte
python3 -m http.server 8000
# open http://localhost:8000
```

`file://` won't work — browsers block `fetch()` and ES modules over local
files.

For Explain, paste your Gemini (free, get a key at
[aistudio.google.com](https://aistudio.google.com/apikey)) or Anthropic API
key in settings.

## Hosting on GitHub Pages

Push the whole repo, turn on Pages in the repo settings. That's it. There's
no build step, no Node, no backend. Every visitor gets their own
browser-local progress.

If you want to host at a custom domain, set up the CNAME and you're done.

## How persistence works

All progress is stored locally in the user's browser using **IndexedDB**.
It's per-device and per-browser; nothing is sent to a server. Wipe via
**Settings → Reset progress** or `indexedDB.deleteDatabase('en-contexte')` in
DevTools.

If you ever want cross-device sync, you'd need a backend (Cloudflare
Workers + KV is the cheapest option). The current architecture doesn't have
one and probably shouldn't until there's a real need.

## File layout

```
.
├── index.html              # tiny skeleton; loads styles/ and js/
├── styles/                 # plain CSS, no preprocessor
├── js/                     # ES modules, no bundler
│   ├── main.js             # boot + global keyboard
│   ├── state.js            # constants + the S object
│   ├── db.js               # IndexedDB wrapper
│   ├── persistence.js      # save/load meta, progress, batch
│   ├── srs.js              # spaced repetition math
│   ├── scheduler.js        # batch building + card selection
│   ├── render.js           # main render loop
│   ├── cover.js            # cover page
│   ├── settings.js         # settings + stats modal
│   ├── dismiss.js          # per-user dismiss flow
│   ├── explain.js          # Gemini + Anthropic API calls
│   ├── tutorial.js         # first-use walkthrough
│   ├── tokenize.js         # tokenizer + IPA lookup
│   ├── audio.js            # TTS + correct-answer chime
│   ├── icons.js            # SVG icons
│   └── util.js             # small helpers
├── data/                   # generated by the Python build scripts
│   ├── sentences.json      # ~8000 cards across 10 frequency bands
│   ├── ipa.json            # phonetic transcriptions
│   ├── words.json          # per-band word reference
│   └── words.md
├── build_data.py           # builds sentences.json + words.{json,md}
├── build_ipa.py            # builds ipa.json
└── names_list.json         # CC0 names list (filters proper nouns)
```

## Regenerating the data

The `data/` files ship pre-built, but you can rebuild from sources:

```bash
# Tatoeba sentence pairs (CC-BY 2.0 FR)
git clone --depth 1 https://github.com/eudoxia0/diy-clozemaster.git
cp 'diy-clozemaster/Sentence pairs in English-French - 2023-02-06.tsv' pairs.tsv

# OpenSubtitles 2018 French word frequencies (MIT)
git clone --depth 1 https://github.com/hermitdave/FrequencyWords.git
cp FrequencyWords/content/2018/fr/fr_50k.txt fr_freq.txt

# Build the cards
python3 build_data.py

# (Optional) Rebuild IPA
git clone --depth 1 https://github.com/open-dict-data/ipa-dict.git
python3 build_ipa.py
```

No dependencies outside the Python standard library.

## Contributing

Issues and pull requests welcome. A few specific things that'd be useful:

- **Report bad sentences.** Some Tatoeba translations are awkward, outdated,
  or wrong (looking at you, "Bruno shows signs of burn-out"). The app has a
  built-in dismiss button (the × in the card's top-right) that opens a
  pre-filled GitHub issue when configured — just set your repo URL in
  settings. Or open an issue manually with the sentence ID.
- **Other languages.** The pipeline is French-only right now but most of it
  is language-agnostic. Adding Spanish or German would mean swapping the
  Tatoeba TSV and the frequency list, plus tweaking the name detection
  heuristics. PRs welcome.
- **UI/UX improvements.** Especially mobile: the desktop experience is
  polished but mobile has rough edges.
- **More example sentences per word.** Currently each cloze word gets one
  sentence — adding optional alternates would help vary the practice.
- **Calibration quiz at first launch.** Pick the user's starting band based
  on a 20-question pre-test instead of dumping them at band 1.

Standard fork → branch → PR flow. No CLA, just be reasonable.

## About this codebase

Full disclosure: this is **vibe-coded** with Claude

I'm flagging this because anyone reading the code should know what was designed deliberately (high-level decisions).

The architectural decisions, the SRS model, the data quality work (proper
noun filtering via combined corpus statistics + curated names list,
build-time pair denylist, dismiss-and-report flow), the typing UX, and the
overall product direction are mine. The grunt work of writing 80KB of JS,
CSS, and Python was largely Claude's, under my direction.

## Credits

- **Sentences:** [Tatoeba](https://tatoeba.org/), CC BY 2.0 FR. Pre-filtered
  TSV from [eudoxia0/diy-clozemaster](https://github.com/eudoxia0/diy-clozemaster).
- **Word frequencies:**
  [hermitdave/FrequencyWords](https://github.com/hermitdave/FrequencyWords)
  (OpenSubtitles 2018), MIT.
- **Names list:**
  [sigpwned/popular-names-by-country-dataset](https://github.com/sigpwned/popular-names-by-country-dataset),
  CC0.
- **IPA dictionary:**
  [open-dict-data/ipa-dict](https://github.com/open-dict-data/ipa-dict),
  MIT.
- **Inspiration:** [Clozemaster](https://www.clozemaster.com/) (the
  concept), [Anki](https://apps.ankiweb.net/) (the SRS).
- **Code assistance:** [Claude](https://claude.ai/) by Anthropic.

## License

MIT. Use it, fork it, host it, modify it. Just leave the credits in.

---

Built by [Jaskeerat Singh Sarin](https://github.com/jaskeeratsingh).
