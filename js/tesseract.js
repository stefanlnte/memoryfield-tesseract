/* Memoryfield · Tesseract — public view. Reads published data from Supabase (anon key),
   or data/demo.json when Supabase is not configured or ?demo is in the URL. */
(() => {
  "use strict";
  const { esc, fmt, daysFromIso, isoFromDays } = MF;
  const TODAY = new Date().toISOString().slice(0, 10);
  const START = "1789-01-01";
  const $ = (id) => document.getElementById(id);
  const SVGNS = "http://www.w3.org/2000/svg";

  // ================================================================ data sources
  const params = new URLSearchParams(location.search);
  const sb = params.has("demo") ? null : MF.client();

  function supabaseSource(sb) {
    async function all(make, page = 1000) {
      const out = [];
      for (let from = 0; ; from += page) {
        const { data, error } = await make().range(from, from + page - 1);
        if (error) throw new Error(error.message);
        out.push(...data);
        if (data.length < page) return out;
      }
    }
    return {
      mode: "live",
      async base() {
        const [crises, links, cases, runs, forecasts] = await Promise.all([
          all(() => sb.from("crises").select("*").order("onset")),
          all(() => sb.from("crisis_links").select("*")),
          all(() => sb.from("cases").select("*").order("window_start")),
          all(() => sb.from("runs").select("id,case_id,engine_version,status,registered_at,readout_params,vocabulary_version,cutoff,created_at").order("created_at", { ascending: false })),
          all(() => sb.from("forecasts").select("*").order("flagged_on")),
        ]);
        return { crises, links, cases, runs, forecasts };
      },
      readings: (runId) => all(() => sb.from("readings")
        .select("tick,date,b,c,f,phi,phi_smooth,flag,coherence,entropy,energy,persistence").eq("run_id", runId).order("tick")),
      frames: (runId) => all(() => sb.from("frames").select("tick,date,graph").eq("run_id", runId).order("tick"), 200),
      sources: (caseId) => all(() => sb.from("sources")
        .select("id,date,title,url,mentions(node,weight),relations(src,dst,label)").eq("case_id", caseId).order("date").order("id")),
      // Realtime: a push from the workstation ends by touching runs.last_push_at, so one event per upload
      subscribe(onChange, onStatus) {
        const ch = sb.channel("memoryfield-live");
        for (const table of ["crises", "crisis_links", "cases", "runs", "forecasts"]) {
          ch.on("postgres_changes", { event: "*", schema: "public", table }, (p) => onChange(table, p));
        }
        ch.subscribe((status) => onStatus(status));
        return ch;
      },
    };
  }

  function demoSource() {
    let p;
    const get = () => (p = p || fetch("data/demo.json").then((r) => { if (!r.ok) throw new Error("data/demo.json not found"); return r.json(); }));
    return {
      mode: "demo",
      async base() { const d = await get(); return { crises: d.crises, links: d.links, cases: d.cases, runs: d.runs, forecasts: d.forecasts, note: d.note }; },
      async readings(id) { return (await get()).readings[id] || []; },
      async frames(id) { return (await get()).frames[id] || []; },
      async sources(id) { return (await get()).sources[id] || []; },
    };
  }

  const Data = sb ? supabaseSource(sb) : demoSource();

  // ================================================================ state
  const S = { crises: [], links: [], cases: [], runs: [], forecasts: [], runByCase: {}, readings: {}, frames: {}, sources: {},
              caseId: null, date: TODAY, zoom: "full" };

  const runOf = (caseId) => S.runByCase[caseId] || null;
  const caseById = (id) => S.cases.find((c) => c.id === id);
  const crisisById = (id) => S.crises.find((c) => c.id === id);
  function lastAtOrBefore(rows, date) {
    let lo = 0, hi = rows.length - 1, best = null;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (rows[mid].date <= date) { best = rows[mid]; lo = mid + 1; } else hi = mid - 1; }
    return best;
  }
  const kindClass = (k) => (k.includes("political") && k.includes("financial") ? "both" : k.includes("financial") ? "fin" : "pol");
  const KIND_COLOR = { pol: "var(--cyan)", fin: "var(--amber)", both: "var(--violet)" };

  // ================================================================ metrics
  const METRICS = [
    ["coherence", "Field Coherence", "χ", "share of nodes inside the dead band [100, 200]"],
    ["entropy", "Entropy", "Ω", "how evenly pressure is spread (0 = one node holds it all)"],
    ["persistence", "Persistence", "Π", "stability of the ten strongest nodes over the window"],
    ["energy", "Energy", "ε", "total pressure in the field, Σp / 255n"],
    ["phi_smooth", "Seldon Crisis", "Φ", "smoothed Φ(t) = αB + βC + γF"],
  ];
  function renderMetrics() {
    const run = runOf(S.caseId);
    const r = run ? lastAtOrBefore(S.readings[run.id] || [], S.date) : null;
    const theta = run?.readout_params?.theta;
    $("metrics").innerHTML = METRICS.map(([k, name, sym, def]) => {
      const v = r ? r[k] : null;
      const crisis = k === "phi_smooth";
      const hot = crisis && r?.flag;
      return `<div class="metric${crisis ? " crisis" : ""}${hot ? " hot" : ""}" title="${esc(def)}">
        <div class="name">${esc(name)}</div>
        <div class="val">${v === null || v === undefined ? "—" : fmt(v, crisis ? 2 : 3)}<sub>${sym}</sub></div>
        <div class="def">${crisis ? (hot ? "FLAG: Φ above θ for k windows" : theta !== undefined ? `flag when above θ = ${fmt(theta, 2)}` : esc(def)) : esc(def)}</div>
        <div class="bar"><i style="width:${v ? Math.max(0, Math.min(1, v)) * 100 : 0}%"></i></div></div>`;
    }).join("");
  }

  // ================================================================ field
  function hash(s) { let h = 2166136261; for (const c of s) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
  const EDGE_COLOR = { structural: "#c9d6f5", learned: "#2a87a3", contradiction: "#ff5f6d", temporary: "#4d5b7c" };
  const STATE_COLOR = { expansion: "#ffb547", resonance: "#5ee0ff", remanence: "#3c4a6b" };

  function renderField() {
    const svg = $("field");
    const run = runOf(S.caseId);
    const frames = run ? S.frames[run.id] : null;
    const fr = frames ? lastAtOrBefore(frames, S.date) : null;
    if (!fr) {
      svg.innerHTML = `<text x="320" y="220" text-anchor="middle" fill="var(--faint)" font-size="14">${
        !run ? "No published run for this case yet." : frames ? "The run had not started by this date." : "Loading the field…"}</text>`;
      $("field-note").textContent = "";
      return;
    }
    const nodes = [...fr.graph.nodes].sort((a, b) => b.p - a.p || (a.id < b.id ? -1 : 1));
    const n = nodes.length, pos = {};
    nodes.forEach((nd, i) => {
      const r = 195 * (0.1 + 0.9 * (n > 1 ? i / (n - 1) : 0));
      const a = (hash(nd.id) % 3600) / 3600 * Math.PI * 2;
      pos[nd.id] = [320 + r * Math.cos(a), 220 + r * Math.sin(a) * 0.98];
    });
    const edges = fr.graph.edges.filter((e) => pos[e.src] && pos[e.dst]);
    const parts = [];
    parts.push(`<circle cx="320" cy="220" r="205" fill="none" stroke="#16213a"/><circle cx="320" cy="220" r="110" fill="none" stroke="#121c33"/>`);
    for (const e of edges) {
      const [x1, y1] = pos[e.src], [x2, y2] = pos[e.dst];
      parts.push(`<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${EDGE_COLOR[e.type] || "#4d5b7c"}" stroke-opacity="${(0.15 + 0.6 * e.w / 255).toFixed(2)}" stroke-width="${e.type === "structural" ? 1.6 : 1}"/>`);
    }
    for (const nd of [...nodes].reverse()) {
      const [x, y] = pos[nd.id], r = 3 + (nd.p / 255) * 13;
      parts.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r.toFixed(1)}" fill="${STATE_COLOR[nd.state] || "#3c4a6b"}" fill-opacity="0.85" stroke="#070b14" stroke-width="1"><title>${esc(nd.id)} · p ${nd.p} · ${esc(nd.state || "")}${nd.kind ? " · " + esc(nd.kind) : ""}</title></circle>`);
    }
    nodes.slice(0, 10).forEach((nd) => {
      const [x, y] = pos[nd.id], r = 3 + (nd.p / 255) * 13;
      parts.push(`<text x="${(x + r + 4).toFixed(1)}" y="${(y + 4).toFixed(1)}" font-size="11.5" fill="var(--ink)" paint-order="stroke" stroke="#070b14" stroke-width="3">${esc(nd.id)}</text>`);
    });
    svg.innerHTML = parts.join("");
    $("field-note").textContent = `frame ${fr.date} · ${n} strongest nodes`;
  }

  // ================================================================ correlations
  function renderCorrelations() {
    const run = runOf(S.caseId);
    const frames = run ? S.frames[run.id] : null;
    const box = $("correlations");
    if (!frames) { box.innerHTML = `<div class="empty-note">No run to correlate.</div>`; return; }
    const upto = frames.filter((f) => f.date <= S.date).slice(-12);
    if (upto.length < 4) { box.innerHTML = `<div class="empty-note">Needs at least 4 frames before this date.</div>`; return; }
    const top = [...upto.at(-1).graph.nodes].sort((a, b) => b.p - a.p).slice(0, 8).map((n) => n.id);
    const series = Object.fromEntries(top.map((id) => [id, upto.map((f) => f.graph.nodes.find((n) => n.id === id)?.p ?? 0)]));
    const pairs = [];
    for (let i = 0; i < top.length; i++) for (let j = i + 1; j < top.length; j++) {
      const r = MF.pearson(series[top[i]], series[top[j]]);
      if (r !== null) pairs.push([top[i], top[j], r]);
    }
    pairs.sort((a, b) => Math.abs(b[2]) - Math.abs(a[2]));
    box.innerHTML = pairs.slice(0, 6).map(([a, b, r]) => `<div class="pair"><span>${esc(a)}</span><span class="sym">↔</span><span>${esc(b)}</span>
      <span class="r ${r >= 0 ? "pos" : "neg"}">${r >= 0 ? "+" : ""}${fmt(r, 2)}</span></div>`).join("")
      || `<div class="empty-note">No varying pairs yet.</div>`;
  }

  // ================================================================ sources
  function renderSources() {
    const c = caseById(S.caseId);
    const all = c ? S.sources[c.id] : null;
    const box = $("sources");
    if (!c) { box.innerHTML = ""; $("src-count").textContent = ""; return; }
    if (!all) { box.innerHTML = `<div class="empty-note">Loading…</div>`; return; }
    const read = all.filter((s) => s.date <= S.date && (!c.cutoff || s.date < c.cutoff));
    $("src-count").textContent = `${read.length} of ${all.length}`;
    box.innerHTML = read.slice(-12).reverse().map((s) => {
      const who = (s.mentions || []).slice(0, 4).map((m) => esc(m.node)).join(", ");
      const id = s.url ? `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.id)}</a>` : esc(s.id);
      return `<div class="src"><span class="d">${esc(s.date)}</span>${id}${s.title ? ` — ${esc(s.title)}` : ""}<div class="quiet">${who}</div></div>`;
    }).join("") || `<div class="empty-note">Nothing read yet by this date.</div>`;
  }

  // ================================================================ timeline
  const TL = { left: 170, right: 16, axis: 22, stripTop: 34, stripH: 22, rowsTop: 76, rowH: 44 };
  let geom = null;

  function domain() {
    const d1 = daysFromIso(TODAY) + 200;
    if (S.zoom === "case") {
      const c = caseById(S.caseId);
      if (c) {
        let a = daysFromIso(c.window_start), b = daysFromIso(c.window_end || TODAY);
        const cr = crisisById(c.crisis_id);
        if (cr) b = Math.max(b, daysFromIso(cr.onset));
        if (c.cutoff) b = Math.max(b, daysFromIso(c.cutoff));
        const pad = Math.max(20, (b - a) * 0.06);
        return [a - pad, Math.min(d1, b + pad)];
      }
    }
    return [daysFromIso(START), d1];
  }

  function yearTicks(d0, d1, width) {
    const years = (d1 - d0) / 365.25, target = Math.max(4, Math.floor(width / 90));
    const steps = [1, 2, 5, 10, 20, 25, 50, 100];
    const step = steps.find((s) => years / s <= target) || 100;
    const y0 = Math.ceil(Number(isoFromDays(d0).slice(0, 4)) / step) * step;
    const out = [];
    for (let y = y0; daysFromIso(`${String(y).padStart(4, "0")}-01-01`) <= d1; y += step) out.push(y);
    if (years < 3) {   // months when zoomed in close
      const res = [];
      for (let d = d0; d <= d1; d += 1) { const iso = isoFromDays(d); if (iso.endsWith("-01")) res.push(iso); }
      const every = Math.ceil(res.length / target);
      return res.filter((_, i) => i % every === 0).map((iso) => ({ iso, label: iso.slice(0, 7) }));
    }
    return out.map((y) => ({ iso: `${String(y).padStart(4, "0")}-01-01`, label: String(y) }));
  }

  function rows() {
    return [...S.cases].sort((a, b) => (a.role === "forecast") - (b.role === "forecast") || (a.window_start < b.window_start ? -1 : 1));
  }

  function renderTimeline() {
    const svg = $("timeline");
    const width = Math.max(280, Math.floor(svg.parentNode.clientWidth - 28) || 900);
    const narrow = width < 640;
    TL.left = narrow ? 92 : 170;
    TL.rowH = narrow ? 50 : 44;
    const R = rows();
    const height = TL.rowsTop + Math.max(1, R.length) * TL.rowH + 14;
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.setAttribute("height", height);
    const [d0, d1] = domain();
    const W = width - TL.left - TL.right;
    const x = (iso) => TL.left + ((daysFromIso(iso) - d0) / (d1 - d0)) * W;
    const inView = (iso) => { const d = daysFromIso(iso); return d >= d0 && d <= d1; };
    geom = { d0, d1, W, width };
    const P = [];

    // forecast zone
    const fc = S.cases.filter((c) => c.role === "forecast");
    if (fc.length) {
      const fz = fc.map((c) => c.window_start).sort()[0];
      const xa = Math.max(TL.left, x(fz)), xb = Math.min(TL.left + W, x(TODAY));
      if (xb > xa) P.push(`<rect x="${xa}" y="${TL.stripTop - 4}" width="${xb - xa}" height="${height - TL.stripTop}" fill="#ffb547" fill-opacity="0.05"/>
        <text x="${xb - 4}" y="${height - 6}" text-anchor="end" font-size="10.5" fill="var(--amber)" opacity=".8">FORECAST ZONE · experimental</text>`);
    }
    // axis
    for (const t of yearTicks(d0, d1, W)) {
      const xx = x(t.iso);
      P.push(`<line x1="${xx}" x2="${xx}" y1="${TL.axis + 4}" y2="${height - 4}" stroke="#121c33"/>
        <text x="${xx}" y="${TL.axis}" text-anchor="middle" font-size="11" fill="var(--quiet)" font-family="var(--mono)">${t.label}</text>`);
    }
    // today
    if (inView(TODAY)) P.push(`<line x1="${x(TODAY)}" x2="${x(TODAY)}" y1="${TL.stripTop - 6}" y2="${height - 4}" stroke="var(--amber)" stroke-opacity=".5"/>`);
    // crisis strip label
    P.push(`<text x="${TL.left - 10}" y="${TL.stripTop + 15}" text-anchor="end" font-size="11" fill="var(--quiet)" font-family="var(--mono)">${narrow ? "CRISES" : "ALL CRISES"}</text>`);
    P.push(`<line x1="${TL.left}" x2="${TL.left + W}" y1="${TL.stripTop + TL.stripH / 2}" y2="${TL.stripTop + TL.stripH / 2}" stroke="#1f2b45"/>`);
    // links as arcs
    for (const l of S.links) {
      const a = crisisById(l.from_id), b = crisisById(l.to_id);
      if (!a || !b || !(inView(a.onset) || inView(b.onset))) continue;
      const xa = x(a.onset), xb = x(b.onset), h = Math.min(22, 6 + Math.abs(xb - xa) / 4);
      P.push(`<path d="M${xa} ${TL.stripTop} Q ${(xa + xb) / 2} ${TL.stripTop - h} ${xb} ${TL.stripTop}" fill="none" stroke="var(--violet)" stroke-opacity=".7" stroke-dasharray="3 3"><title>${esc(a.name)} ${esc(l.label)} ${esc(b.name)}</title></path>`);
    }
    for (const c of S.crises) {
      if (!inView(c.onset)) continue;
      const xx = x(c.onset), k = kindClass(c.kind || []);
      P.push(`<g class="crisis-hit" data-crisis="${esc(c.id)}"><rect x="${xx - 7}" y="${TL.stripTop - 4}" width="14" height="${TL.stripH + 8}" fill="transparent"/>
        <line x1="${xx}" x2="${xx}" y1="${TL.stripTop}" y2="${TL.stripTop + TL.stripH}" stroke="${KIND_COLOR[k]}" stroke-width="2.5"/>
        <title>${esc(c.onset)} · ${esc(c.name)} (${esc(c.country)}) · ${esc((c.kind || []).join(", "))}${c.date_source ? " · date: " + esc(c.date_source) : ""}</title></g>`);
    }

    // case rows
    if (!R.length) P.push(`<text x="${TL.left}" y="${TL.rowsTop + 20}" font-size="13" fill="var(--faint)">No published cases yet.</text>`);
    R.forEach((c, i) => {
      const top = TL.rowsTop + i * TL.rowH, mid = top + TL.rowH / 2, sel = c.id === S.caseId;
      const run = runOf(c.id), rs = run ? S.readings[run.id] : null;
      const cr = crisisById(c.crisis_id);
      if (sel) P.push(`<rect x="0" y="${top + 2}" width="${width}" height="${TL.rowH - 4}" fill="#0f1d33" rx="6"/>`);
      P.push(`<g class="row-label" data-case="${esc(c.id)}"><rect x="0" y="${top + 2}" width="${TL.left - 6}" height="${TL.rowH - 4}" fill="transparent"/>
        <text x="${TL.left - 10}" y="${mid - 2}" text-anchor="end" font-size="${narrow ? 11.5 : 12.5}" fill="${sel ? "var(--cyan)" : "var(--ink)"}">${esc(c.name.length > (narrow ? 10 : 24) ? c.name.slice(0, narrow ? 9 : 23) + "…" : c.name)}<title>${esc(c.name)}</title></text>
        <text x="${TL.left - 10}" y="${mid + 12}" text-anchor="end" font-size="10.5" fill="var(--quiet)" font-family="var(--mono)">${esc(c.role)}${run ? "" : " · no run"}</text></g>`);
      const ws = c.window_start, we = c.window_end || TODAY;
      if (daysFromIso(we) >= d0 && daysFromIso(ws) <= d1) {
        const xa = Math.max(TL.left, x(ws)), xb = Math.min(TL.left + W, x(we));
        P.push(`<rect x="${xa}" y="${top + 6}" width="${Math.max(2, xb - xa)}" height="${TL.rowH - 12}" fill="#5ee0ff" fill-opacity="0.05" stroke="#1d3550" rx="3"/>`);
      }
      // phi path
      if (rs && rs.length) {
        const vis = rs.filter((r) => inView(r.date));
        const step = Math.max(1, Math.floor(vis.length / 700));
        const pts = vis.filter((_, k) => k % step === 0).map((r) => `${x(r.date).toFixed(1)},${(top + TL.rowH - 8 - r.phi_smooth * (TL.rowH - 16)).toFixed(1)}`);
        if (pts.length > 1) P.push(`<polyline points="${pts.join(" ")}" fill="none" stroke="var(--cyan)" stroke-width="1.5"/>`);
        let lastFlagX = -10;
        for (const r of vis) if (r.flag) { const xx = x(r.date); if (xx - lastFlagX >= 2) { P.push(`<line x1="${xx}" x2="${xx}" y1="${top + TL.rowH - 8}" y2="${top + TL.rowH - 3}" stroke="var(--red)"/>`); lastFlagX = xx; } }
        const first = rs.find((r) => r.flag);
        if (first && cr && first.date < cr.onset && inView(first.date)) {
          const xa = x(first.date), xb = x(cr.onset), days = daysFromIso(cr.onset) - daysFromIso(first.date);
          P.push(`<path d="M${xa} ${top + 5} V ${top + 2} H ${xb} V ${top + 5}" fill="none" stroke="var(--red)" stroke-opacity=".8"/>
            <text x="${(xa + xb) / 2}" y="${top + 1}" text-anchor="middle" font-size="10" fill="var(--red)">lead ${days} days</text>`);
        }
      }
      if (c.cutoff && inView(c.cutoff)) P.push(`<line x1="${x(c.cutoff)}" x2="${x(c.cutoff)}" y1="${top + 4}" y2="${top + TL.rowH - 4}" stroke="var(--amber)" stroke-dasharray="3 3"><title>cutoff ${esc(c.cutoff)}: the engine read nothing from this date on</title></line>`);
      if (cr && inView(cr.onset)) {
        const xx = x(cr.onset);
        P.push(`<rect x="${xx - 5}" y="${mid - 5}" width="10" height="10" transform="rotate(45 ${xx} ${mid})" fill="var(--ink)"><title>${esc(cr.onset)} · ${esc(cr.name)}</title></rect>`);
      }
      for (const f of S.forecasts.filter((f) => f.case_id === c.id && inView(f.flagged_on))) {
        const xx = x(f.flagged_on), col = f.outcome === "crisis" ? "var(--red)" : f.outcome === "no_crisis" ? "var(--green)" : "var(--amber)";
        P.push(`<rect x="${xx - 5}" y="${mid - 5}" width="10" height="10" transform="rotate(45 ${xx} ${mid})" fill="none" stroke="${col}" stroke-width="1.8"><title>forecast flagged ${esc(f.flagged_on)} · recorded ${esc(String(f.registered_at).slice(0, 10))} · ${esc(f.outcome)}</title></rect>`);
      }
    });

    // cursor
    if (inView(S.date)) {
      const xx = x(S.date), lx = Math.max(40, Math.min(width - 40, xx));
      P.push(`<line x1="${xx}" x2="${xx}" y1="${TL.axis + 4}" y2="${height - 2}" stroke="var(--cyan)" stroke-width="1.5"/>
        <rect x="${lx - 38}" y="${height - 16}" width="76" height="15" rx="4" fill="#123447"/>
        <text x="${lx}" y="${height - 5}" text-anchor="middle" font-size="10.5" fill="var(--cyan)" font-family="var(--mono)">${S.date}</text>`);
    }
    svg.innerHTML = P.join("");
    $("zoom-full").classList.toggle("on", S.zoom === "full");
    $("zoom-case").classList.toggle("on", S.zoom === "case");
  }

  function renderTrack() {
    const parts = [];
    for (const c of S.cases) {
      const run = runOf(c.id), rs = run ? S.readings[run.id] : null;
      if (!rs || !rs.length || c.role === "forecast") continue;
      const first = rs.find((r) => r.flag), cr = crisisById(c.crisis_id);
      if (c.role === "control") parts.push(`<span>${esc(c.name)}: ${first ? `<span class="err">false alarm ${esc(first.date)}</span>` : '<span class="ok">no flag</span>'}</span>`);
      else if (cr) parts.push(`<span>${esc(c.name)}: ${first
        ? (first.date < cr.onset ? `<span class="ok">flag ${daysFromIso(cr.onset) - daysFromIso(first.date)} days before onset</span>` : `<span class="err">flag after onset</span>`)
        : '<span class="err">missed (no flag)</span>'}</span>`);
    }
    const fc = S.forecasts, n = (o) => fc.filter((f) => f.outcome === o).length;
    if (fc.length) parts.push(`<span>Forecasts: ${n("pending")} pending · <span class="err">${n("crisis")} crisis came</span> · <span class="ok">${n("no_crisis")} false alarm</span></span>`);
    $("track").innerHTML = parts.length ? `<b>Track record</b> ${parts.join("")}` : "";
  }

  // ================================================================ orchestration
  let raf = 0;
  function renderAll() {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      $("date").textContent = S.date;
      renderMetrics(); renderField(); renderCorrelations(); renderSources(); renderTimeline(); renderTrack();
    });
  }

  async function selectCase(id, { date, zoom } = {}) {
    S.caseId = id;
    $("case").value = id || "";
    const c = caseById(id), run = runOf(id);
    if (zoom) S.zoom = zoom;
    if (date) S.date = date;
    else if (run && S.readings[run.id]?.length) S.date = S.readings[run.id].at(-1).date;
    else if (c) S.date = c.window_end || TODAY;
    const u = new URL(location.href); if (c) u.searchParams.set("case", c.slug); history.replaceState(null, "", u);
    renderAll();
    try {
      if (run && !S.frames[run.id]) { S.frames[run.id] = await Data.frames(run.id); renderAll(); }
      if (c && !S.sources[c.id]) { S.sources[c.id] = await Data.sources(c.id); renderAll(); }
    } catch (e) { banner(e.message, true); }
  }

  function banner(msg, isErr = false) {
    const b = $("banner"); b.hidden = false; b.textContent = msg;
    if (isErr) b.style.borderColor = "var(--red)";
  }

  function dateFromEvent(ev) {
    const svg = $("timeline"), rect = svg.getBoundingClientRect();
    const px = (ev.clientX - rect.left) * (geom.width / rect.width);
    const t = Math.max(0, Math.min(1, (px - TL.left) / geom.W));
    const iso = isoFromDays(Math.round(geom.d0 + t * (geom.d1 - geom.d0)));
    return iso > TODAY ? TODAY : iso;
  }

  function wire() {
    $("case").addEventListener("change", (e) => selectCase(e.target.value));
    $("zoom-full").addEventListener("click", () => { S.zoom = "full"; renderAll(); });
    $("zoom-case").addEventListener("click", () => { S.zoom = "case"; renderAll(); });
    const svg = $("timeline");
    let dragging = false;
    svg.addEventListener("pointerdown", (ev) => {
      const cr = ev.target.closest(".crisis-hit"), row = ev.target.closest(".row-label");
      if (cr) {
        const crisis = crisisById(cr.dataset.crisis);
        const c = S.cases.find((k) => k.crisis_id === crisis.id);
        if (c) selectCase(c.id, { date: isoFromDays(daysFromIso(crisis.onset) - 1), zoom: "case" });
        else { S.date = crisis.onset > TODAY ? TODAY : crisis.onset; renderAll(); }
        return;
      }
      if (row) { selectCase(row.dataset.case, { zoom: "case" }); return; }
      if (!geom) return;
      dragging = true; svg.setPointerCapture(ev.pointerId);
      S.date = dateFromEvent(ev); renderAll();
    });
    svg.addEventListener("pointermove", (ev) => { if (dragging) { S.date = dateFromEvent(ev); renderAll(); } });
    const stop = () => { dragging = false; };
    svg.addEventListener("pointerup", stop); svg.addEventListener("pointercancel", stop);
    window.addEventListener("keydown", (ev) => {
      if (ev.target.closest("select, input, textarea")) return;
      const step = ev.shiftKey ? 30 : 1;
      if (ev.key === "ArrowLeft" || ev.key === "ArrowRight") {
        const d = daysFromIso(S.date) + (ev.key === "ArrowRight" ? step : -step);
        S.date = isoFromDays(Math.min(d, daysFromIso(TODAY))); renderAll(); ev.preventDefault();
      }
    });
    let rt; window.addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(renderAll, 100); });
  }

  // ================================================================ live updates
  let pending = null, changedRuns = new Set();
  function onChange(table, payload) {
    if (table === "runs") { const id = payload.new?.id || payload.old?.id; if (id) changedRuns.add(id); }
    clearTimeout(pending);
    pending = setTimeout(refreshFromDb, 1200);      // several events in a burst → one refresh
  }
  async function refreshFromDb() {
    const runs = changedRuns; changedRuns = new Set();
    let base;
    try { base = await Data.base(); } catch (e) { return; }
    const before = Object.fromEntries(Object.entries(S.runByCase).map(([c, r]) => [c, r.id + "|" + (r.last_push_at || "")]));
    Object.assign(S, { crises: base.crises, links: base.links, cases: base.cases, runs: base.runs, forecasts: base.forecasts, runByCase: {} });
    for (const r of S.runs) if (!S.runByCase[r.case_id]) S.runByCase[r.case_id] = r;
    const stale = Object.entries(S.runByCase).filter(([c, r]) => runs.has(r.id) || before[c] !== r.id + "|" + (r.last_push_at || ""));
    await Promise.all(stale.map(async ([caseId, r]) => {
      S.readings[r.id] = await Data.readings(r.id);
      delete S.frames[r.id]; delete S.sources[caseId];
    })).catch(() => {});
    fillCaseSelect();
    if (!S.cases.some((c) => c.id === S.caseId)) S.caseId = S.cases.find((c) => runOf(c.id))?.id || S.cases[0]?.id || null;
    await selectCase(S.caseId, { date: S.date, zoom: S.zoom });
    document.querySelector(".timeline-panel")?.classList.remove("flash");
    void document.body.offsetWidth;
    document.querySelector(".timeline-panel")?.classList.add("flash");
  }
  function fillCaseSelect() {
    $("case").innerHTML = S.cases.length ? S.cases.map((c) => `<option value="${esc(c.id)}">${esc(c.name)} · ${esc(c.role)}</option>`).join("")
      : `<option value="">no published cases</option>`;
    if (S.caseId) $("case").value = S.caseId;
  }

  async function start() {
    wire();
    if (Data.mode === "demo") banner(!MF.client() ? "Demo mode: Supabase is not configured yet (js/config.js). The run shown is fictional; the crisis dates are a small sample list."
                                                   : "Demo mode (?demo in the URL). The run shown is fictional; the crisis dates are a small sample list.");
    let base;
    try { base = await Data.base(); }
    catch (e) { banner(`Could not load data: ${e.message}`, true); return; }
    Object.assign(S, { crises: base.crises, links: base.links, cases: base.cases, runs: base.runs, forecasts: base.forecasts });
    for (const r of S.runs) if (!S.runByCase[r.case_id]) S.runByCase[r.case_id] = r;   // newest published run per case
    fillCaseSelect();
    if (Data.subscribe) {
      Data.subscribe(onChange, (status) => {
        const el = $("live"); if (!el) return;
        const on = status === "SUBSCRIBED";
        el.className = "live" + (on ? " on" : "");
        el.textContent = on ? "● live" : status === "CLOSED" ? "○ offline" : "○ reconnecting";
      });
    } else { const el = $("live"); if (el) el.textContent = "demo data"; }
    await Promise.all(Object.values(S.runByCase).map(async (r) => { S.readings[r.id] = await Data.readings(r.id); }))
      .catch((e) => banner(e.message, true));
    const want = params.get("case");
    const initial = S.cases.find((c) => c.slug === want) || S.cases.find((c) => runOf(c.id)) || S.cases[0];
    if (initial) await selectCase(initial.id, { zoom: params.get("zoom") === "case" ? "case" : "full" });
    else renderAll();
  }
  start();
})();
