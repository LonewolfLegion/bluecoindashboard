#!/usr/bin/env python3
"""Generate sample/sample.fydb: a fake Bluecoins backup for demos and testing.

It mirrors the Bluecoins schema as far as the dashboard uses it (DB user_version 47):
amounts scaled by 1e6, soft deletes (deletedTransaction 5/6), reminder rows (9),
two-row transfers, split transactions, labels and hidden accounts.
All names and numbers are invented.

Usage: python3 tools/make-sample-db.py [output_path]
"""
import os, random, sqlite3, sys
from datetime import date, datetime, timedelta

OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), "..", "sample", "sample.fydb")
random.seed(7)
M = 1_000_000  # amount scale

if os.path.exists(OUT):
    os.remove(OUT)
db = sqlite3.connect(OUT)
c = db.cursor()
c.executescript("""
CREATE TABLE ACCOUNTINGGROUPTABLE (accountingGroupTableID INTEGER PRIMARY KEY, accountGroupName TEXT);
CREATE TABLE ACCOUNTTYPETABLE (accountTypeTableID INTEGER PRIMARY KEY, accountTypeName TEXT, accountingGroupID INTEGER);
CREATE TABLE ACCOUNTSTABLE (accountsTableID INTEGER PRIMARY KEY, accountName TEXT, accountTypeID INTEGER,
  accountHidden INTEGER, accountCurrency TEXT, accountConversionRateNew REAL, creditLimit INTEGER);
CREATE TABLE CATEGORYGROUPTABLE (categoryGroupTableID INTEGER PRIMARY KEY, categoryGroupName TEXT);
CREATE TABLE PARENTCATEGORYTABLE (parentCategoryTableID INTEGER PRIMARY KEY, parentCategoryName TEXT,
  budgetAmountCategoryParent INTEGER, budgetEnabledCategoryParent INTEGER, categoryGroupID INTEGER,
  budgetPeriodCategoryParent INTEGER, budgetCustomSetupParent TEXT);
CREATE TABLE CHILDCATEGORYTABLE (categoryTableID INTEGER PRIMARY KEY, childCategoryName TEXT, parentCategoryID INTEGER,
  budgetAmount INTEGER, budgetCustomSetup TEXT, budgetEnabledCategoryChild INTEGER, budgetPeriod INTEGER);
CREATE TABLE ITEMTABLE (itemTableID INTEGER PRIMARY KEY, itemName TEXT);
CREATE TABLE TRANSACTIONSTABLE (transactionsTableID INTEGER PRIMARY KEY, itemID INTEGER, amount INTEGER,
  transactionCurrency TEXT, conversionRateNew REAL, date TEXT, transactionTypeID INTEGER, categoryID INTEGER,
  accountID INTEGER, notes TEXT, status INTEGER, accountPairID INTEGER, uidPairID INTEGER,
  deletedTransaction INTEGER, newSplitTransactionID INTEGER, transferGroupID INTEGER, reminderTransaction INTEGER);
CREATE TABLE LABELSTABLE (labelsTableID INTEGER PRIMARY KEY, labelName TEXT, transactionIDLabels INTEGER);
CREATE TABLE PICTURETABLE (pictureTableID INTEGER PRIMARY KEY, pictureFileName TEXT, transactionID INTEGER);
PRAGMA user_version = 47;
""")

c.executemany("INSERT INTO ACCOUNTINGGROUPTABLE VALUES (?,?)", [(0, "(Unaccounted)"), (1, "Assets"), (2, "Liabilities")])
c.executemany("INSERT INTO ACCOUNTTYPETABLE VALUES (?,?,?)", [
    (1, "Bank", 1), (2, "Cash", 1), (3, "Investments", 1), (4, "Credit Card", 2), (5, "Loan", 2)])
ACC = {"Savings Bank": 1, "Salary Bank": 2, "Wallet": 3, "Fixed Deposits": 4, "Mutual Funds": 5,
       "Rewards Card": 6, "Car Loan": 7, "Old Euro Wallet": 8}
c.executemany("INSERT INTO ACCOUNTSTABLE VALUES (?,?,?,?,?,?,?)", [
    (1, "Savings Bank", 1, 0, "INR", 1, None), (2, "Salary Bank", 1, 0, "INR", 1, None),
    (3, "Wallet", 2, 0, "INR", 1, None), (4, "Fixed Deposits", 3, 0, "INR", 1, None),
    (5, "Mutual Funds", 3, 0, "INR", 1, None), (6, "Rewards Card", 4, 0, "INR", 1, 200000 * M),
    (7, "Car Loan", 5, 0, "INR", 1, None), (8, "Old Euro Wallet", 2, 1, "EUR", 0.0108, None)])

