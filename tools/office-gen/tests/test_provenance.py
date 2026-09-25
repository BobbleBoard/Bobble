"""
VQ-08 — what an office document says that its brief did not.

On the four REAL captured 4B specs (tools/visual-eval/fixtures/captured-4b) every
number, quote, URL and attribution not traceable to the brief — or to simple
arithmetic on it — is flagged; invented "Data sourced from …" lines are stripped;
kickers that describe their slide are linted; and the planner is handed the
brief's parts instead of a rule list to mirror.

    tools/office-gen/.venv/bin/python -m pytest tools/office-gen/tests -q
"""
from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import time
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
OFFICE = HERE.parent
FIX = OFFICE.parents[1] / "tools" / "visual-eval" / "fixtures"
REPLAY = OFFICE.parents[1] / "tools" / "visual-eval" / "py" / "replay_server.py"
sys.path.insert(0, str(OFFICE))

import make_deck  # noqa: E402
import make_doc  # noqa: E402
import provenance as P  # noqa: E402

BRIEFS = json.loads((FIX / "captured-4b" / "briefs.json").read_text())
TIDEWELL = (FIX.parent / "prompts" / "pitch-deck.txt").read_text().strip()


def captured(key):
    b = BRIEFS[key]
    return b["kind"], b["brief"], json.loads((FIX / "captured-4b" / b["spec"]).read_text())


def replies(name):
    return json.loads((FIX / "replies" / f"{name}.json").read_text())


def deck_spec(r):
    plan = r["plan"]
    return {"theme": plan.get("theme"), "running_title": plan.get("running_title"),
            "slides": [{**f, "layout": p["layout"]} for p, f in zip(plan["slides"], r["fills"])]}


def tokens(rev):
    """Numbers flagged as not in the brief."""
    return {t for _w, t in rev.numbers}


def contradicted(rev):
    """Numbers whose label names arithmetic on the brief that they are not."""
    return {t for _w, t, *_ in rev.mismatches}


# ── the four captured specs ──────────────────────────────────────────────────
def test_art_of_tea():
    rev = P.review(*captured("tea-docx"))
    assert {"2.5B+", "500+", "180"} <= tokens(rev)
    assert [q for _w, q in rev.quotes] == ["In every cup, there is a moment of stillness."]
    assert [a for _w, a in rev.attributions] == ["The Tea Lover's Perspective"]


def test_annual_unit_sales():
    rev = P.review(*captured("units-pdf"))
    t, c = tokens(rev), contradicted(rev)
    # the stats row says which arithmetic each number is, and none of them is it
    assert c == {"28", "10", "83%"}
    said = {tok: exp for _w, tok, _ctx, exp in rev.mismatches}
    assert said["28"] == "the brief's 2021–2024 add to 68"                 # "Total Units (2021-2024)"
    assert said["83%"] == "the brief's 2023 → 2024 is +46.7%"              # "YoY Growth (2023 to 2024)"
    assert said["10"].startswith("the brief's 2021–2024 change by +3.33")  # "Average Annual Growth"
    assert {"4", "7", "5", "9", "3", "6", "8"} <= t    # the regional table the brief never had
    assert not {"12", "19", "15", "22"} & (t | c)      # the brief's own numbers
    assert "46.7%" not in t | c                        # (22-15)/15, and its sentence says 2024 vs the year before
    assert any("resilience of the market" in q for _w, q in rev.quotes)
    assert [a for _w, a in rev.attributions] == ["Director of Operations"]
    w = rev.warnings("block")
    assert w[0].startswith("numbers that contradict the brief: 28 for “Total Units (2021-2024)”")


