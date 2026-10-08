"""Rig the CC BY 4.0 goat (Hendrik Reyneke, Sketchfab 2624ac2c) with a quadruped skeleton,
distance-based skin weights and five procedural clips, and export a skinned GLB.

Usage: rig_goat.py <src.glb> <out.glb> [pose_dir]
If pose_dir is given, also writes posed static meshes there for visual checks.
Model convention: +Z forward (head at +Z), +Y up, metres, feet at y = 0.
"""
import json
import math
import os
import struct
import sys

import numpy as np
import trimesh

SRC, OUT = sys.argv[1], sys.argv[2]
POSE_DIR = sys.argv[3] if len(sys.argv) > 3 else None
FPS = 15

# ----------------------------------------------------------------- quaternions (x, y, z, w)
def q_axis(axis, a):
    ax = np.array(axis, float)
    ax = ax / np.linalg.norm(ax)
    s = math.sin(a / 2)
    return np.array([ax[0] * s, ax[1] * s, ax[2] * s, math.cos(a / 2)])


def q_mul(a, b):
    ax, ay, az, aw = a
    bx, by, bz, bw = b
    return np.array([
        aw * bx + ax * bw + ay * bz - az * by,
        aw * by - ax * bz + ay * bw + az * bx,
        aw * bz + ax * by - ay * bx + az * bw,
        aw * bw - ax * bx - ay * by - az * bz,
    ])


def q_mat(q):
    x, y, z, w = q
    return np.array([
        [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w), 0],
        [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w), 0],
        [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y), 0],
        [0, 0, 0, 1],
    ])


def T(v):
    m = np.eye(4)
    m[:3, 3] = v
    return m


AXES = {'x': (1, 0, 0), 'y': (0, 1, 0), 'z': (0, 0, 1)}

# ----------------------------------------------------------------- skeleton
# name, parent, global bind position (metres)
LEG_Z = {'FL': 0.17, 'FR': 0.17, 'RL': -0.33, 'RR': -0.33}
LEG_X = {'FL': 0.06, 'FR': -0.06, 'RL': 0.06, 'RR': -0.06}
BONES = [
    ('hips', None, (0.0, 0.45, -0.30)),
    ('spine', 'hips', (0.0, 0.50, -0.05)),
    ('chest', 'spine', (0.0, 0.52, 0.15)),
    ('neck', 'chest', (0.0, 0.55, 0.30)),
    ('head', 'neck', (0.0, 0.58, 0.45)),
    ('tail1', 'hips', (0.0, 0.52, -0.52)),
    ('tail2', 'tail1', (0.0, 0.50, -0.60)),
]
for leg in ['FL', 'FR', 'RL', 'RR']:
    x, z = LEG_X[leg], LEG_Z[leg]
    BONES += [
        (f'{leg}_up', 'hips', (x, 0.42, z)),
        (f'{leg}_lo', f'{leg}_up', (x, 0.22, z)),
        (f'{leg}_ft', f'{leg}_lo', (x, 0.03, z + 0.02)),
    ]
# The skeleton is authored for the goat (REF bounds). RIG_TARGET=bear stretches it
# to the bear's bounds, after its centimetre mesh is scaled to metres (see below).
REF_MIN = np.array([-0.132, 0.0, -0.6])
REF_MAX = np.array([0.132, 0.824, 0.6])
if os.environ.get('RIG_TARGET') == 'bear':
    TGT_MIN = np.array([-0.378, 0.0, -1.079])
    TGT_MAX = np.array([0.378, 1.399, 1.079])
else:
    TGT_MIN, TGT_MAX = REF_MIN, REF_MAX


def remap(p):
    p = np.asarray(p, float)
    return TGT_MIN + (p - REF_MIN) / (REF_MAX - REF_MIN) * (TGT_MAX - TGT_MIN)


NAMES = [b[0] for b in BONES]
PARENT = {b[0]: b[1] for b in BONES}
GBIND = {b[0]: remap(b[2]) for b in BONES}
CHILDREN = {n: [c for c in NAMES if PARENT[c] == n] for n in NAMES}

# Weight segments: origin -> first child (or an explicit tip for leaves).
TIP = {
    'head': (0.0, 0.62, 0.56), 'tail2': (0.0, 0.45, -0.68),
}
for leg in ['FL', 'FR', 'RL', 'RR']:
    x, z = LEG_X[leg], LEG_Z[leg]
    TIP[f'{leg}_ft'] = (x, 0.0, z + 0.07)


def segment(n):
    a = GBIND[n]
    if n in TIP:
        b = remap(TIP[n])
    else:
        b = GBIND[CHILDREN[n][0]]
    return a, b


