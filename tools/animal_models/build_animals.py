"""
Generate smooth, organic animal meshes for the game.

Each body part is a signed-distance field built from ellipsoids and capsules,
blended with a smooth union, then meshed with marching cubes. Parts are written
to one GLB per species, each mesh named "<part>|<label>" and vertex-coloured.
A JSON sidecar gives each part's bone pivot in model space. The game reads both
and rebuilds the skeleton and clips in code (src/render/proceduralRig.ts).

Model space: x forward (head side), y up, z lateral. The game rotates the model
to face +Z when it rigs it.

Run:  /tmp/meshenv/bin/python tools/animal_models/build_animals.py <species|all> <outdir>
"""
import json
import os
import sys

import numpy as np
import trimesh
from skimage.measure import marching_cubes

HERE = os.path.dirname(os.path.abspath(__file__))
MORPH = json.load(open(os.path.join(HERE, "morph.json")))


# ---------- signed distance primitives (model space) ----------

def ellipsoid(p, c, r):
    q = (p - c) / r
    k0 = np.linalg.norm(q, axis=-1)
    k1 = np.linalg.norm(q / r, axis=-1)
    k1 = np.maximum(k1, 1e-9)
    return k0 * (k0 - 1.0) / k1


def capsule(p, a, b, r):
    pa = p - a
    ba = b - a
    h = np.clip((pa @ ba) / (ba @ ba), 0.0, 1.0)
    return np.linalg.norm(pa - h[..., None] * ba, axis=-1) - r


def smin(a, b, k):
    h = np.clip(0.5 + 0.5 * (b - a) / k, 0.0, 1.0)
    return b * (1 - h) + a * h - k * h * (1 - h)


def shape_sd(p, shape):
    kind = shape[0]
    if kind == "ell":
        return ellipsoid(p, np.array(shape[1]), np.array(shape[2]))
    if kind == "cap":
        return capsule(p, np.array(shape[1]), np.array(shape[2]), shape[3])
    raise ValueError(kind)


def shape_bounds(shape):
    if shape[0] == "ell":
        c, r = np.array(shape[1]), np.array(shape[2])
        return c - r, c + r
    a, b, r = np.array(shape[1]), np.array(shape[2]), shape[3]
    return np.minimum(a, b) - r, np.maximum(a, b) + r


def shape_min_radius(shape):
    if shape[0] == "ell":
        return float(np.min(shape[2]))
    return float(shape[3])


def mesh_part(shapes, k, label_h=None):
    """Smooth-union the shapes, return a trimesh (model space) or None."""
    lo = np.min([shape_bounds(s)[0] for s in shapes], axis=0)
    hi = np.max([shape_bounds(s)[1] for s in shapes], axis=0)
    h = label_h or max(0.0018, min(shape_min_radius(s) for s in shapes) / 3.5)
    pad = 3 * h + k
    lo = lo - pad
    hi = hi + pad
    axes = [np.arange(lo[i], hi[i], h) for i in range(3)]
    gx, gy, gz = np.meshgrid(*axes, indexing="ij")
    pts = np.stack([gx, gy, gz], axis=-1)
    d = None
    for s in shapes:
        sd = shape_sd(pts, s)
        d = sd if d is None else smin(d, sd, k)
    if d.min() > 0 or d.max() < 0:
        return None
    verts, faces, _, _ = marching_cubes(d, level=0.0, spacing=(h, h, h))
    verts = verts + lo
    m = trimesh.Trimesh(vertices=verts, faces=faces, process=True)
    m.fix_normals()
    return m


def colour(rgb):
    return [int(round(np.clip(c, 0, 1) * 255)) for c in rgb] + [255]


def jitter(rgb, amount, seed):
    rng = np.random.default_rng(seed)
    return [float(np.clip(c * (1 + rng.uniform(-amount, amount)), 0, 1)) for c in rgb]


# ---------- species ----------

