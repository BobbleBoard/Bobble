"""
THE DESIGN KITS, as the document pipeline reads them (VQ-04).

A deck, the chart on its third slide and the title card that opens the launch
video should look like they came from one studio. The kits that make that
possible live in TypeScript (packages/design-kit/src/kits/*.json, validated
there for contrast, colour-blind separation and no purple) and are exported,
unchanged, to design_tokens.json beside this file. This module reads that
export — the SAME tokens the chart tool and the diagram renderer read — so
Python never keeps a palette of its own (deliverables/research/
visual-quality.md §4.0: five disconnected style systems was the bug).

Never edit design_tokens.json by hand: `pnpm --filter @pi-desktop/design-kit
export-tokens` writes it, and a test on each side holds it to the kit files.

    import design_tokens as dt
    dt.kit("fog")["light"]["accent"]      # '#1B1C1E'
    dt.kit_palette("paper-blue")          # a palette.Palette in the kit's colours
"""
from __future__ import annotations

import json
import re
import sys
from functools import lru_cache
from pathlib import Path

HERE = Path(__file__).resolve().parent
TOKENS = HERE / "design_tokens.json"

#: The colour roles every kit mode carries, in the TypeScript schema's order.
ROLES = (
    "paper", "surface", "ink", "mute", "line", "accent", "onAccent", "accentInk",
    "deep", "onDeep", "tint", "good", "bad", "warn", "highlight",
)


@lru_cache(maxsize=4)
def load(path: str | None = None) -> dict:
    """The whole export: {schema, default, order, kits}."""
    data = json.loads(Path(path or TOKENS).read_text(encoding="utf-8"))
    if data.get("schema") != 1:
        raise ValueError(f"design_tokens.json schema {data.get('schema')!r} — this reader knows 1")
    return data


def kit_ids() -> list[str]:
    """Every kit, in the order a picker shows them (the default first)."""
    return list(load()["order"])


def _key(name: str) -> str:
    k = re.sub(r"[\s_&]+", "-", name.strip().lower())
    return re.sub(r"-+", "-", k).strip("-")


def kit(name: str | None = None) -> dict:
    """A kit by id or name ("Paper & blue", "paper_blue"); the default when unknown or empty."""
    data = load()
    kits = data["kits"]
    if name:
        key = _key(name)
        for k in kits.values():
            if k["id"] == key or _key(k["name"]) == key:
                return k
    return kits[data["default"]]


def colours(name: str | None = None, mode: str = "light") -> dict:
    """One mode's colour roles (and its series)."""
    if mode not in ("light", "dark"):
        raise ValueError(f"mode must be light or dark, not {mode!r}")
    return kit(name)[mode]


def _platform() -> str:
    return "mac" if sys.platform == "darwin" else "windows" if sys.platform.startswith("win") else "linux"


def font_stack(name: str | None = None, role: str = "text", platform: str | None = None) -> str:
    """The kit's CSS font stack for display / text / mono type on this platform."""
    return kit(name)["type"][role][platform or _platform()]


# What a CSS stack may name that a document cannot: the keywords a browser
# resolves to the system face, the generic families, and Apple's system-private
# faces. SF Pro / SF Pro Rounded / New York ship inside macOS as hidden
# ".SF NS…" fonts a browser reaches through `-apple-system` / `ui-rounded`, but
# a deck that names them gets a substitute: sage & moss's slide came out of
# QuickLook in Times while its page, in Chromium, fell through to Avenir Next
# (visual-eval kits/sage-moss). A document names the first family it can carry.
_KEYWORDS = frozenset({
    "-apple-system", "blinkmacsystemfont", "system-ui", "new york",
    "serif", "sans-serif", "monospace", "cursive", "fantasy",
})
_PREFIXES = ("ui-", "sf pro", "sf compact")


def first_family(stack: str) -> str:
    """The first family of a CSS stack a document can name, unquoted — what
    python-pptx/docx take as a font name. Keywords, generics and Apple's
    system-private faces are passed over; a stack of nothing else gives
    Helvetica Neue."""
    for part in stack.split(","):
        name = part.strip().strip("'\"")
        low = name.lower()
        if name and low not in _KEYWORDS and not low.startswith(_PREFIXES):
            return name
    return "Helvetica Neue"


def contrast(a: str, b: str) -> float:
    """WCAG 2 contrast ratio — the arithmetic validate.ts uses, so Python can check a kit too."""
    def lum(h: str) -> float:
        h = h.lstrip("#")
        chans = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
        lin = [c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in chans]
        return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2]

    la, lb = lum(a), lum(b)
    hi, lo = max(la, lb), min(la, lb)
    return (hi + 0.05) / (lo + 0.05)


def kit_palette(name: str | None = None, mode: str = "light"):
    """The kit as the renderers' own `palette.Palette` — primary = the kit's accent
    AS WORDS (accentInk), accent = its highlight, and the rest from its roles,
    not derived by formula.

    primary, not accent: the renderers set headings and labels in `primary`, and
    palette.build() holds it to 4.5:1 on the paper for exactly that reason. A kit
    whose accent is only a fill (graphite & amber's amber, 3.2:1 on its paper)
    names a deeper twin for words, and that twin is what a heading must use."""
    import palette  # the office pipeline's own module, beside this one

    c = colours(name, mode)
    return palette.Palette(
        primary=c["accentInk"],
        accent=c["highlight"],
        deep=c["deep"],
        support=c["tint"],
        paper=c["paper"],
        ink=c["ink"],
        mute=c["mute"],
        faint=c["line"],
    )