# ----------------------------------------------------------------- clips
def gait(t, period, amp, phases, bob, pitch):
    """Four-leg gait. phases: leg -> phase offset (radians)."""
    base = 2 * math.pi * t / period
    pose = {}
    for leg, off in phases.items():
        p = base + off
        pose[f'{leg}_up'] = [('x', -amp * math.sin(p))]
        pose[f'{leg}_lo'] = [('x', 0.5 * amp * max(0.0, -math.cos(p)) + 0.04)]
    pose['spine'] = [('x', pitch * math.sin(base))]
    hips_t = (0.0, bob * (1 - math.cos(2 * base)) / 2, 0.0)
    return pose, {'hips': hips_t}


def clip_walk(t):
    return gait(t, 1.0, 0.36, {'FL': 0.0, 'RR': 0.0, 'FR': math.pi, 'RL': math.pi}, 0.012, 0.02)


def clip_gallop(t):
    return gait(t, 0.55, 0.62, {'FL': 0.0, 'FR': 0.12, 'RL': 0.95, 'RR': 1.05}, 0.035, 0.09)


def clip_idle(t):
    p = 2 * math.pi * t / 4.0
    return {
        'head': [('x', 0.05 * math.sin(p)), ('y', 0.03 * math.sin(p * 0.5))],
        'neck': [('x', 0.02 * math.sin(p))],
        'chest': [('x', 0.012 * math.sin(p))],
        'tail1': [('y', 0.25 * math.sin(2 * p))],
        'tail2': [('y', 0.2 * math.sin(2 * p + 0.6))],
    }, {}


def clip_eating(t):
    p = 2 * math.pi * t / 3.0
    chomp = 0.05 * math.sin(2 * math.pi * t * 2.5)
    return {
        'neck': [('x', 0.32)],
        'head': [('x', 0.72 + chomp)],
        'chest': [('x', 0.08)],
        'FL_up': [('x', -0.04 * math.sin(p))], 'FR_up': [('x', 0.04 * math.sin(p))],
        'tail1': [('y', 0.2 * math.sin(p))],
    }, {}


def clip_death(t):
    d = min(t, 1.2) / 1.2
    roll = (math.pi / 2) * (d * d * (3 - 2 * d))  # smoothstep to a side fall
    return {
        'hips': [('z', roll)],
        'FL_up': [('z', 0.4 * d)], 'FR_up': [('z', -0.4 * d)],
        'RL_up': [('z', 0.3 * d)], 'RR_up': [('z', -0.3 * d)],
    }, {'hips': (0.0, -0.13 * d, 0.0)}


CLIPS = {
    'Walk': (1.0, clip_walk),
    'Gallop': (0.55, clip_gallop),
    'Idle': (4.0, clip_idle),
    'Eating': (3.0, clip_eating),
    'Death': (1.2, clip_death),
}


def local_rot(pose_state):
    """Bone name -> local quaternion, from a clip state dict."""
    out = {}
    for n in NAMES:
        q = np.array([0, 0, 0, 1.0])
        for axis, ang in pose_state.get(n, []):
            q = q_mul(q, q_axis(AXES[axis], ang))
        out[n] = q
    return out


def pose_globals(state, hips_offset=(0.0, 0.0, 0.0)):
    """Global transform of every bone for a clip state."""
    rots = local_rot(state[0])
    trans_extra = state[1]
    G = {}
    for n in NAMES:
        local_t = np.array(GBIND[n] - (GBIND[PARENT[n]] if PARENT[n] else np.zeros(3)), float)
        if n == 'hips':
            local_t = GBIND['hips'].copy()
        if n in trans_extra:
            local_t = local_t + np.array(trans_extra[n], float)
        L = T(local_t) @ q_mat(rots[n])
        G[n] = (G[PARENT[n]] @ L) if PARENT[n] else L
    return G


# ----------------------------------------------------------------- source mesh
scene = trimesh.load(SRC, force='scene')
geom = list(scene.geometry.values())
assert len(geom) == 1, 'expected one mesh'
mesh = geom[0]
V = np.asarray(mesh.vertices, np.float32)
if os.environ.get('RIG_TARGET') == 'bear':
    # The bear is authored in centimetres and centred on the origin; metres, feet at y = 0.
    V = V * np.float32(0.01)
    V[:, 1] -= V[:, 1].min()
F = np.asarray(mesh.faces, np.uint32)
N = np.asarray(mesh.vertex_normals, np.float32)
UV = np.asarray(mesh.visual.uv, np.float32)

