# Bluecoins .fydb data model (notes for the dashboard)

Checked against a backup at DB user_version 47 (Android Room, SQLite).

## Decoding rules
- amount (TRANSACTIONSTABLE, budgets, creditLimit) is an INTEGER scaled by 1,000,000. ₹15 = 15000000. Divide by 1e6.
- Amounts are stored in the base currency (INR) even for EUR/GBP transactions; transactionCurrency + conversionRateNew give the foreign value (foreign = amount × rate).
- Sign: expenses negative, income positive; transfers are two rows (−/+) linked by transferGroupID / uidPairID; accountPairID points at the other account.
- deletedTransaction: 6 = live, 5 = deleted (soft delete). Always filter = 6.
- reminderTransaction = 9 marks scheduled/future reminder rows (dated up to 2034). Exclude (reminderTransaction IS NULL) for actuals; use them for "upcoming bills" views. Reminders can be expenses (type 3) or transfers (type 5, two rows each). reminderGroupID groups one repeating series; reminderFrequency / reminderRepeatEvery describe the schedule.
- transactionTypeID: 2 New Account (opening balance), 3 Expense, 4 Income, 5 Transfer (lookup: TRANSACTIONTYPETABLE).
- Split transactions share newSplitTransactionID (= ID of the first part); each part is its own row with its own category, so sums work without special handling.
- date is TEXT 'YYYY-MM-DD HH:MM:SS' (local time).
- IDs for newer rows are epoch-millisecond timestamps.
- status: 0 / 2 / 3 — most rows are 2; meaning (likely uncleared / cleared / reconciled) not confirmed.

## Joins
- TRANSACTIONSTABLE.itemID → ITEMTABLE.itemTableID (itemName = payee/description)
- .categoryID → CHILDCATEGORYTABLE.categoryTableID → parentCategoryID → PARENTCATEGORYTABLE.parentCategoryTableID → categoryGroupID → CATEGORYGROUPTABLE (0 none, 1 Transfer, 2 Income, 3 Expense)
- .accountID → ACCOUNTSTABLE.accountsTableID → accountTypeID → ACCOUNTTYPETABLE → accountingGroupID → ACCOUNTINGGROUPTABLE (0 Unaccounted, 1 Assets, 2 Liabilities). accountHidden = 1 for hidden accounts.
- LABELSTABLE.transactionIDLabels → transaction (many labels per transaction; used for trips/events)
- PICTURETABLE.transactionID → receipt image filename (images not in the DB)
- Parent category names are not unique ("Others" and "(No category)" exist once under Expense and once under Income) — group by ID, not name.

## Budgets
- Sub-category budgets: CHILDCATEGORYTABLE.budgetAmount (scaled 1e6), budgetPeriod (3 = monthly; the only period in use), budgetEnabledCategoryChild, budgetCustomSetup.
- Category budgets: PARENTCATEGORYTABLE.budgetAmountCategoryParent, budgetEnabledCategoryParent, budgetPeriodCategoryParent, budgetCustomSetupParent.
- budgetCustomSetup* is JSON like {"a":false,"b":3,"c":[12 monthly amounts, scaled 1e6]} — b looks like the period code, c a per-month amount.
- The enabled flags don't line up cleanly with whether an amount is set (parents can have an amount set with enabled = 0), so the dashboard uses sub-category budgets with budgetAmount > 0 as the source of truth. Parent-level / custom budgets are not shown yet.

## Data quirks to expect
- Transfers can be one-sided when the other half was deleted; they shift account balances. The Net worth tab lists them under Data quality.
- Labels can point at transactions that no longer exist.
- A cash wallet can end up with a negative balance if cash income wasn't recorded.
- Hidden accounts can still hold a balance; Net worth leaves them out unless "Include hidden accounts" is ticked.
- Investment accounts hold principal only (FDs, MFs); Bluecoins doesn't store market value.
