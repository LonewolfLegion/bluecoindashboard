/* Month-end & Forecast: each account's balance on the last day of every month, and where the trend points.
 *
 * - History: running balance per account at every month end, built from actual rows (see BC.forecast).
 * - The current month is partial: shown as "today", never used to fit the trend.
 * - Trend: least-squares line through the last N complete month ends, with an 80% prediction band.
 * - Scheduled: today's balance plus the reminders (scheduled transactions) still to come.
 * - Trend + one-offs: the trend plus reminders that happen only once (repeating ones are already in the trend).
 */
(function (BC) {
  "use strict";
  const F = BC.fmt;
  const FC = BC.forecast;

  const WINDOWS = [6, 12, 24, 36];
  const HORIZONS = [6, 12, 24];
  const MODES = [
    ["trend", "Trend"],
    ["scheduled", "Scheduled"],
    ["oneoff", "Trend + one-offs"],
  ];
  const MODE_HELP = {
    trend: "A straight line through your recent month-end balances, carried forward.",
    scheduled: "Today's balance plus the reminders you've scheduled in Bluecoins. Only counts what's scheduled.",
    oneoff: "The trend, plus reminders that happen only once. Repeating reminders (salary, rent, EMIs) are already part of the trend, so they aren't added twice.",
  };
  const HIST_COLS = 12; // month-end columns shown in the table

  const st = { series: "net", window: 12, horizon: 12, mode: "trend", hidden: false, excluded: new Set() };

  const isAssets = (g) => /^assets?$/i.test(g || "");
  const isLiab = (g) => /^liabilit/i.test(g || "");
  const inNetWorth = (g) => isAssets(g) || isLiab(g);

  // ---------- Model ----------
  function build(ds, accounts) {
    const today = F.today();
    const cur = today.slice(0, 7);
    const lastFull = FC.addMonths(cur, -1);
    const netRows = BC.q.monthlyAccountNet(ds, today);
    const first = netRows.length ? netRows[0].month : cur;
    const { months, balances } = FC.monthEndBalances(netRows, first, cur);
    const nHist = months.length - 1; // complete months; the last entry is the current month so far
    const hist = months.slice(0, nHist);
    const H = st.horizon;
    const fMonths = Array.from({ length: H }, (_, i) => FC.addMonths(lastFull, i + 1));
    const winStart = Math.max(0, nHist - st.window);
    const horizonEnd = FC.monthEndDay(fMonths[H - 1]);

    const sched = BC.q.scheduled(ds, today, horizonEnd);
    const flowsBy = new Map();
    sched.forEach((r) => {
      if (!flowsBy.has(r.accountId)) flowsBy.set(r.accountId, []);
      flowsBy.get(r.accountId).push(r);
    });

    const meta = new Map(accounts.map((a) => [a.id, a]));
    const rows = [];
    for (const [id, bal] of balances) {
      const a = meta.get(id) || { id, name: `Account ${id}`, hidden: 0, type: "", grp: "" };
      const flows = flowsBy.get(id) || [];
      rows.push(seriesFrom({
        id, name: a.name, type: a.type, grp: a.grp, hidden: !!a.hidden,
        hist: bal.slice(0, nHist), mtd: bal[nHist],
        sched: FC.cumulativeByMonth(flows, fMonths),
        oneoff: FC.cumulativeByMonth(flows.filter((f) => f.seriesCount === 1), fMonths),
      }, winStart, H));
    }

    // Flags for the exclusion menu and the data-quality note.
    const oneSided = new Map(BC.q.oneSidedTransferAccounts(ds).map((r) => [r.accountId, r]));
    rows.forEach((r) => {
      r.flags = [];
      if (isAssets(r.grp) && r.mtd < -0.5) r.flags.push("negative asset balance");
      if (r.hidden && Math.abs(r.mtd) >= 1) r.flags.push("hidden but holds money");
      if (oneSided.has(r.id)) r.flags.push(`${oneSided.get(r.id).n} one-sided transfer${oneSided.get(r.id).n === 1 ? "" : "s"}`);
    });

    const included = (r) => inNetWorth(r.grp) && (st.hidden || !r.hidden) && !st.excluded.has(r.id);
    const agg = (name, pred) => {
      const list = rows.filter((r) => included(r) && pred(r));
      return seriesFrom({
        id: null, name, hist: FC.sumSeries(list.map((r) => r.hist), nHist),
        mtd: list.reduce((s, r) => s + r.mtd, 0),
        sched: FC.sumSeries(list.map((r) => r.sched), H),
        oneoff: FC.sumSeries(list.map((r) => r.oneoff), H),
      }, winStart, H);
    };
    const totals = {
      net: agg("Net worth", () => true),
      assets: agg("Assets", (r) => isAssets(r.grp)),
      liab: agg("Liabilities", (r) => isLiab(r.grp)),
    };

    const schedInHorizon = sched.filter((r) => {
      const a = rows.find((x) => x.id === r.accountId);
      return a && included(a);
    });

    return { today, cur, lastFull, hist, nHist, fMonths, winStart, rows, totals, included, sched: schedInHorizon, schedAll: sched };
  }

  // Adds the fit and the three forecast lines to a series of month-end balances.
  function seriesFrom(s, winStart, H) {
    const fit = FC.linearFit(s.hist.slice(winStart));
    const trend = FC.project(fit, H);
    s.fit = fit;
    s.trend = trend;
    s.fcast = {
      trend: trend.map((p) => p.value),
      scheduled: s.sched.map((v) => s.mtd + v),
      oneoff: trend.map((p, i) => p.value + s.oneoff[i]),
    };
    return s;
  }

  // ---------- Render ----------
  function render(el, ctx) {
    const { ds } = ctx;
    const m = build(ds, ctx.accounts);
    const t = BC.charts.theme();

    if (!m.rows.length) {
      el.innerHTML = `<section class="card"><p class="empty">No transactions yet, so there's nothing to forecast.</p></section>`;
      return;
    }

    const sel = pick(m);
    if (!sel) { st.series = "net"; return render(el, ctx); }
    const last = sel.hist.length ? sel.hist[sel.hist.length - 1] : 0;
    const prev = sel.hist.length > 1 ? sel.hist[sel.hist.length - 2] : 0;
    const H = st.horizon;
    const endMonth = m.fMonths[H - 1];
    const fEnd = sel.fcast[st.mode][H - 1];
    const tEnd = sel.trend[H - 1];
    const r2 = sel.fit.r2;
    const nFit = sel.fit.n;
    const weak = !sel.fit.flat && (!isFinite(r2) || r2 < 0.5) && Math.abs(sel.fit.b) > 0.5;
    const flagged = m.rows.filter((r) => r.flags.length && inNetWorth(r.grp) && (st.hidden || !r.hidden));
    const oneoffs = m.sched.filter((r) => r.seriesCount === 1);

    el.innerHTML = `
      <section class="card fc-controls">
        <label class="field"><span>Show</span>
          <select id="fc-series">${seriesOptions(m)}</select>
        </label>
        <div class="field"><span>Fit the trend on</span>
          <div class="seg" role="group" aria-label="Fit window">${WINDOWS.map((w) => `<button class="${st.window === w ? "on" : ""}" data-window="${w}">${w} mo</button>`).join("")}</div>
        </div>
        <div class="field"><span>Forecast ahead</span>
          <div class="seg" role="group" aria-label="Forecast horizon">${HORIZONS.map((h) => `<button class="${st.horizon === h ? "on" : ""}" data-horizon="${h}">${h} mo</button>`).join("")}</div>
        </div>
        <div class="field"><span>Forecast method</span>
          <div class="seg" role="group" aria-label="Forecast method">${MODES.map(([k, l]) => `<button class="${st.mode === k ? "on" : ""}" data-mode="${k}">${l}</button>`).join("")}</div>
        </div>
        <label class="check small"><input type="checkbox" id="fc-hidden" ${st.hidden ? "checked" : ""}> Include hidden accounts</label>
        <details class="menu field fc-exclude">
          <summary class="select-like"><span>Leave out of totals</span><b>${st.excluded.size ? `${st.excluded.size} account${st.excluded.size === 1 ? "" : "s"}` : "Nothing"}</b></summary>
          <div class="menu-panel scroll">
            <div class="menu-row"><button class="btn small ghost" id="fc-ex-none">Include all</button>${flagged.length ? `<button class="btn small ghost" id="fc-ex-flagged">Leave out flagged</button>` : ""}</div>
            ${excludeList(m)}
          </div>
        </details>
      </section>
      <p class="note fc-mode-help">${MODE_HELP[st.mode]}</p>

      <section class="kpis">
        ${BC.ui.kpi(`${F.esc(sel.name)} on ${F.day(FC.monthEndDay(m.lastFull))}`, F.inr(last), last < 0 ? "neg" : "",
          sel.hist.length > 1 ? `${signed(last - prev)} vs ${F.day(FC.monthEndDay(FC.addMonths(m.lastFull, -1)))}` : "")}
        ${BC.ui.kpi("So far this month", F.inr(sel.mtd), sel.mtd < 0 ? "neg" : "", `on ${F.day(m.today)}`)}
        ${BC.ui.kpi("Trend", `${signed(sel.fit.b)}<small> /mo</small>`, sel.fit.b < 0 ? "neg" : "",
          sel.fit.flat ? "Not enough history yet" : `fitted on the last ${nFit} month ends`)}
        ${BC.ui.kpi(`Forecast for ${F.day(FC.monthEndDay(endMonth))}`, F.inr(fEnd), fEnd < 0 ? "neg" : "",
          st.mode === "scheduled" ? `today + ${countSched(m, sel)} scheduled item${countSched(m, sel) === 1 ? "" : "s"}`
            : tEnd.hi - tEnd.lo > 1 ? `80% range ${F.compact(tEnd.lo + (fEnd - tEnd.value))} – ${F.compact(tEnd.hi + (fEnd - tEnd.value))}` : "no spread around the trend")}
        ${BC.ui.kpi("Trend fit (R²)", isFinite(r2) ? r2.toFixed(2) : "—", weak ? "warn" : "",
          sel.fit.flat ? "Needs 3+ month ends" : weak ? "Weak trend, read the forecast loosely" : isFinite(r2) ? "How closely balances follow the line" : "Balance hasn't changed")}
      </section>

      <section class="card">
        <div class="card-head"><h2>${F.esc(sel.name)}: month-end balance and forecast</h2>
          <div class="legend">
            <span class="sw line" style="background:var(--text-primary)"></span>Month end
            <span class="sw line dashed fc-trend-sw"></span>Trend
            <span class="sw fc-band-sw"></span>80% range
            <span class="sw line dotted fc-sched-sw"></span>Scheduled
            ${st.mode === "oneoff" && sel.oneoff.some((v) => Math.abs(v) >= 1) ? `<span class="sw line dashed fc-oneoff-sw"></span>Trend + one-offs` : ""}
            <span class="sw fc-today-sw"></span>Today
          </div>
        </div>
        <div id="fc-chart" class="chart tall"></div>
        <p class="note">Balances on the last day of each month, from every recorded transaction. ${F.month(m.cur)} isn't over yet, so its point is today's balance and the trend is fitted on month ends up to ${F.day(FC.monthEndDay(m.lastFull))}. Investments are at the amount put in, not market value.</p>
      </section>

      <section class="card">
        <div class="card-head"><h2>Month-end balances by account</h2>
          <button class="btn small" id="fc-csv">Download CSV</button>
        </div>
        <div class="table-wrap fc-table-wrap"><table class="data fc-table" id="fc-table"></table></div>
        <p class="note">Shaded columns are forecasts (${MODES.find((x) => x[0] === st.mode)[1].toLowerCase()}). Click an account to chart it. Trend is the average change per month over the fit window.</p>
      </section>

      <div class="grid-2">
        <section class="card" id="fc-sched"></section>
        <section class="card" id="fc-dq"></section>
      </div>`;

    // Controls
    el.querySelector("#fc-series").addEventListener("change", (e) => { st.series = e.target.value; render(el, ctx); });
    el.querySelectorAll("[data-window]").forEach((b) => b.addEventListener("click", () => { st.window = +b.dataset.window; render(el, ctx); }));
    el.querySelectorAll("[data-horizon]").forEach((b) => b.addEventListener("click", () => { st.horizon = +b.dataset.horizon; render(el, ctx); }));
    el.querySelectorAll("[data-mode]").forEach((b) => b.addEventListener("click", () => { st.mode = b.dataset.mode; render(el, ctx); }));
    el.querySelector("#fc-hidden").addEventListener("change", (e) => { st.hidden = e.target.checked; render(el, ctx); });
    const reopen = () => { const d = el.querySelector(".fc-exclude"); if (d) d.open = true; };
    el.querySelectorAll('.fc-exclude input[type="checkbox"]').forEach((cb) => cb.addEventListener("change", () => {
      const id = +cb.value;
      if (cb.checked) st.excluded.add(id); else st.excluded.delete(id);
      render(el, ctx); reopen();
    }));
    el.querySelector("#fc-ex-none").addEventListener("click", () => { st.excluded.clear(); render(el, ctx); reopen(); });
    const exFlagged = el.querySelector("#fc-ex-flagged");
    if (exFlagged) exFlagged.addEventListener("click", () => { flagged.forEach((r) => st.excluded.add(r.id)); render(el, ctx); reopen(); });

    drawChart(el.querySelector("#fc-chart"), m, sel, t);
    drawTable(el, m, ctx);
    el.querySelector("#fc-csv").addEventListener("click", () => downloadCsv(m));
    drawScheduled(el.querySelector("#fc-sched"), m, oneoffs);
    drawQuality(el.querySelector("#fc-dq"), m, flagged);
  }

  function pick(m) {
    if (st.series in m.totals) return m.totals[st.series];
    const id = +String(st.series).replace("acc:", "");
    return m.rows.find((r) => r.id === id) || null;
  }

  // Reminders behind the "Scheduled" forecast of the selected series.
  function countSched(m, sel) {
    if (sel.id !== null) return m.schedAll.filter((r) => r.accountId === sel.id).length;
    const grpOf = (id) => (m.rows.find((r) => r.id === id) || {}).grp;
    const pred = st.series === "assets" ? isAssets : st.series === "liab" ? isLiab : () => true;
    return m.sched.filter((r) => pred(grpOf(r.accountId))).length;
  }

  function seriesOptions(m) {
    const opt = (v, l) => `<option value="${v}" ${String(st.series) === v ? "selected" : ""}>${l}</option>`;
    const group = (label, pred) => {
      const list = m.rows.filter((r) => pred(r) && (st.hidden || !r.hidden) && (Math.abs(r.mtd) >= 1 || r.hist.some((v) => Math.abs(v) >= 1)))
        .sort((a, b) => Math.abs(b.mtd) - Math.abs(a.mtd));
      return list.length ? `<optgroup label="${label}">${list.map((r) => opt(`acc:${r.id}`, F.esc(r.name) + (r.hidden ? " (hidden)" : ""))).join("")}</optgroup>` : "";
    };
    return `<optgroup label="Totals">${opt("net", "Net worth")}${opt("assets", "Assets")}${opt("liab", "Liabilities")}</optgroup>` +
      group("Assets", (r) => isAssets(r.grp)) + group("Liabilities", (r) => isLiab(r.grp));
  }

  function excludeList(m) {
    const list = m.rows.filter((r) => inNetWorth(r.grp) && (st.hidden || !r.hidden) && (Math.abs(r.mtd) >= 1 || r.flags.length))
      .sort((a, b) => (b.flags.length - a.flags.length) || (Math.abs(b.mtd) - Math.abs(a.mtd)));
    return list.map((r) => `<label class="check" title="${F.esc(r.flags.join(", "))}"><input type="checkbox" value="${r.id}" ${st.excluded.has(r.id) ? "checked" : ""}>
      ${F.esc(r.name)} <span class="muted">${F.compact(r.mtd)}</span>${r.flags.length ? ' <span class="tag warn">⚠ flagged</span>' : ""}</label>`).join("") ||
      `<p class="muted">No accounts with a balance.</p>`;
  }

  // ---------- Chart ----------
  function drawChart(holder, m, s, t) {
    const n = m.nHist, H = st.horizon;
    const x = m.hist.concat(m.fMonths); // m.fMonths[0] is the current month
    const N = x.length;
    const blank = () => new Array(N).fill(null);
    const r = (v) => (v === null ? null : Math.round(v));

    const actual = blank(), trend = blank(), lo = blank(), band = blank(), sched = blank(), oneoff = blank(), mtd = blank();
    s.hist.forEach((v, i) => (actual[i] = r(v)));
    for (let i = m.winStart; i < n; i++) trend[i] = r(FC.fitted(s.fit, i - m.winStart));
    if (n) {
      // Forecast lines start from the last month end so they read as continuations.
      lo[n - 1] = trend[n - 1]; band[n - 1] = 0;
      sched[n - 1] = actual[n - 1];
      oneoff[n - 1] = trend[n - 1];
    }
    for (let h = 0; h < H; h++) {
      const i = n + h, p = s.trend[h];
      trend[i] = r(p.value);
      lo[i] = r(p.lo);
      band[i] = Math.round(p.hi - p.lo);
      sched[i] = r(s.fcast.scheduled[h]);
      oneoff[i] = r(s.fcast.oneoff[h]);
    }
    mtd[n] = r(s.mtd);
    const anySched = s.sched.some((v) => Math.abs(v) >= 1);
    const anyOneoff = s.oneoff.some((v) => Math.abs(v) >= 1);

    const trendColor = t.series[0], schedColor = t.series[3], oneoffColor = t.series[2];
    const visibleFrom = Math.max(0, n - Math.max(36, st.window + 12));
    const series = [
      { name: "Month end", type: "line", data: actual, showSymbol: false, symbolSize: 7, lineStyle: { width: 2.5, color: t.net }, itemStyle: { color: t.net }, z: 5 },
      { name: "lo", type: "line", data: lo, stack: "band", stackStrategy: "all", showSymbol: false, lineStyle: { opacity: 0 }, silent: true, tooltip: { show: false } },
      { name: "80% range", type: "line", data: band, stack: "band", stackStrategy: "all", showSymbol: false, lineStyle: { opacity: 0 }, areaStyle: { color: trendColor, opacity: 0.13 }, silent: true, tooltip: { show: false } },
      { name: "Trend", type: "line", data: trend, showSymbol: false, lineStyle: { width: 2, type: [6, 4], color: trendColor }, itemStyle: { color: trendColor }, z: 4 },
    ];
    if (anySched || st.mode === "scheduled") series.push({ name: "Scheduled", type: "line", data: sched, showSymbol: false, lineStyle: { width: 2, type: [2, 3], color: schedColor }, itemStyle: { color: schedColor }, z: 4 });
    if (st.mode === "oneoff" && anyOneoff) series.push({ name: "Trend + one-offs", type: "line", data: oneoff, showSymbol: false, lineStyle: { width: 2, type: [6, 4], color: oneoffColor }, itemStyle: { color: oneoffColor }, z: 4 });
    series.push({
      name: "Today", type: "scatter", data: mtd, symbolSize: 10, itemStyle: { color: t.net, borderColor: t.surface, borderWidth: 2 }, z: 6,
      markLine: n ? { silent: true, symbol: "none", label: { show: true, formatter: "Today", color: t.muted, fontSize: 11, position: "insideEndTop" }, lineStyle: { color: t.muted, type: [3, 3], width: 1 }, data: [{ xAxis: n }] } : undefined,
    });

    BC.charts.mount(holder, {
      ...BC.charts.base(t),
      grid: { left: 8, right: 16, top: 20, bottom: 44, containLabel: true },
      tooltip: {
        ...BC.charts.base(t).tooltip, trigger: "axis",
        axisPointer: { type: "line", lineStyle: { color: t.muted, type: "dashed" } },
        formatter: (ps) => {
          const i = ps[0].dataIndex;
          const lines = [];
          if (i < n) {
            lines.push(`<b>${F.day(FC.monthEndDay(x[i]))}</b>`);
            lines.push(`${BC.ui.dot(t.net)}Month end <b>${F.inr(actual[i])}</b>`);
            if (trend[i] !== null) lines.push(`${BC.ui.dot(trendColor)}Trend line <b>${F.inr(trend[i])}</b>`);
          } else {
            const h = i - n;
            lines.push(`<b>${F.day(FC.monthEndDay(x[i]))}</b> <span style="opacity:.7">forecast</span>`);
            if (h === 0) lines.push(`${BC.ui.dot(t.net)}Today (${F.day(m.today)}) <b>${F.inr(mtd[i])}</b>`);
            lines.push(`${BC.ui.dot(trendColor)}Trend <b>${F.inr(trend[i])}</b>` + (band[i] > 1 ? `<br><span style="opacity:.7;padding-left:14px">80% range ${F.inr(lo[i])} – ${F.inr(lo[i] + band[i])}</span>` : ""));
            if (anySched || st.mode === "scheduled") lines.push(`${BC.ui.dot(schedColor)}Scheduled <b>${F.inr(sched[i])}</b>`);
            if (st.mode === "oneoff" && anyOneoff) lines.push(`${BC.ui.dot(oneoffColor)}Trend + one-offs <b>${F.inr(oneoff[i])}</b>`);
          }
          return lines.join("<br>");
        },
      },
      xAxis: { type: "category", data: x, boundaryGap: false, ...BC.charts.axisStyle(t), splitLine: { show: false }, axisLabel: { ...BC.charts.axisStyle(t).axisLabel, formatter: F.monthShort } },
      yAxis: { type: "value", scale: true, ...BC.charts.axisStyle(t), axisLabel: { ...BC.charts.axisStyle(t).axisLabel, formatter: F.compact } },
      dataZoom: [
        { type: "inside", startValue: visibleFrom, endValue: N - 1 },
        { type: "slider", startValue: visibleFrom, endValue: N - 1, height: 18, bottom: 8, borderColor: t.grid, fillerColor: "rgba(127,127,127,.12)",
          textStyle: { color: t.muted, fontSize: 10 }, labelFormatter: (v) => (x[v] ? F.monthShort(x[v]) : ""), dataBackground: { lineStyle: { color: t.muted }, areaStyle: { color: t.grid } } },
      ],
      series,
    });
  }

  // ---------- Table ----------
  function tableModel(m) {
    const histIdx = [];
    for (let i = Math.max(0, m.nHist - HIST_COLS); i < m.nHist; i++) histIdx.push(i);
    const cols = histIdx.map((i) => ({ kind: "hist", i, label: F.monthShort(m.hist[i]), title: F.day(FC.monthEndDay(m.hist[i])) }))
      .concat([{ kind: "today", label: "Today", title: F.day(m.today) }])
      .concat(m.fMonths.map((mo, h) => ({ kind: "fc", h, label: F.monthShort(mo), title: `${F.day(FC.monthEndDay(mo))} (forecast)` })));
    const val = (s, c) => (c.kind === "hist" ? s.hist[c.i] : c.kind === "today" ? s.mtd : s.fcast[st.mode][c.h]);

    const visible = (r) => (st.hidden || !r.hidden) && cols.some((c) => Math.abs(val(r, c)) >= 0.5);
    const groups = [
      { name: "Assets", total: m.totals.assets, rows: m.rows.filter((r) => isAssets(r.grp) && visible(r)) },
      { name: "Liabilities", total: m.totals.liab, rows: m.rows.filter((r) => isLiab(r.grp) && visible(r)) },
    ];
    const other = m.rows.filter((r) => !inNetWorth(r.grp) && visible(r));
    if (other.length) groups.push({ name: "Not in net worth", total: null, rows: other });
    groups.forEach((g) => g.rows.sort((a, b) => Math.abs(b.mtd) - Math.abs(a.mtd)));
    return { cols, val, groups };
  }

  function drawTable(el, m, ctx) {
    const { cols, val, groups } = tableModel(m);
    const table = el.querySelector("#fc-table");
    const cls = (c) => (c.kind === "fc" ? "fc" : c.kind === "today" ? "today" : "");
    const cells = (s) => cols.map((c) => {
      const v = val(s, c);
      return `<td class="num ${cls(c)} ${v < -0.5 ? "neg" : ""}">${F.inr(v)}</td>`;
    }).join("");
    const fitCells = (s) => `<td class="num ${s.fit.b < -0.5 ? "neg" : ""}">${s.fit.flat ? "—" : signed(s.fit.b)}</td><td class="num muted">${isFinite(s.fit.r2) ? s.fit.r2.toFixed(2) : "—"}</td>`;

    const head = `<thead><tr><th class="sticky">Account</th>${cols.map((c) => `<th class="num ${cls(c)}" title="${c.title}">${c.label}</th>`).join("")}<th class="num">Trend /mo</th><th class="num">R²</th></tr></thead>`;
    const body = groups.map((g) => {
      const header = g.total
        ? `<tr class="group subtotal"><th class="sticky">${g.name}</th>${cols.map((c) => `<th class="num ${cls(c)}">${F.inr(val(g.total, c))}</th>`).join("")}<th class="num">${signed(g.total.fit.b)}</th><th class="num">${isFinite(g.total.fit.r2) ? g.total.fit.r2.toFixed(2) : "—"}</th></tr>`
        : `<tr class="group"><th class="sticky">${g.name}</th><th colspan="${cols.length + 2}"></th></tr>`;
      return header + g.rows.map((r) => {
        const out = !m.included(r);
        const tags = (r.hidden ? ' <span class="tag">hidden</span>' : "") +
          (st.excluded.has(r.id) ? ' <span class="tag">left out</span>' : "") +
          (r.flags.length ? ` <span class="tag warn" title="${F.esc(r.flags.join(", "))}">⚠</span>` : "");
        return `<tr class="acc ${out ? "excluded" : ""} ${String(st.series) === `acc:${r.id}` ? "selected" : ""}" data-id="${r.id}" tabindex="0">
          <td class="sticky">${F.esc(r.name)}${tags}</td>${cells(r)}${fitCells(r)}</tr>`;
      }).join("");
    }).join("");
    const net = m.totals.net;
    const foot = `<tfoot><tr class="total"><th class="sticky">Net worth</th>${cols.map((c) => `<th class="num ${cls(c)} ${val(net, c) < -0.5 ? "neg" : ""}">${F.inr(val(net, c))}</th>`).join("")}<th class="num">${signed(net.fit.b)}</th><th class="num">${isFinite(net.fit.r2) ? net.fit.r2.toFixed(2) : "—"}</th></tr></tfoot>`;
    table.innerHTML = head + `<tbody>${body}</tbody>` + foot;

    table.querySelectorAll("tr.acc").forEach((tr) => {
      const go = () => { st.series = `acc:${tr.dataset.id}`; ctx && render(el, ctx); window.scrollTo({ top: 0, behavior: "smooth" }); };
      tr.addEventListener("click", go);
      tr.addEventListener("keydown", (e) => e.key === "Enter" && go());
    });
    // Start scrolled to the "Today" column so recent history and the forecast are both in view.
    const wrap = el.querySelector(".fc-table-wrap");
    const todayTh = table.querySelector("thead th.today");
    if (wrap && todayTh) wrap.scrollLeft = Math.max(0, todayTh.offsetLeft - wrap.clientWidth * 0.45);
  }

  function downloadCsv(m) {
    const { cols, val, groups } = tableModel(m);
    const cell = (v) => {
      const s = String(v == null ? "" : v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const colName = (c) => (c.kind === "hist" ? FC.monthEndDay(m.hist[c.i]) : c.kind === "today" ? `${m.today} (today)` : `${FC.monthEndDay(m.fMonths[c.h])} (forecast)`);
    const row = (name, grp, s, note) => [name, grp, note || "", ...cols.map((c) => val(s, c).toFixed(2)), s.fit.flat ? "" : s.fit.b.toFixed(2), isFinite(s.fit.r2) ? s.fit.r2.toFixed(3) : ""];
    const lines = [["Account", "Group", "Note", ...cols.map(colName), "Trend per month", "R2"]];
    groups.forEach((g) => {
      g.rows.forEach((r) => lines.push(row(r.name, g.name, r, [r.hidden ? "hidden" : "", st.excluded.has(r.id) ? "left out of totals" : "", ...r.flags].filter(Boolean).join("; "))));
      if (g.total) lines.push(row(`Total ${g.name}`, g.name, g.total));
    });
    lines.push(row("Net worth", "", m.totals.net));
    const blob = new Blob(["﻿" + lines.map((l) => l.map(cell).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `bluecoins-month-end-forecast-${m.today}.csv`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }

  // ---------- Side cards ----------
  function drawScheduled(card, m, oneoffs) {
    const s = m.sched;
    const isTransfer = (r) => r.typeId === BC.db.TYPE.TRANSFER;
    const inflow = s.filter((r) => r.amt > 0 && !isTransfer(r)).reduce((a, r) => a + r.amt, 0);
    const outflow = s.filter((r) => r.amt < 0 && !isTransfer(r)).reduce((a, r) => a + r.amt, 0);
    const end = F.day(FC.monthEndDay(m.fMonths[m.fMonths.length - 1]));
    const name = (id) => (m.rows.find((r) => r.id === id) || {}).name || "";
    card.innerHTML = `
      <div class="card-head"><h2>Scheduled until ${end}</h2></div>
      ${s.length ? `
        <div class="kpis compact">
          ${BC.ui.kpi("Coming in", F.inr(inflow), "income")}
          ${BC.ui.kpi("Going out", F.inr(-outflow), "expense")}
          ${BC.ui.kpi("Net", F.inr(inflow + outflow), inflow + outflow < 0 ? "neg" : "")}
        </div>
        <p class="note">${F.num(s.length)} reminder${s.length === 1 ? "" : "s"} from Bluecoins, counting only accounts in the totals. Transfers between your accounts move money but don't change net worth.</p>
        <div class="subhead">One-off items${oneoffs.length ? ` (${oneoffs.length})` : ""}</div>
        ${oneoffs.length ? `<div class="table-wrap"><table class="data"><tbody>${oneoffs.map((r) => `
          <tr><td class="nowrap muted">${F.day(r.day)}</td><td>${F.esc(r.payee || "(no payee)")}<div class="sub">${F.esc(name(r.accountId))}</div></td>
          <td class="num ${r.amt < 0 ? "neg" : "pos"}">${F.inr2(r.amt)}</td></tr>`).join("")}</tbody></table></div>`
          : `<p class="muted">None. Every reminder in this window repeats, so it's already reflected in the trend.</p>`}`
      : `<p class="muted">No reminders scheduled in this window. Add reminders in Bluecoins to see them here.</p>`}`;
  }

  function drawQuality(card, m, flagged) {
    const items = flagged.map((r) => {
      const state = st.excluded.has(r.id) ? "left out of the totals" : m.included(r) ? "<b>included</b> in the totals" : "not in the totals";
      return `<li><b>${F.esc(r.name)}</b> (${F.inr(r.mtd)}): ${F.esc(r.flags.join(", "))}. Currently ${state}.</li>`;
    });
    card.innerHTML = `<div class="card-head"><h2>Before you trust the numbers</h2></div>
      <ul class="dq">
        ${items.join("")}
        ${items.length ? `<li>Use <b>Leave out of totals</b> above to see net worth and its trend without the flagged accounts.</li>` : ""}
        <li>Large one-time moves (a big purchase, a missing transaction) tilt a straight-line trend. Try a longer or shorter fit window to see how sensitive the forecast is.</li>
        <li>The 80% range assumes the next months wobble around the trend the way past months did.</li>
      </ul>`;
  }

  const signed = (v) => (v >= 0.5 ? "+" : "") + F.inr(v);

  BC.views = BC.views || {};
  BC.views.forecast = { render };
})((window.BC = window.BC || {}));
