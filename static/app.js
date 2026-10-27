(() => {
  const $ = (id) => document.getElementById(id);
  const fmt = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 });
  const PALETTE = ["#4f46e5", "#e11d48", "#f59e0b", "#10b981", "#06b6d4", "#8b5cf6", "#ec4899", "#84cc16", "#f97316", "#64748b"];

  let transactions = [];
  let pieChart = null, barChart = null;

  // ---------- helpers ----------
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function toast(msg) {
    const t = $("toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => t.classList.remove("show"), 2200);
  }

  async function api(url, opts = {}) {
    const res = await fetch(url, {
      headers: { "Content-Type": "application/json" },
      ...opts,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Request failed");
    return data;
  }

  const currentMonth = () => ($("allTime").checked ? "" : $("monthPicker").value);

  function filterQuery() {
    const p = new URLSearchParams();
    const m = currentMonth();
    if (m) p.set("month", m);
    if ($("fType").value) p.set("type", $("fType").value);
    if ($("fCategory").value) p.set("category", $("fCategory").value);
    if ($("search").value.trim()) p.set("q", $("search").value.trim());
    p.set("sort", $("fSort").value);
    return p.toString();
  }

  // ---------- theme ----------
  function applyTheme(t) {
    document.documentElement.setAttribute("data-theme", t);
    try { localStorage.setItem("theme", t); } catch (e) {}
    if (pieChart || barChart) refreshCharts();
  }
  $("themeBtn").addEventListener("click", () => {
    const cur = document.documentElement.getAttribute("data-theme");
    applyTheme(cur === "dark" ? "light" : "dark");
  });
  let saved = "light";
  try { saved = localStorage.getItem("theme") || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"); } catch (e) {}
  document.documentElement.setAttribute("data-theme", saved);

  // ---------- form ----------
  function fillCategories() {
    const type = document.querySelector('input[name="type"]:checked').value;
    const sel = $("category");
    const keep = sel.value;
    sel.innerHTML = window.CATS[type].map((c) => `<option>${esc(c)}</option>`).join("");
    if (window.CATS[type].includes(keep)) sel.value = keep;
  }
  document.querySelectorAll('input[name="type"]').forEach((r) => r.addEventListener("change", fillCategories));

  function fillFilterCategories() {
    const all = [...new Set([...window.CATS.expense, ...window.CATS.income])].sort();
    $("fCategory").innerHTML = '<option value="">All categories</option>' +
      all.map((c) => `<option>${esc(c)}</option>`).join("");
  }

  function resetForm() {
    $("txForm").reset();
    $("txId").value = "";
    $("date").value = new Date().toLocaleDateString("en-CA");
    $("formTitle").textContent = "Add transaction";
    $("saveBtn").textContent = "Add";
    $("cancelBtn").hidden = true;
    $("formError").textContent = "";
    fillCategories();
  }
  $("cancelBtn").addEventListener("click", resetForm);

  $("txForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const payload = {
      type: document.querySelector('input[name="type"]:checked').value,
      title: $("title").value.trim(),
      amount: $("amount").value,
      category: $("category").value,
      date: $("date").value,
      note: $("note").value.trim(),
    };
    if (!payload.title) return ($("formError").textContent = "Title is required");
    if (!(parseFloat(payload.amount) > 0)) return ($("formError").textContent = "Enter an amount greater than 0");
    if (!payload.date) return ($("formError").textContent = "Pick a date");
    $("formError").textContent = "";

    const id = $("txId").value;
    try {
      await api(id ? `/api/transactions/${id}` : "/api/transactions", {
        method: id ? "PUT" : "POST",
        body: JSON.stringify(payload),
      });
      toast(id ? "Transaction updated" : "Transaction added");
      resetForm();
      await refresh();
    } catch (err) {
      $("formError").textContent = err.message;
    }
  });

  function startEdit(tx) {
    $("txId").value = tx.id;
    document.getElementById(tx.type === "income" ? "typeIncome" : "typeExpense").checked = true;
    fillCategories();
    $("title").value = tx.title;
    $("amount").value = tx.amount;
    $("date").value = tx.date;
    $("category").value = tx.category;
    $("note").value = tx.note || "";
    $("formTitle").textContent = "Edit transaction";
    $("saveBtn").textContent = "Save changes";
    $("cancelBtn").hidden = false;
    window.scrollTo({ top: 0, behavior: "smooth" });
    $("title").focus();
  }

  // ---------- list ----------
  function renderList() {
    const body = $("txBody");
    $("listEmpty").hidden = transactions.length > 0;
    body.innerHTML = transactions.map((t) => `
      <tr>
        <td>${esc(t.date)}</td>
        <td class="title-cell">${esc(t.title)}${t.note ? `<small>${esc(t.note)}</small>` : ""}</td>
        <td><span class="tag">${esc(t.category)}</span></td>
        <td class="num ${t.type === "income" ? "inc" : "exp"}">${t.type === "income" ? "+" : "−"}${fmt.format(t.amount)}</td>
        <td class="actions">
          <button class="icon-btn" data-edit="${t.id}" title="Edit">✏️</button>
          <button class="icon-btn" data-del="${t.id}" title="Delete">🗑️</button>
        </td>
      </tr>`).join("");
  }

  $("txBody").addEventListener("click", async (e) => {
    const edit = e.target.closest("[data-edit]");
    const del = e.target.closest("[data-del]");
    if (edit) {
      const tx = transactions.find((t) => t.id === +edit.dataset.edit);
      if (tx) startEdit(tx);
    } else if (del) {
      if (!confirm("Delete this transaction?")) return;
      try {
        await api(`/api/transactions/${del.dataset.del}`, { method: "DELETE" });
        toast("Deleted");
        await refresh();
      } catch (err) { toast(err.message); }
    }
  });

  // ---------- summary + budget ----------
  function renderSummary(s) {
    $("sumIncome").textContent = fmt.format(s.income);
    $("sumExpense").textContent = fmt.format(s.expense);
    const b = $("sumBalance");
    b.textContent = fmt.format(s.balance);
    b.classList.toggle("neg", s.balance < 0);

    const bar = $("budgetBar");
    if (s.budget > 0 && !$("allTime").checked) {
      const pct = (s.expense / s.budget) * 100;
      $("budgetText").textContent = `${fmt.format(s.expense)} / ${fmt.format(s.budget)}`;
      bar.style.width = Math.min(pct, 100) + "%";
      bar.style.background = pct >= 100 ? "var(--expense)" : pct >= 80 ? "#f59e0b" : "var(--income)";
      if (pct >= 100) $("budgetText").textContent += " ⚠ over";
    } else {
      $("budgetText").textContent = s.budget > 0 ? fmt.format(s.budget) + " / month" : "Not set";
      bar.style.width = "0";
    }
  }

  $("editBudget").addEventListener("click", async () => {
    const cur = await api("/api/budget");
    const v = prompt("Monthly budget (₹). Enter 0 to clear:", cur.budget || "");
    if (v === null) return;
    try {
      await api("/api/budget", { method: "PUT", body: JSON.stringify({ budget: v }) });
      toast("Budget saved");
      refresh();
    } catch (err) { toast(err.message); }
  });

  // ---------- charts ----------
  function chartColors() {
    const dark = document.documentElement.getAttribute("data-theme") === "dark";
    return { text: dark ? "#e8ecf5" : "#1c2333", grid: dark ? "#283049" : "#e3e7f0" };
  }

  function renderPie(cats) {
    $("pieEmpty").hidden = cats.length > 0;
    $("pieChart").parentElement.hidden = cats.length === 0;
    if (pieChart) pieChart.destroy();
    if (!cats.length) return;
    const c = chartColors();
    pieChart = new Chart($("pieChart"), {
      type: "doughnut",
      data: {
        labels: cats.map((x) => x.category),
        datasets: [{ data: cats.map((x) => x.total), backgroundColor: PALETTE, borderWidth: 0 }],
      },
      options: {
        maintainAspectRatio: false,
        plugins: {
          legend: { position: "right", labels: { color: c.text, boxWidth: 12 } },
          tooltip: { callbacks: { label: (ctx) => ` ${ctx.label}: ${fmt.format(ctx.parsed)}` } },
        },
      },
    });
  }

  function renderBar(trend) {
    if (barChart) barChart.destroy();
    const c = chartColors();
    barChart = new Chart($("barChart"), {
      type: "bar",
      data: {
        labels: trend.map((t) => t.month),
        datasets: [
          { label: "Income", data: trend.map((t) => t.income), backgroundColor: "#16a34a" },
          { label: "Expense", data: trend.map((t) => t.expense), backgroundColor: "#e11d48" },
        ],
      },
      options: {
        maintainAspectRatio: false,
        scales: {
          x: { ticks: { color: c.text }, grid: { display: false } },
          y: { ticks: { color: c.text }, grid: { color: c.grid }, beginAtZero: true },
        },
        plugins: {
          legend: { labels: { color: c.text, boxWidth: 12 } },
          tooltip: { callbacks: { label: (ctx) => ` ${ctx.dataset.label}: ${fmt.format(ctx.parsed.y)}` } },
        },
      },
    });
  }

  let lastSummary = null, lastTrend = null;
  function refreshCharts() {
    if (lastSummary) renderPie(lastSummary.categories);
    if (lastTrend) renderBar(lastTrend);
  }

  // ---------- data loading ----------
  async function refresh() {
    const m = currentMonth();
    const sumQ = m ? `?month=${encodeURIComponent(m)}` : "";
    try {
      const [list, summary, trend] = await Promise.all([
        api(`/api/transactions?${filterQuery()}`),
        api(`/api/summary${sumQ}`),
        api("/api/trend"),
      ]);
      transactions = list;
      lastSummary = summary;
      lastTrend = trend;
      renderList();
      renderSummary(summary);
      refreshCharts();
    } catch (err) {
      toast(err.message);
    }
  }

  // ---------- filter events ----------
  let debounce;
  $("search").addEventListener("input", () => { clearTimeout(debounce); debounce = setTimeout(refresh, 250); });
  ["fType", "fCategory", "fSort", "monthPicker"].forEach((id) => $(id).addEventListener("change", refresh));
  $("allTime").addEventListener("change", () => { $("monthPicker").disabled = $("allTime").checked; refresh(); });
  $("exportBtn").addEventListener("click", () => { window.location = `/api/export?${filterQuery()}`; });

  // ---------- init ----------
  fillCategories();
  fillFilterCategories();
  refresh();
})();
