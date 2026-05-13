#!/usr/bin/env python3
"""
build_data.py: produce sentences.json for cloze.fr

Inputs:
  - pairs.tsv         : Tatoeba French↔English pairs
                        (from eudoxia0/diy-clozemaster, format:
                         eng_id \\t eng_text \\t fra_id \\t fra_text)
  - fr_freq.txt       : OpenSubtitles 2018 French frequency list
                        (from hermitdave/FrequencyWords, format:
                         word\\scount, ranked by frequency descending)

Why two sources? Word frequencies should reflect *real-world French*: not
just what happens to appear in our sentence corpus. The OpenSubtitles list
is built from millions of subtitle lines, so it's a much better proxy for
"what words a learner will actually encounter" than counting words in our
filtered Tatoeba subset (which is biased: lots of Tom/Marie placeholder
sentences, lots of basic example dialogues, weird coverage of advanced
vocab).

So: OpenSubtitles tells us what *should* be in band N. Tatoeba gives us the
example sentences. The card for "vilain" goes in whichever band the
OpenSubtitles list places vilain in (band 5), not whichever band a Tatoeba
recount puts it in (band 10).

Get the source files:
    git clone --depth 1 https://github.com/eudoxia0/diy-clozemaster.git
    cp 'diy-clozemaster/Sentence pairs in English-French - 2023-02-06.tsv' pairs.tsv

    git clone --depth 1 https://github.com/hermitdave/FrequencyWords.git
    cp FrequencyWords/content/2018/fr/fr_50k.txt fr_freq.txt

No dependencies outside Python standard library.
"""

from __future__ import annotations

import argparse
import bz2
import csv
import io
import json
import random
import re
import sys
import time
import urllib.request
from collections import Counter, defaultdict
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Tuple

HERE = Path(__file__).parent
LOCAL_TSV = HERE / "pairs.tsv"
FREQ_FILE = HERE / "fr_freq.txt"
NAMES_FILE = HERE / "names_list.json"  # CC0 list of common given names + surnames
CACHE = HERE / ".tatoeba_cache"
DATA_DIR = HERE / "data"
OUT_FILE = DATA_DIR / "sentences.json"

URLS = {
    "fra_sentences.tsv.bz2":   "https://downloads.tatoeba.org/exports/per_language/fra/fra_sentences.tsv.bz2",
    "eng_sentences.tsv.bz2":   "https://downloads.tatoeba.org/exports/per_language/eng/eng_sentences.tsv.bz2",
    "links.csv.bz2":           "https://downloads.tatoeba.org/exports/links.csv.bz2",
}

MIN_FRENCH_WORDS = 4
MAX_FRENCH_WORDS = 14
MAX_PER_BAND     = 1500
TOTAL_BANDS      = 10
MIN_WORD_LEN     = 2

NEVER_CLOZE = {
    "le","la","les","un","une","des","de","du","à","au","aux","et","ou","ni",
    "mais","donc","car","que","qui","quoi","dont","où","ce","cet","cette","ces",
    "par","pour","sur","dans","sans","sous","vers","chez","entre","avec",
    "depuis","pendant","avant","après","jusqu",
    "il","elle","ils","elles","je","j","tu","nous","vous","on","se","me","te",
    "lui","leur","y","en","ne","pas","plus","très","si","oui","non",
    "mon","ma","mes","ton","ta","tes","son","sa","ses","notre","nos",
    "votre","vos","leurs",
    "est","sont","es","êtes","ai","as","a","ont","avons","avez","fut","été",
    "être","avoir","fait","faire","dit","dire","va","vais","allons","allez","vont",
    "suis","sommes","était","étaient","étais","serait","aurait",
    "tom","marie","mary","john","mike","ken","bob","tony","betty","alice","jane","jim",
    "s","d","m","l","t","c","n","qu","puisqu","lorsqu",
}

