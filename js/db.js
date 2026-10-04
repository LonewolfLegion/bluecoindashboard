/* Loading the Bluecoins .fydb (SQLite) file, caching it locally, and mapping its schema.
 *
 * Decoding rules (see docs/data-model.md):
 *  - amount is an integer scaled by 1,000,000 and stored in the base currency (INR)
 *  - deletedTransaction: 6 = live, 5 = deleted  -> keep 6 only
 *  - reminderTransaction: NULL = actual, 9 = scheduled reminder
 *  - transactionTypeID: 2 opening balance, 3 expense, 4 income, 5 transfer
 */
(function (BC) {
  "use strict";

  const AMOUNT_SCALE = 1e6;
  const LIVE = 6;
  const REMINDER = 9;
  const TYPE = { OPENING: 2, EXPENSE: 3, INCOME: 4, TRANSFER: 5 };

  // Logical schema -> candidate column names (first match wins, case-insensitive).
  const SPEC = {
    tx: {
      table: ["TRANSACTIONSTABLE"],
      required: ["amount", "date", "type"],
      cols: {
        id: ["transactionsTableID", "transactionTableID"],
        amount: ["amount"], date: ["date"], type: ["transactionTypeID"],
        item: ["itemID"], category: ["categoryID"], account: ["accountID"], pairAccount: ["accountPairID"],
        notes: ["notes", "note"], deleted: ["deletedTransaction"], reminder: ["reminderTransaction"],
        transferGroup: ["transferGroupID"], split: ["newSplitTransactionID"],
        currency: ["transactionCurrency"], rate: ["conversionRateNew"], status: ["status"],
        reminderGroup: ["reminderGroupID"], reminderFrequency: ["reminderFrequency"], reminderRepeatEvery: ["reminderRepeatEvery"],
      },
    },
    item: { table: ["ITEMTABLE"], cols: { id: ["itemTableID"], name: ["itemName"] } },
    child: {
      table: ["CHILDCATEGORYTABLE"],
      cols: {
        id: ["categoryTableID", "childCategoryTableID"], name: ["childCategoryName", "categoryName"],
        parent: ["parentCategoryID"], budget: ["budgetAmount", "budget"],
        budgetPeriod: ["budgetPeriod"], budgetEnabled: ["budgetEnabledCategoryChild", "budgetEnabled"],
        budgetCustom: ["budgetCustomSetup"],
      },
    },
    parent: {
      table: ["PARENTCATEGORYTABLE"],
      cols: {
        id: ["parentCategoryTableID"], name: ["parentCategoryName"], group: ["categoryGroupID"],
        budget: ["budgetAmountCategoryParent", "budgetAmount"], budgetPeriod: ["budgetPeriodCategoryParent", "budgetPeriod"],
        budgetEnabled: ["budgetEnabledCategoryParent", "budgetEnabled"], budgetCustom: ["budgetCustomSetupParent"],
      },
    },
    catGroup: { table: ["CATEGORYGROUPTABLE"], cols: { id: ["categoryGroupTableID"], name: ["categoryGroupName"] } },
    account: {
      table: ["ACCOUNTSTABLE"],
      cols: {
        id: ["accountsTableID", "accountTableID"], name: ["accountName"], type: ["accountTypeID"],
        hidden: ["accountHidden", "hidden"], currency: ["accountCurrency"],
      },
    },
    accType: {
      table: ["ACCOUNTTYPETABLE"],
      cols: { id: ["accountTypeTableID"], name: ["accountTypeName"], group: ["accountingGroupID"] },
    },
    accGroup: {
      table: ["ACCOUNTINGGROUPTABLE"],
      cols: { id: ["accountingGroupTableID"], name: ["accountGroupName", "accountingGroupName"] },
    },
    label: { table: ["LABELSTABLE"], cols: { name: ["labelName"], tx: ["transactionIDLabels"] } },
  };

  let sqlPromise = null;
  function sqlJs() {
    if (!sqlPromise) {
      const bin = Uint8Array.from(atob(window.SQL_WASM_BASE64), (ch) => ch.charCodeAt(0));
      sqlPromise = window.initSqlJs({ wasmBinary: bin });
    }
    return sqlPromise;
  }

  const q = (name) => '"' + String(name).replace(/"/g, '""') + '"';

  function rows(db, sql, params) {
    const stmt = db.prepare(sql);
    try {
      if (params) stmt.bind(params);
      const out = [];
      while (stmt.step()) out.push(stmt.getAsObject());
      return out;
    } finally {
      stmt.free();
    }
  }

  function resolveSchema(db) {
    const tables = rows(db, "SELECT name FROM sqlite_master WHERE type='table'").map((r) => r.name);
    const findTable = (cands) => tables.find((t) => cands.some((c) => c.toLowerCase() === t.toLowerCase()));
    const schema = { tables, missing: [], resolved: {} };

    for (const [key, spec] of Object.entries(SPEC)) {
      const table = findTable(spec.table);
      const entry = { table: table || null, cols: {} };
      schema.resolved[key] = entry;
      if (!table) { schema.missing.push(spec.table[0]); continue; }
      const info = rows(db, `PRAGMA table_info(${q(table)})`);
      const names = info.map((c) => c.name);
      for (const [logical, cands] of Object.entries(spec.cols)) {
        let col = names.find((n) => cands.some((c) => c.toLowerCase() === n.toLowerCase()));
        if (!col && logical === "id") col = (info.find((c) => c.pk === 1) || {}).name || names.find((n) => /tableid$/i.test(n));
        if (!col && logical === "name") col = names.find((n) => /name/i.test(n));
        entry.cols[logical] = col || null;
        if (!col && (spec.required || []).includes(logical)) schema.missing.push(`${table}.${cands[0]}`);
      }
    }
    // Any other table that looks budget-related, for diagnostics.
    schema.budgetTables = tables.filter((t) => /budget/i.test(t));
    return schema;
  }

  // Builds TEMP VIEW tx (live rows, decoded, joined) from whatever columns were resolved.
  function createTxView(db, s) {
    const R = s.resolved;
    const col = (key, logical, alias) => {
      const c = R[key] && R[key].table && R[key].cols[logical];
      return c ? `${alias}.${q(c)}` : "NULL";
    };
    const join = (key, alias, onLeft, logicalId = "id") => {
      const e = R[key];
      if (!e || !e.table || !e.cols[logicalId] || onLeft === "NULL") return "";
      return `LEFT JOIN ${q(e.table)} ${alias} ON ${alias}.${q(e.cols[logicalId])} = ${onLeft}`;
    };
    const t = (l) => col("tx", l, "t");
    const where = [];
    if (R.tx.cols.deleted) where.push(`${t("deleted")} = ${LIVE}`);

    const sql = `
      CREATE TEMP VIEW tx AS
      SELECT
        ${t("id")} AS id,
        ${t("amount")} / ${AMOUNT_SCALE}.0 AS amt,
        ${t("date")} AS date,
        substr(${t("date")}, 1, 10) AS day,
        substr(${t("date")}, 1, 7) AS month,
        ${t("type")} AS typeId,
        COALESCE(${col("item", "name", "i")}, '') AS payee,
        COALESCE(${t("notes")}, '') AS notes,
        COALESCE(${col("child", "name", "cc")}, '(No category)') AS category,
        ${t("category")} AS categoryId,
        COALESCE(${col("parent", "name", "pc")}, COALESCE(${col("child", "name", "cc")}, '(No category)')) AS parentCategory,
        ${col("parent", "id", "pc")} AS parentCategoryId,
        ${col("catGroup", "name", "cg")} AS categoryGroup,
        COALESCE(${col("account", "name", "a")}, '(No account)') AS account,
        ${t("account")} AS accountId,
        ${t("pairAccount")} AS pairAccountId,
        COALESCE(${col("account", "hidden", "a")}, 0) AS accountHidden,
        COALESCE(${col("accType", "name", "at")}, '') AS accountType,
        COALESCE(${col("accGroup", "name", "ag")}, '') AS accountingGroup,
        ${t("transferGroup")} AS transferGroupId,
        ${t("split")} AS splitId,
        ${t("currency")} AS currency,
        ${t("rate")} AS rate,
        CASE WHEN ${t("reminder")} IS NULL THEN 0 ELSE 1 END AS isScheduled,
        ${t("reminder")} AS reminderFlag,
        ${t("reminderGroup")} AS reminderGroupId,
        ${t("reminderFrequency")} AS reminderFrequency,
        ${t("reminderRepeatEvery")} AS reminderRepeatEvery
      FROM ${q(R.tx.table)} t
      ${join("item", "i", t("item"))}
      ${join("child", "cc", t("category"))}
      ${join("parent", "pc", col("child", "parent", "cc"))}
      ${join("catGroup", "cg", col("parent", "group", "pc"))}
      ${join("account", "a", t("account"))}
      ${join("accType", "at", col("account", "type", "a"))}
      ${join("accGroup", "ag", col("accType", "group", "at"))}
      ${where.length ? "WHERE " + where.join(" AND ") : ""}`;
    db.run("DROP VIEW IF EXISTS tx");
    db.run(sql);

    // Labels: one row per (transaction, label).
    const L = R.label;
    db.run("DROP VIEW IF EXISTS tx_labels");
    if (L.table && L.cols.name && L.cols.tx) {
      db.run(`CREATE TEMP VIEW tx_labels AS SELECT ${q(L.cols.tx)} AS txId, ${q(L.cols.name)} AS label FROM ${q(L.table)}`);
    } else {
      db.run("CREATE TEMP VIEW tx_labels AS SELECT NULL AS txId, NULL AS label WHERE 0");
    }
  }

  async function open(bytes, meta) {
    const SQL = await sqlJs();
    let db;
    try {
      db = new SQL.Database(new Uint8Array(bytes));
      rows(db, "SELECT count(*) FROM sqlite_master");
    } catch (e) {
      throw new Error("This file isn't a readable SQLite database. Export a fresh backup (.fydb) from Bluecoins and try again.");
    }
    const schema = resolveSchema(db);
    if (!schema.resolved.tx.table) {
      db.close();
      throw new Error("This doesn't look like a Bluecoins backup: there's no TRANSACTIONSTABLE in it.");
    }
    const hard = schema.missing.filter((m) => m.startsWith(schema.resolved.tx.table + "."));
    if (hard.length) {
      db.close();
      throw new Error("The transactions table is missing columns the dashboard needs: " + hard.join(", "));
    }
    createTxView(db, schema);
    const userVersion = rows(db, "PRAGMA user_version")[0].user_version;
    return {
      db,
      schema,
      meta: Object.assign({ userVersion }, meta),
      all: (sql, params) => rows(db, sql, params),
      one: (sql, params) => rows(db, sql, params)[0] || null,
      close: () => db.close(),
    };
  }

  // ---- Local cache (IndexedDB, this browser only) ----
  const IDB_NAME = "bluecoins-dashboard";
  const STORE = "files";
  function idb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function idbDo(mode, fn) {
    const d = await idb();
    return new Promise((resolve, reject) => {
      const tr = d.transaction(STORE, mode);
      const r = fn(tr.objectStore(STORE));
      tr.oncomplete = () => { d.close(); resolve(r && r.result); };
      tr.onerror = () => { d.close(); reject(tr.error); };
    });
  }
  const cache = {
    async save(bytes, meta) {
      try { await idbDo("readwrite", (s) => s.put({ bytes, meta }, "last")); } catch (e) { /* cache is optional */ }
    },
    async load() {
      try { return (await idbDo("readonly", (s) => s.get("last"))) || null; } catch (e) { return null; }
    },
    async clear() {
      try { await idbDo("readwrite", (s) => s.delete("last")); } catch (e) { /* ignore */ }
    },
  };

  BC.db = { open, cache, TYPE, LIVE, REMINDER, AMOUNT_SCALE };
})((window.BC = window.BC || {}));
