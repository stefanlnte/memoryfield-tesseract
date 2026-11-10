/* Memoryfield shared code: Supabase client, dates, small helpers.
   Works in the browser (window.MF) and in Node (module.exports) for tests. */
(function (root) {
  "use strict";

  // ------------------------------------------------------------------ helpers
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmt = (x, d = 2) => (x === null || x === undefined || Number.isNaN(x) ? "—" : Number(x).toFixed(d));
  const isoFromDays = (days) => new Date(days * 86400000).toISOString().slice(0, 10);
  const daysFromIso = (iso) => Math.round(Date.parse(iso + "T00:00:00Z") / 86400000);
  const yearOf = (iso) => Number(String(iso).slice(0, 4));

  function client() {
    const cfg = root.MF_CONFIG || {};
    if (!root.supabase || !cfg.url || cfg.url.includes("YOUR-PROJECT")) return null;
    return root.supabase.createClient(cfg.url, cfg.anonKey);
  }

  // ------------------------------------------------------------------ statistics
  function pearson(xs, ys) {
    const n = Math.min(xs.length, ys.length);
    if (n < 3) return null;
    let mx = 0, my = 0;
    for (let i = 0; i < n; i++) { mx += xs[i]; my += ys[i]; }
    mx /= n; my /= n;
    let sxy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < n; i++) { const a = xs[i] - mx, b = ys[i] - my; sxy += a * b; sxx += a * a; syy += b * b; }
    return sxx && syy ? sxy / Math.sqrt(sxx * syy) : null;
  }

  const MF = { esc, fmt, isoFromDays, daysFromIso, yearOf, client, pearson };
  root.MF = MF;
  if (typeof module !== "undefined" && module.exports) module.exports = MF;
})(typeof window !== "undefined" ? window : globalThis);
