/* Formatting helpers: INR with Indian digit grouping, dates, HTML escaping. */
(function (BC) {
  "use strict";
  const inr0 = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 });
  const inr2 = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const num = new Intl.NumberFormat("en-IN");
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  // Compact Indian units: 1.2 K, 3.4 L (lakh), 1.1 Cr (crore).
  function compact(v) {
    const a = Math.abs(v), sign = v < 0 ? "−" : "";
    if (a >= 1e7) return `${sign}₹${(a / 1e7).toFixed(a >= 1e8 ? 0 : 1)} Cr`;
    if (a >= 1e4) return `${sign}₹${+(a / 1e5).toFixed(a >= 1e6 ? 0 : a >= 1e5 ? 1 : 2)} L`;
    if (a >= 1e3) return `${sign}₹${(a / 1e3).toFixed(a >= 1e4 ? 0 : 1)} K`;
    return `${sign}₹${Math.round(a)}`;
  }

  const pad = (n) => String(n).padStart(2, "0");
  const isoDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

  BC.fmt = {
    inr: (v) => inr0.format(v || 0).replace("-", "−"),
    inr2: (v) => inr2.format(v || 0).replace("-", "−"),
    compact,
    num: (v) => num.format(v || 0),
    pct: (v) => (isFinite(v) ? `${(v * 100).toFixed(1)}%` : "—"),
    isoDay,
    today: () => isoDay(new Date()),
    addDays(day, n) {
      const d = new Date(day + "T00:00:00");
      d.setDate(d.getDate() + n);
      return isoDay(d);
    },
    month(m) { // "2026-09" -> "Sep 2026"
      const [y, mo] = m.split("-");
      return `${MONTHS[+mo - 1]} ${y}`;
    },
    monthShort(m) { // "2026-09" -> "Sep ’26"
      const [y, mo] = m.split("-");
      return `${MONTHS[+mo - 1]} ’${y.slice(2)}`;
    },
    day(d) { // "2026-09-21" -> "21 Sep 2026"
      if (!d) return "";
      const [y, mo, dd] = d.slice(0, 10).split("-");
      return `${+dd} ${MONTHS[+mo - 1]} ${y}`;
    },
    // Every "YYYY-MM" from a to b inclusive.
    monthsBetween(a, b) {
      const out = [];
      let [y, m] = a.split("-").map(Number);
      const [y2, m2] = b.split("-").map(Number);
      while (y < y2 || (y === y2 && m <= m2)) {
        out.push(`${y}-${pad(m)}`);
        if (++m > 12) { m = 1; y++; }
      }
      return out;
    },
    esc(s) {
      return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    },
  };
})((window.BC = window.BC || {}));
