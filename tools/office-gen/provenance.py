"""
What an office document says that its brief did not — checked BEFORE it is drawn.

The plan/fill model that writes a deck or a document works from the brief alone,
with no conversation, and a small one fills the gaps it was never given: "2.5B+
daily consumers", a quote from "The Tea Lover's Perspective", "Total units 28"
when the brief's units add to 68, "83% YoY growth (2023 to 2024)" when the
brief's 2023 → 2024 is +46.7%, "Source: https://www.allrecipes.com/recipe/
123456/", "Data sourced from internal company metrics" — all REAL, in four
captured 4B specs (deliverables/research/visual-quality.md D18).

The check assumes nothing about the task. It only asks, of every number, quote,
URL and attribution in the spec: is it in the brief, or simple arithmetic on the
brief's numbers (a sum, a difference, a ratio or change, a product, an average)?
Where the spec SAYS which arithmetic — a label naming a total, a change or an
average over the brief's own years, quarters or months — the number must be
that arithmetic, not merely some arithmetic: 83% is (22 − 12) / 12, but the
label says 2023 to 2024.

The user's recommended default (PLAN.md §5 Q15) is what happens to what fails:
  - a PROVENANCE line naming a source the brief never gave is STRIPPED — it is
    pure invention, and a file that cites a fake source is worse than one that
    cites none;
  - every other unsupported number, quote, URL or attribution is FLAGGED in the
    warnings the chat model reads, so the reply can say so. Nothing else is
    removed: a model asked for "rough numbers" was asked to supply them.

Two label checks ride along, because the same second model writes them: a
kicker or eyebrow that DESCRIBES the slide ("Bar chart showing cumulative
capacity by year") is dropped — a label is one to three words — and the brief's
PARTS ("Problem: …", "Team: …") that no slide carries are named, which is how a
plan that followed the planner's own rule list instead of the brief shows up.
"""
from __future__ import annotations

import copy
import itertools
import re
from dataclasses import dataclass, field

import numparse

__all__ = ["Part", "Review", "brief_parts", "parts_block", "review", "pages_in", "facts",
           "supported_number", "supported_minutes"]

# ── text helpers ──────────────────────────────────────────────────────────────
_STOP = set("""a an and are as at be been but by for from has have in into is it its of on or our so
that the their them then there these they this to was we were what when which while who will with
you your per via over under than more most less least very just also each every all any some""".split())
_NUMBER_WORDS = {"one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8,
                 "nine": 9, "ten": 10, "eleven": 11, "twelve": 12, "dozen": 12, "single": 1, "pair": 2,
                 "twenty": 20, "hundred": 100}

NUM_TOKEN = re.compile(
    r"(?<![A-Za-z0-9.,])(?:US\$|[$€£¥₹])?\s?\d(?:[\d,]*\d)?(?:\.\d+)?"
    r"(?:\s?(?:k|K|M|B|T|bn|mn|(?i:thousand|million|billion|trillion))(?![A-Za-z]))?%?\+?")
DURATION = re.compile(
    r"\b(\d+)\s*h(?:ours?|rs?)?\s*(\d+)\s*m(?:in(?:utes?)?)?\b|\b(\d+)\s*(?:hours?|hrs?)\b|\b(\d+)\s*(?:minutes?|mins?)\b",
    re.I)
URL = re.compile(r"(?:https?://|www\.)[^\s)\]>\"']+|\b[a-z0-9-]+\.(?:com|org|net|io|gov|edu|co|uk|ai)(?:/[^\s)\]>\"']*)?",
                 re.I)
QUOTED = re.compile(r"[“\"]([^”\"]{12,}?)[”\"]")
PROVENANCE = re.compile(
    r"^\s*\(?\s*(?:"
    r"(?:(?:data|figures|numbers|statistics|stats|information|estimates|insights|findings|results)"
    r"(?:\s+\w+)?\s+(?:is\s+|are\s+|were\s+|was\s+)?)?"
    r"(?:sourced|derived|compiled|drawn|taken|gathered|obtained|adapted|pulled)\s+from"
    r"|sources?\s*:|based\s+on|according\s+to|courtesy\s+of|source\b)",
    re.I)
SELF_SOURCE = {"brief", "request", "user", "provided", "given", "prompt", "you", "your"}
META = re.compile(
    r"\b(chart|graph|diagram|slide|showing|shows|comparing|compared?|visuali[sz]\w*|illustrat\w*|"
    r"overview\s+of|map(?:ping)?\s+(?:the|out|how)|highlight(?:s|ing)?|summari[sz]\w*|key\s+metrics|"
    r"breakdown\s+of|describ\w*|depict\w*|this\s+(?:slide|section|deck))\b"
    # …or an instruction: the planner's "intent" copied into the label.
    r"|^\s*(?:map|compare|contrast|show|highlight|summari[sz]e|illustrate|visuali[sz]e|introduce|present|"
    r"describe|outline|explain|list|walk\s+through)\b", re.I)
ATTRIBUTION_LIKE = re.compile(
    r"\b(by|prepared|written|authored|team|department|director|head\s+of|manager|officer|chief|ceo|cfo|cto|"
    r"coo|founder|president|vp|analyst|expert|professor|dr\.?|editor|perspective|society|association|"
    r"institute|university|lover|enthusiast)\b", re.I)


