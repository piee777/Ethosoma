#!/usr/bin/env python3
"""FlyWire connectome → compact Three.js point-cloud preprocessor.

Merges the three FlyWire data products in frontend/data/ into a single binary
that the browser can decode without blocking the main thread:

  * coordinates.csv              — true somatic 3D positions (nm, FAFB space)
  * neurons.csv                  — per-cell ``group`` (neuropil) + ``nt_type``
  * consolidated_cell_types.csv  — per-cell ``primary_type`` (cell identity)

Outputs:
  * frontend/data/connectome.bin  — compact binary (positions Float32 +
                                    circuit-tag Uint8), header "FWC1"
  * frontend/data/manifest.json   — circuit & region composition for the HUD

Circuit tags (nice, behaviourally-grounded sub-populations — NOT broad
neurotransmitter buckets). 0 = baseline; the rest are the flashable modules
driven by the temporal calcium transients in the viewer:

  0  Baseline (everything not in a mapped circuit)
  1  LC / LPLC optic-lobe columnar visual projection neurons (looming)
  2  T-series visual columns (medulla/lobula motion columns)
  3  PPL1 aversive dopamine (MB punishment / threat salience)
  4  PAM reward dopamine (MB reinforcement / sugar)
  5  Descending / Giant-Fibre motor neurons (escape output)
  6  OA-VUM* octopaminergic arousal neurons
  7  Central complex (FB / EB / PB) — relay & integration
  8  Gustatory / taste projection neurons (BM_Taste / claw_tpGRN)
  9  AL olfactory receptor neurons (ORN* — antennal sensory input)

Axis alignment (data-driven, deterministic):
  * lateral (widest span) axis → world X → optic lobes extend on ±X
  * dorso-ventral axis (largest calyx-vs-gnathal landmark separation of the
    two remaining axes) → world Y → dorsal (calyx pole) = +Y
  * remaining (A-P) axis → world Z

Coordinate placement: centred at (0,0,0), scaled so the widest span = 2.0
(bounding radius ≈ 1).
"""

import csv
import json
import os
import re
import struct
import sys
from array import array as pyarray
from collections import Counter

DATA_DIR = os.path.join(os.path.dirname(__file__), "..", "frontend", "data")
OUT_BIN = os.path.join(DATA_DIR, "connectome.bin")
OUT_MANIFEST = os.path.join(DATA_DIR, "manifest.json")

T_BASELINE = 0
T_LOOMING = 1       # LC* / LPLC* optic-lobe columnar projection neurons
T_COLUMNS = 2       # T* / Tm* / TmY* / CT* / Tu* visual columns
T_PPL1 = 3          # PPL1* aversive dopamine
T_PAM = 4           # PAM* reward dopamine
T_DESCENDING = 5    # DNp01 / s-CPDN* / APDN* giant-fibre descending
T_OA = 6            # OA-VUM* / OA-VPM* / OA-ASM* / OA-AL* octopamine
T_CENTRAL = 7       # FB / EB / PB central complex
T_TASTE = 8         # BM_Taste / claw_tpGRN / dorsal_tpGRN gustatory
T_AL = 9            # ORN* olfactory receptor neurons — antennal sensory

# Gradient target for each circuit (colour is chosen at render time).
CIRCUIT_NAMES = {
    T_BASELINE: "Baseline",
    T_LOOMING: "LC/LPLC Visual Projection",
    T_COLUMNS: "T-series Visual Columns",
    T_PPL1: "PPL1 Aversive Dopamine",
    T_PAM: "PAM Reward Dopamine",
    T_DESCENDING: "Giant-Fibre / Descending",
    T_OA: "OA-VUM Octopaminergic Arousal",
    T_CENTRAL: "Central Complex",
    T_TASTE: "Gustatory / Taste",
    T_AL: "AL Olfactory / Antennal Sensory",
}

# Patterns — high specificity first (a neuron gets exactly ONE circuit tag).
LC_RE = re.compile(r"^(LC|LPLC)", re.I)
COLUMNS_RE = re.compile(r"^(T\d|Tm|TmY|CT\d|Tu)", re.I)
DESCENDING_NAMES = {"DNp01"}
DESCENDING_PREFIXES = ("s-CPDN", "APDN")
OA_PREFIXES = ("OA-",)
CENTRAL_COMPLEX_TOKENS = {"FB", "EB", "PB"}
GUSTATORY_NAMES = {"BM_Taste", "claw_tpGRN", "dorsal_tpGRN"}