def test_cookie_recipe():
    kind, brief, spec = captured("cookie-docx")
    rev = P.review(kind, brief, spec)
    assert {"2", "1", "3", "350", "10", "12"} <= tokens(rev)   # amounts the brief never gave
    assert "6" not in tokens(rev)                               # "6 giant cookies" is the brief's
    assert [u for _w, u in rev.urls] == ["https://www.allrecipes.com/recipe/123456/"]
    assert [q for _w, q in rev.quotes] == ["Bigger is better."]
    assert [a for _w, a in rev.attributions] == ["A note on cookie size"]
    # the fabricated source line is gone from the spec that gets drawn
    assert [g for _w, g in rev.stripped] == ["Source: https://www.allrecipes.com/recipe/123456/"]
    assert "allrecipes" not in json.dumps(rev.spec)
    assert "allrecipes" in json.dumps(spec)                     # the input is not mutated


def test_solar_deck():
    rev = P.review(*captured("solar-deck"))
    assert {"1,200", "1,500", "6,800", "25%"} <= tokens(rev)    # "rough capacity numbers": the model's
    assert "tripling every two years" in tokens(rev)            # a number written as a word is a claim
    dropped = [k[1] for k in rev.kickers if k[2]]
    assert dropped == ["Bar chart showing cumulative capacity by year",
                       "Compare drivers: costs, policy, corporate, storage, adoption"]
    assert "kicker" not in rev.spec["slides"][1]


def test_warnings_are_short_and_name_where():
    rev = P.review(*captured("cookie-docx"))
    w = rev.warnings("block")
    assert 1 <= len(w) <= 7 and all(len(x) < 320 for x in w)
    assert any("numbers not in the brief" in x and "block 4" in x for x in w)


# ── arithmetic on the brief is not invention ─────────────────────────────────
@pytest.mark.parametrize("brief,tok,value", [
    (TIDEWELL, "$792M", 792e6),           # 22M units x $3 x 12 months
    (TIDEWELL, "3.1k", 3100),
    (TIDEWELL, "$24k", 24000),
    ("12,480 tickets. Top drivers: billing 31%, login 22%, shipping 18%.", "71%", 71),
    ("Units: 2021: 12, 2022: 19, 2023: 15, 2024: 22.", "68", 68),
])
def test_derived_numbers_are_supported(brief, tok, value):
    assert P.supported_number(tok, value, P.facts(brief))


def test_the_k_dropped_is_caught():
    f = P.facts("MAU by quarter: Q1 2025: 48k, Q2: 61k, Q3: 79k, Q4: 102k")
    assert not any(P.supported_number(t, v, f) for t, v in (("48", 48), ("61", 61), ("102", 102)))


def test_durations():
    f = P.facts("median first response 2h 14m (down from 3h 40m)")
    assert P.supported_minutes(86, f)          # "1h 26m faster"
    assert not P.supported_minutes(95, f)


# ── provenance lines: stripped unless the brief names the source ─────────────
def test_invented_source_lines_are_stripped():
    spec = deck_spec(replies("pitch-deck-a"))
    rev = P.review("pptx", TIDEWELL, spec)
    assert sorted(g for _w, g in rev.stripped) == ["Based on current product capabilities.",
                                                   "Data sourced from internal company metrics"]
    assert "footnote" not in rev.spec["slides"][0] and "note" not in rev.spec["slides"][2]


def test_a_source_the_brief_names_is_kept():
    fill = json.loads((FIX / "captured-4b" / "raw_fill1.txt").read_text())
    spec = {"slides": [fill]}
    assert P.review("pptx", "Solar capacity report.", spec).stripped
    kept = P.review("pptx", "Solar capacity, from the IEA and national grids data.", spec)
    assert not kept.stripped and kept.spec["slides"][0]["footnote"].startswith("Data sourced")


# ── kickers are labels ────────────────────────────────────────────────────────
@pytest.mark.parametrize("text,meta", [
    ("Map the process from leak detection to automatic shutoff", True),
    ("Key metrics showing company growth", True),
    ("Bar chart comparing market size to current units", True),
    ("Map lifecycle from emergence to saturation", True),
    ("Contrast conventional grid needs against offshore and BIPV opportunities", True),
    ("Traction", False),
    ("Market & model", False),
])
def test_kicker_lint(text, meta):
    rev = P.review("pptx", TIDEWELL, {"slides": [{"layout": "stats", "title": "x", "kicker": text}]})
    assert bool([k for k in rev.kickers if k[2]]) is meta
    assert ("kicker" in rev.spec["slides"][0]) is not meta


