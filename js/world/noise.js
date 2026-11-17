

// ============================== Zufall & Rauschen ==============================
/** Deterministischer Zufallsgenerator: Die Welt sieht bei jedem Start gleich aus. */
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hash2(i, j, seed) {
  let h = (Math.imul(i, 374761393) + Math.imul(j, 668265263) + Math.imul(seed, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return ((h & 0xffffff) / 0xffffff) * 2 - 1;
}
/** Value-Noise (−1..1) mit weicher Interpolation. */
function vnoise(x, y, seed = 0) {
  const i = Math.floor(x), j = Math.floor(y), fx = x - i, fy = y - j;
  const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
  const a = hash2(i, j, seed), b = hash2(i + 1, j, seed), c = hash2(i, j + 1, seed), d = hash2(i + 1, j + 1, seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function fbm(x, y, oct, seed = 0) {
  let s = 0, amp = 0.5, f = 1, n = 0;
  for (let o = 0; o < oct; o++) { s += amp * vnoise(x * f, y * f, seed + o * 17); n += amp; amp *= 0.5; f *= 2.03; }
  return s / n;
}
function ridged(x, y, oct, seed = 0) {
  let s = 0, amp = 0.5, f = 1, n = 0;
  for (let o = 0; o < oct; o++) { const r = 1 - Math.abs(vnoise(x * f, y * f, seed + o * 31)); s += amp * r * r; n += amp; amp *= 0.5; f *= 2.07; }
  return s / n;
}
const tick = () => new Promise((r) => setTimeout(r, 0));

export { mulberry32, hash2, vnoise, fbm, ridged, tick };