# French word tokenizer. We deliberately do NOT include apostrophes in the
# character class: that way "l'arbre" tokenizes to ["l", "arbre"] (two
# words), keeping the cloze answer to a single typeable word. Hyphens DO
# stay inside ("grand-mère", "peux-tu", "celui-ci": single token).
# This regex must match the JS-side TOKEN_RE in index.html exactly.
TOKEN_RE = re.compile(r"[A-Za-zÀ-ÖØ-öø-ÿœŒæÆ\-]+", re.UNICODE)


def tokenize(s: str) -> List[str]:
    return TOKEN_RE.findall(s)


def normalize(w: str) -> str:
    return w.lower().replace("’", "'")


# ---------- loaders ----------

def load_local_tsv(path: Path) -> List[Tuple[int, str, int, str]]:
    """Read pairs from the diy-clozemaster TSV.
    Format: eng_id \t eng_text \t fra_id \t fra_text
    Returns (fra_id, fra_text, eng_id, eng_text) per row.
    Multiple translations per English ID are collapsed: keep first
    occurrence of each French ID."""
    pairs: List[Tuple[int, str, int, str]] = []
    seen_fra: set = set()
    with open(path, "r", encoding="utf-8-sig", newline="") as f:
        for line in f:
            line = line.rstrip("\r\n")
            if not line:
                continue
            parts = line.split("\t")
            if len(parts) < 4:
                continue
            try:
                eid = int(parts[0])
                fid = int(parts[2])
            except ValueError:
                continue
            etext = parts[1].strip()
            ftext = parts[3].strip()
            if not etext or not ftext:
                continue
            if fid in seen_fra:
                continue
            seen_fra.add(fid)
            pairs.append((fid, ftext, eid, etext))
    return pairs


def fetch(name: str, url: str) -> Path:
    CACHE.mkdir(exist_ok=True)
    out = CACHE / name
    if out.exists() and out.stat().st_size > 1024:
        print(f"  cached: {name} ({out.stat().st_size / 1e6:.1f} MB)")
        return out
    print(f"  downloading {name}…")
    req = urllib.request.Request(url, headers={"User-Agent": "EnContexte/1.0"})
    with urllib.request.urlopen(req, timeout=120) as r:
        total = int(r.headers.get("Content-Length", "0"))
        got = 0
        t0 = time.time()
        with open(out, "wb") as f:
            while True:
                buf = r.read(64 * 1024)
                if not buf:
                    break
                f.write(buf); got += len(buf)
                if total:
                    pct = got * 100 // total
                    speed = got / 1e6 / max(time.time() - t0, 0.01)
                    sys.stdout.write(f"\r    {pct:3d}%  {got/1e6:6.1f} MB  {speed:5.2f} MB/s")
                    sys.stdout.flush()
        sys.stdout.write("\n")
    return out


def open_tatoeba(path: Path):
    if path.suffix == ".bz2":
        return io.TextIOWrapper(bz2.open(path, "rb"), encoding="utf-8", newline="")
    return open(path, "r", encoding="utf-8", newline="")


def load_tatoeba_sentences(path: Path) -> Dict[int, str]:
    out: Dict[int, str] = {}
    with open_tatoeba(path) as f:
        reader = csv.reader(f, delimiter="\t", quoting=csv.QUOTE_NONE)
        for row in reader:
            if len(row) >= 3:
                try:
                    sid = int(row[0])
                except ValueError:
                    continue
                out[sid] = row[2]
    return out


def load_tatoeba_links(path: Path, fra_ids: set, eng_ids: set) -> List[Tuple[int, int]]:
    pairs: List[Tuple[int, int]] = []
    with open_tatoeba(path) as f:
        sample = f.read(4096); f.seek(0)
        first_line = (sample.splitlines() or [""])[0]
        delim = "\t" if "\t" in first_line else ","
        reader = csv.reader(f, delimiter=delim, quoting=csv.QUOTE_NONE)
        for row in reader:
            if len(row) < 2:
                continue
            try:
                a, b = int(row[0]), int(row[1])
            except ValueError:
                continue
            if a in fra_ids and b in eng_ids:
                pairs.append((a, b))
    return pairs