REGION_NAMES = {
    "ME": "Medulla (optic)", "LO": "Lobula (optic)", "LA": "Lamina (optic)",
    "LOP": "Lobula Plate (optic)", "MB_CA": "Mushroom Body Calyx",
    "FB": "Fan-Shaped Body", "EB": "Ellipsoid Body", "PB": "Protocerebral Bridge",
    "GNG": "Gnathal Ganglion", "AL": "Antennal Lobe", "LH": "Lateral Horn",
    "AVLP": "Ant. Ventral Lateral Protocerebrum", "SMP": "Sup. Medial Protocerebrum",
    "SLP": "Sup. Lateral Protocerebrum", "PLP": "Posterior Lateral Protocerebrum",
    "SPS": "Sup. Posterior Slope", "IPS": "Inf. Posterior Slope",
    "SAD": "Saddle", "NO": "Noduli", "LAL": "Lateral Accessory Lobe",
    "CRE": "Crepine", "OCG": "Optic Glomerulus", "ICL": "Inferior Clamp",
    "PRW": "Prow", "IB": "Inferior Bridge", "SCL": "Superior Clamp",
    "WED": "Wedge", "VES": "Vest", "SIP": "Superior Intermediate Protocerebrum",
    "FLA": "Flange", "PVLP": "Post. Ventral Lateral Protocerebrum",
    "AMMC": "Antenna Mechanosensory & Motor Ctr",
    "ATL": "Anterolateral Protocerebrum", "BU": "Bulb", "CAN": "Cantal",
    "AME": "AME", "EPA": "Epaulette", "GA": "GA", "GOR": "Gorilla",
    "MB_ML": "Mushroom Body Medial Lobe",
    "MB_VL": "Mushroom Body Vertical Lobe", "MB_PED": "Mushroom Body Peduncle",
    "AOTU": "Anterior Optic Tubercle",
    "NO_CONS": "Unassigned", "UNASGD": "Unassigned",
}


def parse_position(raw):
    return tuple(int(v) for v in raw.strip()[1:-1].split())


