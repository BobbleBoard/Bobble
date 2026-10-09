"""
Imagery and background systems.

Two sources, deliberately in this order:

1. STOCK PHOTOS, fetched once and cached on disk. The user's call, and the right
   one — generated imagery on a research deck invites the model to illustrate
   data, and a hallucinated chart drawn as a picture is worse than no picture.
   A photograph is decoration and reads as decoration.

2. PROCEDURAL fields — gradients and geometry generated locally. These are the
   fallback when there is no network, and they are also just better than a
   photograph for a section divider, where a picture would compete with the
   type.

Every photo gets a DUOTONE treatment mapped onto the deck's palette. Untreated
stock photography is the fastest way to make a deck look like a template: the
colours never agree with anything else on the slide. Duotoning forces every
image into the same two-colour system as the rest of the deck.
"""
from __future__ import annotations

import hashlib
import urllib.request
from pathlib import Path

from PIL import Image, ImageDraw, ImageEnhance, ImageFilter

from scratch import offline, scratch_dir

CACHE = scratch_dir() / "img-cache"
CACHE.mkdir(parents=True, exist_ok=True)
UA = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"}


def _rgb(hexs: str) -> tuple[int, int, int]:
    h = hexs.lstrip("#")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def fetch_photo(query: str, w=1600, h=900, *, timeout=12) -> Path | None:
    """One photo for a query, cached by (query, size).

    Source is Unsplash's keyword endpoint, which needs no API key. Failure is
    normal and non-fatal — offline is the expected state for this app, so every
    caller must handle None rather than assume a picture exists.
    """
    key = hashlib.sha1(f"{query}|{w}x{h}".encode()).hexdigest()[:16]
    dest = CACHE / f"{key}.jpg"
    if dest.exists() and dest.stat().st_size > 4096:
        return dest
    # Nothing leaves the Mac by default (scratch.offline); the caller paints a
    # gradient ground instead, which is what an offline deck always got.
    if offline():
        return None
    # source.unsplash.com was retired; picsum serves keyless stock photography
    # and takes a deterministic seed, so the same query always yields the same
    # picture — a deck that reshuffles its imagery on every rebuild is not a
    # deck you can iterate on.
    seed = hashlib.sha1(query.encode()).hexdigest()[:12]
    url = f"https://picsum.photos/seed/{seed}/{w}/{h}"
    try:
        req = urllib.request.Request(url, headers=UA)
        with urllib.request.urlopen(req, timeout=timeout) as r:
            data = r.read()
        if len(data) < 4096:
            return None
        dest.write_bytes(data)
        return dest
    except Exception:
        return None


def duotone(src: Path, dark_hex: str, light_hex: str, out: Path,
            *, contrast=1.25, blur=0.0) -> Path:
    """Map a photo's luminance onto two palette colours.

    This is what stops stock photography looking bolted on. The image keeps its
    structure and loses its own colour, so it belongs to the deck's system.
    """
    im = Image.open(src).convert("L")
    if blur:
        im = im.filter(ImageFilter.GaussianBlur(blur))
    im = ImageEnhance.Contrast(im).enhance(contrast)
    d, l = _rgb(dark_hex), _rgb(light_hex)
    ramp = []
    for i in range(256):
        f = i / 255.0
        ramp.extend([int(d[c] + (l[c] - d[c]) * f) for c in range(3)])
    out_im = im.convert("P")
    out_im.putpalette(ramp)
    out_im.convert("RGB").save(out, quality=92)
    return out


def gradient_field(out: Path, c0: str, c1: str, *, size=(1600, 900),
                   angle="diagonal", grain=True) -> Path:
    """A soft two-stop field. python-pptx can do a linear gradient fill, but not
    a diagonal one with grain, and grain is most of what stops a large flat
    gradient looking like a 2013 PowerPoint background."""
    w, h = size
    a, b = _rgb(c0), _rgb(c1)
    im = Image.new("RGB", size)
    px = im.load()
    for y in range(h):
        for x in range(0, w, 4):
            if angle == "diagonal":
                f = (x / w * 0.65 + y / h * 0.35)
            elif angle == "vertical":
                f = y / h
            else:
                f = x / w
            f = max(0.0, min(1.0, f))
            col = (int(a[0] + (b[0] - a[0]) * f),
                   int(a[1] + (b[1] - a[1]) * f),
                   int(a[2] + (b[2] - a[2]) * f))
            for dx in range(4):
                if x + dx < w:
                    px[x + dx, y] = col
    if grain:
        # A whisper of noise, then a blur: banding on a large flat gradient is
        # the single most obvious cheap-render tell on a projector.
        import random
        rnd = random.Random(7)
        ov = Image.new("L", (w // 3, h // 3))
        ov.putdata([rnd.randint(112, 143) for _ in range((w // 3) * (h // 3))])
        ov = ov.resize(size, Image.BILINEAR).filter(ImageFilter.GaussianBlur(1.1))
        im = Image.blend(im, Image.merge("RGB", (ov, ov, ov)), 0.055)
    im.save(out, quality=94)
    return out


def geometric_field(out: Path, base: str, accent: str, *, size=(1600, 900),
                    seed=3) -> Path:
    """Concentric arcs on a flat ground — a motif, not an illustration. Cheap,
    offline, and it never competes with the type because it has no subject."""
    import random
    rnd = random.Random(seed)
    w, h = size
    im = Image.new("RGB", size, _rgb(base))
    d = ImageDraw.Draw(im, "RGBA")
    ax, ay = int(w * 0.78), int(h * 0.30)
    acc = _rgb(accent)
    for i in range(9):
        r = int(w * (0.10 + i * 0.062))
        alpha = max(10, 52 - i * 5)
        d.ellipse([ax - r, ay - r, ax + r, ay + r], outline=(*acc, alpha), width=3)
    for _ in range(3):
        rx = rnd.randint(0, w)
        d.line([(rx, 0), (rx + rnd.randint(-200, 200), h)], fill=(*acc, 22), width=2)
    im = im.filter(ImageFilter.SMOOTH)
    im.save(out, quality=94)
    return out


import urllib.parse  # noqa: E402  (used by fetch_photo)