def _norm(s: str) -> str:
    s = str(s or "").lower()
    s = s.replace("’", "'").replace("‘", "'").replace("“", '"').replace("”", '"')
    s = re.sub(r"[‐‑‒–—−]", "-", s)
    return re.sub(r"\s+", " ", s).strip()


def _words(s: str) -> list[str]:
    return [w.rstrip("s") if len(w) > 3 else w for w in re.findall(r"[a-z0-9]+", _norm(s))]


def _content(s: str) -> list[str]:
    return [w for w in _words(s) if w not in _STOP and len(w) >= 3 and not w.isdigit()]


def _is_year(tok: str, v: float) -> bool:
    return bool(re.fullmatch(r"\d{4}", tok.strip())) and 1900 <= v <= 2100


def _decimals(tok: str) -> int:
    m = re.search(r"\.(\d+)", tok)
    return len(m.group(1)) if m else 0


def _scale(tok: str) -> float:
    t = tok.strip().rstrip("%+")
    for suf, k in (("trillion", 1e12), ("billion", 1e9), ("million", 1e6), ("thousand", 1e3),
                   ("bn", 1e9), ("mn", 1e6), ("T", 1e12), ("B", 1e9), ("M", 1e6), ("k", 1e3), ("K", 1e3)):
        if t.lower().endswith(suf.lower()) if len(suf) > 1 else t.endswith(suf):
            return k
    return 1.0


def _short(s: str, n: int) -> str:
    s = " ".join(str(s).split())
    return s if len(s) <= n else s[: n - 1] + "…"


# ── the brief's years, quarters and months ────────────────────────────────────
# "2021: 12, 2022: 19", "Q1 2025: 48k, Q2: 61k", "March: 4.1". Only TIME keys:
# they are the series a model sums, averages and takes changes of, and a word
# key ("Traction: 42 buildings, 3,100 units, …") often carries several numbers.
_MON = (r"Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|"
        r"Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?")
_MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]
TIME_KEY = re.compile(
    r"(?<![\w$€£])(?:"
    r"(?P<q>[QqHh][1-4])(?:\s*(?P<qy>(?:19|20)\d{2}))?"
    r"|(?P<m>" + _MON + r")\.?(?:\s+(?P<my>(?:19|20)\d{2}))?"
    r"|(?P<y>(?:19|20)\d{2})(?:\s*(?P<yq>[QqHh][1-4]))?"
    r")(?!\w)")


def _key_of(m: re.Match) -> tuple:
    """(kind, period, year): ("y", 0, 2021), ("q", 1, 2025), ("q", 2, None), ("m", 3, None)."""
    if m.group("q"):
        return (m.group("q")[0].lower(), int(m.group("q")[1]), int(m.group("qy")) if m.group("qy") else None)
    if m.group("m"):
        return ("m", _MONTHS.index(m.group("m")[:3].lower()) + 1, int(m.group("my")) if m.group("my") else None)
    if m.group("yq"):
        return (m.group("yq")[0].lower(), int(m.group("yq")[1]), int(m.group("y")))
    return ("y", 0, int(m.group("y")))


def _same_key(a: tuple, b: tuple) -> bool:
    """Q2 is Q2 2025 when only one of them names the year."""
    return a[0] == b[0] and a[1] == b[1] and (a[2] == b[2] or a[2] is None or b[2] is None)


@dataclass(frozen=True)
class Keyed:
    key: tuple
    label: str      # as the brief writes it: "2021", "Q1 2025"
    value: float
    tok: str        # the value as the brief writes it: "48k"


def _keyed(brief: str) -> list[Keyed]:
    """What the brief gives FOR each year / quarter / month, in the brief's order."""
    out: list[Keyed] = []
    for m in TIME_KEY.finditer(brief):
        sep = re.match(r"\s*[:=]\s*", brief[m.end():])
        if not sep:
            continue
        n = NUM_TOKEN.match(brief, m.end() + sep.end())
        if not n:
            continue
        tok = n.group(0).strip()
        p = numparse.parse(tok)
        key = _key_of(m)
        if p is None or _is_year(tok, p.value) or any(_same_key(key, k.key) for k in out):
            continue
        out.append(Keyed(key, m.group(0).strip(), p.value, tok))
    return out


# ── the brief ─────────────────────────────────────────────────────────────────
@dataclass
class Part:
    label: str
    text: str