def load_via_tatoeba() -> List[Tuple[int, str, int, str]]:
    print("Step 1: download Tatoeba exports")
    paths = {name: fetch(name, url) for name, url in URLS.items()}
    print("  loading French sentences…");  fra = load_tatoeba_sentences(paths["fra_sentences.tsv.bz2"])
    print(f"    {len(fra):,}")
    print("  loading English sentences…"); eng = load_tatoeba_sentences(paths["eng_sentences.tsv.bz2"])
    print(f"    {len(eng):,}")
    print("  loading links…");              links = load_tatoeba_links(paths["links.csv.bz2"], set(fra), set(eng))
    print(f"    {len(links):,}")
    fr_to_en: Dict[int, int] = {}
    for fid, eid in links:
        if fid not in fr_to_en:
            fr_to_en[fid] = eid
    return [(fid, fra[fid], eid, eng[eid]) for fid, eid in fr_to_en.items()]


# ---------- filter & cloze ----------

def is_clean_french(s: str) -> bool:
    if not s or len(s) > 200: return False
    n = len(tokenize(s))
    if n < MIN_FRENCH_WORDS or n > MAX_FRENCH_WORDS: return False
    if re.search(r"https?://|www\.", s): return False
    if re.search(r"\d{3,}", s): return False
    return True


def is_clean_english(s: str) -> bool:
    if not s or len(s) > 200: return False
    n = len(tokenize(s))
    if n < 3 or n > 22: return False
    if re.search(r"https?://|www\.", s): return False
    # Drop pairs where the English translation uses noun-form vulgarities that
    # are usually a sign the translation is outdated/awkward, not a faithful
    # rendering of the French. e.g. "He's a private dick" for "Il est détective
    # privé." (the original 7731129). This is a tiny denylist: most flagged
    # words are valid in other senses, but in the noun positions these forms
    # take, they're almost always the bad kind.
    if re.search(r"\b(dick|prick|cock)s?\b", s, re.I):
        return False
    return True


# Tatoeba pair IDs to exclude individually. Add IDs here when users report
# bad pairs that don't fall to the regex filters. Keep this list small.
# this is whack-a-mole, the dismiss button is the primary defense.
EXCLUDE_TATOEBA_IDS: set[int] = {
    7731129,  # "Il est détective privé." / "He's a private dick." (vulgar slang)
}


def load_opensubtitles_freq(path: Path) -> Tuple[Dict[str, int], Dict[str, int]]:
    """Load the OpenSubtitles 2018 word frequency list.

    Format: lines of `word count` ordered by frequency descending. Returns
    (word_rank, word_count) dicts where ranks are 1-based (rank 1 = most
    common). Both keys are normalized (lowercase, curly-apostrophes mapped).

    OpenSubtitles is the right ranking source: it reflects real spoken/
    written French (~millions of subtitle lines), not whatever happens to be
    in our particular Tatoeba subset.
    """
    if not path.exists():
        raise FileNotFoundError(
            f"{path.name} not found.\n"
            "Run: git clone --depth 1 https://github.com/hermitdave/FrequencyWords.git\n"
            "     cp FrequencyWords/content/2018/fr/fr_50k.txt fr_freq.txt"
        )
    word_rank: Dict[str, int] = {}
    word_count: Dict[str, int] = {}
    with path.open(encoding="utf-8") as f:
        rank = 0
        for line in f:
            parts = line.strip().split()
            if len(parts) < 2:
                continue
            try:
                count = int(parts[-1])
            except ValueError:
                continue
            word = " ".join(parts[:-1])  # words can be multi-token? rare
            norm = normalize(word)
            if not norm:
                continue
            # The list may have duplicates after normalization (curly vs straight
            # apostrophe). Keep the first (highest frequency) occurrence.
            if norm in word_rank:
                continue
            rank += 1
            word_rank[norm] = rank
            word_count[norm] = count
    return word_rank, word_count


