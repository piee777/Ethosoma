<p align="center"><img src="frontend/assets/whitelogo.png" width="220" alt="Ethosoma Logo"/></p>

# Ethosoma — Drosophila Connectome Digital Twin

<p align="center">
  <a href="https://ethosoma.dpdns.org"><img src="https://img.shields.io/badge/live-webapp-blue?style=flat-square" alt="Live domain"/></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green?style=flat-square" alt="License"/></a>
</p>

**Ethosoma** is an in-silico ethological twin of the adult female *Drosophila melanogaster* brain: the complete FlyWire FAFB v14.1 reconstruction — 139,255 proofread somas resolved from serial-section electron microscopy — mounted inside a real-time WebGL brain simulator and coupled to a computational-allostasis engine governed by socio-economic stress dynamics.

Where classic connectomics freezes the wiring diagram, Ethosoma *runs* it. Neuromodulatory state (PAM reward dopamine, PPL1 aversive dopamine, octopaminergic arousal, serotonin, sleep pressure, circadian phase) is continuously integrated against an exogenous stressor layer — heat, queues, deadlines, inflation, kinship obligations — and rendered as travelling GCaMP-style calcium transients across the real circuit modules: optic columns, mushroom-body valence, and central-complex action selection.

## Key Features

- **Neural network topologies** — Every subsystem inherits its exact soma counts from the FAFB reconstruction: 81,324 medulla + lobula optic-lobe cells, 42,027 T-series motion columns, 4,657 mushroom-body calyx Kenyon cells, 2,196 central-complex integrators, rendered as a 139,255-GPU-point volumetric cloud at 4×4×40 nm voxel fidelity (JRC2018U space).
- **Allostatic phase space** — A six-state adult-female ethogram (locomotion, grooming, quiescence, escape, depressive freeze, economic-quiescence/metabolic deprivation freeze) driven by a forced slow–fast hybrid dynamical system with saddle-node fold bifurcations, epigenetic kindling, and path-dependent bio-energetic strain.
- **Live parametric tuning** — Nudge the neuromodulatory population vector and environmental stressor mix in-browser and watch the basin of attraction deform: activation thresholds, allostatic scarring, and economic-quiescence latching all respond interactively.
- **WebGL 2 interactive brain simulation** — Hardware-accelerated Three.js pipeline with traveling-wave stimuli, circuit-module telemetry, and optogenetics-compatible calcium envelopes at 60 fps.

## Local Setup

```bash
git clone https://github.com/piee777/ethosoma.git
cd ethosoma
```

No package installation is required — the engine is written in dependency-free ES modules and Three.js (v0.160) is served via import map. You only need Python 3 (standard library) or any static-file server.

```bash
# Option A — Ethosoma dev server (serves frontend/ + models/, correct MIME + CORS)
python3 backend/server.py --port 8000

# Option B — plain static server from the frontend tree
python3 -m http.server 8000 -d frontend
```

Then open **http://localhost:8000** — the landing page (research methodology) and **Launch Simulation Studio** (interactive twin) are both served from the same origin.

## Repository Layout

```
backend/server.py      Threaded HTTP server (CORS + MIME-correct, traversal-safe)
frontend/              Landing page (index.html) + simulation studio (app.html)
frontend/data/         Connectome binary + FAFB neuron / coordinate tables
frontend/assets/       Brand assets & anatomy renders
models/fly_brain.obj   Whole-brain anatomical mesh
scripts/ , tools/      Connectome processing & render utilities
```

## Data & Attribution

Connectome, annotations, and cell-type taxonomy derive from the 2024 *Nature* whole-brain reconstructions of the FlyWire consortium ([Dorkenwald et al.](https://doi.org/10.1038/s41586-024-07558-y), [Schlegel et al.](https://doi.org/10.1038/s41586-024-07686-5)). See the in-app Citations section for full attribution.

## License

Copyright (c) 2026 Adel Benaissa. All rights reserved. — released under the [MIT License](LICENSE).

## Live Deployment

**Ethosoma is now live at [https://ethosoma.dpdns.org](https://ethosoma.dpdns.org)** — the landing page and the interactive Simulation Studio are both deployed and publicly accessible.