@dataclass
class Facts:
    text: str
    norm: str
    words: set
    values: list          # every number the brief gives
    plain: list           # the non-percentage ones arithmetic may combine (not years)
    pcts: list            # the percentages
    minutes: list         # durations, in minutes
    counts: set           # small integers the brief states in words
    urls: set
    keyed: list = field(default_factory=list)   # Keyed, in the brief's order
    mults: set = field(default_factory=set)     # multipliers the brief itself states ("doubled", "3x")
    _derived: dict = field(default_factory=dict)

    def derived(self, kind: str) -> list[float]:
        """Simple arithmetic on the brief's numbers, TYPED so a coincidence is
        rare: a plain number may be a sum, difference, average or product of
        the brief's plain numbers (of comparable size); a percentage may be a
        ratio or change between two of them, or a sum or difference of the
        brief's percentages; money may also be a product times 12 (a month
        rate made yearly: 22M units x $3 x 12)."""
        if kind in self._derived:
            return self._derived[kind]
        plain = sorted(set(self.plain))[:24]
        pcts = sorted(set(self.pcts))[:16]
        out: set[float] = set()

        def comparable(xs) -> bool:
            xs = [abs(x) for x in xs if x]
            return bool(xs) and max(xs) / min(xs) <= 1000

        if kind in ("plain", "money"):
            for r in (2, 3, 4):
                for combo in itertools.combinations(plain, r):
                    if comparable(combo):
                        out.add(sum(combo))
                        out.add(sum(combo) / r)
            for a, b in itertools.permutations(plain, 2):
                if comparable((a, b)):
                    out.add(a - b)
                out.add(a * b)
                if kind == "money":
                    out.add(a * b * 12)
            for a in plain:
                out.update((a * 12, a / 12))
        else:
            for a, b in itertools.permutations(plain, 2):
                if b and comparable((a, b)):
                    out.add(100 * a / b)
                    out.add(100 * (a - b) / b)
            for r in (2, 3, 4):
                for combo in itertools.combinations(pcts, r):
                    out.add(sum(combo))
                    out.add(sum(combo) / r)
            for a, b in itertools.permutations(pcts, 2):
                out.add(a - b)
        self._derived[kind] = sorted(out)
        return self._derived[kind]


def _durations(text: str) -> tuple[list[float], str]:
    mins: list[float] = []

    def repl(m):
        if m.group(1):
            mins.append(int(m.group(1)) * 60 + int(m.group(2)))
        elif m.group(3):
            mins.append(int(m.group(3)) * 60)
        else:
            mins.append(int(m.group(4)))
        return " "
    return mins, DURATION.sub(repl, text)


# A small number that NAMES something rather than counting it: "Step 2",
# "Phase 3", "Week 1", "Option 2". Not a claim about the world.
ENUMERATED = re.compile(r"(?:\b(?:step|phase|part|stage|no\.?|number|week|day|chapter|section|slide|page|"
                        r"tier|level|round|option|version|grade|class|room|table|figure|fig\.?)|#)\s*$", re.I)


def _numbers(text: str) -> list[tuple[str, float]]:
    _mins, rest = _durations(text)
    out = []
    for m in NUM_TOKEN.finditer(rest):
        tok = m.group(0).strip()
        after = rest[m.end(): m.end() + 1]
        # part of a word — "1st", "3D", "4K", "10x", "5G" — not a figure ("10x"
        # as a CLAIM is read by MULTIPLIER below)
        if after.isalpha() and not re.search(r"[kKMBT%]$|bn$|mn$", tok):
            continue
        p = numparse.parse(tok)
        if p is None:
            continue
        if abs(p.value) < 100 and float(p.value).is_integer() and ENUMERATED.search(rest[max(0, m.start() - 12): m.start()]):
            continue
        out.append((tok, p.value))
    return out


# "doubled", "tripling every two years", "10x faster", "3-fold", "four times as
# many": a number written as a word is still a claim.
MULTIPLIER = re.compile(
    r"\b(?:(?P<w>doubl|tripl|quadrupl|quintupl)(?:e|ed|es|ing)\b"
    r"(?!-|\s+(?:check|click|tap|room|bed|down|quotes?|space|standard|digits?|dip|entry|agent|edged|sided|decker)s?\b)"
    r"|(?P<h>halv)(?:e|ed|es|ing)\b"
    r"|(?P<fn>\d+(?:\.\d+)?|two|three|four|five|six|seven|eight|nine|ten|twenty|hundred)[- ]?fold\b"
    r"|(?P<xn>\d+(?:\.\d+)?)\s?[x×](?!\w)"
    r"|(?P<tn>\d+(?:\.\d+)?|two|three|four|five|six|seven|eight|nine|ten)\s+times\s+"
    r"(?:more|less|fewer|as|faster|slower|larger|smaller|bigger|higher|lower|greater|the)\b"
    r")(?:\s+every\s+(?:\w+\s+)?(?:years?|months?|quarters?|weeks?|days?))?", re.I)
_MULT_WORDS = {"doubl": 2.0, "tripl": 3.0, "quadrupl": 4.0, "quintupl": 5.0, "halv": 0.5}


def _mult_value(m: re.Match) -> float | None:
    if m.group("w"):
        return _MULT_WORDS[m.group("w").lower()]
    if m.group("h"):
        return 0.5
    tok = m.group("fn") or m.group("xn") or m.group("tn")
    if tok is None:
        return None
    return float(tok) if tok[0].isdigit() else float(_NUMBER_WORDS.get(tok.lower(), 0)) or None


def _multipliers(text: str) -> list[tuple[str, float]]:
    out = []
    for m in MULTIPLIER.finditer(text):
        v = _mult_value(m)
        if v:
            out.append((" ".join(m.group(0).split()), v))
    return out


def facts(brief: str) -> Facts:
    mins, _ = _durations(brief)
    nums = _numbers(brief)
    values = [v for _t, v in nums]
    plain = [v for t, v in nums if not _is_year(t, v) and v != 0 and "%" not in t]
    pcts = [v for t, v in nums if "%" in t]
    # Small numbers the brief states in WORDS ("a six-slide deck", "three
    # drivers"). List lengths are deliberately not counted: "ingredients,
    # instructions and the source" is three things, and that made an invented
    # "3 cups" look sourced.
    counts = {_NUMBER_WORDS[w] for w in re.findall(r"[a-z]+", brief.lower()) if w in _NUMBER_WORDS}
    return Facts(text=brief, norm=_norm(brief), words=set(_words(brief)), values=values, plain=plain,
                 pcts=pcts, minutes=mins, counts=counts,
                 urls={_norm(u).rstrip("/.") for u in URL.findall(brief)},
                 keyed=_keyed(brief), mults={v for _t, v in _multipliers(brief)})