# ----------------------------------------------------------------- skin weights
SIGMA = 0.045
dist = []
for n in NAMES:
    A, B = segment(n)
    AB = B - A
    t = np.clip(((V - A) @ AB) / max(float(AB @ AB), 1e-9), 0, 1)
    P = A + t[:, None] * AB
    dist.append(np.linalg.norm(V - P, axis=1))
dist = np.stack(dist, axis=1)  # N x bones
w = np.exp(-(dist / SIGMA) ** 2)
order = np.argsort(-w, axis=1)[:, :4]
top_w = np.take_along_axis(w, order, axis=1)
top_w = top_w / np.maximum(top_w.sum(axis=1, keepdims=True), 1e-12)
# A vertex far from every segment takes its nearest bone fully.
far = w.max(axis=1) < 1e-6
if far.any():
    nearest = np.argmin(dist[far], axis=1)
    top_w[far] = 0
    top_w[far, 0] = 1
    order[far, 0] = nearest
JOINTS = order.astype(np.uint16)
WEIGHTS = top_w.astype(np.float32)


# ----------------------------------------------------------------- posing (for checks and IBM)
GINV_BIND = {n: np.linalg.inv(T(GBIND[n])) for n in NAMES}


def skin(state):
    G = pose_globals(state)
    M = np.stack([G[n] @ GINV_BIND[n] for n in NAMES])  # bones x4x4
    homo = np.concatenate([V, np.ones((len(V), 1), np.float32)], axis=1)
    out = np.zeros((len(V), 3))
    for k in range(4):
        m = M[JOINTS[:, k]]  # N x4x4
        vk = np.einsum('nij,nj->ni', m, homo)[:, :3]
        out += WEIGHTS[:, k:k + 1] * vk
    return out


if POSE_DIR:
    os.makedirs(POSE_DIR, exist_ok=True)
    checks = [('Walk', 0.25), ('Walk', 0.75), ('Gallop', 0.2), ('Idle', 1.0), ('Eating', 1.0), ('Death', 1.2)]
    for cname, t in checks:
        state = CLIPS[cname][1](t)
        Vp = skin(state)
        trimesh.Trimesh(vertices=Vp, faces=F, process=False).export(
            os.path.join(POSE_DIR, f'{cname}_{t}.glb'))
    print('pose checks written to', POSE_DIR)


# ----------------------------------------------------------------- GLB writer
orig = trimesh.load(SRC, force='scene')  # reuse textures from the source file
raw = open(SRC, 'rb').read()
jlen = struct.unpack('<I', raw[12:16])[0]
orig_json = json.loads(raw[20:20 + jlen])
orig_bin = raw[20 + jlen + 8:]

binary = bytearray()
bviews, accs = [], []


def add_bytes(data, target=None):
    pad = (-len(binary)) % 4
    binary.extend(b'\0' * pad)
    off = len(binary)
    binary.extend(data)
    bv = {'buffer': 0, 'byteOffset': off, 'byteLength': len(data)}
    if target:
        bv['target'] = target
    bviews.append(bv)
    return len(bviews) - 1


def add_acc(arr, ctype, typ, target=None, with_minmax=False):
    arr = np.ascontiguousarray(arr)
    bv = add_bytes(arr.tobytes(), target)
    a = {'bufferView': bv, 'componentType': ctype, 'count': int(arr.shape[0]), 'type': typ}
    if with_minmax:
        a['min'] = [float(x) for x in np.min(arr, axis=0).reshape(-1)]
        a['max'] = [float(x) for x in np.max(arr, axis=0).reshape(-1)]
    accs.append(a)
    return len(accs) - 1


FLOAT, USHORT, UINT = 5126, 5123, 5125
ARRAY_BUFFER, ELEMENT_ARRAY = 34962, 34963

acc_pos = add_acc(V, FLOAT, 'VEC3', ARRAY_BUFFER, True)
acc_nrm = add_acc(N, FLOAT, 'VEC3', ARRAY_BUFFER)
acc_uv = add_acc(UV, FLOAT, 'VEC2', ARRAY_BUFFER)
acc_jnt = add_acc(JOINTS, USHORT, 'VEC4', ARRAY_BUFFER)
acc_wgt = add_acc(WEIGHTS, FLOAT, 'VEC4', ARRAY_BUFFER)
acc_idx = add_acc(F.reshape(-1), UINT, 'SCALAR', ELEMENT_ARRAY)

# inverse bind matrices, column-major on disk
IBM = np.stack([np.linalg.inv(T(GBIND[n])) for n in NAMES]).astype(np.float32)
acc_ibm = add_acc(np.transpose(IBM, (0, 2, 1)).reshape(len(NAMES), 16), FLOAT, 'MAT4')