def test_a_sentence_eyebrow_is_flagged_not_dropped():
    rev = P.review("pptx", TIDEWELL, deck_spec(replies("pitch-deck-a")))
    wordy = [k for k in rev.kickers if not k[2]]
    assert wordy and wordy[0][1].startswith("Raising a $2.5M seed")
    assert rev.spec["slides"][0].get("eyebrow")


# ── the brief's parts, and a plan that leaves some out ────────────────────────
def test_brief_parts_in_order():
    parts = P.brief_parts(TIDEWELL)
    assert [p.label for p in parts] == ["Problem", "Solution", "Traction", "Market", "Business model",
                                        "Team", "Ask"]
    assert parts[3].text.startswith("22M rental units")


def test_the_headline_before_the_first_label_is_a_part():
    report = (FIX.parent / "prompts" / "one-page-report.txt").read_text()
    parts = P.brief_parts(report)
    assert [p.label for p in parts] == ["Q3 customer support performance", "Top ticket drivers", "Recommendations"]
    assert parts[0].text.startswith("12,480 tickets") and parts[0].text.endswith("640 tickets")
    # the ask itself ("Make a 6-slide pitch deck for Tidewell, …") has no figures after a colon: not a part
    assert P.brief_parts(TIDEWELL)[0].label == "Problem"


def test_the_4b_plan_leaves_out_business_model_and_team():
    rev = P.review("pptx", TIDEWELL, deck_spec(replies("pitch-deck-a")))
    assert rev.missing_parts == ["Business model", "Team"]
    assert P.review("pptx", TIDEWELL, deck_spec(replies("pitch-deck-b1"))).missing_parts == []


def test_pages_in():
    assert P.pages_in("Write a one-page report (Word document)") == 1
    assert P.pages_in("a 2-page memo") == 2 and P.pages_in("a one-pager") == 1
    assert P.pages_in("write a report") is None


# ── the prompts: parts, not a rule list; length from the brief; no quotas ────
def test_the_planner_gets_the_brief_parts_not_a_rule_list(monkeypatch):
    seen = {}

    def fake_ask(system, user, **kw):
        seen["system"], seen["user"] = system, user
        return json.dumps(replies("pitch-deck-a")["plan"])

    monkeypatch.setattr(make_deck, "ask", fake_ask)
    make_deck.outline(TIDEWELL, 6, P.brief_parts(TIDEWELL))
    assert "At least FOUR" not in seen["system"] and "Include ONE" not in seen["system"]
    assert "follow the brief's own parts" in seen["system"]
    listed = seen["user"].split("THE BRIEF'S PARTS, in its order:\n")[1].split("\n\n")[0].splitlines()
    assert [ln.split(" — ")[0] for ln in listed] == ["1. Problem", "2. Solution", "3. Traction", "4. Market",
                                                     "5. Business model", "6. Team", "7. Ask"]


def test_the_fill_is_told_labels_and_sources(monkeypatch):
    seen = {}

    def fake_ask(system, user, **kw):
        seen["system"], seen["user"] = system, user
        return '{"title": "x"}'

    monkeypatch.setattr(make_deck, "ask", fake_ask)
    part = P.brief_parts(TIDEWELL)[3]
    make_deck.fill(TIDEWELL, {"layout": "bars", "title": "Market", "intent": "market size"}, 5, 6, part)
    assert "Never write 'Data sourced from ...'" in seen["system"]
    assert "1-3 word LABEL" in seen["system"]
    assert "This slide covers: Market — 22M rental units" in seen["user"]