def _close(v: float, targets, tok: str) -> bool:
    tol_round = 0.5 * 10 ** (-_decimals(tok)) * _scale(tok)
    for d in targets:
        if abs(v - d) <= max(tol_round, 0.005 * abs(d), 1e-9):
            return True
    return False


def supported_number(tok: str, v: float, F: Facts) -> bool:
    if _is_year(tok, v):
        return True                       # a year is context, rarely a claim
    exact = F.values + [x * 100 for x in F.values] + [x / 100 for x in F.values]
    if _close(v, exact, tok):
        return True
    plain_small = abs(v) < 10 and float(v).is_integer() and not re.search(r"[$€£%kMBT]", tok)
    if plain_small:
        # A small bare integer matches arithmetic by accident; only an exact
        # number or a number the brief writes in words supports it.
        return int(abs(v)) in F.counts
    kind = "pct" if "%" in tok else "money" if re.search(r"[$€£¥₹]|[kMBT]\b|million|billion", tok) else "plain"
    return _close(v, F.derived(kind), tok)


def supported_minutes(m: float, F: Facts) -> bool:
    if not F.minutes:
        return False
    base = F.minutes
    cands = set(base)
    for a, b in itertools.permutations(base, 2):
        cands.update((a - b, a + b))
    return any(abs(m - c) <= 1 for c in cands)


def supported_multiplier(v: float, F: Facts) -> bool:
    """A multiplier the brief states, or the ratio of two of its numbers (±5%)."""
    if any(abs(v - x) <= 1e-9 for x in F.mults):
        return True
    return any(b and abs(a / b - v) <= 0.05 * v for a, b in itertools.permutations(set(F.plain), 2))


def _unit_dropped(tok: str, v: float, targets) -> float | None:
    """48 where the brief says 48k: the brief's number with its scale dropped."""
    if _scale(tok) != 1.0 or "%" in tok or (abs(v) < 10 and float(v).is_integer()):
        return None
    for k in (1e3, 1e6, 1e9):
        for d in targets:
            if d and abs(v * k - d) <= max(0.5 * 10 ** (-_decimals(tok)) * k, 0.005 * abs(d)):
                return d
    return None


# ── what a label SAYS its number is ───────────────────────────────────────────
CHANGE = re.compile(
    r"\b(?:growth|grew|grow(?:s|ing)?|change[sd]?|increase[sd]?|decrease[sd]?|rise|rose|risen|fall|fell|fallen|"
    r"drop(?:ped|s)?|jump(?:ed|s)?|gain(?:ed|s)?|declin(?:e|ed|es)|up|down|yoy|y/y|year[- ]over[- ]year|qoq|q/q|"
    r"quarter[- ]over[- ]quarter|mom|month[- ]over[- ]month)\b", re.I)
TOTAL = re.compile(r"\b(?:total(?:led|s)?|sum|combined|overall|altogether|cumulative(?:ly)?|in all)\b", re.I)
MEAN = re.compile(r"\b(?:average[sd]?|avg|mean)\b", re.I)
PREVIOUS = re.compile(
    r"\b(?:previous|prior|preceding|last)\s+(?:year|quarter|month|period)\b|\b(?:yoy|y/y|year[- ]over[- ]year|"
    r"qoq|q/q|quarter[- ]over[- ]quarter|mom|month[- ]over[- ]month)\b", re.I)


def _named(context: str, F: Facts) -> list[int] | None:
    """Which of the brief's keyed values `context` names (indices, in the
    brief's order); None when a mention could be more than one of them."""
    hits: list[int] = []
    for m in TIME_KEY.finditer(context):
        key = _key_of(m)
        idx = [i for i, k in enumerate(F.keyed) if _same_key(key, k.key)]
        if len(idx) > 1:
            return None
        if idx and idx[0] not in hits:
            hits.append(idx[0])
    return sorted(hits)


def _span(idx: list[int], F: Facts) -> list[Keyed] | None:
    """The run of keyed values a total or average covers: the named range, or all."""
    if len(idx) >= 2:
        return F.keyed[idx[0]: idx[-1] + 1]
    return list(F.keyed) if not idx else None


def _pct(x: float) -> str:
    return f"{x:+.1f}%".replace(".0%", "%")


def _signed(x: float) -> str:
    return ("+" if x > 0 else "−" if x < 0 else "") + numparse.fmt(abs(x))


