/* Month-end balances and trend forecasting. Pure functions (no DOM, no SQL), so they can be tested in Node:
 *   node tools/test-forecast.js
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else { root.BC = root.BC || {}; root.BC.forecast = api; }
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  const Z80 = 1.2816; // two-sided 80% normal quantile

  const pad = (n) => String(n).padStart(2, "0");

  // "2026-09" + n months -> "YYYY-MM"
  function addMonths(m, n) {
    let [y, mo] = m.split("-").map(Number);
    mo += n;
    y += Math.floor((mo - 1) / 12);
    mo = ((mo - 1) % 12 + 12) % 12 + 1;
    return `${y}-${pad(mo)}`;
  }

  // Every "YYYY-MM" from a to b inclusive.
  function monthsBetween(a, b) {
    const out = [];
    for (let m = a; m <= b; m = addMonths(m, 1)) out.push(m);
    return out;
  }

  // Last calendar day of a "YYYY-MM" month as "YYYY-MM-DD".
  function monthEndDay(m) {
    const [y, mo] = m.split("-").map(Number);
    return `${m}-${pad(new Date(Date.UTC(y, mo, 0)).getUTCDate())}`;
  }

  /* Running month-end balance per account.
   * netRows: [{ accountId, month, net }] (net movement in that month).
   * Returns { months, balances: Map(accountId -> number[] aligned to months) }.
   * Months with no activity carry the previous balance forward; months before an account's
   * first transaction are 0, which is its true balance then. */
  function monthEndBalances(netRows, firstMonth, lastMonth) {
    const months = firstMonth && lastMonth && firstMonth <= lastMonth ? monthsBetween(firstMonth, lastMonth) : [];
    const idx = new Map(months.map((m, i) => [m, i]));
    const deltas = new Map();
    for (const r of netRows) {
      const i = idx.get(r.month);
      if (i === undefined) continue;
      if (!deltas.has(r.accountId)) deltas.set(r.accountId, new Array(months.length).fill(0));
      deltas.get(r.accountId)[i] += r.net;
    }
    const balances = new Map();
    for (const [id, d] of deltas) {
      let run = 0;
      balances.set(id, d.map((v) => (run += v)));
    }
    return { months, balances };
  }

  // Element-wise sum of equal-length arrays.
  function sumSeries(list, len) {
    const out = new Array(len).fill(0);
    for (const s of list) for (let i = 0; i < len; i++) out[i] += s[i];
    return out;
  }

  /* Ordinary least squares of ys against x = 0..n-1.
   * Returns { a, b, n, sigma, r2, xbar, sxx, last } where y ≈ a + b·x and sigma is the residual
   * standard error (n − 2 degrees of freedom). Fewer than 3 points -> flat line at the last value. */
  function linearFit(ys) {
    const n = ys.length;
    const last = n ? ys[n - 1] : 0;
    if (n < 3) {
      return { a: last, b: 0, n, sigma: 0, r2: NaN, xbar: 0, sxx: 0, last, flat: true };
    }
    const xbar = (n - 1) / 2;
    const ybar = ys.reduce((s, y) => s + y, 0) / n;
    let sxx = 0, sxy = 0, sst = 0;
    for (let i = 0; i < n; i++) {
      const dx = i - xbar, dy = ys[i] - ybar;
      sxx += dx * dx;
      sxy += dx * dy;
      sst += dy * dy;
    }
    const b = sxy / sxx;
    const a = ybar - b * xbar;
    let ssr = 0;
    for (let i = 0; i < n; i++) {
      const e = ys[i] - (a + b * i);
      ssr += e * e;
    }
    // Treat rounding noise as an exact fit.
    const scale = Math.max(1, Math.abs(ybar));
    if (ssr < 1e-12 * scale * scale * n) ssr = 0;
    const sigma = Math.sqrt(ssr / (n - 2));
    const r2 = sst > 0 ? 1 - ssr / sst : NaN;
    return { a, b, n, sigma, r2, xbar, sxx, last, flat: false };
  }

  // Fitted value at window index x (0..n-1 inside the window, n-1+h for h months ahead).
  function fitted(fit, x) {
    return fit.flat ? fit.last : fit.a + fit.b * x;
  }

  /* h = 1..H months after the last point in the fit window.
   * Returns [{ h, value, lo, hi }] with an 80% prediction interval. */
  function project(fit, H) {
    const out = [];
    for (let h = 1; h <= H; h++) {
      const x = fit.n - 1 + h;
      const value = fitted(fit, x);
      let half = 0;
      if (!fit.flat && fit.sigma > 0) {
        half = Z80 * fit.sigma * Math.sqrt(1 + 1 / fit.n + ((x - fit.xbar) ** 2) / fit.sxx);
      }
      out.push({ h, value, lo: value - half, hi: value + half });
    }
    return out;
  }

  /* Cumulative effect of dated cash flows on month-ends.
   * flows: [{ month, amt }], months: forecast month keys in order. Returns number[] aligned to months. */
  function cumulativeByMonth(flows, months) {
    const per = new Map(months.map((m) => [m, 0]));
    for (const f of flows) if (per.has(f.month)) per.set(f.month, per.get(f.month) + f.amt);
    let run = 0;
    return months.map((m) => (run += per.get(m)));
  }

  return { Z80, addMonths, monthsBetween, monthEndDay, monthEndBalances, sumSeries, linearFit, fitted, project, cumulativeByMonth };
});
