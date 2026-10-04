/* Unit tests for js/forecast.js. Run: node tools/test-forecast.js (no npm install needed). */
"use strict";
const assert = require("assert");
const path = require("path");
const FC = require(path.join(__dirname, "..", "js", "forecast.js"));

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log("  ok  " + name); }
  catch (e) { console.error("  FAIL " + name + "\n       " + e.message); process.exitCode = 1; }
}
const near = (a, b, eps = 1e-6, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg || ""} expected ${b}, got ${a}`);

test("exact line y = 2x + 5: slope 2, intercept 5, no band", () => {
  const ys = [0, 1, 2, 3, 4, 5].map((x) => 2 * x + 5);
  const f = FC.linearFit(ys);
  near(f.b, 2); near(f.a, 5); near(f.sigma, 0); near(f.r2, 1);
  const p = FC.project(f, 3);
  near(p[0].value, 2 * 6 + 5);
  near(p[2].value, 2 * 8 + 5);
  p.forEach((q) => { near(q.lo, q.value); near(q.hi, q.value); });
});

test("noisy data: band exists and widens with the horizon", () => {
  const noise = [3, -2, 4, -5, 1, 2, -3, 0, 4, -4, 2, -2];
  const ys = noise.map((e, x) => 1000 + 50 * x + e * 10);
  const f = FC.linearFit(ys);
  assert.ok(f.sigma > 0, "sigma > 0");
  assert.ok(f.r2 > 0.9 && f.r2 < 1, "r2 between 0.9 and 1");
  const p = FC.project(f, 12);
  for (let i = 1; i < p.length; i++) {
    assert.ok(p[i].hi - p[i].lo > p[i - 1].hi - p[i - 1].lo, `band at h=${i + 1} wider than h=${i}`);
  }
  p.forEach((q) => { assert.ok(q.lo < q.value && q.value < q.hi); });
});

test("fewer than 3 points: flat forecast at the last value", () => {
  [[], [42], [10, 20]].forEach((ys) => {
    const f = FC.linearFit(ys);
    assert.ok(f.flat);
    const p = FC.project(f, 4);
    p.forEach((q) => { near(q.value, ys.length ? ys[ys.length - 1] : 0); near(q.hi - q.lo, 0); });
  });
});

test("constant series: zero slope, no band, R² undefined", () => {
  const f = FC.linearFit([500, 500, 500, 500]);
  near(f.b, 0); near(f.sigma, 0);
  assert.ok(Number.isNaN(f.r2));
});

test("point forecasts add up: sum of account forecasts = forecast of the sum", () => {
  const a = [100, 140, 130, 190, 210, 260], b = [-50, -45, -60, -30, -20, -25], c = [0, 0, 10, 10, 400, 380];
  const total = FC.sumSeries([a, b, c], a.length);
  const pa = FC.project(FC.linearFit(a), 6), pb = FC.project(FC.linearFit(b), 6), pc = FC.project(FC.linearFit(c), 6);
  const pt = FC.project(FC.linearFit(total), 6);
  pt.forEach((q, i) => near(q.value, pa[i].value + pb[i].value + pc[i].value, 1e-6, `h=${i + 1}`));
});

test("month helpers", () => {
  assert.strictEqual(FC.addMonths("2026-11", 3), "2027-02");
  assert.strictEqual(FC.addMonths("2026-01", -1), "2025-12");
  assert.strictEqual(FC.addMonths("2026-01", -13), "2024-12");
  assert.deepStrictEqual(FC.monthsBetween("2025-11", "2026-02"), ["2025-11", "2025-12", "2026-01", "2026-02"]);
  assert.strictEqual(FC.monthEndDay("2024-02"), "2024-02-29");
  assert.strictEqual(FC.monthEndDay("2026-09"), "2026-09-30");
  assert.strictEqual(FC.monthEndDay("2026-12"), "2026-12-31");
});

test("month-end balances carry forward through quiet months", () => {
  const rows = [
    { accountId: 1, month: "2026-01", net: 1000 },
    { accountId: 1, month: "2026-03", net: -200 },
    { accountId: 2, month: "2026-02", net: 50 },
  ];
  const { months, balances } = FC.monthEndBalances(rows, "2026-01", "2026-04");
  assert.deepStrictEqual(months, ["2026-01", "2026-02", "2026-03", "2026-04"]);
  assert.deepStrictEqual(balances.get(1), [1000, 1000, 800, 800]);
  assert.deepStrictEqual(balances.get(2), [0, 50, 50, 50]);
});

test("cumulative scheduled flows", () => {
  const out = FC.cumulativeByMonth(
    [{ month: "2026-10", amt: -100 }, { month: "2026-12", amt: 300 }, { month: "2026-10", amt: -50 }, { month: "2027-05", amt: 9 }],
    ["2026-10", "2026-11", "2026-12"]);
  assert.deepStrictEqual(out, [-150, -150, 150]);
});

test("a transfer between two accounts leaves the total unchanged", () => {
  const flows = [{ accountId: 1, month: "2026-11", amt: -5000 }, { accountId: 2, month: "2026-11", amt: 5000 }];
  const months = ["2026-10", "2026-11", "2026-12"];
  const a = FC.cumulativeByMonth(flows.filter((f) => f.accountId === 1), months);
  const b = FC.cumulativeByMonth(flows.filter((f) => f.accountId === 2), months);
  FC.sumSeries([a, b], 3).forEach((v) => near(v, 0));
});

console.log(`\n${passed} passed${process.exitCode ? ", some FAILED" : ""}`);