def _expect(context: str, tok: str, F: Facts, *, single: bool) -> tuple[list[float], str] | None:
    """The value the brief makes of what `context` says the number is — a total,
    a change or an average over its years/quarters/months, or (for a labelled
    value) the value the brief gives for the one period it names. None when the
    context does not pin the arithmetic down."""
    if len(F.keyed) < (1 if single else 2):
        return None
    idx = _named(context, F)
    if idx is None:
        return None
    is_pct = "%" in tok
    total, mean, change = TOTAL.search(context), MEAN.search(context), CHANGE.search(context)
    if total and not change and not is_pct:
        run = _span(idx, F)
        if run and len(run) >= 2:
            s = sum(k.value for k in run)
            return [s], f"the brief's {run[0].label}–{run[-1].label} add to {numparse.fmt(s)}"
        return None
    if mean and change:
        run = _span(idx, F)
        if not run or len(run) < 3:
            return None
        steps = list(zip(run, run[1:]))
        per = {"y": "a year", "q": "a quarter", "h": "a half", "m": "a month"}.get(run[0].key[0], "a step")
        if is_pct:
            pcts = [100 * (b.value - a.value) / a.value for a, b in steps if a.value]
            if len(pcts) != len(steps) or run[0].value <= 0 or run[-1].value <= 0:
                return None
            avg = sum(pcts) / len(pcts)
            cagr = 100 * ((run[-1].value / run[0].value) ** (1 / len(steps)) - 1)
            return [avg, cagr], (f"the brief's {run[0].label}–{run[-1].label} average {_pct(avg)} {per} "
                                 f"({_pct(cagr)} compound)")
        avg = sum(b.value - a.value for a, b in steps) / len(steps)
        return [avg], f"the brief's {run[0].label}–{run[-1].label} change by {_signed(round(avg, 2))} {per} on average"
    if change:
        if len(idx) == 2:
            a, b = F.keyed[idx[0]], F.keyed[idx[1]]
        elif len(idx) == 1 and idx[0] > 0 and PREVIOUS.search(context):
            a, b = F.keyed[idx[0] - 1], F.keyed[idx[0]]
        else:
            return None
        if is_pct:
            if not a.value:
                return None
            e = 100 * (b.value - a.value) / a.value
            return [e, abs(e)], f"the brief's {a.label} → {b.label} is {_pct(e)}"
        d = b.value - a.value
        return [d, abs(d)], f"the brief's {a.label} → {b.label} is {_signed(d)}"
    if mean and not is_pct:
        run = _span(idx, F)
        if run and len(run) >= 2:
            avg = sum(k.value for k in run) / len(run)
            return [avg], f"the brief's {run[0].label}–{run[-1].label} average {numparse.fmt(round(avg, 2))}"
        return None
    if single and len(idx) == 1 and not is_pct:
        k = F.keyed[idx[0]]
        return [k.value], f"the brief gives {k.tok} for {k.label}"
    return None


VALUE_KEYS = ("value", "percent", "number")
LABEL_KEYS = ("label", "name")


def _labelled(obj, path: str, out: dict) -> None:
    """{value path: its label} for every {"value", "label"}-shaped element —
    a stat, a bar, a chart point, a KPI."""
    if isinstance(obj, dict):
        label = next((obj[k] for k in LABEL_KEYS if isinstance(obj.get(k), str) and obj[k].strip()), None)
        if label is not None:
            for k in VALUE_KEYS:
                if k in obj and not isinstance(obj[k], (dict, list, bool)) and obj[k] is not None:
                    out[f"{path}.{k}" if path else k] = label
        for k, v in obj.items():
            if k not in SKIP_KEYS:
                _labelled(v, f"{path}.{k}" if path else k, out)
    elif isinstance(obj, (list, tuple)):
        for i, v in enumerate(obj):
            _labelled(v, f"{path}[{i}]", out)


def _sentences(text: str) -> list[str]:
    return [s for s in re.split(r"(?<=[.!?;])\s+", text) if s.strip()]


# ── the brief's parts ─────────────────────────────────────────────────────────
LABEL = re.compile(r"(?:^|(?<=[.;!?\n]))\s*([A-Z][A-Za-z0-9&/'’ -]{1,32}?):\s+")


def _preamble(text: str) -> Part | None:
    """The run BEFORE the first labelled part, when it too is a labelled list of
    facts: "…summarising our Q3 customer support performance: 12,480 tickets
    (up 9%), …" is the report's headline part. Without figures after its colon
    it is the ask itself ("Make a 6-slide pitch deck for Tidewell, …")."""
    i = text.find(":")
    if i < 0:
        return None
    body = text[i + 1:].strip().rstrip(".;")
    if not NUM_TOKEN.search(body):
        return None
    words = re.findall(r"[A-Za-z0-9&'’/-]+", text[:i])[-4:]
    while words and (words[0].lower() in _STOP or re.search(r"(?:ing|ise|ize)$", words[0].lower())):
        words = words[1:]
    return Part(" ".join(words) or "Overview", body) if body else None


def brief_parts(brief: str) -> list[Part]:
    """The brief's own sections, in its order: "Problem: … Solution: …", or a
    numbered / bulleted list. Empty when the brief is one run of prose."""
    ms = [m for m in LABEL.finditer(brief) if len(m.group(1).split()) <= 4]
    if ms:
        parts = []
        head = _preamble(brief[: ms[0].start()])
        if head is not None:
            parts.append(head)
        for m, nxt in zip(ms, ms[1:] + [None]):
            text = brief[m.end(): nxt.start() if nxt else len(brief)].strip().rstrip(".;")
            if text:
                parts.append(Part(m.group(1).strip(), text))
        if len(parts) >= 2:
            return parts
    lines = [ln.strip() for ln in brief.splitlines() if re.match(r"^\s*(?:\d{1,2}[.)]|[-*•])\s+\S", ln)]
    if len(lines) >= 2:
        out = []
        for ln in lines:
            body = re.sub(r"^\s*(?:\d{1,2}[.)]|[-*•])\s+", "", ln)
            out.append(Part(" ".join(body.split()[:4]), body))
        return out
    return []


