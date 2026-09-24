#!/usr/bin/env python3
"""Render the authentic FlyWire FAFB connectome as a publication-grade frontal
(fronto-dorsal) figure straight from the real data files:

    neurons.csv       root_id -> neuropil group token   (139,255 rows)
    coordinates.csv   root_id -> FAFB voxel position     (superset rows)

Join by root_id, classify each soma into an anatomical family, project with
orthographic fronto-dorsal tilt, paint an additive point cloud at 2x, then
apply a log-compressed tone map (no white burn-out), volumetric shading and a
soft baked alpha feather. Output is RGBA on black for my-style screen blending.

Design intent (Principal Design Systems):
  * no bloom / additive white passes — deep indigo, cyan, subtle violet and
    muted magenta clusters with clean contrast
  * anatomical proportions preserved; volumetric 3D presence via dorsal light,
    anterior depth boost and depth-modulated point size
  * seamless fringe fade: alpha envelope derived from the point density, so no
    mask cutout or dark oval is ever visible
Output: frontend/assets/connectome-anatomy-frontal.png
"""
import csv
import re
import numpy as np
from PIL import Image, ImageFilter

DATA = "frontend/data"
OUT = "frontend/assets/connectome-anatomy-frontal.png"

W, H = 1180, 680          # final figure size (fronto-dorsal, natural aspect)
SS = 2                    # supersample factor
LIGHT = True              # light academic render: colored ink on paper
INK_SAT = 0.92            # ink depth strength for the light render
AX = 1.06
AZ_TILT = 22.0            # fronto-dorsal tilt for volumetric presence
FIT = 0.50                # width-fit fraction of the frame

# --- anatomical family classification -----------------------------------
OPTIC = ("ME", "LO", "LOP", "LA", "AOTU", "OCG", "AME")
MB = ("MB_CA", "MB_ML", "MB_VL", "MB_PED")
CC = ("EB", "FB", "PB", "NO", "IB")


def family(group):
    parts = {p for p in group.split(".") if p}
    if not parts:
        return "OTHER"
    if parts & set(MB):
        return "MB"
    if parts & set(CC):
        return "CC"
    if parts & set(OPTIC):
        return "OPTIC"
    if group == "AL":
        return "ANT"
    if group == "GNG":
        return "VENT"
    return "OTHER"


# per-token optic sub-hues (indigo / cyan / violet / magenta)
OPT_HUE = {"ME": "ind", "LA": "cyn", "LO": "vio", "LOP": "mag",
           "AOTU": "ind", "OCG": "ind", "AME": "ind"}
PAL = {
    "ind":  np.array([0.18, 0.31, 0.58]),   # deep indigo   (medulla bulk)
    "cyn":  np.array([0.16, 0.60, 0.80]),   # cyan          (lamina ring)
    "vio":  np.array([0.34, 0.30, 0.64]),   # subtle violet (lobula)
    "mag":  np.array([0.56, 0.30, 0.60]),   # muted magenta (lobula plate)
    "cc":   np.array([0.56, 0.42, 0.82]),   # violet        (central complex)
    "mb-c": np.array([0.22, 0.66, 0.84]),   # cyan          (calyces)
    "mb-l": np.array([0.20, 0.46, 0.62]),   # dim green-cyan (ped/lobes)
    "ant":  np.array([0.74, 0.34, 0.68]),   # muted magenta (antennal lobes)
    "vent": np.array([0.22, 0.24, 0.40]),   # deep slate    (gnathal)
    "oth":  np.array([0.14, 0.19, 0.36]),   # deep indigo   (medial neuropil)
}


def hue_for(group, fam):
    if fam == "OPTIC":
        for t in group.split("."):
            if t in OPT_HUE:
                return PAL[OPT_HUE[t]]
        return PAL["ind"]
    if fam == "MB":
        if "MB_CA" in group.split("."):
            return PAL["mb-c"]
        return PAL["mb-l"]
    if fam == "CC":
        return PAL["cc"]
    if fam == "ANT":
        return PAL["ant"]
    if fam == "VENT":
        return PAL["vent"]
    return PAL["oth"]


# --- load data ------------------------------------------------------------
print("reading neurons.csv ...")
families = {}
raw = {}
with open(f"{DATA}/neurons.csv") as f:
    for row in csv.DictReader(f):
        g = (row["group"] or "").strip()
        raw[row["root_id"]] = g
        families[row["root_id"]] = family(g)

print("reading coordinates.csv ...")
pos = {}
n_parsed = 0
pat = re.compile(r"\[(-?\d+)\s+(-?\d+)\s+(-?\d+)\]")
with open(f"{DATA}/coordinates.csv") as f:
    for row in csv.DictReader(f):
        m = pat.search(row["position"])
        if not m:
            continue
        pos[row["root_id"]] = (int(m.group(1)), int(m.group(2)), int(m.group(3)))
        n_parsed += 1

pts, fam, grp = [], [], []
missing = 0
for rid, g in families.items():
    if rid not in pos:
        missing += 1
        continue
    pts.append(pos[rid])
    fam.append(g)
    grp.append(raw[rid])
print(f"joined {len(pts)} somas, missing {missing} coords, parsed {n_parsed}")

pts = np.asarray(pts, dtype=np.float64)
fam = np.asarray(fam)
grp = np.asarray(grp, dtype=object)

cen = pts.mean(axis=0)
pts = pts - cen
rad = np.linalg.norm(pts, axis=1).max()
pts = pts / rad * AX

