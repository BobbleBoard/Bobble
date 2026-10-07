"""d1-3B, untuned, grounding 20 elements on Blender 5.2's default UI.

Two ways of asking, both one forward pass per decision:
  grid       a numbered 3x3 grid over the view: "which cell holds X?" -> zoom into that cell
             (padded 20%), four levels; the answer is the final cell's centre.
  direction  a mouse pointer drawn on the full screenshot: "which way to X: left/right/up/down,
             or on it?" -> move; a reversal on an axis halves that axis's step; 16 steps max.
A hit is the final point inside the element's box (boxes marked by hand off the screenshot).
"""
import base64, io, json, subprocess, sys, time
from PIL import Image, ImageDraw, ImageFont

SHOT = sys.argv[1]
OUT = sys.argv[2]
PORT = sys.argv[3]
ELEMENTS = [
    ("the File menu in the top menu bar", (29, 37, 52, 53)),
    ("the Render menu in the top menu bar", (96, 37, 137, 53)),
    ("the Help menu in the top menu bar", (203, 37, 231, 53)),
    ("the Modeling workspace tab", (312, 36, 370, 54)),
    ("the Shading workspace tab", (607, 36, 660, 54)),
    ("the Scripting workspace tab", (999, 36, 1057, 54)),
    ("the Object Mode dropdown", (50, 61, 156, 81)),
    ("the Add menu in the 3D viewport header", (252, 62, 278, 80)),
    ("the Move tool in the left toolbar", (11, 194, 49, 228)),
    ("the Rotate tool in the left toolbar", (11, 229, 49, 262)),
    ("the Scale tool in the left toolbar", (11, 264, 49, 297)),
    ("the Add Cube tool in the left toolbar", (11, 413, 49, 449)),
    ("the zoom (magnifying glass) button in the 3D viewport", (1205, 208, 1230, 232)),
    ("the camera view button in the 3D viewport", (1205, 268, 1230, 294)),
    ("the blue Z axis circle on the navigation gizmo", (1180, 123, 1200, 143)),
    ("the search field in the outliner", (1338, 62, 1452, 80)),
    ("Scene Collection in the outliner", (1262, 88, 1380, 104)),
    ("the play button in the timeline", (578, 789, 597, 809)),
    ("the End frame field in the timeline", (1091, 789, 1180, 809)),
    ("the Gravity checkbox in the properties panel", (1298, 449, 1364, 465)),
]


FIRST = {"printed": False}