def parts_block(parts) -> str:
    """The brief's parts as the planner and each fill see them — the outline the
    plan follows instead of a rule list (make_deck, make_doc)."""
    if not parts:
        return ""
    lines = [f"{i}. {p.label} — {p.text}" for i, p in enumerate(parts, 1)]
    return "THE BRIEF'S PARTS, in its order:\n" + "\n".join(lines) + "\n\n"


def pages_in(brief: str) -> int | None:
    """"a one-page report", "2 pages", "a one-pager" — the page budget asked for."""
    low = brief.lower()
    if re.search(r"\bone[- ]pager\b", low):
        return 1
    m = re.search(r"\b(one|two|three|four|five|six|single|\d{1,2})[- ]pages?\b", low)
    if not m:
        return None
    tok = m.group(1)
    n = 1 if tok == "single" else int(tok) if tok.isdigit() else _NUMBER_WORDS.get(tok)
    return n if n and 1 <= n <= 30 else None


# ── the spec ──────────────────────────────────────────────────────────────────
TEXT_KEYS = ("title", "subtitle", "kicker", "eyebrow", "footnote", "note", "statement", "attribution", "quote",
             "verdict", "summary", "caption", "label", "text", "standfirst", "byline", "display", "heading",
             "value", "percent", "from", "to", "number", "total_label", "x_label", "y_label", "name")
LIST_KEYS = ("bullets", "points", "body", "items", "stats", "steps", "bands", "rows", "columns", "sides",
             "headers", "paragraphs", "kpis", "series")
SKIP_KEYS = {"layout", "type", "image_query", "ground", "emphasis", "highlight_index", "highlight", "theme",
             "palette", "number_format", "sheet_name", "chart", "_note"}


def _walk(obj, where: str, path: str, out: list):
    """Every string/number in a spec element: (where, dotted field path, text)."""
    if isinstance(obj, str):
        if obj.strip():
            out.append((where, path, obj))
    elif isinstance(obj, bool) or obj is None:
        return
    elif isinstance(obj, (int, float)):
        out.append((where, path, numparse.fmt(float(obj))))
    elif isinstance(obj, dict):
        for k, v in obj.items():
            if k in SKIP_KEYS:
                continue
            _walk(v, where, f"{path}.{k}" if path else k, out)
    elif isinstance(obj, (list, tuple)):
        for i, v in enumerate(obj):
            _walk(v, where, f"{path}[{i}]", out)


def units_of(kind: str, spec: dict) -> list[tuple[str, dict]]:
    """(where, element) for each slide / block / the whole spec."""
    if kind == "pptx":
        return [(f"slide {i} ({s.get('layout', '?')})", s) for i, s in enumerate(spec.get("slides", []), 1)
                if isinstance(s, dict)]
    if kind in ("docx", "pdf"):
        head = {k: spec[k] for k in ("title", "subtitle") if k in spec}
        units = [("the document", head)] if head else []
        return units + [(f"block {i} ({b.get('type', '?')})", b)
                        for i, b in enumerate(spec.get("blocks", []), 1) if isinstance(b, dict)]
    return [("the " + ("chart" if kind == "chart" else "workbook"), spec)]