c.executemany("INSERT INTO CATEGORYGROUPTABLE VALUES (?,?)", [(0, "(No category)"), (1, "Transfer"), (2, "Income"), (3, "Expense")])
parents = [(1, "Food", 3), (2, "Housing", 3), (3, "Transport", 3), (4, "Shopping", 3), (5, "Health", 3),
           (6, "Entertainment", 3), (7, "Bills & Utilities", 3), (8, "Travel", 3),
           (9, "Salary", 2), (10, "Other Income", 2), (11, "(Transfer)", 1), (12, "(No category)", 0)]
c.executemany("INSERT INTO PARENTCATEGORYTABLE VALUES (?,?,0,0,?,3,NULL)", parents)
# child: id, name, parent, monthly budget (₹), period code, enabled
children = [
    (1, "Groceries", 1, 12000), (2, "Restaurants", 1, 6000), (3, "Coffee", 1, None),
    (4, "Rent", 2, 30000), (5, "Maintenance", 2, None),
    (6, "Fuel", 3, 5000), (7, "Cab", 3, 2500), (8, "Car EMI", 3, None),
    (9, "Clothing", 4, 4000), (10, "Electronics", 4, None),
    (11, "Pharmacy", 5, None), (12, "Doctor", 5, None),
    (13, "Movies", 6, 1500), (14, "Subscriptions", 6, 1200),
    (15, "Electricity", 7, 3000), (16, "Mobile & Internet", 7, 1500),
    (17, "Flights", 8, None), (18, "Hotels", 8, None),
    (19, "Monthly Salary", 9, 150000), (20, "Bonus", 9, None),
    (21, "Interest", 10, None), (22, "Cashback", 10, None),
    (23, "(Transfer)", 11, None), (24, "(New Account)", 12, None),
]
c.executemany("INSERT INTO CHILDCATEGORYTABLE VALUES (?,?,?,?,NULL,1,3)",
              [(i, n, p, (b * M if b else 0)) for i, n, p, b in children])

items = {}
def item(name):
    if name not in items:
        items[name] = len(items) + 1
        c.execute("INSERT INTO ITEMTABLE VALUES (?,?)", (items[name], name))
    return items[name]

tid = [1000]
def tx(d, amt, typ, cat, acc, payee, notes="", deleted=6, reminder=None, split=None, tgroup=None, pair=None):
    tid[0] += 1
    t = tid[0]
    c.execute("INSERT INTO TRANSACTIONSTABLE VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", (
        t, item(payee), int(round(amt * M)), "INR", 1, d.strftime("%Y-%m-%d %H:%M:%S"), typ, cat, acc,
        notes, 2, pair, None, deleted, split, tgroup, reminder))
    return t

def transfer(d, amt, frm, to, payee="Transfer", reminder=None):
    g = tid[0] + 1
    tx(d, -amt, 5, 23, frm, payee, tgroup=g, pair=to, reminder=reminder)
    tx(d, amt, 5, 23, to, payee, tgroup=g, pair=frm, reminder=reminder)

def label(t, name):
    c.execute("INSERT INTO LABELSTABLE (labelName, transactionIDLabels) VALUES (?,?)", (name, t))

today = date.today()
start = date(today.year - 3, 1, 1)
def at(d, h=None):
    return datetime(d.year, d.month, d.day, h if h is not None else random.randint(8, 21), random.randint(0, 59))

# opening balances
for acc, amt in [(1, 150000), (2, 20000), (3, 5000), (4, 300000), (5, 120000), (6, 0), (7, -600000), (8, 24000)]:
    tx(at(start, 9), amt, 2, 24, acc, "Opening balance")

