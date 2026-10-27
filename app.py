import csv
import io
import os
import sqlite3
from datetime import date, datetime

from flask import Flask, Response, g, jsonify, render_template, request

app = Flask(__name__)
DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "expenses.db")

EXPENSE_CATEGORIES = [
    "Food", "Transport", "Rent", "Shopping", "Bills",
    "Health", "Entertainment", "Education", "Travel", "Other",
]
INCOME_CATEGORIES = ["Salary", "Freelance", "Gift", "Investment", "Other"]


# ---------- database ----------
def get_db():
    if "db" not in g:
        g.db = sqlite3.connect(DB_PATH)
        g.db.row_factory = sqlite3.Row
    return g.db


@app.teardown_appcontext
def close_db(_exc):
    db = g.pop("db", None)
    if db is not None:
        db.close()


def init_db():
    db = sqlite3.connect(DB_PATH)
    db.executescript(
        """
        CREATE TABLE IF NOT EXISTS transactions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            type TEXT NOT NULL CHECK (type IN ('income', 'expense')),
            title TEXT NOT NULL,
            amount REAL NOT NULL CHECK (amount > 0),
            category TEXT NOT NULL,
            date TEXT NOT NULL,
            note TEXT DEFAULT '',
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_tx_date ON transactions(date);
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        """
    )
    db.commit()
    db.close()


# ---------- helpers ----------
def validate(data):
    """Return (clean_dict, error_message)."""
    if not isinstance(data, dict):
        return None, "Invalid JSON body"
    t = data.get("type")
    if t not in ("income", "expense"):
        return None, "Type must be income or expense"
    title = (data.get("title") or "").strip()
    if not title:
        return None, "Title is required"
    if len(title) > 100:
        return None, "Title too long (max 100)"
    try:
        amount = round(float(data.get("amount")), 2)
    except (TypeError, ValueError):
        return None, "Amount must be a number"
    if amount <= 0 or amount > 1e9:
        return None, "Amount must be greater than 0"
    allowed = EXPENSE_CATEGORIES if t == "expense" else INCOME_CATEGORIES
    category = data.get("category")
    if category not in allowed:
        return None, "Invalid category"
    try:
        d = datetime.strptime(data.get("date", ""), "%Y-%m-%d").date().isoformat()
    except ValueError:
        return None, "Date must be YYYY-MM-DD"
    note = (data.get("note") or "").strip()[:300]
    return {"type": t, "title": title, "amount": amount,
            "category": category, "date": d, "note": note}, None


def row_to_dict(r):
    return {k: r[k] for k in r.keys()}


def month_arg():
    m = request.args.get("month", "").strip()
    if m:
        try:
            datetime.strptime(m, "%Y-%m")
        except ValueError:
            return None, "month must be YYYY-MM"
    return m, None


def build_filters(month, args):
    where, params = [], []
    if month:
        where.append("substr(date,1,7) = ?")
        params.append(month)
    if args.get("type") in ("income", "expense"):
        where.append("type = ?")
        params.append(args["type"])
    if args.get("category"):
        where.append("category = ?")
        params.append(args["category"])
    q = args.get("q", "").strip()
    if q:
        where.append("(title LIKE ? OR note LIKE ?)")
        params += [f"%{q}%", f"%{q}%"]
    return (" WHERE " + " AND ".join(where)) if where else "", params


# ---------- pages ----------
@app.route("/")
def index():
    return render_template(
        "index.html",
        expense_categories=EXPENSE_CATEGORIES,
        income_categories=INCOME_CATEGORIES,
        today=date.today().isoformat(),
        this_month=date.today().strftime("%Y-%m"),
    )


# ---------- API ----------
@app.get("/api/transactions")
def list_transactions():
    month, err = month_arg()
    if err:
        return jsonify(error=err), 400
    where, params = build_filters(month, request.args)
    sort = request.args.get("sort", "date_desc")
    order = {
        "date_desc": "date DESC, id DESC",
        "date_asc": "date ASC, id ASC",
        "amount_desc": "amount DESC",
        "amount_asc": "amount ASC",
    }.get(sort, "date DESC, id DESC")
    rows = get_db().execute(
        f"SELECT * FROM transactions{where} ORDER BY {order}", params
    ).fetchall()
    return jsonify([row_to_dict(r) for r in rows])


@app.post("/api/transactions")
def create_transaction():
    clean, err = validate(request.get_json(silent=True))
    if err:
        return jsonify(error=err), 400
    db = get_db()
    cur = db.execute(
        "INSERT INTO transactions (type,title,amount,category,date,note) "
        "VALUES (:type,:title,:amount,:category,:date,:note)", clean)
    db.commit()
    row = db.execute("SELECT * FROM transactions WHERE id=?", (cur.lastrowid,)).fetchone()
    return jsonify(row_to_dict(row)), 201


