# Expense Tracker

Flask + SQLite + HTML/CSS/JS.

## Run

```bash
cd expense-tracker
python -m venv venv
venv\Scripts\activate        # Windows
# source venv/bin/activate   # macOS/Linux
pip install -r requirements.txt
python app.py
```

Open http://127.0.0.1:5000

The SQLite database (`expenses.db`) is created automatically on first run.

## Features

- Add / edit / delete income and expenses
- Category-wise doughnut chart and 6-month income vs expense chart
- Month picker or "All time" view
- Search, type/category filters, sorting
- Monthly budget with progress bar (turns amber at 80%, red when over)
- CSV export (respects current filters)
- Dark mode (remembered)

## API

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/api/transactions?month=YYYY-MM&type=&category=&q=&sort=` | List |
| POST | `/api/transactions` | Create |
| PUT | `/api/transactions/<id>` | Update |
| DELETE | `/api/transactions/<id>` | Delete |
| GET | `/api/summary?month=YYYY-MM` | Totals + category breakdown |
| GET | `/api/trend` | Last 6 months |
| GET/PUT | `/api/budget` | Monthly budget |
| GET | `/api/export` | CSV download |

## Structure

```
expense-tracker/
├── app.py
├── requirements.txt
├── templates/index.html
└── static/{style.css, app.js}
```