d = start
while d <= today:
    first = d.day == 1
    if first:
        tx(at(d, 10), 145000 + 5000 * (d.year - start.year), 4, 19, 2, "Acme Corp", "Salary")
        transfer(at(d, 11), 60000, 2, 1)
        tx(at(d, 12), -30000, 3, 4, 1, "Landlord", "Rent")
        tx(at(d, 12), -14500, 3, 8, 1, "Car loan EMI")
        transfer(at(d, 12), 11000, 1, 7, "Car loan principal")
        tx(at(d, 13), -random.randint(1800, 3400), 3, 15, 1, "Power Co")
        tx(at(d, 13), -999, 3, 16, 6, "TelcoNet")
        tx(at(d, 14), -649, 3, 14, 6, "StreamFlix")
        transfer(at(d, 15), 10000, 1, 5, "SIP")
        tx(at(d, 15), round(random.uniform(300, 900), 2), 4, 21, 1, "Savings interest")
        # pay last month's card bill
        transfer(at(d, 16), random.randint(14000, 22000), 1, 6, "Card bill payment")
        if d.month == 3:
            tx(at(d, 10), 90000, 4, 20, 2, "Acme Corp", "Annual bonus")
    # daily-ish spending
    if random.random() < 0.55:
        tx(at(d), -random.randint(300, 2600), 3, 1, random.choice([6, 6, 1, 3]), random.choice(["FreshMart", "Daily Needs", "Big Basket"]))
    if random.random() < 0.18:
        tx(at(d), -random.randint(400, 3200), 3, 2, 6, random.choice(["Spice Route", "Pizza Place", "Dosa Corner"]))
    if random.random() < 0.25:
        tx(at(d), -random.randint(120, 380), 3, 3, 3, "Brew Cafe")
    if random.random() < 0.1:
        tx(at(d), -random.randint(1500, 3500), 3, 6, 6, "Fuel Station")
    if random.random() < 0.12:
        tx(at(d), -random.randint(150, 650), 3, 7, 6, "RideNow")
    if random.random() < 0.03:
        tx(at(d), -random.randint(900, 6000), 3, 9, 6, random.choice(["Style Hub", "Denim Co"]))
    if random.random() < 0.03:
        tx(at(d), -random.randint(200, 1800), 3, 11, 3, "City Pharmacy")
    if random.random() < 0.04:
        tx(at(d), -random.randint(300, 900), 3, 13, 6, "Cineplex")
    if random.random() < 0.02:
        tx(at(d), round(random.uniform(20, 400), 2), 4, 22, 6, "Card cashback")
    if random.random() < 0.05:
        transfer(at(d), random.choice([2000, 3000, 5000]), 1, 3, "ATM withdrawal")
    d += timedelta(days=1)

# A split transaction: one shopping receipt over three categories
ds = at(today.replace(day=1) - timedelta(days=20))
first_id = tid[0] + 1
tx(ds, -2400, 3, 1, 6, "MegaMart", "Split: groceries", split=first_id)
tx(ds, -5200, 3, 10, 6, "MegaMart", "Split: headphones", split=first_id)
tx(ds, -900, 3, 11, 6, "MegaMart", "Split: pharmacy", split=first_id)

# A trip with labels
trip = today.replace(day=1) - timedelta(days=75)
for t in [tx(at(trip), -18500, 3, 17, 6, "SkyAir", "Flights to Goa"),
          tx(at(trip + timedelta(days=1)), -14200, 3, 18, 6, "Beach Resort"),
          tx(at(trip + timedelta(days=2)), -3600, 3, 2, 6, "Shack Cafe")]:
    label(t, "Goa trip")
label(tx(at(today - timedelta(days=200)), -32999, 3, 10, 6, "Gadget World", "New phone"), "Gadgets")

# Deleted rows that must be ignored
tx(at(today - timedelta(days=5)), -99999, 3, 10, 6, "Deleted purchase", deleted=5)
tx(at(today - timedelta(days=40)), 50000, 4, 20, 2, "Deleted income", deleted=5)

# A one-sided transfer (its pair row is missing) to exercise the data-quality check
tx(at(today - timedelta(days=400)), -2000, 5, 23, 3, "Transfer", tgroup=999999, pair=1)
# A label pointing at a transaction that no longer exists
label(123456789, "Orphan label")

# Upcoming reminders (scheduled bills) for the next 12 months, plus an expected salary
m = today.replace(day=1)
for i in range(1, 13):
    y, mo = m.year + (m.month - 1 + i) // 12, (m.month - 1 + i) % 12 + 1
    nd = date(y, mo, 1)
    tx(at(nd, 10), -30000, 3, 4, 1, "Landlord", "Rent", reminder=9)
    tx(at(nd, 10), -14500, 3, 8, 1, "Car loan EMI", reminder=9)
    tx(at(nd.replace(day=5), 10), -999, 3, 16, 6, "TelcoNet", reminder=9)
    tx(at(nd.replace(day=7), 10), -649, 3, 14, 6, "StreamFlix", reminder=9)
    tx(at(nd, 9), 160000, 4, 19, 2, "Acme Corp", "Salary", reminder=9)
tx(at(today + timedelta(days=9), 10), -12500, 3, 12, 1, "Insurance premium", reminder=9)

db.commit()
n = c.execute("SELECT count(*) FROM TRANSACTIONSTABLE").fetchone()[0]
db.close()
print(f"wrote {OUT} with {n} transactions")
