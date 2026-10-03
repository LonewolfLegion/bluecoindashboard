/* App shell: loading a file, tabs, the shared filter bar, theme toggle. */
(function (BC) {
  "use strict";
  const F = BC.fmt;
  const $ = (sel, root = document) => root.querySelector(sel);

  const VIEWS = [
    { id: "spending", label: "Spending", filters: true },
    { id: "category", label: "Category trend", filters: true },
    { id: "networth", label: "Net worth", filters: true },
    { id: "transactions", label: "Transactions", filters: true },
  ];

  const PRESETS = [
    ["month", "This month"],
    ["lastmonth", "Last month"],
    ["3m", "Last 3 months"],
    ["12m", "Last 12 months"],
    ["ytd", "Year to date"],
    ["lastyear", "Last year"],
    ["all", "All time"],
    ["custom", "Custom…"],
  ];

  const state = {
    ds: null,
    view: "spending",
    filters: { preset: "12m", from: null, to: null, accounts: [] },
    range: null,
    accounts: [],
  };

  function presetRange(p) {
    const today = F.today();
    const [y, m] = today.split("-").map(Number);
    const monthStart = (yy, mm) => {
      while (mm < 1) { mm += 12; yy--; }
      return `${yy}-${String(mm).padStart(2, "0")}-01`;
    };
    switch (p) {
      case "month": return [monthStart(y, m), today];
      case "lastmonth": return [monthStart(y, m - 1), F.addDays(monthStart(y, m), -1)];
      case "3m": return [monthStart(y, m - 2), today];
      case "12m": return [monthStart(y, m - 11), today];
      case "ytd": return [`${y}-01-01`, today];
      case "lastyear": return [`${y - 1}-01-01`, `${y - 1}-12-31`];
      case "all": return [state.range ? state.range.first : null, today];
      default: return [state.filters.from, state.filters.to];
    }
  }

  function setPreset(p) {
    state.filters.preset = p;
    if (p !== "custom") [state.filters.from, state.filters.to] = presetRange(p);
  }

  // ---------- Loading ----------
  async function loadBytes(bytes, meta, { persist }) {
    showStatus("Opening your backup…");
    try {
      const ds = await BC.db.open(bytes, meta);
      if (state.ds) state.ds.close();
      state.ds = ds;
      state.range = BC.q.dataRange(ds);
      state.accounts = BC.q.accounts(ds);
      state.filters.accounts = [];
      setPreset(state.filters.preset);
      if (persist) await BC.db.cache.save(bytes, meta);
      showDashboard();
    } catch (e) {
      console.error(e);
      showUpload(e.message || String(e));
    }
  }

  async function loadFile(file) {
    const bytes = await file.arrayBuffer();
    await loadBytes(bytes, { name: file.name, loadedAt: new Date().toISOString(), sample: false }, { persist: true });
  }

  function loadSample() {
    const go = () => {
      const bytes = Uint8Array.from(atob(window.SAMPLE_FYDB_BASE64), (c) => c.charCodeAt(0)).buffer;
      loadBytes(bytes, { name: "Sample data", loadedAt: new Date().toISOString(), sample: true }, { persist: false });
    };
    if (window.SAMPLE_FYDB_BASE64) return go();
    const s = document.createElement("script");
    s.src = "sample/sample-data.js";
    s.onload = go;
    s.onerror = () => showUpload("Couldn't load the sample data file.");
    document.head.appendChild(s);
  }

  // ---------- Screens ----------
  function showStatus(msg) {
    $("#app").innerHTML = `<div class="center-screen"><div class="spinner" aria-hidden="true"></div><p>${F.esc(msg)}</p></div>`;
  }

  function showUpload(error) {
    document.body.classList.remove("has-data");
    $("#app").innerHTML = `
      <div class="center-screen">
        <div class="upload-card">
          <div class="brand-mark big" aria-hidden="true">₹</div>
          <h1>Bluecoins Dashboard</h1>
          <p class="lede">Open a Bluecoins backup to see your spending, net worth and transactions.</p>
          ${error ? `<div class="alert" role="alert"><strong>Couldn't open that file.</strong> ${F.esc(error)}</div>` : ""}
          <label class="dropzone" id="dropzone" tabindex="0">
            <input type="file" id="file" accept=".fydb,.db,.sqlite,application/octet-stream" hidden>
            <span class="dz-title">Drop your <code>.fydb</code> backup here</span>
            <span class="dz-sub">or click to choose a file</span>
          </label>
          <button class="btn ghost" id="sample">Try it with sample data</button>
          <details class="howto">
            <summary>How do I get a backup file?</summary>
            <ol>
              <li>In the Bluecoins app, open <b>Settings → Backup & Restore</b> (or <b>Data Management</b>).</li>
              <li>Create a local backup, or back up to Google Drive or Dropbox.</li>
              <li>Copy the <code>.fydb</code> file to this computer and drop it above.</li>
            </ol>
          </details>
          <p class="privacy">🔒 Your file is read inside this browser and never uploaded anywhere. The last file you open is remembered on this device until you click <b>Clear data</b>.</p>
        </div>
      </div>`;
    const input = $("#file"), dz = $("#dropzone");
    input.addEventListener("change", () => input.files[0] && loadFile(input.files[0]));
    dz.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input.click(); } });
    ["dragenter", "dragover"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add("over"); }));
    ["dragleave", "drop"].forEach((ev) => dz.addEventListener(ev, () => dz.classList.remove("over")));
    dz.addEventListener("drop", (e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) loadFile(f); });
    $("#sample").addEventListener("click", loadSample);
  }

  function showDashboard() {
    document.body.classList.add("has-data");
    const m = state.ds.meta;
    const loaded = new Date(m.loadedAt);
    $("#app").innerHTML = `
      <header class="topbar">
        <div class="brand"><div class="brand-mark" aria-hidden="true">₹</div><span>Bluecoins Dashboard</span></div>
        <nav class="tabs" role="tablist">
          ${VIEWS.map((v) => `<a role="tab" href="#${v.id}" data-view="${v.id}">${v.label}</a>`).join("")}
        </nav>
        <div class="topbar-actions">
          <details class="menu">
            <summary class="btn ghost small" title="File">${m.sample ? "Sample data" : "Backup"} ▾</summary>
            <div class="menu-panel">
              <div class="meta">
                <div><b>${F.esc(m.name)}</b></div>
                <div>Opened ${F.esc(loaded.toLocaleString("en-IN"))}</div>
                <div>Data from ${F.day(state.range.first)} to ${F.day(state.range.last)}</div>
                <div>${F.num(state.range.n)} transactions · DB version ${F.esc(m.userVersion)}</div>
              </div>
              <button class="btn small" id="open-other">Open another file</button>
              <button class="btn small danger" id="clear">Clear data</button>
            </div>
          </details>
          <button class="btn ghost small icon" id="theme" title="Toggle light/dark" aria-label="Toggle light or dark theme"><svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 1.5a6.5 6.5 0 0 1 0 13z" fill="currentColor"/></svg></button>
        </div>
      </header>
      <div class="filterbar" id="filterbar"></div>
      <main id="view" class="view"></main>
      <input type="file" id="file2" accept=".fydb,.db,.sqlite,application/octet-stream" hidden>`;

    $("#open-other").addEventListener("click", () => $("#file2").click());
    $("#file2").addEventListener("change", (e) => e.target.files[0] && loadFile(e.target.files[0]));
    $("#clear").addEventListener("click", async () => {
      await BC.db.cache.clear();
      if (state.ds) state.ds.close();
      state.ds = null;
      showUpload();
    });
    $("#theme").addEventListener("click", toggleTheme);
    route();
  }

  // ---------- Filter bar ----------
  function renderFilterBar() {
    const bar = $("#filterbar");
    const view = VIEWS.find((v) => v.id === state.view);
    if (!view.filters) { bar.hidden = true; bar.innerHTML = ""; return; }
    bar.hidden = false;
    const f = state.filters;
    const sel = f.accounts.length;
    const groups = {};
    state.accounts.forEach((a) => (groups[a.grp || "Other"] = groups[a.grp || "Other"] || []).push(a));

    bar.innerHTML = `
      <label class="field"><span>Period</span>
        <select id="preset">${PRESETS.map(([k, l]) => `<option value="${k}" ${k === f.preset ? "selected" : ""}>${l}</option>`).join("")}</select>
      </label>
      <label class="field"><span>From</span><input type="date" id="from" value="${f.from || ""}"></label>
      <label class="field"><span>To</span><input type="date" id="to" value="${f.to || ""}"></label>
      <details class="menu field accounts-menu">
        <summary class="select-like"><span>Accounts</span><b>${sel ? `${sel} selected` : "All accounts"}</b></summary>
        <div class="menu-panel scroll">
          <div class="menu-row"><button class="btn small" id="acc-all">All</button><button class="btn small ghost" id="acc-none">Clear</button></div>
          ${Object.entries(groups).map(([g, list]) => `
            <div class="menu-group">${F.esc(g)}</div>
            ${list.map((a) => `<label class="check"><input type="checkbox" value="${a.id}" ${f.accounts.includes(a.id) ? "checked" : ""}>
              ${F.esc(a.name)}${a.hidden ? ' <span class="tag">hidden</span>' : ""}</label>`).join("")}`).join("")}
        </div>
      </details>
      <div class="filter-summary">${f.from ? F.day(f.from) : "Start"} – ${f.to ? F.day(f.to) : "Today"}</div>`;

    $("#preset").addEventListener("change", (e) => { setPreset(e.target.value); renderFilterBar(); renderView(); });
    const custom = () => {
      state.filters.preset = "custom";
      state.filters.from = $("#from").value || null;
      state.filters.to = $("#to").value || null;
      renderFilterBar();
      renderView();
    };
    $("#from").addEventListener("change", custom);
    $("#to").addEventListener("change", custom);
    bar.querySelectorAll('.accounts-menu input[type="checkbox"]').forEach((cb) =>
      cb.addEventListener("change", () => {
        state.filters.accounts = [...bar.querySelectorAll('.accounts-menu input:checked')].map((x) => +x.value);
        bar.querySelector(".accounts-menu summary b").textContent = state.filters.accounts.length ? `${state.filters.accounts.length} selected` : "All accounts";
        renderView();
      }));
    $("#acc-all").addEventListener("click", () => { state.filters.accounts = []; renderFilterBar(); renderView(); $(".accounts-menu").open = true; });
    $("#acc-none").addEventListener("click", () => { state.filters.accounts = []; renderFilterBar(); renderView(); });
  }

  // ---------- Routing ----------
  function route() {
    const id = (location.hash || "").slice(1);
    state.view = VIEWS.some((v) => v.id === id) ? id : "spending";
    document.querySelectorAll(".tabs a").forEach((a) => a.setAttribute("aria-selected", a.dataset.view === state.view));
    renderFilterBar();
    renderView();
  }

  function renderView() {
    if (!state.ds) return;
    BC.charts.disposeAll();
    const el = $("#view");
    try {
      BC.views[state.view].render(el, {
        ds: state.ds,
        filters: { ...state.filters },
        accounts: state.accounts,
        range: state.range,
        goto(view, patch) {
          if (patch) Object.assign(state.filters, patch);
          location.hash = view;
        },
      });
    } catch (e) {
      console.error(e);
      el.innerHTML = `<div class="alert" role="alert"><strong>Something went wrong drawing this view.</strong> ${F.esc(e.message)}</div>`;
    }
  }

  // ---------- Theme ----------
  function applyTheme(t) {
    if (t) document.documentElement.dataset.theme = t;
    else delete document.documentElement.dataset.theme;
  }
  function toggleTheme() {
    const dark = document.documentElement.dataset.theme
      ? document.documentElement.dataset.theme === "dark"
      : matchMedia("(prefers-color-scheme: dark)").matches;
    const next = dark ? "light" : "dark";
    applyTheme(next);
    try { localStorage.setItem("bc-theme", next); } catch (e) { /* ignore */ }
    renderView();
  }

  // ---------- Boot ----------
  async function boot() {
    try { applyTheme(localStorage.getItem("bc-theme")); } catch (e) { /* ignore */ }
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => renderView());
    window.addEventListener("hashchange", () => state.ds && route());
    showStatus("Loading…");
    const cached = await BC.db.cache.load();
    if (cached && cached.bytes) await loadBytes(cached.bytes, cached.meta, { persist: false });
    else showUpload();
  }

  BC.views = BC.views || {};
  BC.app = { state };
  document.addEventListener("DOMContentLoaded", boot);
})((window.BC = window.BC || {}));