@dataclass
class Review:
    spec: dict
    numbers: list = field(default_factory=list)       # (where, token) — not in the brief
    mismatches: list = field(default_factory=list)    # (where, token, what the label says, what the brief makes)
    unit_dropped: list = field(default_factory=list)  # (where, token, the brief's token)
    quotes: list = field(default_factory=list)        # (where, text)
    attributions: list = field(default_factory=list)  # (where, text)
    urls: list = field(default_factory=list)          # (where, url)
    stripped: list = field(default_factory=list)      # (where, text)
    kickers: list = field(default_factory=list)       # (where, text, dropped)
    missing_parts: list = field(default_factory=list)

    @property
    def flagged(self) -> int:
        return (len(self.numbers) + len(self.mismatches) + len(self.unit_dropped) + len(self.quotes)
                + len(self.attributions) + len(self.urls))

    def lines(self, noun: str = "slide") -> tuple[list[str], list[str]]:
        """(lead, trail): what the chat model reads, one short line per kind of
        finding. The lead is the content that is wrong or unsupported — it goes
        before the renderer's own notes; the trail (parts left out, kicker
        labels) after them."""
        lead: list[str] = []
        trail: list[str] = []

        def places(items) -> str:
            ws = list(dict.fromkeys(w.split(" (")[0] for w, *_ in items))
            return ", ".join(ws[:4]) + (" …" if len(ws) > 4 else "")

        if self.mismatches:
            said = "; ".join(f"{t} for “{_short(c, 34)}” — {e}" for _w, t, c, e in self.mismatches[:3])
            more = f" (+{len(self.mismatches) - 3} more)" if len(self.mismatches) > 3 else ""
            lead.append(f"numbers that contradict the brief: {said}{more} ({places(self.mismatches)}) — "
                        f"correct them from the brief")
        if self.unit_dropped:
            pairs = list(dict.fromkeys(f"{t} (the brief's {b})" for _w, t, b in self.unit_dropped))
            lead.append(f"numbers missing their unit: {', '.join(pairs[:5])}"
                        + (f" and {len(pairs) - 5} more" if len(pairs) > 5 else "")
                        + f" ({places(self.unit_dropped)}) — write each with its unit")
        if self.numbers:
            toks = list(dict.fromkeys(t for _w, t in self.numbers))
            shown = ", ".join(toks[:8]) + (f" and {len(toks) - 8} more" if len(toks) > 8 else "")
            lead.append(f"numbers not in the brief — confirm them with the user or mark them as estimates: "
                        f"{shown} ({places(self.numbers)})")
        if self.quotes or self.attributions:
            said = [f"“{_short(q, 60)}”" for _w, q in self.quotes[:2]]
            said += [_short(a, 50) for _w, a in self.attributions[:3]]
            what = ("quote and credit" if self.quotes and self.attributions
                    else "quote" if self.quotes else "attribution")
            lead.append(f"{what} not in the brief: {'; '.join(said)} ({places(self.quotes + self.attributions)}) "
                        f"— use only the brief's own words, credited to whom the brief names")
        in_stripped = {u for _w, g in self.stripped for u in URL.findall(g)}
        loose = [(w, u) for w, u in self.urls if u not in in_stripped]
        if self.stripped:
            has_url = any(URL.search(g) for _w, g in self.stripped)
            lead.append(f"removed {len(self.stripped)} source line(s) naming a source the brief does not give"
                        + (" (a URL not in the brief)" if has_url else "")
                        + f": '{_short(self.stripped[0][1], 60)}' ({places(self.stripped)}) — a source must come "
                          f"from the user; never make one up")
        if loose:
            lead.append(f"URL not in the brief: {', '.join(u for _w, u in loose[:2])} ({places(loose)}) "
                        f"— give the real link in the brief, or leave it out")
        if self.missing_parts:
            trail.append(f"the {'deck' if noun == 'slide' else 'document'} leaves out part of the brief: "
                         f"{', '.join(self.missing_parts)} — add them or say why not")
        dropped = [k for k in self.kickers if k[2]]
        wordy = [k for k in self.kickers if not k[2]]
        if dropped or wordy:
            said = []
            if dropped:
                said.append(f"dropped {len(dropped)} kicker(s) that described the {noun} instead of "
                            f"labelling it ({places(dropped)})")
            if wordy:
                said.append(f"{len(wordy)} kicker/eyebrow reads as a sentence ('{_short(wordy[0][1], 40)}', "
                            f"{places(wordy)})")
            trail.append("; ".join(said) + " — a kicker is a 1–3 word label")
        return lead, trail

    def warnings(self, noun: str = "slide") -> list[str]:
        lead, trail = self.lines(noun)
        return lead + trail


def _supported_source(rest: str, F: Facts) -> bool:
    """Is the source a provenance line names actually in the brief?"""
    for u in URL.findall(rest):
        if _norm(u).rstrip("/.") in F.urls:
            return True
    words = _content(rest)
    if not words:
        return True
    if any(w in SELF_SOURCE for w in words):
        return True
    hit = sum(1 for w in words if w in F.words)
    return hit / len(words) >= 0.6


def _strip_provenance(value: str, F: Facts) -> tuple[str, list[str]]:
    """Drop the sentences of `value` that name a source the brief does not give."""
    sentences = re.split(r"(?<=[.!?])\s+", value.strip())
    keep, gone = [], []
    for s in sentences:
        m = PROVENANCE.match(s)
        if m and not _supported_source(s[m.end():], F):
            gone.append(s)
        else:
            keep.append(s)
    return " ".join(keep).strip(), gone


PROV_FIELDS = ("footnote", "note", "caption", "subtitle", "verdict", "summary", "byline", "standfirst", "text")
PROV_LISTS = ("paragraphs", "bullets", "points", "items")


def _check_number(R: Review, where: str, tok: str, v: float, F: Facts, context: str | None,
                  single: bool) -> None:
    """One number: what its context says it is, else whether the brief has it."""
    if context is not None:
        exp = _expect(context, tok, F, single=single)
        if exp is not None:
            targets, said = exp
            if _close(v, targets, tok):
                return
            base = _unit_dropped(tok, v, targets)
            if base is not None:
                R.unit_dropped.append((where, tok, _brief_token(base, F)))
            else:
                R.mismatches.append((where, tok, context, said))
            return
    if supported_number(tok, v, F):
        return
    base = _unit_dropped(tok, v, F.values)
    if base is not None:
        R.unit_dropped.append((where, tok, _brief_token(base, F)))
    else:
        R.numbers.append((where, tok))


def _brief_token(value: float, F: Facts) -> str:
    """How the brief writes `value` ("48k"), for the model to copy."""
    for t, v in _numbers(F.text):
        if abs(v - value) <= 1e-9 * max(1.0, abs(value)):
            return t
    return numparse.fmt(value)


