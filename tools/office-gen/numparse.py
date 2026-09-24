"""
Numbers, booleans and text AS A MODEL WRITES THEM — one parser for every renderer.

The renderers each had their own `_num`, and every one of them was wrong in the
same quiet way: `float(str(v).replace(",", "").replace("%", "").replace("k", "000"))`
turns "22M", "$38k", "1.2B" and "$24,000" into 0.0, so a market-size bar drew
EMPTY beside a full "3,100" bar and nothing said so (visual-quality.md D3). The
flow layout's `bool("false")` is True, so every node was "emphasised" (D5). And a
`display` of "GW" or "units" replaced the number on the bar (D4).

    parse("22M")      -> Parsed(value=22_000_000, scale="M")
    parse("$38k")     -> Parsed(value=38_000, currency="$", scale="k")
    parse("1,200 GW") -> Parsed(value=1200, unit="GW")
    parse("18%")      -> Parsed(value=18, pct=True)
    parse("(12)")     -> Parsed(value=-12)
    num("N/A", 0.0)   -> 0.0          (and parse() says None, so a caller can warn)
    truthy("false")   -> False
    shown("22M", "units") -> "22M units"

A comma followed by exactly three digits is a thousands separator ("3,100",
"1,200,000"); any other comma is a decimal comma ("3,5"). A lone lowercase `m`
after a bare number is a UNIT (metres, minutes), not millions — only a currency
makes "$5m" five million.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

__all__ = ["Parsed", "parse", "num", "truthy", "as_text", "shown", "has_digit", "fmt"]

_SCALE = {
    "k": 1e3, "K": 1e3, "thousand": 1e3,
    "M": 1e6, "m": 1e6, "mn": 1e6, "mm": 1e6, "mio": 1e6, "million": 1e6,
    "B": 1e9, "bn": 1e9, "billion": 1e9,
    "T": 1e12, "tn": 1e12, "trillion": 1e12,
}
_CURRENCY = ("US$", "USD", "EUR", "GBP", "$", "€", "£", "¥", "₹")
_NUM_RE = re.compile(
    r"""^\s*
    (?P<sign>[-+−–])?\s*
    (?P<cur>US\$|USD|EUR|GBP|[$€£¥₹])?\s*
    (?P<sign2>[-+−])?\s*
    (?P<num>\d[\d,]*(?:\.\d+)?|\.\d+)
    \s*(?P<scale>thousand|million|billion|trillion|mio|mn|mm|bn|tn|[kKMBTm])?(?![a-zA-Z])
    \s*(?P<pct>%)?
    \s*(?P<rest>.*?)\s*$""",
    re.X,
)


@dataclass(frozen=True)
class Parsed:
    value: float
    currency: str = ""
    scale: str = ""
    pct: bool = False
    unit: str = ""
    approx: bool = False


def has_digit(s) -> bool:
    return bool(re.search(r"\d", str(s or "")))


def _digits(tok: str) -> float:
    if "," in tok:
        groups = tok.split(",")
        if all(len(g) == 3 for g in groups[1:]) and groups[0]:
            tok = tok.replace(",", "")
        elif len(groups) == 2 and "." not in tok:
            tok = tok.replace(",", ".")          # a decimal comma: "3,5"
        else:
            tok = tok.replace(",", "")
    return float(tok)


def parse(v) -> Parsed | None:
    """One value as a model writes it, or None when it is not a single number."""
    if isinstance(v, bool) or v is None:
        return None
    if isinstance(v, (int, float)):
        return Parsed(float(v))
    s = str(v).strip()
    if not s:
        return None
    neg = False
    approx = False
    if s.startswith("(") and s.endswith(")"):          # accounting negative
        s, neg = s[1:-1].strip(), True
    while s and s[0] in "~≈<>≥≤":
        s, approx = s[1:].strip(), True
    if s.endswith("+"):                                  # "2.5B+"
        s, approx = s[:-1].strip(), True
    m = _NUM_RE.match(s)
    if not m:
        return None
    try:
        value = _digits(m.group("num"))
    except ValueError:
        return None
    cur = m.group("cur") or ""
    scale = m.group("scale") or ""
    rest = (m.group("rest") or "").strip()
    if scale == "m" and not cur:
        # "12m" is minutes or metres, not millions — unless money says so.
        rest = ("m " + rest).strip()
        scale = ""
    if scale:
        value *= _SCALE[scale]
    # A second number in the tail ("10–12", "2h 14m") means this is not one value.
    if re.match(r"^[-–—to]+\s*\d", rest) or re.match(r"^[hms]\b", rest) and has_digit(rest):
        return None
    if cur == "" and rest[:1] in ("$", "€", "£"):
        return None
    sign = (m.group("sign") or "") + (m.group("sign2") or "")
    if neg or any(ch in sign for ch in "-−–"):
        value = -value
    return Parsed(value=value, currency=cur, scale=scale, pct=bool(m.group("pct")),
                  unit=rest, approx=approx)


def num(v, default: float = 0.0) -> float:
    """The drop-in for the renderers' old `_num`: a float, or `default`."""
    p = parse(v)
    return p.value if p is not None else default


_TRUE = {"true", "yes", "y", "1", "on", "t", "✓", "✔", "x"}
_FALSE = {"false", "no", "n", "0", "off", "f", "", "none", "null", "-", "–", "—"}


def truthy(v, *, loose: bool = False) -> bool:
    """A model's boolean. Strings name their value: "false" is False (D5).

    Any OTHER word is not a yes by default — the 4B wrote `"emphasis": "current"`,
    `"goal"`, `"outcome"` on three flow nodes, and highlighting all three is the
    bug, not the intent. `loose=True` is for a matrix cell, where a word in the
    cell ("High", "partial") still means something is there."""
    if isinstance(v, bool):
        return v
    if v is None:
        return False
    if isinstance(v, (int, float)):
        return v != 0
    s = str(v).strip().lower()
    if s in _TRUE:
        return True
    if s in _FALSE:
        return False
    return loose


def as_text(v) -> str:
    """Whatever the model produced -> a string (a list where a string was asked
    for is common enough on a 4B to be load-bearing)."""
    if v is None:
        return ""
    if isinstance(v, str):
        return v
    if isinstance(v, bool):
        return "yes" if v else "no"
    if isinstance(v, (int, float)):
        return fmt(float(v))
    if isinstance(v, (list, tuple)):
        return "  ".join(as_text(x) for x in v if x is not None)
    if isinstance(v, dict):
        for k in ("text", "value", "label", "content"):
            if k in v:
                return as_text(v[k])
        return "  ".join(as_text(x) for x in v.values())
    return str(v)


def fmt(x: float) -> str:
    """A number for a label: thousands grouped, no trailing .0."""
    if abs(x - round(x)) < 1e-9:
        return f"{int(round(x)):,}"
    return f"{x:,.2f}".rstrip("0").rstrip(".")


def shown(value, display) -> str:
    """What goes on the bar: the display the model wrote when it carries a number;
    the value PLUS that text when the display is only a unit ("GW", "units" — D4);
    the value alone when there is no display."""
    d = as_text(display).strip()
    v = as_text(value).strip()
    if d and has_digit(d):
        return d
    if d and v:
        return f"{v} {d}"
    return v or d
