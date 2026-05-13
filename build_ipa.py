#!/usr/bin/env python3
"""
build_ipa.py: produce ipa.json for cloze.fr

Reads:
  - ipa-dict/data/fr_FR.txt  (from open-dict-data/ipa-dict, MIT)
  - sentences.json           (built by build_data.py)

Writes:
  - ipa.json: a focused per-word IPA lookup containing only the words that
    actually appear in our 15,000 sentences (keeps the file ~450 KB).

The upstream IPA dictionary has a quirk: short-stub apostrophe forms like
"l'école", "m'a", "n'ai" are transcribed as if you were spelling out the
letter ("l" → "ɛl"), giving "l'école" → /ɛlekɔl/ instead of /lekɔl/. This
script fixes that for short-stub forms by ignoring the dict's joined entry
and rebuilding from parts. Other apostrophe forms ("aujourd'hui",
"qu'est-ce") trust the dict.

No dependencies outside Python stdlib.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

HERE = Path(__file__).parent
SOURCE = HERE / "ipa-dict" / "data" / "fr_FR.txt"
SENTENCES = HERE / "data" / "sentences.json"
OUT = HERE / "data" / "ipa.json"

TOKEN_RE = re.compile(r"[A-Za-zÀ-ÖØ-öø-ÿœŒæÆ\-]+", re.UNICODE)
APOS_GLUE = re.compile(
    r"[A-Za-zÀ-ÖØ-öø-ÿœŒæÆ\-]+(?:[\u0027\u2019][A-Za-zÀ-ÖØ-öø-ÿœŒæÆ\-]+)+",
    re.UNICODE,
)

# Stubs whose elided IPA is just a single consonant glided onto the next vowel.
# The upstream dict spells these out as letter names; we synthesize correctly.
SHORT_STUB = {"l", "m", "n", "s", "t", "d", "c", "j"}
STUB_IPA = {
    "l": "l", "m": "m", "n": "n", "s": "s",
    "t": "t", "d": "d", "c": "s", "j": "ʒ",
}


def load_source() -> dict[str, str]:
    """Load the open-dict-data/ipa-dict French file. Format: word\t/IPA/[, /IPA/]."""
    if not SOURCE.exists():
        raise FileNotFoundError(
            f"{SOURCE} not found.\n"
            f"Run: git clone --depth 1 https://github.com/open-dict-data/ipa-dict.git"
        )
    out: dict[str, str] = {}
    with SOURCE.open(encoding="utf-8") as f:
        for line in f:
            parts = line.rstrip("\n").split("\t")
            if len(parts) != 2:
                continue
            word, transcr = parts
            first = transcr.split(",")[0].strip().strip("/")
            out[word.lower()] = first
    return out


def lookup_smart(w: str, ipa: dict[str, str]) -> str | None:
    """Look up a word, with fixes for the dict's short-stub bug."""
    w = w.lower()

    if "'" in w:
        parts = w.split("'")
        # Short-stub elision: ignore the dict's joined entry (it has spurious
        # ɛ-prefix) and synthesize from parts.
        if parts[0] in SHORT_STUB and len(parts) >= 2:
            rest = "'".join(parts[1:])
            rest_ipa = lookup_smart(rest, ipa)
            if rest_ipa is None:
                return None
            return STUB_IPA[parts[0]] + rest_ipa
        # Other apostrophe forms: trust the dict
        if w in ipa:
            return ipa[w]
        # Per-piece fallback
        pieces = [ipa.get(p) for p in parts]
        if all(pieces):
            return "".join(pieces)
        return None

    if w in ipa:
        return ipa[w]

    if "-" in w:
        parts = w.split("-")
        pieces = [ipa.get(p) for p in parts]
        if all(pieces):
            return "".join(pieces)
    return None


def main() -> None:
    print("Loading IPA source dictionary…")
    ipa = load_source()
    print(f"  {len(ipa):,} entries")

    print(f"Loading {SENTENCES.name}…")
    if not SENTENCES.exists():
        raise FileNotFoundError(f"{SENTENCES} not found. Run build_data.py first.")
    data = json.loads(SENTENCES.read_text(encoding="utf-8"))

    print("Collecting needed forms…")
    needed: set[str] = set()
    for r in data["sentences"]:
        for w in TOKEN_RE.findall(r["fr"]):
            needed.add(w.lower())
        needed.add(r["ans"].lower())
        for o in r["opts"]:
            needed.add(o.lower())
        # apostrophe-glued spans (aujourd'hui, qu'est-ce, jusqu'à...)
        for m in APOS_GLUE.finditer(r["fr"]):
            needed.add(m.group(0).lower().replace("\u2019", "'"))
    print(f"  {len(needed):,} unique forms")

    print("Building lookup…")
    out: dict[str, str] = {}
    for w in needed:
        v = lookup_smart(w, ipa)
        if v is not None:
            out[w] = v

    pct = 100 * len(out) / max(1, len(needed))
    print(f"  covered {len(out):,}/{len(needed):,}  ({pct:.1f}%)")

    OUT.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")))
    sz = OUT.stat().st_size / 1024
    print(f"\n✓ wrote {OUT}  ({sz:.1f} KB)")


if __name__ == "__main__":
    main()
