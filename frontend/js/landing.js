/**
 * Ethosoma — Drosophila Neural Model (landing page)
 * Copyright (c) 2026 Adel Benaissa. All rights reserved.
 * MIT License — see LICENSE in the repository root.
 */
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function formatCount(v) { return Math.round(v).toLocaleString("en-US"); }

function countUp(el) {
  const target = parseInt(el.dataset.count, 10) || 0;
  if (reducedMotion || !target) {
    el.textContent = formatCount(target);
    return;
  }
  const dur = 1400;
  const t0 = performance.now();
  const tick = (now) => {
    const p = Math.min(1, (now - t0) / dur);
    const e = 1 - Math.pow(1 - p, 3);
    el.textContent = formatCount(target * e);
    if (p < 1) requestAnimationFrame(tick);
    else el.textContent = formatCount(target);
  };
  requestAnimationFrame(tick);
}

const statNums = document.querySelectorAll(".stat-num[data-count]");
if ("IntersectionObserver" in window) {
  const io = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        countUp(entry.target);
        io.unobserve(entry.target);
      }
    }
  }, { threshold: 0.35 });
  statNums.forEach((el) => io.observe(el));
} else {
  statNums.forEach(countUp);
}

const revealEls = document.querySelectorAll(".reveal");
if (revealEls.length && "IntersectionObserver" in window && !reducedMotion) {
  const io = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        entry.target.classList.add("is-in");
        io.unobserve(entry.target);
      }
    }
  }, { threshold: 0.18 });
  revealEls.forEach((el) => io.observe(el));
} else if (revealEls.length) {
  revealEls.forEach((el) => el.classList.add("is-in"));
}