@app.put("/api/transactions/<int:tx_id>")
def update_transaction(tx_id):
    clean, err = validate(request.get_json(silent=True))
    if err:
        return jsonify(error=err), 400
    db = get_db()
    cur = db.execute(
        "UPDATE transactions SET type=:type,title=:title,amount=:amount,"
        "category=:category,date=:date,note=:note WHERE id=:id",
        {**clean, "id": tx_id})
    db.commit()
    if cur.rowcount == 0:
        return jsonify(error="Not found"), 404
    row = db.execute("SELECT * FROM transactions WHERE id=?", (tx_id,)).fetchone()
    return jsonify(row_to_dict(row))


@app.delete("/api/transactions/<int:tx_id>")
def delete_transaction(tx_id):
    db = get_db()
    cur = db.execute("DELETE FROM transactions WHERE id=?", (tx_id,))
    db.commit()
    if cur.rowcount == 0:
        return jsonify(error="Not found"), 404
    return jsonify(ok=True)


@app.get("/api/summary")
def summary():
    month, err = month_arg()
    if err:
        return jsonify(error=err), 400
    db = get_db()
    clause, params = ("WHERE substr(date,1,7)=?", [month]) if month else ("", [])
    totals = {"income": 0.0, "expense": 0.0}
    count = 0
    for r in db.execute(
        f"SELECT type, SUM(amount) s, COUNT(*) c FROM transactions {clause} GROUP BY type",
        params):
        totals[r["type"]] = r["s"] or 0.0
        count += r["c"]
    and_or_where = "AND" if clause else "WHERE"
    cats = db.execute(
        f"SELECT category, SUM(amount) total FROM transactions {clause} "
        f"{and_or_where} type='expense' GROUP BY category ORDER BY total DESC", params
    ).fetchall()
    budget_row = db.execute("SELECT value FROM settings WHERE key='budget'").fetchone()
    budget = float(budget_row["value"]) if budget_row else 0.0
    return jsonify(
        income=round(totals["income"], 2),
        expense=round(totals["expense"], 2),
        balance=round(totals["income"] - totals["expense"], 2),
        count=count,
        budget=budget,
        categories=[{"category": c["category"], "total": round(c["total"], 2)} for c in cats],
    )


@app.get("/api/trend")
def trend():
    """Income vs expense for the last 6 months (including current)."""
    today = date.today()
    months = []
    y, m = today.year, today.month
    for _ in range(6):
        months.append(f"{y:04d}-{m:02d}")
        m -= 1
        if m == 0:
            m, y = 12, y - 1
    months.reverse()
    data = {k: {"income": 0.0, "expense": 0.0} for k in months}
    rows = get_db().execute(
        "SELECT substr(date,1,7) mth, type, SUM(amount) s FROM transactions "
        "WHERE substr(date,1,7) >= ? GROUP BY mth, type", (months[0],)).fetchall()
    for r in rows:
        if r["mth"] in data:
            data[r["mth"]][r["type"]] = round(r["s"], 2)
    return jsonify([{"month": k, **v} for k, v in data.items()])


@app.route("/api/budget", methods=["GET", "PUT"])
def budget():
    db = get_db()
    if request.method == "PUT":
        body = request.get_json(silent=True) or {}
        try:
            value = float(body.get("budget"))
        except (TypeError, ValueError):
            return jsonify(error="Budget must be a number"), 400
        if value < 0 or value > 1e9:
            return jsonify(error="Budget out of range"), 400
        db.execute("INSERT INTO settings(key,value) VALUES('budget',?) "
                   "ON CONFLICT(key) DO UPDATE SET value=excluded.value", (str(value),))
        db.commit()
    row = db.execute("SELECT value FROM settings WHERE key='budget'").fetchone()
    return jsonify(budget=float(row["value"]) if row else 0.0)


@app.get("/api/export")
def export_csv():
    month, err = month_arg()
    if err:
        return jsonify(error=err), 400
    where, params = build_filters(month, request.args)
    rows = get_db().execute(
        f"SELECT date,type,title,category,amount,note FROM transactions{where} "
        "ORDER BY date DESC, id DESC", params).fetchall()
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["Date", "Type", "Title", "Category", "Amount", "Note"])
    for r in rows:
        w.writerow([r["date"], r["type"], r["title"], r["category"], r["amount"], r["note"]])
    name = f"expenses_{month or 'all'}.csv"
    return Response(buf.getvalue(), mimetype="text/csv",
                    headers={"Content-Disposition": f"attachment; filename={name}"})


init_db()

if __name__ == "__main__":
    app.run(debug=True)