def build_cap_stats(clean: List[Tuple[int, str, int, str]]) -> Tuple[Counter, Counter]:
    """Scan the corpus and count how often each word appears capitalized
    mid-sentence vs lowercase mid-sentence. (Sentence-start positions are
    excluded: every word looks capitalized there, regardless of whether
    it's a name.)

    Returns (cap_counts, low_counts): word.lower() -> int.
    """
    cap_counts: Counter = Counter()
    low_counts: Counter = Counter()
    for _, ftext, _, _ in clean:
        toks = tokenize(ftext)
        for i, w in enumerate(toks):
            if i == 0: continue          # sentence-start: no info about name-ness
            lw = w.lower()
            if w[:1].isupper() and (len(w) > 1 and w[1:].islower()):
                cap_counts[lw] += 1
            else:
                low_counts[lw] += 1
    return cap_counts, low_counts


def load_names_list(path: Path) -> set:
    """Load the curated names list (CC0, ~3k common given names + surnames
    across many countries) from names_list.json. Lowercased.

    The list is intentionally a fallback: it catches names that are too
    rare in our corpus to detect statistically (e.g., Bruno: only 3 corpus
    appearances, all at sentence-start).
    """
    if not path.exists():
        # Names list is optional but recommended; the statistical signal
        # alone catches well-attested names. Warn and continue.
        print(f"  ⚠ {path.name} not found: falling back to statistical signal only.")
        print(f"    (Cards with low-frequency names like 'Bruno' may slip through.)")
        return set()
    return set(json.loads(path.read_text(encoding="utf-8")))


def is_name(w: str, cap_counts: Counter, low_counts: Counter,
            names_list: set) -> bool:
    """Decide whether a word should be treated as a name / proper noun
    (and therefore never clozed).

    Two complementary signals:

    1. **Corpus statistics**: a word seen ≥ 5 times mid-sentence with ≥ 70%
       of those appearances capitalized is overwhelmingly a name in this
       corpus (regardless of whether we have a curated list entry).

    2. **Curated names list**: catches rare names not well-attested in the
       corpus (e.g., "Bruno" appears 3× total, all sentence-start). To avoid
       false positives on real words that collide with names (e.g., "rose"
       the flower and "Rose" the name), we override the curated list when
       the corpus strongly says it's a real word: ≥ 10 lowercase appearances
       AND lowercase usage ≥ 5× capitalized.
    """
    lw = w.lower()
    n_cap = cap_counts.get(lw, 0)
    n_low = low_counts.get(lw, 0)
    total_mid = n_cap + n_low

    # Signal 1: corpus statistics
    if total_mid >= 5 and n_cap / total_mid >= 0.7:
        return True

    # Signal 2: curated list, with corpus-based override for false positives
    if lw in names_list:
        if n_low >= 10 and n_low >= 5 * max(1, n_cap):
            return False   # corpus says it's a real word
        return True

    return False


def is_proper_noun_like(i: int, w: str, word_rank: Dict[str, int],
                        cap_counts: Counter, low_counts: Counter,
                        names_list: set) -> bool:
    """Words we should treat as 'transparent' for level assignment: they
    don't count toward the difficulty of the sentence. Three cases:

    1. Single capital letter alone = sentence-variable placeholder. e.g.
       "Quelle est la différence entre A et B ?": A and B are stand-ins.

    2. The word is a name per is_name(): matches our curated list and/or
       statistical signal. Names should never affect band difficulty.

    3. Capitalized mid-sentence and ranked beyond the curriculum (>10k), or
       missing from the frequency list. e.g. "J'ai vu Pessoa hier soir."
      : Pessoa is band-irrelevant. (This is a fallback for when neither
       the names list nor the corpus stats have caught a name.)
    """
    # case 1: single-letter placeholders
    if len(w) == 1 and w.isupper() and w.isalpha():
        return True
    # case 2: known name (works at any position, including sentence-start)
    if w[:1].isupper() and is_name(w, cap_counts, low_counts, names_list):
        return True
    # case 3: capitalized mid-sentence + out of curriculum range
    if i > 0 and w[:1].isupper() and w[1:].islower():
        rank = word_rank.get(w.lower())
        if rank is None or rank > TOTAL_BANDS * 1000:
            return True
    return False