def read_coordinates(path):
    """root_id -> first recorded (x, y, z). One soma position per cell."""
    coords = {}
    with open(path, newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            rid = int(row["root_id"])
            if rid not in coords:
                coords[rid] = parse_position(row["position"])
    return coords


def read_cell_types(path):
    """root_id -> primary_type ('' when absent)."""
    out = {}
    with open(path, newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            out[int(row["root_id"])] = row["primary_type"].strip() or ""
    return out


def circuit_for(primary_type, group_token):
    """Primary_type is authoritative; central complex uses the neuropil token."""
    pt = primary_type or ""
    if pt.startswith("PPL1"):
        return T_PPL1
    if pt.startswith("PAM"):
        return T_PAM
    if pt in DESCENDING_NAMES or pt.startswith(DESCENDING_PREFIXES):
        return T_DESCENDING
    if pt.startswith(OA_PREFIXES):
        return T_OA
    if pt in GUSTATORY_NAMES:
        return T_TASTE
    if pt.startswith("ORN"):
        return T_AL
    if LC_RE.match(pt):
        return T_LOOMING
    if COLUMNS_RE.match(pt):
        return T_COLUMNS
    if group_token in CENTRAL_COMPLEX_TOKENS:
        return T_CENTRAL
    return T_BASELINE


def orient_to_world(points, groups):
    """Return (perm, sgn) mapping voxel axes -> world X(lateral)/Y(dorsal)/Z."""
    def spans():
        lo = [min(p[i] for p in points) for i in range(3)]
        hi = [max(p[i] for p in points) for i in range(3)]
        return [hi[i] - lo[i] for i in range(3)]

    sp = spans()
    lateral = sp.index(max(sp))                    # widest = left-right
    rest = [i for i in range(3) if i != lateral]

    def landmark_mean(pred):
        acc = [0.0, 0.0, 0.0]
        cnt = 0
        for p, g in zip(points, groups):
            if pred(g):
                for i in range(3):
                    acc[i] += p[i]
                cnt += 1
        return [a / cnt for a in acc] if cnt else None

    calyx = landmark_mean(lambda g: g == "MB_CA")
    gnathal = landmark_mean(lambda g: g == "GNG")

    if calyx and gnathal:
        a, b = rest
        sep_a = abs(calyx[a] - gnathal[a])
        sep_b = abs(calyx[b] - gnathal[b])
        dv = a if sep_a >= sep_b else b
        dv_sign = 1 if calyx[dv] > gnathal[dv] else -1   # dorsal (calyx) up
    else:
        dv, dv_sign = rest[0], 1
    third = rest[1] if dv == rest[0] else rest[0]
    return (lateral, 1), (dv, dv_sign), (third, 1)


def main():
    coords_path = os.path.join(DATA_DIR, "coordinates.csv")
    neurons_path = os.path.join(DATA_DIR, "neurons.csv")
    ptypes_path = os.path.join(DATA_DIR, "consolidated_cell_types.csv")

    print("reading coordinates …")
    coords = read_coordinates(coords_path)
    print("reading consolidated cell types …")
    ptypes = read_cell_types(ptypes_path)

    print("joining neurons.csv …")
    rows = []                    # (pos3, group_token, circuit_tag)
    region_counts = Counter()
    circuit_counts = Counter()
    with open(neurons_path, newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            rid = int(row["root_id"])
            pos = coords.get(rid)
            if pos is None:
                continue
            group = row["group"].strip()
            group_token = group.split(".")[0]
            circuit = circuit_for(ptypes.get(rid, ""), group_token)
            rows.append((pos, group_token, circuit))
            region_counts[group_token] += 1
            circuit_counts[circuit] += 1

    n = len(rows)
    print(f"joined {n} neurons")

    # ---- axis alignment (optic lobes on X, dorsal up) -----------------------
    points = [r[0] for r in rows]
    groups = [r[1] for r in rows]
    (x_ax, x_sgn), (y_ax, y_sgn), (z_ax, z_sgn) = orient_to_world(points, groups)
    print(f"axis map: X<-(voxel{x_ax})  Y<-(voxel{y_ax},sgn{y_sgn})  Z<-(voxel{z_ax})")

    def to_world(p):
        return (x_sgn * p[x_ax], y_sgn * p[y_ax], z_sgn * p[z_ax])

    world = [to_world(p) for p in points]

    # ---- center + scale so widest span = 2.0 --------------------------------
    lo = [min(p[i] for p in world) for i in range(3)]
    hi = [max(p[i] for p in world) for i in range(3)]
    center = [(lo[i] + hi[i]) / 2 for i in range(3)]
    scale = 2.0 / max(hi[i] - lo[i] for i in range(3))
    print(f"world span: X {hi[0]-lo[0]:.0f} Y {hi[1]-lo[1]:.0f} Z {hi[2]-lo[2]:.0f}")

    px = pyarray("f")
    pc = pyarray("B")
    for r, p in zip(rows, world):
        pos = r[0]
        px.append((x_sgn * pos[x_ax] - center[0]) * scale)
        px.append((y_sgn * pos[y_ax] - center[1]) * scale)
        px.append((z_sgn * pos[z_ax] - center[2]) * scale)
        pc.append(r[2])
    assert len(px) == n * 3 and len(pc) == n

    # ---- export binary ------------------------------------------------------
    with open(OUT_BIN, "wb") as f:
        f.write(b"FWC1")
        f.write(struct.pack("<I", 2))      # version 2 = circuit tags
        f.write(struct.pack("<I", n))
        px.tofile(f)
        pc.tofile(f)
    size_mb = os.path.getsize(OUT_BIN) / (1024 * 1024)
    print(f"wrote {OUT_BIN}  ({n} neurons, {size_mb:.2f} MB)")

    # ---- export manifest -----------------------------------------------------
    regions = sorted(
        ({"token": t, "name": REGION_NAMES.get(t, t), "count": c,
          "pct": round(100.0 * c / n, 1)} for t, c in region_counts.items()),
        key=lambda r: -r["count"],
    )
    circuits = {
        CIRCUIT_NAMES[k]: v for k, v in sorted(circuit_counts.items())
    }
    manifest = {"total": n, "scale": scale, "circuits": circuits, "regions": regions}
    with open(OUT_MANIFEST, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=1)
    print("wrote", OUT_MANIFEST)

    print("\ncircuit composition:")
    for k, v in sorted(circuit_counts.items()):
        print(f"  tag {k} ({CIRCUIT_NAMES[k]:34s}) {v:6d}  {100.0*v/n:.2f}%")

    print("\ntop regions:")
    for r in regions[:10]:
        print(f"  {r['token']:12s} {r['name']:38s} {r['count']:6d}  {r['pct']:.1f}%")


if __name__ == "__main__":
    sys.exit(main())