def test_the_document_prompt_takes_its_length_from_the_brief(monkeypatch):
    seen = {}

    def fake_ask(system, user, max_tokens=0):
        seen["system"], seen["user"] = system, user
        return '{"title": "x", "blocks": []}'

    monkeypatch.setattr(make_doc, "ask", fake_ask)
    report = (FIX.parent / "prompts" / "one-page-report.txt").read_text()
    make_doc.generate("docx", report)
    s = seen["system"]
    assert "must fit ONE page" in s and "no `cover`" in s
    assert "at least one" not in s.lower() and "9-14 blocks" not in s
    assert "Never invent data, rows" in s
    assert seen["user"] == report                      # no parts given: the brief as it was
    make_doc.generate("docx", report, P.brief_parts(report))
    assert seen["user"].startswith(report) and "THE BRIEF'S PARTS, in its order:" in seen["user"]
    assert "1. Q3 customer support performance — 12,480 tickets" in seen["user"]


# ── end to end: office.py make says it ────────────────────────────────────────
def _free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


def _office_make(tmp_path, reply_obj, kind, brief):
    rfile = tmp_path / "replies.json"
    rfile.write_text(json.dumps(reply_obj))
    log = tmp_path / "requests.jsonl"
    port = _free_port()
    srv = subprocess.Popen([sys.executable, str(REPLAY), str(rfile), str(port), str(log)])
    try:
        for _ in range(100):
            try:
                socket.create_connection(("127.0.0.1", port), timeout=0.2).close()
                break
            except OSError:
                time.sleep(0.05)
        env = {**os.environ, "PI_OFFICE_GEN_SERVER": f"http://127.0.0.1:{port}",
               "PI_OFFICE_GEN_SCRATCH": str(tmp_path / "s"), "no_proxy": "*", "NO_PROXY": "*"}
        r = subprocess.run([sys.executable, str(OFFICE / "office.py"), "make", kind, "--brief", brief,
                            "--out", str(tmp_path / f"out.{kind}")], env=env, capture_output=True, text=True,
                           timeout=120)
    finally:
        srv.terminate()
        srv.wait(timeout=5)
    reqs = [json.loads(ln) for ln in log.read_text().splitlines()] if log.exists() else []
    return json.loads(r.stdout.strip().splitlines()[-1]), reqs


def test_office_make_flags_and_strips(tmp_path):
    kind, brief, spec = captured("cookie-docx")
    out, _ = _office_make(tmp_path, {"doc": spec}, kind, brief)
    assert out["ok"], out
    assert out["checks"]["sources_removed"] == 1 and out["checks"]["not_in_brief"] >= 10
    assert any("URL not in the brief" in w for w in out["warnings"])
    from docx import Document
    assert "allrecipes" not in "\n".join(p.text for p in Document(out["path"]).paragraphs)


def test_office_make_says_what_contradicts_the_brief_first(tmp_path):
    kind, brief, spec = captured("units-pdf")
    out, reqs = _office_make(tmp_path, {"doc": spec}, kind, brief)
    assert out["ok"], out
    assert out["checks"]["contradicts_brief"] == 3
    assert out["warnings"][0].startswith("numbers that contradict the brief: 28 for")
    assert len(out["warnings"]) <= 8
    # the document's own prompt carried the brief (no labelled parts in this one)
    assert reqs and reqs[0]["user"].startswith("Units sold by year")


def test_office_make_deck_follows_the_parts(tmp_path):
    out, reqs = _office_make(tmp_path, replies("pitch-deck-a"), "pptx", TIDEWELL)
    assert out["ok"], out
    assert out["checks"]["parts_left_out"] == ["Business model", "Team"]
    assert any("leaves out part of the brief: Business model, Team" in w for w in out["warnings"])
    plan_req = next(r for r in reqs if "presentation planner" in r["system"])
    assert "THE BRIEF'S PARTS" in plan_req["user"]
    fills = [r for r in reqs if "content for ONE slide" in r["system"]]
    assert any("This slide covers: Market" in r["user"] for r in fills)