def assign_band(rank: int) -> int:
    return min(TOTAL_BANDS, (rank - 1) // 1000 + 1)


def sentence_band(words: List[str], word_rank: Dict[str, int],
                  cap_counts: Counter, low_counts: Counter,
                  names_list: set) -> Optional[int]:
    """Return the lowest band B such that EVERY non-name word in the
    sentence has rank ≤ B*1000. This is the level at which a learner who
    has mastered up to band B should comfortably read this sentence.

    Returns None if the sentence's hardest word is past TOTAL_BANDS*1000,
    or if no word in the sentence is in our frequency list at all.
    """
    max_rank = 0
    saw_any = False
    for i, w in enumerate(words):
        if is_proper_noun_like(i, w, word_rank, cap_counts, low_counts, names_list):
            continue
        norm = normalize(w)
        rank = word_rank.get(norm)
        if rank is None:
            # Word not in OpenSubtitles top-50k. Could be a typo, an obscure
            # form, or a name we didn't catch. Treat as out-of-curriculum:
            # skip, don't penalize.
            continue
        saw_any = True
        if rank > max_rank:
            max_rank = rank
    if not saw_any:
        return None
    band = assign_band(max_rank)
    if band > TOTAL_BANDS:
        return None
    return band


def matches_shape(a: str, b: str) -> bool:
    if not a or not b: return False
    if (a[:1].isupper()) != (b[:1].isupper()): return False
    end_a = a[-1].lower(); end_b = b[-1].lower()
    vowels = set("aeiouéèêëàâîïôöûüy")
    return (end_a in vowels) == (end_b in vowels)


def pick_cloze(words: List[str], word_rank: Dict[str, int],
               cap_counts: Counter, low_counts: Counter,
               names_list: set) -> Optional[Tuple[int, str]]:
    """Pick the rarest clozable word (highest rank in OpenSubtitles).
    Skips stopwords, single-letter placeholders, and proper nouns (names,
    places, brands), even when they appear at sentence-start.
    """
    candidates: List[Tuple[int, str, int]] = []
    for i, w in enumerate(words):
        norm = normalize(w)
        if len(norm) < MIN_WORD_LEN: continue
        if norm in NEVER_CLOZE: continue
        rank = word_rank.get(norm)
        if rank is None: continue
        if rank > TOTAL_BANDS * 1000: continue   # past the curriculum
        # Skip single-letter placeholders ("A", "B", "X")
        if len(w) == 1 and w.isupper() and w.isalpha():
            continue
        # Skip names / places / brands (works at any position, sentence-start
        # included: this is what was missing before: "Bruno" at index 0
        # used to pass through and become a cloze)
        if is_proper_noun_like(i, w, word_rank, cap_counts, low_counts, names_list):
            continue
        candidates.append((i, w, rank))
    if not candidates: return None
    # Highest rank = rarest. Tiebreak: leftmost in sentence.
    candidates.sort(key=lambda x: (-x[2], x[0]))
    idx, word, _ = candidates[0]
    return idx, word


def make_distractors(answer: str, by_band: Dict[int, List[str]],
                     band_idx: int, rng: random.Random) -> List[str]:
    norm_answer = normalize(answer)
    pool: List[str] = []
    for delta in (0, -1, 1, -2, 2):
        b = band_idx + delta
        if b in by_band:
            pool.extend(by_band[b])
        if len(pool) > 4000:
            break
    rng.shuffle(pool)
    chosen: List[str] = []
    seen = {norm_answer}
    for w in pool:
        if len(chosen) == 3: break
        nw = normalize(w)
        if nw in seen: continue
        if not matches_shape(answer, w): continue
        chosen.append(w); seen.add(nw)
    if len(chosen) < 3:
        for w in pool:
            if len(chosen) == 3: break
            nw = normalize(w)
            if nw in seen: continue
            chosen.append(w); seen.add(nw)
    return chosen[:3]


# ---------- main ----------

def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--tatoeba", action="store_true",
                    help="Force fresh download from downloads.tatoeba.org")
    ap.add_argument("--input", type=Path, default=LOCAL_TSV,
                    help=f"Local TSV file (default: {LOCAL_TSV.name})")
    ap.add_argument("--out", type=Path, default=OUT_FILE)
    ap.add_argument("--max-per-band", type=int, default=MAX_PER_BAND)
    args = ap.parse_args()
    DATA_DIR.mkdir(exist_ok=True)

    if args.tatoeba or not args.input.exists():
        if not args.tatoeba:
            print(f"⚠  {args.input.name} not found, falling back to Tatoeba download")
        raw_pairs = load_via_tatoeba()
    else:
        print(f"Loading {args.input.name}…")
        raw_pairs = load_local_tsv(args.input)
        print(f"  {len(raw_pairs):,} raw pairs")

    print("Filtering…")
    seen_text: set = set()
    clean: List[Tuple[int, str, int, str]] = []
    excluded_by_id = 0
    for fid, ftext, eid, etext in raw_pairs:
        if fid in EXCLUDE_TATOEBA_IDS:
            excluded_by_id += 1
            continue
        if not is_clean_french(ftext) or not is_clean_english(etext):
            continue
        key = ftext.lower()
        if key in seen_text: continue
        seen_text.add(key)
        clean.append((fid, ftext, eid, etext))
    print(f"  {len(clean):,} clean pairs")
    if excluded_by_id:
        print(f"  excluded {excluded_by_id} pairs by explicit ID denylist")

    print(f"Loading OpenSubtitles frequency list ({FREQ_FILE.name})…")
    word_rank, word_count = load_opensubtitles_freq(FREQ_FILE)
    print(f"  {len(word_rank):,} ranked word forms (rank 1 = most common)")

    # Sanity-check: top 10 should be common stopwords
    top10 = sorted(word_rank.items(), key=lambda kv: kv[1])[:10]
    print(f"  top 10: {', '.join(w for w, _ in top10)}")

    print("Loading curated names list…")
    names_list = load_names_list(NAMES_FILE)
    print(f"  {len(names_list):,} names")

    print("Computing corpus capitalization statistics…")
    cap_counts, low_counts = build_cap_stats(clean)
    print(f"  {len(cap_counts):,} words seen capitalized mid-sentence")

    # by_band_words: distractor pools per band, taken from the OpenSubtitles
    # ranking. Distractors must be plausible same-level words.
    by_band_words: Dict[int, List[str]] = defaultdict(list)
    for w, r in word_rank.items():
        if r > TOTAL_BANDS * 1000: break
        b = assign_band(r)
        by_band_words[b].append(w)

    rng = random.Random(42)

    # ------------------------------------------------------------------
    # Level-assignment algorithm (per-target-word):
    #
    # For each band B (1..10), we want one sentence for every word whose
    # OpenSubtitles rank is in band B. Each sentence's job is to teach that
    # word.
    #
    # Requirements for a sentence to qualify as the band-B card for target
    # word T:
    #   1. T appears in the sentence as a clozable word
    #   2. T is the rarest clozable word in that sentence (so pick_cloze
    #      will pick it)
    #   3. The sentence's hardest word (excluding placeholders/proper nouns)
    #      is rank ≤ B*1000: the surrounding context is band-B-or-easier
    #
    # Among qualifying sentences for the same target, we prefer shorter ones
    # (typically more useful for early study). Ties broken by sentence ID for
    # determinism.
    # ------------------------------------------------------------------

    print("Indexing sentences by their cloze word…")
    # cloze_word_norm -> list of (sentence_band, length, fid, ftext, eid, etext, cloze_idx, cloze_word)
    by_cloze: Dict[str, List[Tuple[int, int, int, str, int, str, int, str]]] = defaultdict(list)
    skip_no_cloze = 0
    skip_no_band = 0

    for fid, ftext, eid, etext in clean:
        words = tokenize(ftext)
        sb = sentence_band(words, word_rank, cap_counts, low_counts, names_list)
        if sb is None:
            skip_no_band += 1
            continue
        pick = pick_cloze(words, word_rank, cap_counts, low_counts, names_list)
        if not pick:
            skip_no_cloze += 1
            continue
        cloze_idx, cloze_word = pick
        norm = normalize(cloze_word)
        by_cloze[norm].append((sb, len(words), fid, ftext, eid, etext, cloze_idx, cloze_word))

    # Sort each list: lowest sentence_band first (so we use sentences whose
    # context is at the target's level when possible), then shortest, then
    # by fid for determinism.
    for k in by_cloze:
        by_cloze[k].sort(key=lambda t: (t[0], t[1], t[2]))

    print("Building cards (one per target word per band)…")
    out_rows: List[dict] = []
    band_counts: Dict[int, int] = defaultdict(int)
    no_card_for_word = 0
    skip_no_distractors = 0

    # Walk the frequency-ranked word list. Each word becomes (at most) one
    # card, in the band determined by its OpenSubtitles rank.
    for target_norm, target_rank in sorted(word_rank.items(), key=lambda kv: kv[1]):
        if target_rank > TOTAL_BANDS * 1000:
            break  # past the end of band 10: outside the curriculum
        target_band = assign_band(target_rank)

        # Skip words we never clozify (stopwords, pronouns, etc.)
        if target_norm in NEVER_CLOZE:
            continue
        if len(target_norm) < MIN_WORD_LEN:
            continue
        # Skip single-letter placeholders (uppercase A/B/X are excluded,
        # but the lowercased form is what's in the freq table; still skip
        # if the only display form is a single capital letter)
        if len(target_norm) == 1:
            continue
        # Skip names: they shouldn't be target cloze words at any band.
        # `is_name` consults both the corpus stats and the curated list.
        if is_name(target_norm, cap_counts, low_counts, names_list):
            continue

        # Find a qualifying sentence for this target. We need:
        #   sentence's own band ≤ target_band  (context not too hard)
        candidates = by_cloze.get(target_norm, [])
        chosen = None
        for cand in candidates:
            sb, length, fid, ftext, eid, etext, cloze_idx, cloze_word = cand
            if sb <= target_band:
                chosen = cand
                break
        if not chosen:
            no_card_for_word += 1
            continue

        sb, length, fid, ftext, eid, etext, cloze_idx, cloze_word = chosen

        distractors = make_distractors(cloze_word, by_band_words, target_band, rng)
        if len(distractors) < 3:
            skip_no_distractors += 1
            continue

        out_rows.append({
            "id":   fid,
            "fr":   ftext,
            "en":   etext,
            "idx":  cloze_idx,
            "ans":  cloze_word,
            "opts": distractors,
            "band": target_band,
            "rank": target_rank,
        })
        band_counts[target_band] += 1

    out_rows.sort(key=lambda r: (r["band"], r["rank"]))

    print(f"  {len(out_rows):,} cloze cards")
    print(f"  skipped {skip_no_cloze:,} sentences with no clozable word")
    print(f"  skipped {skip_no_band:,} sentences past band 10")
    print(f"  skipped {no_card_for_word:,} target words with no qualifying sentence")
    print(f"  skipped {skip_no_distractors:,} cards lacking 3 distractors")
    print("\n  Cards per band (max 1000 per band: the band's word count):")
    for b in range(1, TOTAL_BANDS + 1):
        lo, hi = (b-1)*1000+1, b*1000
        print(f"    band {b}  (top {lo}–{hi}):  {band_counts[b]:>4} cards")

    payload = {
        "version": 1,
        "language_pair": "fra-eng",
        "source": "Tatoeba (CC BY 2.0 FR): https://tatoeba.org",
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "bands": TOTAL_BANDS,
        "sentences": out_rows,
    }
    args.out.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
    print(f"\n✓ wrote {args.out}  ({args.out.stat().st_size / 1e6:.1f} MB)")

    # ------------------------------------------------------------------
    # Reference exports: which words live in which band
    # ------------------------------------------------------------------
    # words.json: machine-readable, per-band ranked word list with counts
    # words.md  : human-readable summary with the top-N of each band shown
    # ------------------------------------------------------------------

    words_by_band: Dict[int, List[Tuple[str, int, int]]] = defaultdict(list)
    for w, rank in sorted(word_rank.items(), key=lambda kv: kv[1]):
        if rank > TOTAL_BANDS * 1000:
            break
        b = assign_band(rank)
        words_by_band[b].append((w, rank, word_count.get(w, 0)))

    words_json = DATA_DIR / "words.json"
    words_payload = {
        "source": "Word frequencies from OpenSubtitles 2018 French subtitle corpus "
                  "(via hermitdave/FrequencyWords on GitHub, MIT). Rank 1 = most "
                  "common form across millions of subtitle lines.",
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "bands": TOTAL_BANDS,
        "by_band": {
            str(b): [
                {"rank": r, "word": w, "count": c}
                for (w, r, c) in words_by_band[b]
            ] for b in range(1, TOTAL_BANDS + 1)
        },
    }
    words_json.write_text(json.dumps(words_payload, ensure_ascii=False, indent=2))
    print(f"✓ wrote {words_json}  ({words_json.stat().st_size / 1024:.1f} KB)")

    # Human-readable summary
    md_lines = [
        "# Frequency bands: word reference",
        "",
        "**Source:** OpenSubtitles 2018 French subtitle corpus, via "
        "[hermitdave/FrequencyWords](https://github.com/hermitdave/FrequencyWords) (MIT). "
        "Each band is 1000 frequency-ranked word forms.",
        "",
        "Rank 1 is the most common form (typically `de`, `je`, `est`, `pas`...). "
        "Cards in the app are only built for **content** words: stopwords like "
        "*le*, *je*, *est* appear here in the rank list but don't get their own "
        "cards (they're learned implicitly through context).",
        "",
        "Inflected forms are counted separately. So *aime* (rank ~155) and *aimer* "
        "(rank ~976) are distinct entries. This matches how the app teaches them: "
        "you'll meet them as separate cards in band 1.",
        "",
        "---",
        "",
    ]
    PER_BAND_PREVIEW = 50  # show the first 50 words of each band inline
    for b in range(1, TOTAL_BANDS + 1):
        words = words_by_band[b]
        if not words:
            continue
        lo, hi = (b-1)*1000+1, b*1000
        md_lines.append(f"## Band {b}: ranks {lo}–{hi}")
        md_lines.append("")
        md_lines.append(f"{len(words)} words. First {min(PER_BAND_PREVIEW, len(words))} shown; "
                        "see `words.json` for the full list.")
        md_lines.append("")
        md_lines.append("| Rank | Word | Occurrences |")
        md_lines.append("|-----:|:-----|------------:|")
        for w, r, c in words[:PER_BAND_PREVIEW]:
            md_lines.append(f"| {r} | `{w}` | {c:,} |")
        md_lines.append("")
    words_md = DATA_DIR / "words.md"
    words_md.write_text("\n".join(md_lines))
    print(f"✓ wrote {words_md}  ({words_md.stat().st_size / 1024:.1f} KB)")


if __name__ == "__main__":
    main()