def review(kind: str, brief: str, spec: dict, *, parts: list[Part] | None = None) -> Review:
    """Check `spec` against `brief`. Returns the spec with invented provenance
    lines stripped and descriptive kickers dropped, and everything flagged."""
    F = facts(brief)
    spec = copy.deepcopy(spec)
    R = Review(spec=spec)
    for where, unit in units_of(kind, spec):
        # 1. provenance lines — stripped
        for key in PROV_FIELDS:
            v = unit.get(key)
            if isinstance(v, str) and v.strip():
                kept, gone = _strip_provenance(v, F)
                if gone:
                    R.stripped += [(where, g) for g in gone]
                    if kept:
                        unit[key] = kept
                    else:
                        unit.pop(key, None)
        for key in PROV_LISTS:
            v = unit.get(key)
            if isinstance(v, list):
                new = []
                for item in v:
                    if isinstance(item, str):
                        kept, gone = _strip_provenance(item, F)
                        R.stripped += [(where, g) for g in gone]
                        if kept:
                            new.append(kept)
                    else:
                        new.append(item)
                unit[key] = new
        # 2. kickers and eyebrows — labels, not descriptions
        for key in ("kicker", "eyebrow"):
            v = unit.get(key)
            if isinstance(v, str) and v.strip():
                meta = bool(META.search(v))
                if meta or len(v.split()) > 5:
                    R.kickers.append((where, v, meta))
                    if meta:
                        unit.pop(key, None)
        # 3. quotes and attributions
        quote = unit.get("quote") if isinstance(unit.get("quote"), str) else None
        if kind == "pptx" and unit.get("layout") == "hero_statement" and _norm(unit.get("attribution") or ""):
            quote = unit.get("statement")
        texts: list = []
        _walk(unit, where, "", texts)
        if quote and not _quote_in_brief(quote, F):
            R.quotes.append((where, quote))
        for _w, path, t in texts:
            for q in QUOTED.findall(t):
                if len(q.split()) >= 4 and not _quote_in_brief(q, F) and q != quote:
                    R.quotes.append((where, q))
        att = unit.get("attribution")
        if isinstance(att, str) and att.strip() and not _named_in_brief(att, F):
            R.attributions.append((where, att.strip().lstrip("—-– ").strip()))
        byline = unit.get("byline")
        if isinstance(byline, str) and ATTRIBUTION_LIKE.search(byline) and not _named_in_brief(byline, F):
            R.attributions.append((where, byline.strip()))
        # 4. URLs, numbers and multipliers, in everything that is still there
        labels: dict = {}
        _labelled(unit, "", labels)
        seen: set = set()
        for _w, path, t in texts:
            if path.split(".")[-1].split("[")[0] in ("attribution",):
                continue
            for u in URL.findall(t):
                nu = _norm(u).rstrip("/.")
                if nu not in F.urls and not any(nu in x or x in nu for x in F.urls) and u not in seen:
                    seen.add(u)
                    R.urls.append((where, u.rstrip(".,")))
            for sentence in _sentences(t) if path not in labels else [t]:
                mins, rest = _durations(sentence)
                for m_ in mins:
                    if not supported_minutes(m_, F):
                        R.numbers.append((where, _fmt_minutes(m_)))
                for tok, mv in _multipliers(rest):
                    if not supported_multiplier(mv, F):
                        R.numbers.append((where, tok))
                nums = [(tok, v) for tok, v in _numbers(rest) if not any(tok in u for u in URL.findall(t))]
                figures = [(tok, v) for tok, v in nums if not _is_year(tok, v)]
                for tok, v in nums:
                    if _is_year(tok, v):
                        continue                  # a year is context, rarely a claim
                    if path in labels:
                        # a stat, a bar, a point: its label says what it is
                        _check_number(R, where, tok, v, F, labels[path], single=True)
                    elif len(figures) == 1 or ("%" in tok and sum("%" in x for x, _ in figures) == 1):
                        # a sentence with one figure (or one percentage) says what it is too
                        _check_number(R, where, tok, v, F, sentence, single=False)
                    else:
                        _check_number(R, where, tok, v, F, None, single=False)
    # URLs that were only in stripped lines are still worth naming.
    for where, g in R.stripped:
        for u in URL.findall(g):
            nu = _norm(u).rstrip("/.")
            if nu not in F.urls and (where, u.rstrip(".,")) not in R.urls:
                R.urls.append((where, u.rstrip(".,")))
    # 5. the brief's parts nothing carries
    for p in parts if parts is not None else brief_parts(brief):
        if not _covered(p, kind, spec):
            R.missing_parts.append(p.label)
    return R


def _fmt_minutes(m: float) -> str:
    m = int(round(m))
    return f"{m // 60}h {m % 60}m" if m >= 60 else f"{m}m"


def _quote_in_brief(q: str, F: Facts) -> bool:
    nq = _norm(q).strip(" .\"'")
    if len(nq) >= 8 and nq in F.norm:
        return True
    w = _content(q)
    return bool(w) and sum(1 for x in w if x in F.words) / len(w) >= 0.85


def _named_in_brief(a: str, F: Facts) -> bool:
    w = [x for x in _content(a) if x not in ("prepared", "written")]
    return bool(w) and all(x in F.words for x in w)


def _covered(p: Part, kind: str, spec: dict) -> bool:
    texts: list = []
    for where, unit in units_of(kind, spec):
        _walk(unit, where, "", texts)
    blob = " ".join(t for _w, _p, t in texts)
    words = set(_words(blob))
    nums = [v for _t, v in _numbers(blob)]
    pnums = [(t, v) for t, v in _numbers(p.text) if not _is_year(t, v)]
    if any(_close(v, nums, t) for t, v in pnums if abs(v) >= 10 or re.search(r"[$€£%kMBT]", t)):
        return True
    key = [w for w in _content(p.text) if not w.isdigit()]
    if not key:
        return True
    return sum(1 for w in key if w in words) / len(key) >= 0.5