def rabbit_parts(m):
    L, G, S, H = m["bodyLength"], m["bodyGirth"], m["standHeight"], m["headSize"]
    fur, belly, accent, eye = m["fur"], m["belly"], m["accent"], m["eye"]
    leg = [c * 0.8 for c in fur]
    nose = [0.86, 0.55, 0.55]
    neck = (L * 0.36, S + G * 0.15, 0.0)
    head = (L * 0.5 + H * 0.2, S + G * 0.3 + H * 0.15, 0.0)
    tail = (-L * 0.5, S, 0.0)

    bones = {
        "body": (0.0, S, 0.0),
        "head": neck,
        "tail": tail,
        "earL": (head[0] - H * 0.15, head[1] + H * 0.6, -H * 0.3),
        "earR": (head[0] - H * 0.15, head[1] + H * 0.6, H * 0.3),
        "legFL": (L * 0.3, S - G * 0.4, -G * 0.4),
        "legFR": (L * 0.3, S - G * 0.4, G * 0.4),
        "legRL": (-L * 0.22, S - G * 0.1, -G * 0.5),
        "legRR": (-L * 0.22, S - G * 0.1, G * 0.5),
    }

    parts = []
    # Torso: one blended surface, so there are no visible sphere seams.
    parts.append(("body", "torso", fur, 0.035, [
        ("ell", (0.0, S, 0.0), (L * 0.36, G * 0.6, G * 0.64)),
        ("ell", (-L * 0.18, S + G * 0.04, 0.0), (L * 0.26, G * 0.66, G * 0.7)),
        ("ell", (L * 0.22, S - G * 0.03, 0.0), (L * 0.2, G * 0.5, G * 0.52)),
    ]))
    parts.append(("body", "belly", belly, 0.03, [
        ("ell", (L * 0.02, S - G * 0.34, 0.0), (L * 0.3, G * 0.3, G * 0.4)),
    ]))
    parts.append(("head", "skull", fur, 0.04, [
        ("cap", neck, (head[0] - H * 0.05, head[1] - H * 0.05, 0.0), H * 0.52),
        ("ell", head, (H * 0.9, H * 0.78, H * 0.72)),
        ("ell", (head[0] + H * 0.08, head[1] - H * 0.25, 0.0), (H * 0.5, H * 0.42, H * 0.5)),
        ("ell", (head[0] + H * 0.7, head[1] - H * 0.18, 0.0), (H * 0.42, H * 0.34, H * 0.36)),
    ]))
    parts.append(("head", "nose", nose, 0.02, [
        ("ell", (head[0] + H * 1.1, head[1] - H * 0.1, 0.0), (H * 0.13, H * 0.11, H * 0.13)),
    ]))
    for side in (-1, 1):
        z = side * H * 0.6
        parts.append(("head", f"eye{side}", eye, 0.01, [
            ("ell", (head[0] + H * 0.46, head[1] + H * 0.14, z), (H * 0.17, H * 0.17, H * 0.17)),
        ]))
    for side, name in ((-1, "earL"), (1, "earR")):
        z = side * H * 0.3
        parts.append((name, "ear", fur, 0.03, [
            ("ell", (head[0] - H * 0.15, head[1] + H * 1.0, z), (H * 0.2, H * 1.15, H * 0.1)),
        ]))
        parts.append((name, "inner", accent, 0.02, [
            ("ell", (head[0] - H * 0.13, head[1] + H * 0.95, z + side * H * 0.07), (H * 0.09, H * 0.95, H * 0.03)),
        ]))
    for side, name in ((-1, "legFL"), (1, "legFR")):
        z = side * G * 0.4
        parts.append((name, "leg", leg, 0.03, [
            ("cap", (L * 0.3, S - G * 0.4, z), (L * 0.34, 0.03, z), G * 0.13),
        ]))
    for side, name in ((-1, "legRL"), (1, "legRR")):
        z = side * G * 0.5
        hip = (-L * 0.22, S - G * 0.1, z)
        parts.append((name, "thigh", fur, 0.03, [
            ("ell", hip, (G * 0.42, G * 0.46, G * 0.36)),
            ("cap", hip, (-L * 0.12, 0.05, z), G * 0.14),
            ("ell", (-L * 0.08, 0.05, z), (L * 0.2, G * 0.1, G * 0.2)),
        ]))
    parts.append(("tail", "scut", belly, 0.02, [
        ("ell", (-L * 0.52, S + G * 0.05, 0.0), (G * 0.3, G * 0.3, G * 0.3)),
    ]))
    return bones, parts