# --- display axes (FAFB/JRC2018 conventions) ------------------------------
# axis 0 = LR, axis 1 = A-P (+posterior), axis 2 = D-V (−z dorsal)
lr, dv, ap = 0, 2, 1
u = pts[:, lr]                            # right (+)
v = -pts[:, dv]                           # dorsal (+up)
d = -pts[:, ap]                           # anterior (+ toward camera)
print("axes: LR=0, D-V=2 (dorsal = -z), A-P=1 (anterior = -y)")

# --- per-soma colour, brightness, size -------------------------------------
n = len(pts)
color = np.empty((n, 3))
for i, g in enumerate(grp):
    color[i] = hue_for(g, fam[i])

# dorsal light + anterior depth boost (volumetric model illumination)
vnorm = (v + AX) / (2 * AX)
dnorm = (d + AX) / (2 * AX)
shade = (0.42 + 1.05 * vnorm) * (0.82 + 0.30 * dnorm)
color *= shade[:, None]

# brightness hierarchy: core modules lift off the medial neuropil
BRI = {
    "OPTIC": 1.00, "CC": 1.70, "MB": 1.55, "ANT": 1.60, "VENT": 0.75, "OTHER": 0.80,
}
for k, b in BRI.items():
    color[fam == k] *= b

BASE_SIZE = {"OPTIC": 1.4, "CC": 2.1, "MB": 1.9, "ANT": 1.8, "VENT": 1.3, "OTHER": 1.25}
size = np.array([BASE_SIZE[k] for k in fam])
size *= 0.72 + 0.5 * dnorm            # nearer somas read slightly larger

# --- project (orthographic, tilt about LR axis, auto-fit) -------------------
theta = np.radians(AZ_TILT)
y2 = v * np.cos(theta) - d * np.sin(theta)
sx, sy = u, y2

W2, H2 = W * SS, H * SS
zf = min(FIT * W2 / np.abs(sx).max(), FIT * H2 / np.abs(sy).max())
sx = sx * zf
sy = sy * zf

cx, cy = W2 / 2, H2 / 2
px = (sx + cx).astype(np.int32)
py = (sy + cy).astype(np.int32)
r2 = np.maximum(1, np.round(size * SS).astype(np.int32))

ok = (px - r2 > 0) & (px + r2 < W2) & (py - r2 > 0) & (py + r2 < H2)
print(f"painting {ok.sum()} of {n} points")

for k in BRI:
    m = fam == k
    if m.sum() == 0:
        continue
    print(f"  {k:6s} n={m.sum():6d}  cx={px[m].mean():6.0f} cy={py[m].mean():6.0f}"
          f"  x[{px[m].min()},{px[m].max()}] y[{py[m].min()},{py[m].max()}]")

# --- paint additive point cloud at 2x ----------------------------------------
canvas = np.zeros((H2, W2, 3), dtype=np.float64)
rr0 = r2[ok]
xx0, yy0, cc0 = px[ok], py[ok], color[ok]
for i in range(xx0.size):
    r = rr0[i]
    s = slice(yy0[i] - r, yy0[i] + r + 1), slice(xx0[i] - r, xx0[i] + r + 1)
    canvas[s] += cc0[i]

c = (canvas[0::2, 0::2] + canvas[0::2, 1::2] + canvas[1::2, 0::2] + canvas[1::2, 1::2]) * 0.25

# --- tone map: log-compressed, texture preserved, never clipped flat ---------
logc = np.log1p(c * 3.0)
denom = np.percentile(logc, 99.7)

if LIGHT:
    # painter's ink model: blend the paper tone toward the accumulated ink hue,
    # weighted by log-compressed point density. Hue is preserved (no inversion),
    # dense fiber bundles deepen without white or black burn-out.
    cl = c.max(axis=2)
    tau = np.clip(np.log1p(cl * 3.0) / denom, 0, 1) ** 0.85
    hue = c / (cl[:, :, None] + 1e-9)
    ink = hue * INK_SAT
    paper = np.ones_like(ink)
    img = np.clip(paper * (1 - tau[:, :, None]) + ink * tau[:, :, None], 0, 1)
    img = img ** 0.92
else:
    # dark render: additive emission, faint colour-matched halo, no white pass
    d = np.clip(logc / denom, 0, 1) ** 0.75 * 0.95
    glow = np.asarray(
        Image.fromarray((np.clip(d, 0, 1) * 255).astype(np.uint8), mode="RGB").filter(
            ImageFilter.GaussianBlur(radius=16)
        ),
        dtype=np.float32,
    ) / 255.0
    img = np.clip(d + glow * 0.05, 0, 0.94) ** 0.92

# --- baked alpha feather from point density (no mask, no hard oval) ----------
lum = tau if LIGHT else img.max(axis=2)
env = np.asarray(
    Image.fromarray((np.clip(lum, 0, 1) * 255).astype(np.uint8)).filter(
        ImageFilter.GaussianBlur(radius=34)
    ),
    dtype=np.float32,
) / 255.0
env = env / (env.max() + 1e-9)
alpha = np.clip((env - 0.16) * 2.1, 0, 1)
img = img * (0.30 + 0.70 * alpha)[:, :, None]   # fringe rolls off toward background

# --- write RGBA (alpha feather allows screen- or normal-blend compositing) --
rgb8 = (img * 255).astype(np.uint8)
a8 = (alpha * 255).astype(np.uint8)
out = Image.fromarray(np.dstack([rgb8, a8]), mode="RGBA")
out.save(OUT, "PNG")
print("wrote", OUT, out.size, "max_lum=", f"{img.max():.3f}",
      "white_px=", int((img.min(axis=2) > 0.96).sum()))