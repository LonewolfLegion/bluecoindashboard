/* Transactions explorer: search, filter, sort, page and export. */
(function (BC) {
  "use strict";
  const F = BC.fmt;
  const T = BC.db.TYPE;
  const TYPE_NAMES = { [T.OPENING]: "Opening balance", [T.EXPENSE]: "Expense", [T.INCOME]: "Income", [T.TRANSFER]: "Transfer" };
  const PAGE = 50;
  const st = { q: "", type: "", parent: "", label: "", min: "", max: "", sort: "date", dir: -1, page: 0 };

  const COLS = [
    { key: "date", label: "Date" },
    { key: "payee", label: "Payee / item" },
    { key: "category", label: "Category" },
    { key: "account", label: "Account" },
    { key: "labels", label: "Labels" },
    { key: "amt", label: "Amount", num: true },
  ];

  function render(el, ctx) {
    const all = BC.q.transactions(ctx.ds, ctx.filters);
    const parents = [...new Set(all.map((r) => r.parentCategory))].sort((a, b) => a.localeCompare(b));
    const labels = BC.q.labels(ctx.ds);

    el.innerHTML = `
      <section class="card">
        <div class="tx-filters">
          <label class="field grow"><span>Search</span><input type="search" id="tx-q" placeholder="Payee, notes, category, account, label…" value="${F.esc(st.q)}"></label>
          <label class="field"><span>Type</span><select id="tx-type"><option value="">All types</option>
            ${Object.entries(TYPE_NAMES).map(([k, v]) => `<option value="${k}" ${st.type === k ? "selected" : ""}>${v}</option>`).join("")}</select></label>
          <label class="field"><span>Category</span><select id="tx-parent"><option value="">All categories</option>
            ${parents.map((p) => `<option ${st.parent === p ? "selected" : ""}>${F.esc(p)}</option>`).join("")}</select></label>
          <label class="field"><span>Label</span><select id="tx-label"><option value="">Any label</option>
            ${labels.map((l) => `<option value="${F.esc(l.label)}" ${st.label === l.label ? "selected" : ""}>${F.esc(l.label)}</option>`).join("")}</select></label>
          <label class="field narrow"><span>Min ₹</span><input type="number" id="tx-min" min="0" value="${F.esc(st.min)}"></label>
          <label class="field narrow"><span>Max ₹</span><input type="number" id="tx-max" min="0" value="${F.esc(st.max)}"></label>
          <button class="btn small ghost" id="tx-reset">Reset</button>
        </div>
        <div class="tx-summary" id="tx-summary"></div>
        <div class="table-wrap"><table class="data tx">
          <thead><tr>${COLS.map((c) => `<th class="${c.num ? "num" : ""} sortable" data-key="${c.key}" aria-sort="${st.sort === c.key ? (st.dir > 0 ? "ascending" : "descending") : "none"}">${c.label}${st.sort === c.key ? (st.dir > 0 ? " ↑" : " ↓") : ""}</th>`).join("")}</tr></thead>
          <tbody id="tx-rows"></tbody>
        </table></div>
        <div class="pager" id="tx-pager"></div>
      </section>`;

    const bind = (id, key, ev = "change") => el.querySelector(id).addEventListener(ev, (e) => { st[key] = e.target.value; st.page = 0; update(); });
    bind("#tx-q", "q", "input");
    bind("#tx-type", "type");
    bind("#tx-parent", "parent");
    bind("#tx-label", "label");
    bind("#tx-min", "min", "input");
    bind("#tx-max", "max", "input");
    el.querySelector("#tx-reset").addEventListener("click", () => {
      Object.assign(st, { q: "", type: "", parent: "", label: "", min: "", max: "", page: 0 });
      render(el, ctx);
    });
    el.querySelectorAll("th.sortable").forEach((th) => th.addEventListener("click", () => {
      const k = th.dataset.key;
      st.dir = st.sort === k ? -st.dir : k === "date" || k === "amt" ? -1 : 1;
      st.sort = k;
      st.page = 0;
      render(el, ctx);
    }));

    let current = [];
    function update() {
      current = filter(all);
      const n = current.length;
      const inflow = current.reduce((s, r) => s + (r.amt > 0 ? r.amt : 0), 0);
      const outflow = current.reduce((s, r) => s + (r.amt < 0 ? -r.amt : 0), 0);
      el.querySelector("#tx-summary").innerHTML = `
        <span><b>${F.num(n)}</b> of ${F.num(all.length)} transactions</span>
        <span>In <b class="pos">${F.inr(inflow)}</b></span>
        <span>Out <b class="neg">${F.inr(outflow)}</b></span>
        <button class="btn small" id="tx-csv" ${n ? "" : "disabled"}>Download CSV</button>`;
      el.querySelector("#tx-csv").addEventListener("click", () => downloadCsv(current));

      const pages = Math.max(1, Math.ceil(n / PAGE));
      st.page = Math.min(st.page, pages - 1);
      const slice = current.slice(st.page * PAGE, st.page * PAGE + PAGE);
      el.querySelector("#tx-rows").innerHTML = slice.map(row).join("") ||
        `<tr><td colspan="${COLS.length}" class="empty">No transactions match these filters.</td></tr>`;
      el.querySelector("#tx-pager").innerHTML = pages > 1 ? `
        <button class="btn small ghost" data-p="prev" ${st.page === 0 ? "disabled" : ""}>← Newer</button>
        <span>Page ${st.page + 1} of ${pages}</span>
        <button class="btn small ghost" data-p="next" ${st.page >= pages - 1 ? "disabled" : ""}>Older →</button>` : "";
      el.querySelectorAll("#tx-pager button").forEach((b) => b.addEventListener("click", () => {
        st.page += b.dataset.p === "next" ? 1 : -1;
        update();
        el.querySelector(".table-wrap").scrollIntoView({ block: "nearest" });
      }));
    }
    update();
  }

  function filter(rows) {
    const q = st.q.trim().toLowerCase();
    const min = st.min === "" ? null : +st.min, max = st.max === "" ? null : +st.max;
    const out = rows.filter((r) => {
      if (st.type && r.typeId !== +st.type) return false;
      if (st.parent && r.parentCategory !== st.parent) return false;
      if (st.label && !(r.labels || "").split(", ").includes(st.label)) return false;
      const a = Math.abs(r.amt);
      if (min !== null && a < min) return false;
      if (max !== null && a > max) return false;
      if (q && !`${r.payee} ${r.notes} ${r.category} ${r.parentCategory} ${r.account} ${r.labels || ""}`.toLowerCase().includes(q)) return false;
      return true;
    });
    const k = st.sort, d = st.dir;
    out.sort((a, b) => {
      const x = a[k] == null ? "" : a[k], y = b[k] == null ? "" : b[k];
      const c = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y));
      return c * d || (b.date > a.date ? 1 : -1);
    });
    return out;
  }

  function row(r) {
    const cat = r.typeId === T.TRANSFER ? "Transfer" : r.category === r.parentCategory ? r.category : `${r.parentCategory} › ${r.category}`;
    return `<tr>
      <td class="nowrap">${F.day(r.day)}</td>
      <td><div>${F.esc(r.payee) || '<span class="muted">—</span>'}${r.splitId ? ' <span class="tag" title="Part of a split transaction">split</span>' : ""}</div>${r.notes ? `<div class="sub">${F.esc(r.notes)}</div>` : ""}</td>
      <td>${F.esc(cat)}${r.typeId === T.OPENING ? ' <span class="tag">opening</span>' : ""}</td>
      <td class="muted">${F.esc(r.account)}</td>
      <td>${(r.labels || "").split(", ").filter(Boolean).map((l) => `<span class="chip">${F.esc(l)}</span>`).join("")}</td>
      <td class="num ${r.amt < 0 ? "neg" : "pos"}">${F.inr2(r.amt)}${r.currency && r.currency !== "INR" ? ` <span class="tag">${F.esc(r.currency)}</span>` : ""}</td>
    </tr>`;
  }

  function downloadCsv(rows) {
    const head = ["Date", "Type", "Payee", "Notes", "Parent category", "Category", "Account", "Labels", "Amount (INR)", "Currency"];
    const cell = (v) => {
      const s = String(v == null ? "" : v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [head.join(",")].concat(rows.map((r) => [
      r.date, TYPE_NAMES[r.typeId] || r.typeId, r.payee, r.notes, r.parentCategory, r.category, r.account, r.labels || "", r.amt.toFixed(2), r.currency || "",
    ].map(cell).join(",")));
    const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `bluecoins-transactions-${F.today()}.csv`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }

  BC.views = BC.views || {};
  BC.views.transactions = { render };
})((window.BC = window.BC || {}));
