"""
Sources and citation markers — the render path's (WF-06), never the make path's.

A research workflow (deliverables/research/workflows.md §4.5) writes prose with
markers like `[S3]` or `[S3, S7]`, where every S# was minted by CODE from a page
it actually fetched, and hands `office.py render` a spec with a `sources` list.
This module is the one place those markers are read, so a docx superscript, a
deck's "Sources: 3, 7" footer and a workbook's cite cell all number a source
the same way: by its position in the spec's `sources` list, 1-based.

It invents nothing. A marker naming an id the list does not have is dropped
and REPORTED ("[S9] names no source"), never given an entry; a source with no
http(s) URL and no title is dropped and reported too. The make path never
builds one of these: its specs come from a small model, and the user's rule for
those stands (VQ-08, PLAN.md Q15) — a file that cites a fake source is worse
than one that cites none.

    {"sources": [{"id": "S1", "title": "…", "site": "…", "date": "…",
                  "url": "https://…", "accessed": "2026-09-24"}, …]}
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

# [S3]  [S3, S7]  [S3; S7]  [s3] — and "[S3][S7]" as one group. Only S-ids: a
# bracketed "[1]" or "[sic]" in prose is prose.
MARKER = re.compile(r"\[\s*([Ss]\d+(?:\s*[,;]\s*[Ss]\d+)*)\s*\]")
_GROUP = re.compile(r"(?:\s*" + MARKER.pattern + r")+")
_URL = re.compile(r"^https?://\S+$", re.I)


@dataclass
class Source:
    n: int                  # the number a reader sees: its position in the list
    id: str                 # what the markers name ("S3")
    title: str
    url: str
    site: str = ""
    date: str = ""
    accessed: str = ""

    def label(self) -> str:
        """Title — site, date: the entry as a reader identifies it."""
        tail = ", ".join(x for x in (self.site, self.date) if x)
        return f"{self.title} — {tail}" if tail else self.title


def _s(v) -> str:
    return " ".join(str(v).split()) if v is not None else ""


def numbers_text(nums: list[int]) -> str:
    """1, 2, 3, 7 -> "1–3, 7": a run of three or more is a range."""
    nums = sorted(dict.fromkeys(nums))
    out, i = [], 0
    while i < len(nums):
        j = i
        while j + 1 < len(nums) and nums[j + 1] == nums[j] + 1:
            j += 1
        out.append(f"{nums[i]}–{nums[j]}" if j - i >= 2 else ", ".join(str(x) for x in nums[i:j + 1]))
        i = j + 1
    return ", ".join(out)


@dataclass
class Citations:
    """The spec's sources, numbered, and everything the markers did."""
    sources: list[Source] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    unknown: list[str] = field(default_factory=list)   # ids cited that the list lacks
    used: list[int] = field(default_factory=list)      # numbers cited, first-use order

    @classmethod
    def of(cls, raw) -> "Citations":
        c = cls()
        items = raw if isinstance(raw, list) else []
        # An entry with no id is "S<its position>" — unless another entry
        # names that id itself, which wins.
        claimed = {_s(x.get("id")).upper() for x in items if isinstance(x, dict) and _s(x.get("id"))}
        seen: set[str] = set()
        for i, item in enumerate(items, 1):
            if not isinstance(item, dict):
                c.warnings.append(f"source {i} is not an object; left out")
                continue
            url, title = _s(item.get("url")), _s(item.get("title"))
            if url and not _URL.match(url):
                c.warnings.append(f"source {i}: '{url[:60]}' is not an http(s) URL; shown without a link")
                url = ""
            if not url and not title:
                c.warnings.append(f"source {i} has neither a URL nor a title; left out")
                continue
            sid = _s(item.get("id"))
            if not sid:
                sid = f"S{i}" if f"S{i}" not in claimed else f"#{i}"   # "#i": listed, not citable
            if sid.upper() in seen:
                c.warnings.append(f"source {i}: id {sid} is used twice; the second is left out")
                continue
            seen.add(sid.upper())
            c.sources.append(Source(n=len(c.sources) + 1, id=sid, title=title or url, url=url,
                                    site=_s(item.get("site")), date=_s(item.get("date")),
                                    accessed=_s(item.get("accessed"))))
        return c

    def by_id(self, sid: str) -> Source | None:
        for s in self.sources:
            if s.id.upper() == sid.upper():
                return s
        return None

    def _resolve(self, group: str) -> list[int]:
        nums = []
        for sid in re.findall(r"[Ss]\d+", group):
            src = self.by_id(sid)
            if src is None:
                if sid.upper() not in self.unknown:
                    self.unknown.append(sid.upper())
                continue
            nums.append(src.n)
            if src.n not in self.used:
                self.used.append(src.n)
        return nums

    def resolve_ids(self, ids) -> list[int]:
        """An explicit list of ids (a slide's `sources`, a cell's `cite`)."""
        return self._resolve(" ".join(_s(x) for x in (ids if isinstance(ids, list) else [ids])))

    def split(self, text: str) -> list[str | list[int]]:
        """Text and citation groups in order: "rose 14% [S3][S7]." ->
        ["rose 14%", [1, 2], "."] — the space before a marker goes with it, so
        a superscript sits on its word."""
        out: list[str | list[int]] = []
        pos = 0
        for m in _GROUP.finditer(text):
            if m.start() > pos:
                out.append(text[pos:m.start()])
            nums = self._resolve(m.group(0))
            if nums:
                out.append(sorted(dict.fromkeys(nums)))
            pos = m.end()
        if pos < len(text):
            out.append(text[pos:])
        return out or [text]

    def strip(self, text: str) -> tuple[str, list[int]]:
        """The text without its markers, and the numbers they cited."""
        nums: list[int] = []
        parts = []
        for seg in self.split(text):
            if isinstance(seg, list):
                nums += seg
            else:
                parts.append(seg)
        return "".join(parts), nums

    def plain(self, text: str) -> str:
        """Markers as bracketed numbers, for a format with no superscript links."""
        return "".join(seg if isinstance(seg, str) else f" [{numbers_text(seg)}]" for seg in self.split(text))

    def report(self) -> list[str]:
        """What the model-free caller should hear about its citations."""
        out = list(self.warnings)
        if self.unknown:
            out.append(f"citations {', '.join('[' + u + ']' for u in self.unknown)} name no source in the list; "
                       "they were left out rather than given an entry")
        return out


