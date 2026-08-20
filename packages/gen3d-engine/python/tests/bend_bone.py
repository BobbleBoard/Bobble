"""Bake a big rotation onto one bone so two rigs can be compared side by side.

Not a test — a tool. Run it, then render both GLBs with
apps/desktop/tests/e2e/gen3d-visual-check.mjs and look:

    python tests/bend_bone.py <in.glb> <out.glb> 90 near "0.26,0.10,0.02"

This is what showed that euclidean skin weights drag the chest when the arm
swings, and that geodesic ones do not — the same 90 degrees on the same bone of
the same character, which is the only comparison that settles it.

The question is whether SKIN WEIGHTS are what tears the surface when a limb
swings a long way. Answering it needs the same motion on both rigs, and the
motion has to come from outside either rigger — so this picks the bone by
GEOMETRY (high on the body, furthest out to the side = an upper arm) and writes
a one-second rotation about the axis that swings it forward.
"""
import json, struct, sys
import numpy as np

src, dst, deg = sys.argv[1], sys.argv[2], float(sys.argv[3])
d = bytearray(open(src, 'rb').read())
jlen = struct.unpack('<I', d[12:16])[0]
gl = json.loads(bytes(d[20:20 + jlen]))
binoff = 20 + jlen + 8

def acc(i):
    a = gl['accessors'][i]; bv = gl['bufferViews'][a['bufferView']]
    off = binoff + bv.get('byteOffset', 0) + a.get('byteOffset', 0)
    dt = {5121: np.uint8, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}[a['componentType']]
    nc = {'SCALAR': 1, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}[a['type']]
    return np.frombuffer(bytes(d), dtype=dt, count=a['count'] * nc, offset=off).reshape(a['count'], nc)

skin = gl['skins'][0]
ibm = acc(skin['inverseBindMatrices']).reshape(-1, 4, 4)
jpos = np.stack([np.linalg.inv(m.T)[:3, 3] for m in ibm])
ys = jpos[:, 1]
lo, hi = ys.min(), ys.max()
upper = (ys - lo) / max(hi - lo, 1e-9) > 0.55
if not upper.any():
    upper = np.ones(len(ys), bool)
# PICK BY WHAT THE BONE ACTUALLY SKINS, not by where its joint sits. Matching
# joint POSITIONS between two rigs picked a bone that drives the helmet on one
# of them, because a learned rig puts joints where it likes. The centroid of the
# vertices a bone dominates is a description of the limb itself.
prim = gl['meshes'][0]['primitives'][0]
P = acc(prim['attributes']['POSITION']).astype(np.float64)
JJ = acc(prim['attributes']['JOINTS_0']).astype(np.int32)
WW = acc(prim['attributes']['WEIGHTS_0']).astype(np.float64)
dom = JJ[np.arange(len(JJ)), WW.argmax(1)]
h = P[:, 1].max() - P[:, 1].min()
mid = (P[:, 1].max() + P[:, 1].min()) * 0.5
best, best_score = None, -1e9
for k in range(len(jpos)):
    sel = P[dom == k]
    if len(sel) < 200:
        continue
    c = sel.mean(0)
    # An upper arm: far out to one side, near mid-height, and its cloud is
    # taller than it is wide (a limb, not a slab like the torso or backpack).
    span = sel.max(0) - sel.min(0)
    limbness = span[1] / max(span[0], 1e-6)
    score = abs(c[0]) / h - abs(c[1] - mid) / h + 0.15 * min(limbness, 3)
    if score > best_score:
        best_score, best = score, k
if best is not None:
    print(f"  arm-like bone by skinning: {best} score {best_score:.2f}")

