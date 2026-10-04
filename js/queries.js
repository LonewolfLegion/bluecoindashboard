/* Every SQL query the dashboard runs. All of them read the decoded TEMP VIEW `tx` (see db.js). */
(function (BC) {
  "use strict";
  const { TYPE } = BC.db;

  // Shared WHERE for actual (non-scheduled) rows inside the global date range and account filter.
  function scope(f, extra) {
    const where = ["isScheduled = 0"];
    const params = [];
    if (f.from) { where.push("day >= ?"); params.push(f.from); }
    if (f.to) { where.push("day <= ?"); params.push(f.to); }
    if (f.accounts && f.accounts.length) {
      where.push(`accountId IN (${f.accounts.map(() => "?").join(",")})`);
      params.push(...f.accounts);
    }
    if (extra) where.push(extra);
    return { where: "WHERE " + where.join(" AND "), params };
  }

  // Rows that count toward a category's net spending: expenses (and any income booked to it, e.g. refunds).
  function catScope(f, sel) {
    const col = sel.level === "parent" ? "parentCategoryId" : "categoryId";
    return scope(f, `typeId IN (${TYPE.EXPENSE}, ${TYPE.INCOME}) AND ${col} = ${Number(sel.id)}`);
  }

  const Q = {
    dataRange(ds) {
      return ds.one("SELECT min(day) AS first, max(day) AS last, count(*) AS n FROM tx WHERE isScheduled = 0");
    },

    accounts(ds) {
      return ds.all(`
        SELECT accountId AS id, account AS name, max(accountHidden) AS hidden, accountType AS type, accountingGroup AS grp
        FROM tx WHERE accountId IS NOT NULL GROUP BY accountId ORDER BY hidden, grp, name`);
    },

    totals(ds, f) {
      const s = scope(f);
      return ds.one(`
        SELECT COALESCE(sum(CASE WHEN typeId = ${TYPE.INCOME} THEN amt END), 0) AS income,
               COALESCE(-sum(CASE WHEN typeId = ${TYPE.EXPENSE} THEN amt END), 0) AS expense,
               count(CASE WHEN typeId IN (${TYPE.INCOME}, ${TYPE.EXPENSE}) THEN 1 END) AS n
        FROM tx ${s.where}`, s.params);
    },

    monthly(ds, f) {
      const s = scope(f, `typeId IN (${TYPE.INCOME}, ${TYPE.EXPENSE})`);
      return ds.all(`
        SELECT month,
               COALESCE(sum(CASE WHEN typeId = ${TYPE.INCOME} THEN amt END), 0) AS income,
               COALESCE(-sum(CASE WHEN typeId = ${TYPE.EXPENSE} THEN amt END), 0) AS expense
        FROM tx ${s.where} GROUP BY month ORDER BY month`, s.params);
    },

    // parentId null -> spend per parent category; otherwise per child inside that parent.
    spendByCategory(ds, f, parentId) {
      const drill = parentId !== null && parentId !== undefined;
      const s = scope(f, `typeId = ${TYPE.EXPENSE}` + (drill ? " AND parentCategoryId = ?" : ""));
      if (drill) s.params.push(parentId);
      return ds.all(`
        SELECT ${drill ? "categoryId AS id, category AS name" : "parentCategoryId AS id, parentCategory AS name"},
               -sum(amt) AS value, count(*) AS n
        FROM tx ${s.where} GROUP BY 1 HAVING value > 0 ORDER BY value DESC`, s.params);
    },

    topPayees(ds, f, n) {
      const s = scope(f, `typeId = ${TYPE.EXPENSE} AND payee <> ''`);
      return ds.all(`
        SELECT payee AS name, -sum(amt) AS value, count(*) AS n
        FROM tx ${s.where} GROUP BY payee HAVING value > 0 ORDER BY value DESC LIMIT ${n | 0}`, s.params);
    },

    // Balance of every account at the end of `asOf` (inclusive), optionally limited to some accounts.
    balances(ds, asOf, accounts) {
      const p = [asOf];
      let acc = "";
      if (accounts && accounts.length) { acc = `AND accountId IN (${accounts.map(() => "?").join(",")})`; p.push(...accounts); }
      return ds.all(`
        SELECT accountId AS id, account AS name, accountType AS type, accountingGroup AS grp,
               max(accountHidden) AS hidden, sum(amt) AS balance, max(day) AS lastActivity, count(*) AS n
        FROM tx WHERE isScheduled = 0 AND accountId IS NOT NULL AND day <= ? ${acc}
        GROUP BY accountId ORDER BY grp, type, name`, p);
    },

    // Monthly net change per accounting group up to `asOf`; the view turns it into running balances.
    netWorthChanges(ds, includeHidden, asOf, accounts) {
      const p = [asOf];
      let acc = "";
      if (accounts && accounts.length) { acc = `AND accountId IN (${accounts.map(() => "?").join(",")})`; p.push(...accounts); }
      return ds.all(`
        SELECT month, accountingGroup AS grp, sum(amt) AS change
        FROM tx WHERE isScheduled = 0 AND day <= ? ${includeHidden ? "" : "AND accountHidden = 0"} ${acc}
        GROUP BY month, grp ORDER BY month`, p);
    },

    transactions(ds, f) {
      const s = scope(f);
      return ds.all(`
        SELECT t.id, t.date, t.day, t.typeId, t.payee, t.notes, t.category, t.parentCategory, t.account,
               t.amt, t.splitId, t.currency,
               (SELECT group_concat(label, ', ') FROM (SELECT DISTINCT label FROM tx_labels l WHERE l.txId = t.id)) AS labels
        FROM tx t ${s.where.replace(/\b(isScheduled|day|accountId)\b/g, "t.$1")}
        ORDER BY t.date DESC, t.id DESC`, s.params);
    },

    // Expense categories for the Category trend picker: parents with their sub-categories.
    expenseCategories(ds) {
      return ds.all(`
        SELECT parentCategoryId AS parentId, parentCategory AS parent, categoryId AS id, category AS name,
               count(*) AS n, -sum(amt) AS total
        FROM tx WHERE isScheduled = 0 AND typeId = ${TYPE.EXPENSE} AND parentCategoryId IS NOT NULL
        GROUP BY parentCategoryId, categoryId ORDER BY parent, name`);
    },

    // Net spending (expenses minus refunds) for one parent or sub-category, per bucket.
    // grain: "month" | "quarter" | "year". sel: { level: "parent" | "child", id }.
    categorySeries(ds, f, sel, grain) {
      const bucket = {
        month: "month",
        quarter: "substr(day, 1, 4) || '-Q' || ((CAST(substr(day, 6, 2) AS INTEGER) + 2) / 3)",
        year: "substr(day, 1, 4)",
      }[grain];
      const s = catScope(f, sel);
      return ds.all(`SELECT ${bucket} AS bucket, -sum(amt) AS net, count(*) AS n FROM tx ${s.where} GROUP BY bucket ORDER BY bucket`, s.params);
    },

    // Sub-category split of a parent's net spending in the period.
    categoryBreakdown(ds, f, parentId) {
      const s = catScope(f, { level: "parent", id: parentId });
      return ds.all(`SELECT category AS name, categoryId AS id, -sum(amt) AS value, count(*) AS n FROM tx ${s.where}
                     GROUP BY categoryId ORDER BY value DESC`, s.params);
    },

    categoryTransactions(ds, f, sel) {
      const s = catScope(f, sel);
      return ds.all(`SELECT day, payee, notes, category, account, amt FROM tx ${s.where} ORDER BY date DESC, id DESC`, s.params);
    },

    labels(ds) {
      return ds.all("SELECT label, count(*) AS n FROM tx_labels WHERE label IS NOT NULL GROUP BY label ORDER BY label");
    },

    // ---- Month-end & Forecast ----

    // Net movement per account per month for actual rows up to `asOf`; the forecast lib turns it into month-end balances.
    monthlyAccountNet(ds, asOf) {
      return ds.all(`
        SELECT accountId, month, sum(amt) AS net
        FROM tx WHERE isScheduled = 0 AND accountId IS NOT NULL AND day <= ?
        GROUP BY accountId, month ORDER BY month`, [asOf]);
    },

    // Scheduled reminder rows dated after `afterDay` up to `toDay`. seriesCount = how many future rows the same
    // series has (all dates, not just this window); 1 means a one-off. A series is reminderGroupID when the backup
    // has it, otherwise payee + category + type, and always per account so both legs of a transfer count apart.
    scheduled(ds, afterDay, toDay) {
      return ds.all(`
        WITH r AS (
          SELECT accountId, month, day, payee, typeId, amt,
                 COALESCE('g' || reminderGroupId, 'p' || payee || '|' || COALESCE(categoryId, '') || '|' || typeId)
                   || '#' || COALESCE(accountId, '') AS sk
          FROM tx WHERE isScheduled = 1 AND accountId IS NOT NULL AND day > ?
        ),
        c AS (SELECT sk, count(*) AS n FROM r GROUP BY sk)
        SELECT r.accountId, r.month, r.day, r.payee, r.typeId, r.amt, c.n AS seriesCount
        FROM r JOIN c USING (sk) WHERE r.day <= ? ORDER BY r.day`, [afterDay, toDay]);
    },

    // Accounts that hold one half of a transfer whose other half is missing.
    oneSidedTransferAccounts(ds) {
      return ds.all(`
        SELECT accountId, count(*) AS n, sum(amt) AS total FROM tx
        WHERE isScheduled = 0 AND typeId = ${TYPE.TRANSFER} AND transferGroupId IS NOT NULL
          AND transferGroupId IN (SELECT transferGroupId FROM tx WHERE isScheduled = 0 AND typeId = ${TYPE.TRANSFER}
                                  GROUP BY transferGroupId HAVING count(*) = 1)
        GROUP BY accountId`);
    },

    // Problems in the data that change balances or totals.
    dataQuality(ds) {
      const out = {};
      out.oneSidedTransfers = ds.one(`
        SELECT count(*) AS n, COALESCE(sum(amt), 0) AS total FROM tx
        WHERE isScheduled = 0 AND typeId = ${TYPE.TRANSFER} AND transferGroupId IS NOT NULL
          AND transferGroupId IN (SELECT transferGroupId FROM tx WHERE isScheduled = 0 AND typeId = ${TYPE.TRANSFER}
                                  GROUP BY transferGroupId HAVING count(*) = 1)`);
      out.orphanLabels = ds.one(`SELECT count(*) AS n FROM tx_labels l WHERE l.txId NOT IN (SELECT id FROM tx)`).n;
      out.futureActuals = ds.one(`SELECT count(*) AS n FROM tx WHERE isScheduled = 0 AND date > datetime('now', 'localtime')`).n;
      return out;
    },
  };

  BC.q = Q;
})((window.BC = window.BC || {}));