def test_enumerations_and_words_are_not_claims():
    spec = {"slides": [{"layout": "flow", "title": "Rollout", "steps": [
        {"label": "Step 1", "caption": "Phase 2 starts in week 3"},
        {"label": "The 1st pilot", "caption": "3D renders on a 2x2 grid; double-check the output"}]}]}
    rev = P.review("pptx", "Plan the rollout of the pilot.", spec)
    assert rev.numbers == [] and rev.mismatches == [] and rev.unit_dropped == []


# ── multipliers: a number written as a word ───────────────────────────────────
@pytest.mark.parametrize("brief,text,flagged", [
    ("Plan the rollout of the pilot.", "Renders are 10x faster", ["10x"]),
    ("Plan the rollout of the pilot.", "Sign-ups doubled in March", ["doubled"]),
    ("Sign-ups doubled in March.", "Sign-ups doubled in March", []),               # the brief says it
    ("Revenue went from $2M to $6M.", "Revenue tripled", []),                      # 6 / 2: arithmetic on the brief
    ("Revenue went from $2M to $6M.", "Revenue grew four times as fast", ["four times as"]),
    ("Plan the rollout of the pilot.", "Double-click the icon; a double room", []),  # not quantities
])
def test_multipliers(brief, text, flagged):
    rev = P.review("pptx", brief, {"slides": [{"layout": "closing", "title": "x", "points": [text]}]})
    assert [t for _w, t in rev.numbers] == flagged


# ── a label that names the arithmetic is held to it ───────────────────────────
UNITS = "Units sold by year: 2021: 12, 2022: 19, 2023: 15, 2024: 22."


@pytest.mark.parametrize("value,label,ok", [
    ("68", "Total units (2021-2024)", True),
    ("28", "Total units (2021-2024)", False),
    ("34", "Total 2023-2024", False),                  # 15 + 22 = 37
    ("37", "Total 2023–2024", True),
    ("46.7%", "Growth 2023 to 2024", True),
    ("+47%", "YoY growth 2024", True),                 # one year + "YoY": the year before it
    ("83%", "YoY growth 2024", False),
    ("83%", "Growth 2021 to 2024", True),              # the same 83% is right for these two years
    ("-21%", "Change 2022 → 2023", True),
    ("21%", "Decline 2022 to 2023", True),             # the sign said in words
    ("17", "Average units a year (2021-2024)", True),
    ("3.3", "Average annual growth", True),
    ("10", "Average annual growth", False),
    ("15", "Units in 2023", True),
    ("19", "Units in 2023", False),                    # a brief number on the wrong year
])
def test_labelled_arithmetic(value, label, ok):
    spec = {"blocks": [{"type": "stats", "stats": [{"value": value, "label": label}]}]}
    rev = P.review("docx", UNITS, spec)
    assert (rev.mismatches == [] and rev.numbers == []) is ok, (rev.mismatches, rev.numbers)


def test_a_sentence_says_which_arithmetic_too():
    spec = {"blocks": [{"type": "body", "paragraphs": [
        "2024 was the best year, up 46.7% on the previous year.",
        "Sales rose 83% from 2023 to 2024.",
        "Over 2021-2024 the team sold 68 units in total, with 12 in the first year."]}]}
    rev = P.review("docx", UNITS, spec)
    assert contradicted(rev) == {"83%"}
    assert tokens(rev) == set()       # 68 and 12 share a sentence: each is simply in the brief (or its sum)


def test_the_unit_dropped_is_named():
    brief = (FIX.parent / "prompts" / "chart-set.txt").read_text()
    rev = P.review("chart", brief, replies("chart-set-a-office")["chart"])
    assert [(t, b) for _w, t, b in rev.unit_dropped] == [("48", "48k"), ("61", "61k"), ("79", "79k"), ("102", "102k")]
    assert rev.numbers == [] and rev.mismatches == []
    assert rev.warnings("block") == [
        "numbers missing their unit: 48 (the brief's 48k), 61 (the brief's 61k), 79 (the brief's 79k), "
        "102 (the brief's 102k) (the chart) — write each with its unit"]
