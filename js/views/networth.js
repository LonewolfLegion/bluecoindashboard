/* Net worth & accounts: running balances over time, balances per account, data-quality notes. */
(function (BC) {
  "use strict";
  const F = BC.fmt;
  const opts = { hidden: false, zero: false };
  const isAssets = (g) => /^assets?$/i.test(g);
  const isLiab = (g) => /^liabilit/i.test(g);

  function render(el, ctx) {
    const { ds, filters: f } = ctx;
    const t = BC.charts.theme();
    const today = F.today();
    const asOf = f.to && f.to < today ? f.to : today;
    const from = f.from || (ctx.range && ctx.range.first) || asOf;
    const balances = BC.q.balances(ds, asOf, f.accounts);
    // Net worth just before the period starts, to show how much it changed.
    const before = BC.q.balances(ds, F.addDays(from, -1), f.accounts)
      .filter((b) => opts.hidden || !b.hidden)
      .reduce((s, b) => s + (isAssets(b.grp) || isLiab(b.grp) ? b.balance : 0), 0);
    const visible = balances.filter((b) => opts.hidden || !b.hidden);
    const sum = (pred) => visible.filter((b) => pred(b.grp)).reduce((s, b) => s + b.balance, 0);
    const assets = sum(isAssets), liabilities = sum(isLiab);
    const other = visible.filter((b) => !isAssets(b.grp) && !isLiab(b.grp));
    const hiddenWithBalance = balances.filter((b) => b.hidden && Math.abs(b.balance) >= 1);

    el.innerHTML = `
      <section class="kpis">
        ${BC.ui.kpi("Net worth", F.inr(assets + liabilities), assets + liabilities < 0 ? "neg" : "", `on ${F.day(asOf)}`)}
        ${BC.ui.kpi("Assets", F.inr(assets), "assets")}
        ${BC.ui.kpi("Liabilities", F.inr(liabilities), "liabilities")}
        ${BC.ui.kpi("Change in period", (assets + liabilities - before >= 0 ? "+" : "") + F.inr(assets + liabilities - before), assets + liabilities - before < 0 ? "neg" : "", `${F.day(from)} – ${F.day(asOf)}`)}
      </section>
      <div class="toolbar">
        <label class="check"><input type="checkbox" id="nw-hidden" ${opts.hidden ? "checked" : ""}> Include hidden accounts${hiddenWithBalance.length ? ` <span class="tag">${hiddenWithBalance.length} hold a balance</span>` : ""}</label>
      </div>
      <section class="card">
        <div class="card-head"><h2>Net worth over time</h2></div>
        <div class="legend">
          <span class="sw line" style="background:var(--text-primary)"></span>Net worth
          <span class="sw" style="background:var(--assets)"></span>Assets
          <span class="sw" style="background:var(--liabilities)"></span>Liabilities
        </div>
        <div id="nw-chart" class="chart tall"></div>
        <p class="note">Month-end balances (the last point is the end of the selected period), built from every recorded transaction. Investments are at the amount you put in; Bluecoins doesn't store market value.</p>
      </section>
      <section class="card">
        <div class="card-head"><h2>Account balances on ${F.day(asOf)}</h2>
          <label class="check small"><input type="checkbox" id="nw-zero" ${opts.zero ? "checked" : ""}> Show zero-balance accounts</label>
        </div>
        <div class="table-wrap"><table class="data">
          <thead><tr><th>Account</th><th>Type</th><th class="num">Balance</th><th>Last activity</th></tr></thead>
          <tbody id="nw-rows"></tbody>
        </table></div>
      </section>
      <section class="card" id="dq"></section>`;

    el.querySelector("#nw-hidden").addEventListener("change", (e) => { opts.hidden = e.target.checked; render(el, ctx); });
    el.querySelector("#nw-zero").addEventListener("change", (e) => { opts.zero = e.target.checked; render(el, ctx); });

    drawSeries(el, ds, t, from, asOf, f.accounts);

    // Account table, grouped by accounting group then sorted by balance size.
    const rows = visible.filter((b) => opts.zero || Math.abs(b.balance) >= 1);
    const groups = {};
    rows.forEach((b) => (groups[b.grp || "Other"] = groups[b.grp || "Other"] || []).push(b));
    const order = Object.keys(groups).sort((a, b) => rank(a) - rank(b));
    el.querySelector("#nw-rows").innerHTML = order.map((g) => {
      const list = groups[g].sort((a, b) => Math.abs(b.balance) - Math.abs(a.balance));
      const total = list.reduce((s, b) => s + b.balance, 0);
      return `<tr class="group"><th colspan="2">${F.esc(g)}</th><th class="num">${F.inr(total)}</th><th></th></tr>` +
        list.map((b) => {
          const odd = isAssets(b.grp) && b.balance < -0.5;
          return `<tr>
            <td>${F.esc(b.name)}${b.hidden ? ' <span class="tag">hidden</span>' : ""}${odd ? ' <span class="tag warn" title="An asset account with a negative balance usually means a missing transaction">⚠ negative</span>' : ""}</td>
            <td class="muted">${F.esc(b.type)}</td>
            <td class="num ${b.balance < 0 ? "neg" : ""}">${F.inr2(b.balance)}</td>
            <td class="muted">${F.day(b.lastActivity)}</td></tr>`;
        }).join("");
    }).join("") || `<tr><td colspan="4" class="empty">No accounts to show.</td></tr>`;

    // Data quality
    const dq = BC.q.dataQuality(ds);
    const negAssets = visible.filter((b) => isAssets(b.grp) && b.balance < -0.5);
    const items = [];
    if (dq.oneSidedTransfers.n) items.push(`<b>${dq.oneSidedTransfers.n} transfer${dq.oneSidedTransfers.n === 1 ? " is" : "s are"} missing the other half</b> (net ${F.inr(dq.oneSidedTransfers.total)}). Money left one account without arriving in another, so balances and net worth are off by that much.`);
    if (negAssets.length) items.push(`<b>${negAssets.length} asset account${negAssets.length === 1 ? " has" : "s have"} a negative balance:</b> ${negAssets.map((b) => `${F.esc(b.name)} (${F.inr(b.balance)})`).join(", ")}. Usually an income or transfer into it wasn't recorded.`);
    if (hiddenWithBalance.length) items.push(`<b>${hiddenWithBalance.length} hidden account${hiddenWithBalance.length === 1 ? " still holds" : "s still hold"} money:</b> ${hiddenWithBalance.map((b) => `${F.esc(b.name)} (${F.inr(b.balance)})`).join(", ")}. ${opts.hidden ? "They're included above." : "Tick “Include hidden accounts” to count them."}`);
    if (other.some((b) => Math.abs(b.balance) >= 1)) items.push(`<b>Some accounts aren't in Assets or Liabilities</b> and are left out of net worth: ${other.filter((b) => Math.abs(b.balance) >= 1).map((b) => F.esc(b.name)).join(", ")}.`);
    if (dq.orphanLabels) items.push(`<b>${dq.orphanLabels} label${dq.orphanLabels === 1 ? "" : "s"}</b> point at transactions that were deleted.`);
    if (dq.futureActuals) items.push(`<b>${dq.futureActuals} transaction${dq.futureActuals === 1 ? " is" : "s are"} dated in the future</b> but not marked as reminders. They're counted in balances.`);
    el.querySelector("#dq").innerHTML = `<div class="card-head"><h2>Data quality</h2></div>` +
      (items.length ? `<ul class="dq">${items.map((i) => `<li>${i}</li>`).join("")}</ul>` : `<p class="muted">No problems found.</p>`);
  }

  function drawSeries(el, ds, t, from, asOf, accounts) {
    const changes = BC.q.netWorthChanges(ds, opts.hidden, asOf, accounts);
    const holder = el.querySelector("#nw-chart");
    if (!changes.length) { holder.innerHTML = `<p class="empty">No transactions yet.</p>`; return; }
    const months = F.monthsBetween(changes[0].month, asOf.slice(0, 7));
    const delta = {};
    changes.forEach((c) => {
      const k = isAssets(c.grp) ? "a" : isLiab(c.grp) ? "l" : null;
      if (!k) return;
      delta[c.month] = delta[c.month] || { a: 0, l: 0 };
      delta[c.month][k] += c.change;
    });
    let a = 0, l = 0;
    const A = [], L = [], N = [];
    months.forEach((m) => {
      if (delta[m]) { a += delta[m].a; l += delta[m].l; }
      A.push(round(a)); L.push(round(l)); N.push(round(a + l));
    });
    // Show the selected period (at least two points so a single month still draws a line).
    let cut = Math.max(0, months.indexOf(from.slice(0, 7)));
    if (months.indexOf(from.slice(0, 7)) < 0 && from.slice(0, 7) > months[0]) cut = months.length - 1;
    cut = Math.min(cut, Math.max(0, months.length - 2));
    const xs = months.slice(cut);

    BC.charts.mount(holder, {
      ...BC.charts.base(t),
      grid: { left: 8, right: 16, top: 16, bottom: 8, containLabel: true },
      tooltip: {
        ...BC.charts.base(t).tooltip, trigger: "axis",
        axisPointer: { type: "line", lineStyle: { color: t.muted, type: "dashed" } },
        formatter: (ps) => `<b>${F.month(ps[0].axisValue)}</b><br>` + ps.map((p) => `${BC.ui.dot(p.color)}${p.seriesName} <b>${F.inr(p.value)}</b>`).join("<br>"),
      },
      xAxis: { type: "category", data: xs, boundaryGap: false, ...BC.charts.axisStyle(t), splitLine: { show: false }, axisLabel: { ...BC.charts.axisStyle(t).axisLabel, formatter: F.monthShort } },
      yAxis: { type: "value", ...BC.charts.axisStyle(t), axisLabel: { ...BC.charts.axisStyle(t).axisLabel, formatter: F.compact } },
      series: [
        line("Assets", A.slice(cut), t.assets, 2),
        line("Liabilities", L.slice(cut), t.liabilities, 2),
        { ...line("Net worth", N.slice(cut), t.net, 2.5), areaStyle: { color: t.net, opacity: 0.06 } },
      ],
    });
  }

  const line = (name, data, color, width) => ({
    name, type: "line", data, showSymbol: false, symbolSize: 8, lineStyle: { width, color }, itemStyle: { color },
    emphasis: { focus: "series" },
  });
  const round = (v) => Math.round(v * 100) / 100;
  const rank = (g) => (isAssets(g) ? 0 : isLiab(g) ? 1 : 2);

  BC.views = BC.views || {};
  BC.views.networth = { render };
})((window.BC = window.BC || {}));