def ask(state, questions, image):
    buf = io.BytesIO()
    image.save(buf, format="PNG")
    body = {"state": state, "questions": questions,
            "images": ["data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()]}
    out = subprocess.run(["curl", "-s", "-m", "120", f"http://127.0.0.1:{PORT}/v1/systemone",
                          "-H", "content-type: application/json", "--data-binary", "@-"],
                         input=json.dumps(body).encode(), capture_output=True, check=True).stdout
    r = json.loads(out)
    if not FIRST["printed"]:
        FIRST["printed"] = True
        print("first response:", json.dumps(r)[:600], flush=True)
    return r

def answer(r, name):
    a = (r.get("answers") or r)[name]
    return a["choice"], float(a.get("confidence", 0))

class Model:
    def system_one_batch(self, reqs):
        return [ask(st, qs, ims[0]) for st, qs, ims in reqs]

model = Model()

base = Image.open(SHOT).convert("RGB")
W, H = base.size

def inside(p, box):
    return box[0] <= p[0] <= box[2] and box[1] <= p[1] <= box[3]

def font(size):
    try:
        return ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial Bold.ttf", size)
    except OSError:
        return ImageFont.load_default(size=size)

# ---------- grid ----------
def grid_view(region):
    x0, y0, x1, y1 = region
    crop = base.crop((int(x0), int(y0), int(x1), int(y1)))
    s = 1000 / max(crop.size)
    crop = crop.resize((max(1, int(crop.width * s)), max(1, int(crop.height * s))), Image.Resampling.LANCZOS)
    d = ImageDraw.Draw(crop)
    cw, ch = crop.width / 3, crop.height / 3
    for i in (1, 2):
        for lw, col in ((7, "black"), (3, "yellow")):
            d.line([(cw * i, 0), (cw * i, crop.height)], fill=col, width=lw)
            d.line([(0, ch * i), (crop.width, ch * i)], fill=col, width=lw)
    f = font(max(16, int(min(cw, ch) * 0.18)))
    for r in range(3):
        for c in range(3):
            n = r * 3 + c + 1
            tx, ty = cw * c + 6, ch * r + 4
            d.rectangle([tx - 3, ty - 2, tx + f.size * 0.75, ty + f.size + 2], fill="yellow")
            d.text((tx, ty), str(n), fill="black", font=f)
    return crop

CELL_NAMES = ["top left", "top middle", "top right", "middle left", "centre", "middle right",
              "bottom left", "bottom middle", "bottom right"]

def grid_question(desc):
    return {"cell": {"type": "choice",
                     "instructions": f"This is part of a Blender screenshot with a yellow 3x3 grid of numbered "
                                     f"cells drawn over it. Which numbered cell contains {desc}?",
                     "criteria": {str(i + 1): f"cell {i + 1} ({CELL_NAMES[i]})" for i in range(9)}}}

def sub_region(region, n, pad=0.2):
    x0, y0, x1, y1 = region
    cw, ch = (x1 - x0) / 3, (y1 - y0) / 3
    r, c = divmod(n - 1, 3)
    a, b = x0 + c * cw, y0 + r * ch
    return (max(0, a - cw * pad), max(0, b - ch * pad), min(W, a + cw * (1 + pad)), min(H, b + ch * (1 + pad)))

def true_cell(region, box):
    cx, cy = (box[0] + box[2]) / 2, (box[1] + box[3]) / 2
    x0, y0, x1, y1 = region
    c = min(2, max(0, int((cx - x0) / ((x1 - x0) / 3))))
    r = min(2, max(0, int((cy - y0) / ((y1 - y0) / 3))))
    return r * 3 + c + 1

grid = []
regions = [(0, 0, W, H)] * len(ELEMENTS)
levels = [[] for _ in ELEMENTS]
calls = []
for level in range(4):
    reqs = [(None, grid_question(desc), [grid_view(regions[i])]) for i, (desc, _) in enumerate(ELEMENTS)]
    if level == 0:
        grid_view(regions[0]).save(f"{OUT}/grid-level1.png")
    t = time.time()
    res = model.system_one_batch(reqs)
    calls.append((time.time() - t) / len(reqs))
    for i, r in enumerate(res):
        choice, conf = answer(r, "cell")
        n = int(choice)
        a = {"confidence": conf}
        right = true_cell(regions[i], ELEMENTS[i][1])
        levels[i].append({"picked": n, "true": right, "p": round(a["confidence"], 2)})
        regions[i] = sub_region(regions[i], n)
for i, (desc, box) in enumerate(ELEMENTS):
    x0, y0, x1, y1 = regions[i]
    p = ((x0 + x1) / 2, (y0 + y1) / 2)
    grid.append({"element": desc, "point": [round(p[0]), round(p[1])], "hit": inside(p, box),
                 "levels_right": sum(1 for l in levels[i] if l["picked"] == l["true"]), "levels": levels[i]})

# ---------- direction ----------
ARROW = [(0, 0), (0, 26), (7, 20), (12, 31), (17, 29), (12, 18), (21, 18)]

def pointer_view(p):
    im = base.copy()
    d = ImageDraw.Draw(im)
    d.ellipse([p[0] - 14, p[1] - 14, p[0] + 14, p[1] + 14], outline="red", width=3)
    pts = [(p[0] + x, p[1] + y) for x, y in ARROW]
    d.polygon(pts, fill="white", outline="black")
    return im

def dir_question(desc):
    return {"move": {"type": "choice",
                     "instructions": f"This is a Blender screenshot. The white arrow inside the red ring is the "
                                     f"mouse pointer. Which way must the pointer move to reach {desc}?",
                     "criteria": {"left": "move left", "right": "move right", "up": "move up",
                                  "down": "move down", "on": "the pointer is already on it"}}}

pos = [[W / 2, H / 2] for _ in ELEMENTS]
step = [[W / 4, H / 4] for _ in ELEMENTS]
last = [[None, None] for _ in ELEMENTS]
done = [False] * len(ELEMENTS)
trace = [[] for _ in ELEMENTS]
dcalls = []
for it in range(16):
    active = [i for i in range(len(ELEMENTS)) if not done[i]]
    if not active:
        break
    reqs = [(None, dir_question(ELEMENTS[i][0]), [pointer_view(pos[i])]) for i in active]
    if it == 0:
        pointer_view(pos[0]).save(f"{OUT}/pointer-start.png")
    t = time.time()
    res = model.system_one_batch(reqs)
    dcalls.append((time.time() - t) / len(reqs))
    for i, r in zip(active, res):
        mv, _ = answer(r, "move")
        trace[i].append(mv)
        if mv == "on":
            done[i] = True
            continue
        axis, sign = {"left": (0, -1), "right": (0, 1), "up": (1, -1), "down": (1, 1)}[mv]
        if last[i][axis] is not None and last[i][axis] != sign:
            step[i][axis] /= 2
        last[i][axis] = sign
        pos[i][axis] = min((W, H)[axis] - 1, max(0, pos[i][axis] + sign * step[i][axis]))
direction = [{"element": desc, "point": [round(pos[i][0]), round(pos[i][1])], "hit": inside(pos[i], box),
              "said_on": done[i], "moves": "".join(m[0] for m in trace[i])}
             for i, (desc, box) in enumerate(ELEMENTS)]

report = {
    "grid_hits": sum(g["hit"] for g in grid), "direction_hits": sum(d["hit"] for d in direction),
    "grid_level_accuracy": [sum(1 for i in range(len(ELEMENTS)) if levels[i][l]["picked"] == levels[i][l]["true"])
                            for l in range(4)],
    "ms_per_decision_grid": [round(c * 1000) for c in calls],
    "ms_per_decision_direction": round(sum(dcalls) / len(dcalls) * 1000) if dcalls else None,
    "grid": grid, "direction": direction,
}
json.dump(report, open(f"{OUT}/report.json", "w"), indent=1)
print(json.dumps({k: v for k, v in report.items() if k not in ("grid", "direction")}))
for g, d in zip(grid, direction):
    print(f"{'HIT ' if g['hit'] else 'miss'} grid {g['levels_right']}/4  |  {'HIT ' if d['hit'] else 'miss'} dir {d['moves']:<16} | {g['element']}")