# NEAR x,y,z — the bone that dominates the vertices AT a known limb location.
# This is the only identification that survives a rig naming its bones
# bone_0..bone_25 and placing joints wherever it likes: the arm is a place on
# the mesh, and whichever bone drives the vertices there IS that rig's arm.
if len(sys.argv) > 5 and sys.argv[4] == 'near':
    want = np.array([float(v) for v in sys.argv[5].split(',')])
    r = 0.07 * h
    sel = np.linalg.norm(P - want, axis=1) < r
    while sel.sum() < 300 and r < 0.4 * h:
        r *= 1.5
        sel = np.linalg.norm(P - want, axis=1) < r
    ids, counts = np.unique(dom[sel], return_counts=True)
    pick = int(ids[counts.argmax()])
    print(f"  {sel.sum():,} vertices near {want.round(3)} -> bone index {pick} "
          f"({counts.max() / sel.sum() * 100:.0f}% of them)")
    node = skin['joints'][pick]
    print(f"  bone node {node} ({gl['nodes'][node].get('name')}) at {jpos[pick].round(3)}")
else:
    node = None

cand = np.where(upper)[0]
if node is not None:
    pass
elif len(sys.argv) > 4 and sys.argv[4] == 'auto':
    pick = best if best is not None else cand[np.argmax(np.abs(jpos[cand, 0]))]
elif len(sys.argv) > 4:
    # TARGET x,y,z — pick the joint nearest a position. Both rigs are fitted to
    # the same character in the same space, so "the bone where the other rig's
    # upper arm is" is the only way to compare like with like when one of them
    # names its bones bone_0..bone_25.
    want = np.array([float(v) for v in sys.argv[4].split(',')])
    pick = int(np.argmin(np.linalg.norm(jpos - want, axis=1)))
else:
    pick = cand[np.argmax(np.abs(jpos[cand, 0]))]
if node is None:
    node = skin['joints'][pick]
    print(f"  bone node {node} ({gl['nodes'][node].get('name')}) at {jpos[pick].round(3)}")

base = gl['nodes'][node].get('rotation', [0, 0, 0, 1])
th = np.deg2rad(deg) / 2
delta = np.array([np.sin(th), 0, 0, np.cos(th)])  # about X: swings the arm fore/aft
bx, by, bz, bw = base
dx, dy, dz, dw = delta
out = [
    bw * dx + bx * dw + by * dz - bz * dy,
    bw * dy - bx * dz + by * dw + bz * dx,
    bw * dz + bx * dy - by * dx + bz * dw,
    bw * dw - bx * dx - by * dy - bz * dz,
]

times = np.array([0.0, 0.5, 1.0], dtype=np.float32)
# HOLD the bent pose at every key: the viewer loops the clip, so a
# keyframe back at rest means whatever moment gets screenshotted is a
# coin flip — and it landed on rest for both rigs the first time.
rots = np.array([out, out, out], dtype=np.float32)
blob = times.tobytes() + rots.tobytes()
pad = (-len(blob)) % 4
blob += b'\x00' * pad
bin_len = struct.unpack('<I', d[20 + jlen:24 + jlen])[0]
bv0 = len(gl['bufferViews'])
gl['bufferViews'] += [
    {'buffer': 0, 'byteOffset': bin_len, 'byteLength': times.nbytes},
    {'buffer': 0, 'byteOffset': bin_len + times.nbytes, 'byteLength': rots.nbytes},
]
a0 = len(gl['accessors'])
gl['accessors'] += [
    {'bufferView': bv0, 'componentType': 5126, 'count': 3, 'type': 'SCALAR',
     'min': [0.0], 'max': [1.0]},
    {'bufferView': bv0 + 1, 'componentType': 5126, 'count': 3, 'type': 'VEC4'},
]
gl['animations'] = [{
    'name': 'bend',
    'samplers': [{'input': a0, 'output': a0 + 1, 'interpolation': 'LINEAR'}],
    'channels': [{'sampler': 0, 'target': {'node': node, 'path': 'rotation'}}],
}]
gl['buffers'][0]['byteLength'] = bin_len + len(blob)

newj = json.dumps(gl).encode()
newj += b' ' * ((-len(newj)) % 4)
body = bytes(d[20 + jlen + 8:20 + jlen + 8 + bin_len]) + blob
out_b = bytearray()
out_b += b'glTF' + struct.pack('<II', 2, 12 + 8 + len(newj) + 8 + len(body))
out_b += struct.pack('<I', len(newj)) + b'JSON' + newj
out_b += struct.pack('<I', len(body)) + b'BIN\x00' + body
open(dst, 'wb').write(bytes(out_b))
print(f"  wrote {dst}")