def deer_parts(m):
    L, G, S, H = m["bodyLength"], m["bodyGirth"], m["standHeight"], m["headSize"]
    fur, belly, accent, eye = m["fur"], m["belly"], m["accent"], m["eye"]
    leg = [c * 0.78 for c in fur]
    rump = [0.93, 0.91, 0.85]
    neck = (L * 0.36, S + G * 0.2, 0.0)
    head = (L * 0.66, S + G * 0.85, 0.0)
    tail = (-L * 0.5, S + G * 0.3, 0.0)

    bones = {
        "body": (0.0, S, 0.0),
        "head": neck,
        "tail": tail,
        "earL": (head[0] - H * 0.25, head[1] + H * 0.15, -H * 0.35),
        "earR": (head[0] - H * 0.25, head[1] + H * 0.15, H * 0.35),
        "legFL": (L * 0.32, S - G * 0.3, -G * 0.36),
        "legFR": (L * 0.32, S - G * 0.3, G * 0.36),
        "legRL": (-L * 0.3, S - G * 0.3, -G * 0.36),
        "legRR": (-L * 0.3, S - G * 0.3, G * 0.36),
    }

    parts = []
    # Barrel body, deeper at the chest.
    parts.append(("body", "barrel", fur, 0.04, [
        ("ell", (0.0, S, 0.0), (L * 0.42, G * 0.5, G * 0.52)),
        ("ell", (L * 0.22, S - G * 0.02, 0.0), (L * 0.22, G * 0.46, G * 0.5)),
    ]))
    parts.append(("body", "belly", belly, 0.03, [
        ("ell", (L * 0.02, S - G * 0.3, 0.0), (L * 0.3, G * 0.28, G * 0.36)),
    ]))
    parts.append(("body", "rump", rump, 0.02, [
        ("ell", (-L * 0.42, S + G * 0.02, 0.0), (L * 0.12, G * 0.36, G * 0.5)),
    ]))
    # Long neck and narrow head.
    parts.append(("head", "neckHead", fur, 0.04, [
        ("cap", neck, head, G * 0.4),
        ("ell", head, (H * 0.85, H * 0.5, H * 0.5)),
        ("ell", (head[0] + H * 0.55, head[1] - H * 0.18, 0.0), (H * 0.9, H * 0.42, H * 0.4)),
    ]))
    parts.append(("head", "nose", accent, 0.02, [
        ("ell", (head[0] + H * 1.1, head[1] - H * 0.25, 0.0), (H * 0.32, H * 0.28, H * 0.3)),
    ]))
    for side in (-1, 1):
        parts.append(("head", f"eye{side}", eye, 0.01, [
            ("ell", (head[0] + H * 0.2, head[1] + H * 0.22, side * H * 0.42), (H * 0.12, H * 0.12, H * 0.12)),
        ]))
        # Antlers: a beam with two tines on each side.
        root = (head[0] - H * 0.2, head[1] + H * 0.45, side * H * 0.22)
        tip = (root[0] - H * 0.3, root[1] + H * 2.0, side * H * 0.5)
        parts.append(("head", f"antler{side}", accent, 0.02, [("cap", root, tip, H * 0.1)]))
        for t in (0.45, 0.7):
            at = tuple(root[i] + (tip[i] - root[i]) * t for i in range(3))
            tine = (at[0] + H * 0.55, at[1] + H * 0.45, at[2] + side * H * 0.12)
            parts.append(("head", f"tine{side}{t}", accent, 0.02, [("cap", at, tine, H * 0.06)]))
    for side, name in ((-1, "earL"), (1, "earR")):
        parts.append((name, "ear", fur, 0.03, [
            ("ell", (head[0] - H * 0.25, head[1] + H * 0.3, side * H * 0.7), (H * 0.14, H * 0.55, H * 0.3)),
        ]))
    for side, name in ((-1, "legFL"), (1, "legFR")):
        z = side * G * 0.36
        parts.append((name, "leg", leg, 0.03, [("cap", (L * 0.32, S - G * 0.3, z), (L * 0.34, 0.02, z), G * 0.1)]))
    for side, name in ((-1, "legRL"), (1, "legRR")):
        z = side * G * 0.36
        parts.append((name, "leg", leg, 0.03, [("cap", (-L * 0.3, S - G * 0.3, z), (-L * 0.32, 0.02, z), G * 0.1)]))
    parts.append(("tail", "stub", belly, 0.02, [
        ("ell", (-L * 0.52, S + G * 0.24, 0.0), (G * 0.12, G * 0.14, G * 0.12)),
    ]))
    return bones, parts


SPECIES = {"rabbit": rabbit_parts, "deer": deer_parts}


def build(key, outdir):
    m = MORPH[key]
    bones, parts = SPECIES[key](m)
    scene = trimesh.Scene()
    for i, (part, label, rgb, k, shapes) in enumerate(parts):
        mesh = mesh_part(shapes, k)
        if mesh is None:
            print("skip empty", part, label)
            continue
        mesh.visual.vertex_colors = np.tile(np.array(colour(jitter(rgb, 0.04, i + 1)), dtype=np.uint8), (len(mesh.vertices), 1))
        scene.add_geometry(mesh, node_name=f"{part}|{label}", geom_name=f"{part}|{label}")
    os.makedirs(outdir, exist_ok=True)
    glb = os.path.join(outdir, f"{key}.glb")
    scene.export(glb)
    sidecar = os.path.join(outdir, f"{key}.json")
    json.dump({"bones": {k: list(v) for k, v in bones.items()}, "standHeight": m["standHeight"]}, open(sidecar, "w"), indent=1)
    print("WROTE", glb, os.path.getsize(glb), "bytes;", sidecar)


if __name__ == "__main__":
    which = sys.argv[1]
    outdir = sys.argv[2]
    for key in (SPECIES.keys() if which == "all" else [which]):
        build(key, outdir)