def theme_links(package_part, hex_colour: str) -> bool:
    """Set a file's theme hyperlink colours — link AND followed link — to one
    of the document's own colours. The python-pptx/-docx templates carry
    Office's 0000FF and a FOLLOWED-link 800080: a purple that PowerPoint paints
    a source link in once it is clicked, whatever the run's colour says (and
    the user: no purple, anywhere). Returns whether the theme was found."""
    from lxml import etree
    try:
        rt = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme"
        theme = package_part.part_related_by(rt)
    except (KeyError, AttributeError):
        return False
    ns = {"a": "http://schemas.openxmlformats.org/drawingml/2006/main"}
    root = etree.fromstring(theme.blob)
    val = hex_colour.lstrip("#").upper()
    for tag in ("hlink", "folHlink"):
        for el in root.findall(f".//a:clrScheme/a:{tag}", ns):
            for child in list(el):
                el.remove(child)
            etree.SubElement(el, f"{{{ns['a']}}}srgbClr").set("val", val)
    theme._blob = etree.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True)
    return True


def has_markers(v) -> bool:
    """Whether any string in a spec value carries a marker."""
    if isinstance(v, str):
        return MARKER.search(v) is not None
    if isinstance(v, dict):
        return any(has_markers(x) for x in v.values())
    if isinstance(v, list):
        return any(has_markers(x) for x in v)
    return False


def strip_all(v, cite: Citations, found: list[int]):
    """A copy of a spec value with every marker removed; the numbers go to `found`."""
    if isinstance(v, str):
        text, nums = cite.strip(v)
        found += nums
        return text
    if isinstance(v, dict):
        return {k: strip_all(x, cite, found) for k, x in v.items()}
    if isinstance(v, list):
        return [strip_all(x, cite, found) for x in v]
    return v


def plain_all(v, cite: Citations):
    """A copy of a spec value with every marker written as "[n]"."""
    if isinstance(v, str):
        return cite.plain(v)
    if isinstance(v, dict):
        return {k: plain_all(x, cite) for k, x in v.items()}
    if isinstance(v, list):
        return [plain_all(x, cite) for x in v]
    return v