# animations
anim_list = []
for cname, (period, fn) in CLIPS.items():
    frames = max(2, int(round(period * FPS)))
    times = np.arange(frames, dtype=np.float32) / FPS
    rot = {n: [] for n in NAMES}
    trn = {n: [] for n in NAMES}
    for i in range(frames):
        state = fn(float(times[i]))
        rots = local_rot(state[0])
        for n in NAMES:
            rot[n].append(rots[n])
            base = GBIND[n] - (GBIND[PARENT[n]] if PARENT[n] else np.zeros(3))
            if n == 'hips':
                base = GBIND['hips'].copy()
            extra = state[1].get(n, (0, 0, 0))
            trn[n].append(base + np.array(extra, float))
    t_acc = add_acc(times, FLOAT, 'SCALAR', None, True)
    channels, samplers = [], []
    for n in NAMES:
        ni = None  # filled after nodes are built (node index = 1 + bone index)
        r_out = add_acc(np.array(rot[n], np.float32), FLOAT, 'VEC4')
        samplers.append({'input': t_acc, 'output': r_out, 'interpolation': 'LINEAR'})
        channels.append({'sampler': len(samplers) - 1, 'target': {'node': NAMES.index(n) + 1, 'path': 'rotation'}})
        if n == 'hips':
            t_out = add_acc(np.array(trn[n], np.float32), FLOAT, 'VEC3')
            samplers.append({'input': t_acc, 'output': t_out, 'interpolation': 'LINEAR'})
            channels.append({'sampler': len(samplers) - 1, 'target': {'node': NAMES.index(n) + 1, 'path': 'translation'}})
    anim_list.append({'name': cname, 'channels': channels, 'samplers': samplers})

# images from the source file (textures are reused as they are)
new_images = []
for im in orig_json.get('images', []):
    src_bv = orig_json['bufferViews'][im['bufferView']]
    data = orig_bin[src_bv.get('byteOffset', 0): src_bv.get('byteOffset', 0) + src_bv['byteLength']]
    bv = add_bytes(data)
    new_images.append({'bufferView': bv, 'mimeType': im['mimeType'], **({'name': im['name']} if 'name' in im else {})})

# nodes: 0 = mesh node, 1.. = bones
nodes = [{'name': 'Goat', 'mesh': 0, 'skin': 0}]
for n in NAMES:
    if PARENT[n]:
        local_t = GBIND[n] - GBIND[PARENT[n]]
    else:
        local_t = GBIND[n]
    node = {'name': n, 'translation': [float(x) for x in local_t]}
    if CHILDREN[n]:
        node['children'] = [NAMES.index(c) + 1 for c in CHILDREN[n]]
    nodes.append(node)
root_bones = [NAMES.index(n) + 1 for n in NAMES if PARENT[n] is None]
scene_nodes = [0] + root_bones

prim = {
    'attributes': {'POSITION': acc_pos, 'NORMAL': acc_nrm, 'TEXCOORD_0': acc_uv,
                   'JOINTS_0': acc_jnt, 'WEIGHTS_0': acc_wgt},
    'indices': acc_idx,
    'material': 0,
}
gltf = {
    'asset': {'version': '2.0', 'generator': 'rig_goat.py (procedural rig on CC BY 4.0 source)'},
    'scene': 0,
    'scenes': [{'nodes': scene_nodes}],
    'nodes': nodes,
    'meshes': [{'name': 'Goat', 'primitives': [prim]}],
    'skins': [{'name': 'GoatSkin', 'joints': list(range(1, len(NAMES) + 1)),
               'skeleton': NAMES.index('hips') + 1, 'inverseBindMatrices': acc_ibm}],
    'animations': anim_list,
    'materials': orig_json.get('materials', []),
    'textures': orig_json.get('textures', []),
    'samplers': orig_json.get('samplers', []),
    'images': new_images,
    'accessors': accs,
    'bufferViews': bviews,
    'buffers': [{'byteLength': len(binary)}],
}
js = json.dumps(gltf, separators=(',', ':')).encode()
js += b' ' * ((-len(js)) % 4)
binary += b'\0' * ((-len(binary)) % 4)
total = 12 + 8 + len(js) + 8 + len(binary)
with open(OUT, 'wb') as f:
    f.write(struct.pack('<III', 0x46546C67, 2, total))
    f.write(struct.pack('<II', len(js), 0x4E4F534A))
    f.write(js)
    f.write(struct.pack('<II', len(binary), 0x004E4942))
    f.write(binary)
print('wrote', OUT, total, 'bytes; bones', len(NAMES), 'clips', [c['name'] for c in anim_list])
