/* Spending overview: KPIs, monthly income vs expense, category breakdown with drill-down, top payees. */
(function (BC) {
  "use strict";
  const F = BC.fmt;
  let drillParent = null; // remembered while switching filters
  let drillName = "";
  let otherOpen = false; // "Other (n)" row expanded to list the folded categories

  function render(el, ctx) {
    const { ds, filters: f } = ctx;
    const t = BC.charts.theme();
    const tot = BC.q.totals(ds, f);
    const net = tot.income - tot.expense;
    const rate = tot.income > 0 ? net / tot.income : NaN;
    const monthly = BC.q.monthly(ds, f);
    const months = monthly.length ? F.monthsBetween(monthly[0].month, monthly[monthly.length - 1].month) : [];
    const byMonth = Object.fromEntries(monthly.map((r) => [r.month, r]));
    const avgExpense = months.length ? tot.expense / months.length : 0;

    el.innerHTML = `
      <section class="kpis">
        ${kpi("Income", F.inr(tot.income), "income")}
        ${kpi("Expenses", F.inr(tot.expense), "expense")}
        ${kpi("Net savings", F.inr(net), net < 0 ? "neg" : "")}
        ${kpi("Savings rate", F.pct(rate), rate < 0 ? "neg" : "")}
        ${kpi("Avg monthly spend", F.inr(avgExpense), "", `${months.length} month${months.length === 1 ? "" : "s"}`)}
      </section>
      <section class="card">
        <div class="card-head"><h2>Income vs expenses by month</h2>
          <div class="legend"><span class="sw" style="background:var(--income)"></span>Income<span class="sw" style="background:var(--expense)"></span>Expenses</div></div>
        <div id="monthly" class="chart tall"></div>
      </section>
      <div class="grid-2">
        <section class="card">
          <div class="card-head"><h2 id="cat-title">Spending by category</h2><button class="btn small ghost" id="cat-back" hidden>← All categories</button></div>
          <div class="cat-wrap"><div id="cats" class="chart"></div><ol id="cat-list" class="bar-list"></ol></div>
        </section>
        <section class="card">
          <div class="card-head"><h2>Top payees</h2></div>
          <ol id="payees" class="bar-list"></ol>
        </section>
      </div>`;

    if (!months.length) {
      el.querySelector("#monthly").innerHTML = `<p class="empty">No income or expenses in this period.</p>`;
    } else {
      BC.charts.mount(el.querySelector("#monthly"), {
        ...BC.charts.base(t),
        grid: { left: 8, right: 8, top: 16, bottom: 8, containLabel: true },
        tooltip: {
          ...BC.charts.base(t).tooltip, trigger: "axis", axisPointer: { type: "shadow", shadowStyle: { color: "rgba(127,127,127,.08)" } },
          formatter: (ps) => {
            const m = ps[0].axisValue, r = byMonth[m] || { income: 0, expense: 0 };
            return `<b>${F.month(m)}</b><br>${dot(t.income)}Income <b>${F.inr(r.income)}</b><br>${dot(t.expense)}Expenses <b>${F.inr(r.expense)}</b><br>Net <b>${F.inr(r.income - r.expense)}</b>`;
          },
        },
        xAxis: { type: "category", data: months, ...BC.charts.axisStyle(t), splitLine: { show: false }, axisLabel: { ...BC.charts.axisStyle(t).axisLabel, formatter: F.monthShort } },
        yAxis: { type: "value", ...BC.charts.axisStyle(t), axisLabel: { ...BC.charts.axisStyle(t).axisLabel, formatter: F.compact } },
        series: [
          { name: "Income", type: "bar", data: months.map((m) => (byMonth[m] || {}).income || 0), itemStyle: { color: t.income, borderRadius: [4, 4, 0, 0] }, barGap: "8%", barMaxWidth: 22 },
          { name: "Expenses", type: "bar", data: months.map((m) => (byMonth[m] || {}).expense || 0), itemStyle: { color: t.expense, borderRadius: [4, 4, 0, 0] }, barMaxWidth: 22 },
        ],
      });
    }

    drawCategories(el, ctx, t);

    const payees = BC.q.topPayees(ds, f, 10);
    barList(el.querySelector("#payees"), payees, (p) => `${F.num(p.n)} transaction${p.n === 1 ? "" : "s"}`, "var(--expense)");
  }

  function drawCategories(el, ctx, t) {
    const { ds, filters: f } = ctx;
    let data = BC.q.spendByCategory(ds, f, drillParent);
    if (drillParent !== null && !data.length) { drillParent = null; data = BC.q.spendByCategory(ds, f, null); }
    const total = data.reduce((s, d) => s + d.value, 0);
    // Fixed palette order; anything past slot 7 folds into "Other".
    const MAX = 7;
    const shown = data.slice(0, MAX);
    const rest = data.slice(MAX);
    if (rest.length) shown.push({ id: "__other", name: `Other (${rest.length})`, value: rest.reduce((s, d) => s + d.value, 0) });
    const colors = shown.map((d, i) => (d.id === "__other" ? t.muted : t.series[i]));

    el.querySelector("#cat-title").textContent = drillParent === null ? "Spending by category" : `${drillName} breakdown`;
    const back = el.querySelector("#cat-back");
    back.hidden = drillParent === null;
    back.onclick = () => { drillParent = null; otherOpen = false; redraw(); };

    const holder = el.querySelector("#cats");
    const list = el.querySelector("#cat-list");
    if (!shown.length) { holder.innerHTML = `<p class="empty">No expenses in this period.</p>`; list.innerHTML = ""; return; }

    const chart = BC.charts.mount(holder, {
      ...BC.charts.base(t),
      tooltip: { ...BC.charts.base(t).tooltip, trigger: "item", formatter: (p) => `<b>${F.esc(p.name)}</b><br>${F.inr(p.value)} · ${F.pct(p.value / total)}` },
      series: [{
        type: "pie", radius: ["58%", "88%"], padAngle: 1, itemStyle: { borderRadius: 4, borderColor: t.surface, borderWidth: 2 },
        label: { show: true, position: "center", formatter: () => `{a|${F.compact(total)}}\n{b|total spent}`, rich: { a: { fontSize: 18, fontWeight: 600, color: t.text }, b: { fontSize: 11, color: t.muted, padding: [4, 0, 0, 0] } } },
        emphasis: { scale: true, scaleSize: 4, label: { show: true } },
        data: shown.map((d, i) => ({ name: d.name, value: d.value, id: d.id, itemStyle: { color: colors[i] } })),
      }],
    });

    const canDrill = drillParent === null;
    const rowHtml = (d, color, cls = "") => `
      <li class="${cls} ${canDrill ? "clickable" : ""}" data-id="${d.id}" data-name="${F.esc(d.name)}" tabindex="${canDrill ? 0 : -1}">
        <span class="sw" style="background:${color}"></span>
        <span class="name">${F.esc(d.name)}</span>
        <span class="val">${F.inr(d.value)}</span><span class="share">${F.pct(d.value / total)}</span>
      </li>`;
    list.innerHTML = shown.map((d, i) => {
      if (d.id !== "__other") return rowHtml(d, colors[i]);
      return `
      <li class="clickable other-toggle" data-id="__other" tabindex="0" aria-expanded="${otherOpen}">
        <span class="sw" style="background:${colors[i]}"></span>
        <span class="name">${otherOpen ? "▾" : "▸"} ${F.esc(d.name)}</span>
        <span class="val">${F.inr(d.value)}</span><span class="share">${F.pct(d.value / total)}</span>
      </li>` + (otherOpen ? rest.map((r) => rowHtml(r, "transparent", "nested")).join("") : "");
    }).join("");

    const drill = (id, name) => {
      if (id === "__other") { otherOpen = !otherOpen; redraw(); return; }
      if (drillParent !== null || id === "null") return;
      drillParent = isNaN(+id) ? id : +id;
      drillName = name;
      otherOpen = false;
      redraw();
    };
    list.querySelectorAll("li.clickable").forEach((li) => {
      li.addEventListener("click", () => drill(li.dataset.id, li.dataset.name));
      li.addEventListener("keydown", (e) => e.key === "Enter" && drill(li.dataset.id, li.dataset.name));
    });
    chart.on("click", (p) => drill(String(p.data.id), p.name));

    function redraw() {
      chart.dispose();
      drawCategories(el, ctx, t);
    }
  }

  function barList(ol, rows, sub, color) {
    if (!rows.length) { ol.innerHTML = `<p class="empty">Nothing here for this period.</p>`; return; }
    const max = rows[0].value;
    ol.innerHTML = rows.map((r) => `
      <li>
        <div class="row"><span class="name">${F.esc(r.name)}</span><span class="val">${F.inr(r.value)}</span></div>
        <div class="bar"><span style="width:${Math.max(2, (r.value / max) * 100)}%;background:${color}"></span></div>
        <div class="sub">${sub(r)}</div>
      </li>`).join("");
  }

  const kpi = (label, value, cls = "", sub = "") =>
    `<div class="kpi ${cls}"><div class="kpi-label">${label}</div><div class="kpi-value">${value}</div>${sub ? `<div class="kpi-sub">${sub}</div>` : ""}</div>`;
  const dot = (c) => `<span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${c};margin-right:6px"></span>`;

  BC.views = BC.views || {};
  BC.views.spending = { render };
  BC.ui = { kpi, dot, barList };
})((window.BC = window.BC || {}));
