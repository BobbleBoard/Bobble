# Licensing, attribution, and what we must do

**Status: analysis and a plan, not legal advice.** I am not a lawyer and this has
not been reviewed by one. Everything below is checkable — every claim names the
licence text or the measurement it came from — but the decision to relicense a
project is one to take with a lawyer if anything material rides on it.

---

## 1. The question

Can we take [GenOffice](https://github.com/genspark-ai/genoffice) for document
rendering and editable `.docx` / `.xlsx` / `.pptx`, and ship it inside Bobble
under **GPL-3.0** instead of our current MIT?

**Short answer: yes, with four hard conditions.** The licence direction works.
The conditions are not optional and two of them are easy to get wrong.

---

## 2. What GenOffice actually is, licence-wise

| Thing | Licence | Consequence for us |
|---|---|---|
| GenOffice (the repository) | **Apache-2.0** | Usable. Apache-2.0 → GPLv3 is compatible **one way**. |
| GenOffice `ee/` directory | **GenOffice Enterprise License** (proprietary) | **Must be excluded entirely.** Not open source. |
| GenOffice / Genspark names + logos | **Trademarks of Mainfunc, Inc.** | Apache-2.0 §6 grants **no** trademark rights. We must rebrand. |
| [Univer](https://github.com/dream-num/univer) (spreadsheet core) | Apache-2.0 | Usable. **Univer Pro** is a separate commercial layer — do not pull it in. |
| pdf.js | Apache-2.0 | Usable. |
| pdf-lib | MIT | Usable. |
| Tiptap (editor) | MIT core | Usable. **Tiptap Pro** extensions are paid/commercial — verify none are dependencies. |
| HarfBuzz (text shaping) | "Old MIT" | Usable, GPL-compatible. |
| Liberation, Carlito, Caladea, Noto CJK fonts | SIL OFL-1.1 / Apache-2.0 | Usable. OFL has its own conditions — see §5. |

### Why Apache-2.0 → GPLv3 works

The Apache-2.0 licence has a patent-retaliation clause and an indemnification
clause that GPL**v2** treats as extra restrictions, which is why Apache-2.0 code
cannot go into a GPLv2 project. **GPLv3 was written to accept exactly those
terms** (it has its own patent provisions), and the FSF lists Apache-2.0 as
compatible with GPLv3.

The compatibility is **one-directional**. We may take Apache-2.0 code into a
GPLv3 work; the combined result is GPLv3. We may **not** later take the combined
work back out as Apache-2.0, and nobody downstream can either. Relicensing to
GPLv3 is a one-way door for this codebase.

---

## 3. The four hard conditions

### 3.1 Exclude `ee/` completely

The `ee/` directory is under a proprietary Enterprise License. It must not be
copied, vendored, built, or referenced. If we vendor GenOffice, the import step
must delete `ee/` and a check should fail the build if it ever reappears.

### 3.2 Rebrand — no "GenOffice", no "Genspark"

Apache-2.0 §6 explicitly withholds trademark rights, and GenOffice's own README
says so directly: *"The Apache-2.0 license does not grant permission to use
them."* Our surface must carry our own name. Referring to the project factually
in credits ("based on GenOffice by Mainfunc, Inc.") is normal attribution and is
fine; using the name or logo as our product identity is not.

### 3.3 Keep every Apache-2.0 notice, and add a NOTICE file

Apache-2.0 §4 requires, for any distribution:

- a copy of the Apache-2.0 licence itself;
- retention of all copyright, patent, trademark and attribution notices in the
  source we take;
- **the `NOTICE` file contents** carried forward, if the upstream has one;
- **a statement of the changes we made** to modified files.

Concretely, that means shipping `THIRD-PARTY-NOTICES.md` (see §6) and adding a
short "modified by" line at the top of any GenOffice file we edit.

### 3.4 Our own relicensing must be clean

- The repo declared **MIT** — a 21-line `LICENSE` at the root ("Copyright (c)
  2026 Pi Desktop contributors") and `"license": "MIT"` in every workspace
  package. (An earlier draft of this document said there was no `LICENSE` file;
  that was wrong — a shell glob failure had aborted the check before it ran.)
- Relicensing our own code MIT → GPLv3 is permitted: we hold the copyright, and
  MIT allows sublicensing.
- **If anyone else has contributed code**, their contributions were received
  under MIT; MIT permits relicensing downstream, so this is workable, but the
  clean path is to note the change in `CHANGELOG`/`LICENSE` history and, for any
  substantial outside contribution, get agreement.

---

## 4. Is anything in our current tree incompatible with GPLv3?

**Measured, not assumed** — a scan of the resolved pnpm store, 977 packages:

```
 802  MIT
  53  Apache-2.0
  42  ISC
  27  BSD-3-Clause
  23  BSD-2-Clause
   7  BlueOak-1.0.0
   3  MPL-2.0
   2  MIT OR Apache-2.0
   2  MIT-0
   2  OFL-1.1
```

**No GPLv3 blockers.** Every licence above is GPLv3-compatible. Two items to
note rather than fix:

- **`jszip`** — dual `MIT OR GPL-3.0-or-later`. We may take either arm; under a
  GPLv3 project either works.
- **`only@0.0.2`** — states no licence in `package.json` and ships no LICENCE
  file. It is a nine-line utility by TJ Holowaychuk whose repo is MIT, but the
  package as published is technically unlicensed. Low risk, trivially
  replaceable, worth removing if we want a spotless bill of materials.

Also relevant: **pi (`@mariozechner/pi-coding-agent`) is MIT** — compatible, and
in any case we spawn it as a separate process rather than linking it.

MPL-2.0 (3 packages) is GPL-compatible by its own §3.3 unless marked
"Incompatible With Secondary Licenses"; none of ours are.

---

## 5. Fonts — OFL is compatible but has its own rules

The bundled Liberation / Carlito / Caladea / Noto fonts are SIL OFL-1.1. OFL is
GPL-compatible, but it carries conditions the code licences do not:

- **Reserved Font Names**: if we modify a font, we must rename it.
- **Cannot be sold on their own** — bundling them in an application is fine.
- **Must ship the OFL text** with the fonts.

Practically: bundle them unmodified, ship `OFL.txt`, do not rename or re-hint.

---

## 6. What we must actually produce

1. **`LICENSE`** at the repo root — the full GPL-3.0 text.
2. **`THIRD-PARTY-NOTICES.md`** — every bundled component, its copyright holder,
   its licence, and the full text of each distinct licence. This is the Apache-2.0
   §4(d) obligation and the OFL obligation in one file.
3. **A "modified by" header** on any GenOffice/Univer file we change.
4. **A vendoring script** that pulls GenOffice at a pinned commit, **deletes
   `ee/`**, and records the commit hash — so the exclusion is mechanical rather
   than remembered.
5. **A build check** that fails if `ee/` or the strings `GenOffice`/`Genspark`
   appear in shipped output outside the credits file.
6. Update `apps/desktop/package.json` `"license": "MIT"` → `"GPL-3.0-or-later"`.

---

## 7. Consequences of GPLv3 worth deciding on deliberately

These are not blockers, but they are real and they are hard to reverse.

- **The Mac App Store becomes unavailable.** Apple's terms impose usage rules and
  DRM that conflict with GPLv3 §6 (installation information) and its
  anti-DRM/anti-Tivoization terms. GPL-licensed apps have been pulled from the
  App Store over exactly this. Direct download and Homebrew are unaffected. If
  Mac App Store distribution is ever wanted, GPLv3 forecloses it.
- **Anyone distributing a modified Bobble must publish their source**, including
  a company that ships it to customers. That is usually the point of choosing
  GPLv3, but it also deters some commercial adopters and contributors.
- **We cannot take it back.** Once GPLv3 code (or Apache-2.0 code combined under
  GPLv3) is in, the project cannot return to MIT without removing that code and
  getting agreement from every contributor since.
- **Dual licensing stays possible only for code we wholly own.** Once GenOffice's
  Apache-2.0 code is mixed in, we cannot offer the combined work under a
  proprietary licence — we would only be able to dual-license the parts we wrote.

---

## 7a. What has actually been done (2026-08-07)

- `LICENSE` at the root replaced with the **verbatim GPL-3.0 text** — 621 lines,
  all 18 sections through `END OF TERMS AND CONDITIONS`, taken from an
  authoritative copy shipped in the dependency tree rather than retyped.
- **24 workspace `package.json` files** moved from `"MIT"` to
  `"GPL-3.0-or-later"`.
- The previous MIT text is preserved in git history at the commit before this
  one; the project was MIT up to and including that commit, and every copy
  distributed under it stays MIT for its recipients — relicensing is not
  retroactive.

Still outstanding from §6: `THIRD-PARTY-NOTICES.md`, the vendoring script with
the `ee/` deletion, and the build check for the trademark strings. Those are only
needed once GenOffice is actually vendored.

## 8. Recommendation

The licence direction is sound and the dependency tree is clean. I would:

1. Add the missing root `LICENSE` **now**, independent of the GenOffice decision.
2. Relicense to `GPL-3.0-or-later` if the App Store consequence in §7 is
   acceptable — that is the one item that is genuinely irreversible and not
   purely legal-hygiene.
3. Vendor GenOffice at a pinned commit with `ee/` deleted mechanically, and
   generate `THIRD-PARTY-NOTICES.md` from the actual dependency tree rather than
   by hand, so it cannot drift.

Nothing here looks unlawful. The two things most likely to go wrong in practice
are the **`ee/` directory** and the **trademark**, because both are silent
failures — nothing breaks, we just end up shipping something we had no right to.
