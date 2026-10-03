/* Category trend: net spending (expenses minus refunds) of one category over the selected period. */
(function (BC) {
  "use strict";
  const F = BC.fmt;
  const st = { sel: null, grain: "month" }; // sel: "p:<parentId>" or "c:<categoryId>"
  const GRAINS = [["month", "Monthly", "month"], ["quarter", "Quarterly", "quarter"], ["year", "Yearly", "year"]];

  function render(el, ctx) {
    const { ds, filters } = ctx;
    const t = BC.charts.theme();
    const today = F.today();
    const f = { ...filters, from: filters.from || (ctx.range && ctx.range.first) || today, to: filters.to || today };

    // Picker options: every expense parent, followed by its sub-categories.
    const cats = BC.q.expenseCategories(ds);
    const parents = [];
    const byParent = {};
    cats.forEach((c) => {
      if (!byParent[c.parentId]) { byParent[c.parentId] = { id: c.parentId, name: c.parent, children: [] }; parents.push(byParent[c.parentId]); }
      byParent[c.parentId].children.push(c);
    });
    parents.sort((a, b) => a.name.localeCompare(b.name));

    if (!parents.length) { el.innerHTML = `<section class="card"><p class="empty">There are no expenses in this backup.</p></section>`; return; }

    // Default to the biggest category in the period.
    if (!st.sel || !isValid(st.sel, byParent, cats)) {
      const top = BC.q.spendByCategory(ds, f, null)[0];
      st.sel = `p:${top ? top.id : parents[0].id}`;
    }
    const [lvl, idStr] = st.sel.split(":");
    const sel = { level: lvl === "p" ? "parent" : "child", id: Number(idStr) };
    const selName = sel.level === "parent"
      ? byParent[sel.id].name
      : (() => { const c = cats.find((x) => x.id === sel.id); return c.parent === c.name ? c.name : `${c.parent} › ${c.name}`; })();
    const grainWord = GRAINS.find((g) => g[0] === st.grain)[2];

    const rows = BC.q.categorySeries(ds, f, sel, st.grain);
    const buckets = bucketsBetween(f.from, f.to, st.grain);
    const byBucket = Object.fromEntries(rows.map((r) => [r.bucket, r]));
    const values = buckets.map((b) => round((byBucket[b] || {}).net || 0));
    const counts = buckets.map((b) => (byBucket[b] || {}).n || 0);
    const net = values.reduce((s, v) => s + v, 0);
    const n = counts.reduce((s, v) => s + v, 0);
    const avg = buckets.length ? net / buckets.length : 0;
    let hi = -1;
    values.forEach((v, i) => { if (hi < 0 || v > values[hi]) hi = i; });
    const allSpend = BC.q.totals(ds, f).expense;

    el.innerHTML = `
      <section class="card picker-card">
        <label class="field grow"><span>Category</span>
          <select id="cat-pick">
            ${parents.map((p) => `
              <optgroup label="${F.esc(p.name)}">
                <option value="p:${p.id}" ${st.sel === `p:${p.id}` ? "selected" : ""}>All of ${F.esc(p.name)}</option>
                ${p.children.length > 1 || (p.children[0] && p.children[0].name !== p.name)
                  ? p.children.map((c) => `<option value="c:${c.id}" ${st.sel === `c:${c.id}` ? "selected" : ""}>&nbsp;&nbsp;${F.esc(c.name)}</option>`).join("")
                  : ""}
              </optgroup>`).join("")}
          </select>
        </label>
        <div class="field"><span>Group by</span>
          <div class="seg" role="group" aria-label="Group by">
            ${GRAINS.map(([k, l]) => `<button class="${st.grain === k ? "on" : ""}" data-grain="${k}">${l}</button>`).join("")}
          </div>
        </div>
      </section>
      <section class="kpis">
        ${BC.ui.kpi("Net spending", F.inr(net), "expense", `${F.day(f.from)} – ${F.day(f.to)}`)}
        ${BC.ui.kpi(`Average per ${grainWord}`, F.inr(avg), "", `${buckets.length} ${grainWord}${buckets.length === 1 ? "" : "s"}`)}
        ${BC.ui.kpi(`Highest ${grainWord}`, hi >= 0 && values[hi] > 0 ? F.inr(values[hi]) : "—", "", hi >= 0 && values[hi] > 0 ? label(buckets[hi], st.grain, true) : "")}
        ${BC.ui.kpi("Share of all spending", allSpend > 0 ? F.pct(net / allSpend) : "—", "", `${F.num(n)} transaction${n === 1 ? "" : "s"}`)}
      </section>
      <section class="card">
        <div class="card-head"><h2>${F.esc(selName)}: net spending by ${grainWord}</h2>
          <div class="legend"><span class="sw" style="background:var(--expense)"></span>Net spending<span class="sw line dashed"></span>Average</div></div>
        <div id="cat-chart" class="chart tall"></div>
        <p class="note">Net spending = expenses minus any refunds booked to this category. Transfers aren't included.</p>
      </section>
      <div class="grid-2" id="cat-lower"></div>`;

    el.querySelector("#cat-pick").addEventListener("change", (e) => { st.sel = e.target.value; render(el, ctx); });
    el.querySelectorAll("[data-grain]").forEach((b) => b.addEventListener("click", () => { st.grain = b.dataset.grain; render(el, ctx); }));

    // Chart
    const holder = el.querySelector("#cat-chart");
    if (!n) {
      holder.innerHTML = `<p class="empty">No spending in ${F.esc(selName)} in this period.</p>`;
    } else {
      BC.charts.mount(holder, {
        ...BC.charts.base(t),
        grid: { left: 8, right: 16, top: 24, bottom: 8, containLabel: true },
        tooltip: {
          ...BC.charts.base(t).tooltip, trigger: "axis", axisPointer: { type: "shadow", shadowStyle: { color: "rgba(127,127,127,.08)" } },
          formatter: (ps) => {
            const i = ps[0].dataIndex;
            return `<b>${label(buckets[i], st.grain, true)}</b><br>${BC.ui.dot(t.expense)}Net spending <b>${F.inr(values[i])}</b><br><span style="color:${t.muted}">${counts[i]} transaction${counts[i] === 1 ? "" : "s"}</span>`;
          },
        },
        xAxis: { type: "category", data: buckets, ...BC.charts.axisStyle(t), splitLine: { show: false },
          axisLabel: { ...BC.charts.axisStyle(t).axisLabel, formatter: (b) => label(b, st.grain, false) } },
        yAxis: { type: "value", ...BC.charts.axisStyle(t), axisLabel: { ...BC.charts.axisStyle(t).axisLabel, formatter: F.compact } },
        series: [{
          name: "Net spending", type: "bar", data: values, barMaxWidth: 36,
          itemStyle: { color: t.expense, borderRadius: [4, 4, 0, 0] },
          markLine: buckets.length > 1 ? {
            symbol: "none", silent: true,
            lineStyle: { color: t.muted, type: "dashed", width: 1.5 },
            label: { formatter: () => `Avg ${F.compact(avg)}`, color: t.text2, fontSize: 11, position: "insideEndTop" },
            data: [{ yAxis: avg }],
          } : undefined,
        }],
      });
    }

    // Lower panels: sub-category split (for a parent) and the transactions themselves.
    const lower = el.querySelector("#cat-lower");
    const split = sel.level === "parent" ? BC.q.categoryBreakdown(ds, f, sel.id) : [];
    const txs = BC.q.categoryTransactions(ds, f, sel);
    const LIMIT = 100;
    const showSplit = split.length > 1;
    lower.className = showSplit ? "grid-2 wide-right" : "";
    lower.innerHTML = `
      ${showSplit ? `<section class="card"><div class="card-head"><h2>By sub-category</h2></div><ol id="cat-split" class="bar-list"></ol>
        <p class="note">Click a sub-category to see its own trend.</p></section>` : ""}
      <section class="card">
        <div class="card-head"><h2>Transactions</h2><span class="muted">${txs.length > LIMIT ? `Latest ${LIMIT} of ${F.num(txs.length)}` : `${F.num(txs.length)}`}</span></div>
        <div class="table-wrap"><table class="data">
          <thead><tr><th>Date</th><th>Payee / item</th>${sel.level === "parent" ? "<th>Sub-category</th>" : ""}<th>Account</th><th class="num">Amount</th></tr></thead>
          <tbody>${txs.slice(0, LIMIT).map((r) => `<tr>
            <td class="nowrap">${F.day(r.day)}</td>
            <td><div>${F.esc(r.payee) || '<span class="muted">—</span>'}</div>${r.notes ? `<div class="sub">${F.esc(r.notes)}</div>` : ""}</td>
            ${sel.level === "parent" ? `<td>${F.esc(r.category)}</td>` : ""}
            <td class="muted">${F.esc(r.account)}</td>
            <td class="num ${r.amt < 0 ? "neg" : "pos"}">${F.inr2(r.amt)}</td></tr>`).join("") ||
            `<tr><td colspan="5" class="empty">No transactions in this period.</td></tr>`}</tbody>
        </table></div>
      </section>`;

    if (showSplit) {
      const ol = el.querySelector("#cat-split");
      const max = Math.max(...split.map((r) => r.value), 1);
      ol.innerHTML = split.map((r) => `
        <li class="clickable" data-id="${r.id}" tabindex="0">
          <div class="row"><span class="name">${F.esc(r.name)}</span><span class="val">${F.inr(r.value)}</span></div>
          <div class="bar"><span style="width:${Math.max(2, (Math.max(r.value, 0) / max) * 100)}%;background:var(--expense)"></span></div>
          <div class="sub">${net > 0 ? F.pct(r.value / net) + " · " : ""}${F.num(r.n)} transaction${r.n === 1 ? "" : "s"}</div>
        </li>`).join("");
      ol.querySelectorAll("li").forEach((li) => {
        const go = () => { st.sel = `c:${li.dataset.id}`; render(el, ctx); window.scrollTo({ top: 0, behavior: "smooth" }); };
        li.addEventListener("click", go);
        li.addEventListener("keydown", (e) => e.key === "Enter" && go());
      });
    }
  }

  function isValid(sel, byParent, cats) {
    const [lvl, id] = sel.split(":");
    return lvl === "p" ? !!byParent[id] : cats.some((c) => String(c.id) === id);
  }

  // Every bucket key between two days, so empty months still show as zero.
  function bucketsBetween(from, to, grain) {
    const months = F.monthsBetween(from.slice(0, 7), to.slice(0, 7));
    if (grain === "month") return months;
    const keys = months.map((m) => (grain === "year" ? m.slice(0, 4) : `${m.slice(0, 4)}-Q${Math.ceil(+m.slice(5, 7) / 3)}`));
    return [...new Set(keys)];
  }

  function label(b, grain, long) {
    if (grain === "month") return long ? F.month(b) : F.monthShort(b);
    if (grain === "quarter") { const [y, q] = b.split("-"); return long ? `${q} ${y}` : `${q} ’${y.slice(2)}`; }
    return b;
  }

  const round = (v) => Math.round(v * 100) / 100;

  BC.views = BC.views || {};
  BC.views.category = { render };
})((window.BC = window.BC || {}));
