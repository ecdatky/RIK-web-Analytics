// RIK Web解析ダッシュボード（フロント）
// データは /api/* から取得。キャッシュが古ければまず即表示し、裏で最新を取り直して差し替える。

const state = {
  sites: [],
  demo: false,
  tab: "summary",
  range: "28d",
  metric: "activeUsers",
  charts: [],
  realtimeTimer: null,
};

try {
  const saved = JSON.parse(localStorage.getItem("rik-dash") || "{}");
  if (saved.range) state.range = saved.range;
  if (saved.tab) state.tab = saved.tab;
} catch {}
const remember = () => {
  try { localStorage.setItem("rik-dash", JSON.stringify({ range: state.range, tab: state.tab })); } catch {}
};

// ---------- utils ----------
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmtInt = (n) => Math.round(n).toLocaleString("ja-JP");
const fmtYen = (n) => `¥${Math.round(n).toLocaleString("ja-JP")}`;
const fmtPct = (n) => `${(n * 100).toFixed(1)}%`;
const fmtDec = (n) => (Math.round(n * 10) / 10).toLocaleString("ja-JP");
const fmtDur = (sec) => `${Math.floor(sec / 60)}分${String(Math.round(sec % 60)).padStart(2, "0")}秒`;
const fmtTime = (iso) =>
  new Date(iso).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
const ratio = (a, b) => (b ? a / b : 0);

async function api(path, opts) {
  const res = await fetch(path, opts);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

/**
 * 前期間比。higherIsBetter=false の指標（CPAなど）は色を反転、null は色を付けない
 */
function delta(cur, prev, higherIsBetter = true) {
  if (!prev) return `<span class="delta flat">前期間データなし</span>`;
  const d = (cur - prev) / prev;
  const arrow = d > 0.005 ? "▲" : d < -0.005 ? "▼" : "→";
  let cls = "flat";
  if (Math.abs(d) > 0.005 && higherIsBetter !== null) cls = (d > 0) === higherIsBetter ? "good" : "bad";
  return `<span class="delta ${cls}">${arrow} ${(Math.abs(d) * 100).toFixed(1)}% <span class="muted">前期間比</span></span>`;
}

function tile(label, value, deltaHtml = "") {
  return `<div class="tile"><div class="label">${esc(label)}</div><div class="value">${value}</div>${deltaHtml}</div>`;
}

const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function destroyCharts() {
  state.charts.forEach((c) => c.destroy());
  state.charts = [];
}

function lineChart(canvas, labels, datasets, format) {
  const grid = cssVar("--border");
  const text = cssVar("--text-secondary");
  const chart = new Chart(canvas, {
    type: "line",
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${format(c.parsed.y)}` } },
      },
      elements: { point: { radius: 0, hoverRadius: 4 }, line: { borderWidth: 2, tension: 0.25 } },
      scales: {
        x: { grid: { display: false }, ticks: { color: text, maxRotation: 0, autoSkip: true, maxTicksLimit: 8 } },
        y: { beginAtZero: true, grid: { color: grid }, border: { display: false }, ticks: { color: text, callback: format } },
      },
    },
  });
  state.charts.push(chart);
  return chart;
}

function barChart(canvas, labels, data, label, format) {
  const grid = cssVar("--border");
  const text = cssVar("--text-secondary");
  const chart = new Chart(canvas, {
    type: "bar",
    data: { labels, datasets: [{ label, data, backgroundColor: cssVar("--series-1"), borderRadius: 4, maxBarThickness: 18 }] },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => `${label}: ${format(c.parsed.y)}` } } },
      scales: {
        x: { grid: { display: false }, ticks: { color: text, maxRotation: 0, autoSkip: true, maxTicksLimit: 8 } },
        y: { beginAtZero: true, grid: { color: grid }, border: { display: false }, ticks: { color: text, callback: format } },
      },
    },
  });
  state.charts.push(chart);
  return chart;
}

const md = (date) => `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;

// ---------- data ----------
async function loadReport(siteId, { force = false } = {}) {
  const q = `/api/report?site=${encodeURIComponent(siteId)}&range=${state.range}${force ? "&refresh=1" : ""}`;
  return api(q);
}

/** キャッシュを即表示 → 古ければ最新を取り直して onUpdate */
async function loadReportFresh(siteId, onUpdate) {
  const first = await loadReport(siteId);
  onUpdate(first.report, first.stale);
  if (first.stale) {
    const fresh = await loadReport(siteId, { force: true });
    onUpdate(fresh.report, false);
  }
}

// ---------- views ----------
function renderTabs() {
  const tabs = [{ id: "summary", name: "サマリー" }, ...state.sites];
  $("#tabs").innerHTML = tabs
    .map((t) => `<button role="tab" data-tab="${esc(t.id)}" aria-selected="${t.id === state.tab}">${esc(t.name)}</button>`)
    .join("");
}

function statusLine(report, stale) {
  const parts = [`<span class="muted small">期間 ${report.current.startDate} 〜 ${report.current.endDate}（前期間 ${report.previous.startDate} 〜 ${report.previous.endDate}）</span>`];
  parts.push(`<span class="muted small">取得 ${fmtTime(report.fetchedAt)}</span>`);
  if (stale) parts.push(`<span class="badge badge-info">最新データを取得中…</span>`);
  if (report.demo) parts.push(`<span class="badge badge-warn">デモデータ</span>`);
  return `<div class="statusline">${parts.join("")}</div>`;
}

async function renderSummary() {
  const view = $("#view");
  view.innerHTML = `<div class="card"><h2>全サイトのサマリー</h2><div id="sum-body" class="table-wrap"><p class="muted">読み込み中…</p></div></div>`;
  const rows = await Promise.all(
    state.sites.map(async (s) => {
      try {
        const [{ report }, { advice }] = await Promise.all([loadReport(s.id), api(`/api/advice?site=${encodeURIComponent(s.id)}`)]);
        return { s, report, advice };
      } catch (e) {
        return { s, error: e.message };
      }
    }),
  );
  if (state.tab !== "summary") return;
  const body = rows
    .map(({ s, report, advice, error }) => {
      if (error) return `<tr><td>${esc(s.name)}</td><td colspan="8" class="muted">${esc(error)}</td></tr>`;
      const g = report.ga4?.totals;
      const a = report.ads?.totals;
      const cpa = a ? ratio(a.cost.current, a.conversions.current) : 0;
      return `<tr>
        <td><button class="btn" data-goto="${esc(s.id)}">${esc(s.name)}</button></td>
        <td class="r">${g ? fmtInt(g.activeUsers.current) : "-"}<br>${g ? delta(g.activeUsers.current, g.activeUsers.previous) : ""}</td>
        <td class="r">${g ? fmtInt(g.sessions.current) : "-"}</td>
        <td class="r">${g ? fmtInt(g.keyEvents.current) : "-"}<br>${g ? delta(g.keyEvents.current, g.keyEvents.previous) : ""}</td>
        <td class="r">${g ? fmtPct(ratio(g.keyEvents.current, g.sessions.current)) : "-"}</td>
        <td class="r">${a ? fmtYen(a.cost.current) : "-"}</td>
        <td class="r">${a ? fmtDec(a.conversions.current) : "-"}</td>
        <td class="r">${a && a.conversions.current ? fmtYen(cpa) : "-"}</td>
        <td style="white-space:normal;min-width:260px">${advice ? esc(advice.summary) : '<span class="muted">未生成</span>'}</td>
      </tr>`;
    })
    .join("");
  $("#sum-body").innerHTML = `<table>
    <thead><tr><th>サイト</th><th class="r">ユーザー</th><th class="r">セッション</th><th class="r">キーイベント</th><th class="r">CVR</th><th class="r">広告費</th><th class="r">広告CV</th><th class="r">CPA</th><th>AIのひとこと</th></tr></thead>
    <tbody>${body}</tbody></table>`;
}

function renderGa4(g) {
  const t = g.totals;
  const cvr = ratio(t.keyEvents.current, t.sessions.current);
  const cvrPrev = ratio(t.keyEvents.previous, t.sessions.previous);
  return `
  <div class="section-title"><h2>アクセス（GA4）</h2></div>
  <div class="tiles">
    ${tile("ユーザー", fmtInt(t.activeUsers.current), delta(t.activeUsers.current, t.activeUsers.previous))}
    ${tile("新規ユーザー", fmtInt(t.newUsers.current), delta(t.newUsers.current, t.newUsers.previous))}
    ${tile("セッション", fmtInt(t.sessions.current), delta(t.sessions.current, t.sessions.previous))}
    ${tile("表示回数", fmtInt(t.screenPageViews.current), delta(t.screenPageViews.current, t.screenPageViews.previous))}
    ${tile("エンゲージメント率", fmtPct(t.engagementRate.current), delta(t.engagementRate.current, t.engagementRate.previous))}
    ${tile("平均セッション時間", fmtDur(t.averageSessionDuration.current), delta(t.averageSessionDuration.current, t.averageSessionDuration.previous))}
    ${tile("キーイベント", fmtInt(t.keyEvents.current), delta(t.keyEvents.current, t.keyEvents.previous))}
    ${tile("CVR（キーイベント/セッション）", fmtPct(cvr), delta(cvr, cvrPrev))}
  </div>

  <div class="card">
    <div class="chart-head">
      <h3>日別推移</h3>
      <div class="seg" role="radiogroup" aria-label="指標" id="metric-seg">
        <button data-metric="activeUsers" role="radio" aria-checked="${state.metric === "activeUsers"}">ユーザー</button>
        <button data-metric="sessions" role="radio" aria-checked="${state.metric === "sessions"}">セッション</button>
        <button data-metric="keyEvents" role="radio" aria-checked="${state.metric === "keyEvents"}">キーイベント</button>
      </div>
      <div class="legend"><span><i style="background:var(--series-1)"></i>今期間</span><span><i style="background:var(--series-prev)"></i>前期間</span></div>
    </div>
    <div class="chart-box"><canvas id="trend" aria-label="日別推移グラフ"></canvas></div>
  </div>

  <div class="grid grid-2">
    <div class="card"><h3>チャネル別セッション</h3>${bars(g.channels.map((c) => [c.channel, c.sessions, `${fmtInt(c.sessions)}<span class="muted small"> / CV ${fmtInt(c.keyEvents)}</span>`]))}</div>
    <div class="card"><h3>デバイス別セッション</h3>${bars(g.devices.map((d) => [d.device, d.sessions, `${fmtPct(ratio(d.sessions, t.sessions.current))}`]))}
      <h3 style="margin-top:16px">参照元 / メディア</h3>${bars(g.sourceMedium.map((s) => [s.sourceMedium, s.sessions, `${fmtInt(s.sessions)}<span class="muted small"> / CV ${fmtInt(s.keyEvents)}</span>`]))}
    </div>
  </div>

  <div class="grid grid-2">
    <div class="card"><h3>よく見られているページ</h3><div class="table-wrap"><table>
      <thead><tr><th>ページ</th><th class="r">表示回数</th><th class="r">ユーザー</th><th class="r">エンゲージ率</th></tr></thead>
      <tbody>${g.topPages.map((p) => `<tr><td class="path" title="${esc(p.path)}">${esc(p.title || p.path)}<small>${esc(p.path)}</small></td><td class="r">${fmtInt(p.views)}</td><td class="r">${fmtInt(p.users)}</td><td class="r">${fmtPct(p.engagementRate)}</td></tr>`).join("")}</tbody>
    </table></div></div>
    <div class="card"><h3>ランディングページ</h3><div class="table-wrap"><table>
      <thead><tr><th>ページ</th><th class="r">セッション</th><th class="r">エンゲージ率</th><th class="r">キーイベント</th></tr></thead>
      <tbody>${g.landingPages.map((p) => `<tr><td class="path" title="${esc(p.path)}">${esc(p.path)}</td><td class="r">${fmtInt(p.sessions)}</td><td class="r">${fmtPct(p.engagementRate)}</td><td class="r">${fmtInt(p.keyEvents)}</td></tr>`).join("")}</tbody>
    </table></div></div>
  </div>`;
}

function bars(items) {
  if (!items.length) return `<p class="muted small">データなし</p>`;
  const max = Math.max(...items.map((i) => i[1]), 1);
  return `<div class="bars">${items
    .map(
      ([name, v, label]) =>
        `<div class="bar-row"><span class="name" title="${esc(name)}">${esc(name)}</span><div class="bar-track"><div class="bar-fill" style="width:${(v / max) * 100}%"></div></div><span class="num">${label}</span></div>`,
    )
    .join("")}</div>`;
}

function renderAds(a) {
  const t = a.totals;
  const ctr = ratio(t.clicks.current, t.impressions.current);
  const ctrPrev = ratio(t.clicks.previous, t.impressions.previous);
  const cpc = ratio(t.cost.current, t.clicks.current);
  const cpcPrev = ratio(t.cost.previous, t.clicks.previous);
  const cpa = ratio(t.cost.current, t.conversions.current);
  const cpaPrev = ratio(t.cost.previous, t.conversions.previous);
  return `
  <div class="section-title"><h2>Google広告</h2><span class="muted small">アカウント ${a.accounts.map(esc).join(", ")}</span></div>
  <div class="tiles">
    ${tile("費用", fmtYen(t.cost.current), delta(t.cost.current, t.cost.previous, null))}
    ${tile("表示回数", fmtInt(t.impressions.current), delta(t.impressions.current, t.impressions.previous))}
    ${tile("クリック", fmtInt(t.clicks.current), delta(t.clicks.current, t.clicks.previous))}
    ${tile("CTR", fmtPct(ctr), delta(ctr, ctrPrev))}
    ${tile("平均CPC", fmtYen(cpc), delta(cpc, cpcPrev, false))}
    ${tile("コンバージョン", fmtDec(t.conversions.current), delta(t.conversions.current, t.conversions.previous))}
    ${tile("CPA", t.conversions.current ? fmtYen(cpa) : "-", t.conversions.current ? delta(cpa, cpaPrev, false) : "")}
  </div>
  <div class="grid grid-2">
    <div class="card"><h3>日別の費用</h3><div class="chart-box sm"><canvas id="ads-cost"></canvas></div></div>
    <div class="card"><h3>日別のコンバージョン</h3><div class="chart-box sm"><canvas id="ads-conv"></canvas></div></div>
  </div>
  <div class="card"><h3>キャンペーン別（費用順）</h3><div class="table-wrap"><table>
    <thead><tr><th>キャンペーン</th><th>種類</th><th class="r">費用</th><th class="r">表示回数</th><th class="r">クリック</th><th class="r">CTR</th><th class="r">CV</th><th class="r">CPA</th></tr></thead>
    <tbody>${a.campaigns
      .map(
        (c) => `<tr><td class="path" title="${esc(c.name)}">${esc(c.name)}${c.status !== "ENABLED" ? ` <span class="muted small">(${esc(c.status)})</span>` : ""}</td>
        <td class="muted small">${esc(c.channelType)}</td><td class="r">${fmtYen(c.cost)}</td><td class="r">${fmtInt(c.impressions)}</td>
        <td class="r">${fmtInt(c.clicks)}</td><td class="r">${fmtPct(ratio(c.clicks, c.impressions))}</td><td class="r">${fmtDec(c.conversions)}</td>
        <td class="r">${c.conversions ? fmtYen(c.cost / c.conversions) : "-"}</td></tr>`,
      )
      .join("")}</tbody>
  </table></div></div>`;
}

function renderAdvice(advice, siteId) {
  const el = $("#advice");
  if (!el) return;
  const head = `<div class="chart-head"><h2 style="margin:0">AIアドバイス</h2>
    <div><span class="muted small">${advice ? `${fmtTime(advice.generatedAt)} 生成${advice.demo ? "（サンプル）" : ""}` : ""}</span>
    <button class="btn" id="advice-gen" data-site="${esc(siteId)}">${advice ? "作り直す" : "アドバイスを作る"}</button></div></div>`;
  if (!advice) {
    el.innerHTML = `${head}<p class="muted">まだアドバイスがありません。毎朝7時に自動で作られます。今すぐ作る場合はボタンを押してください（30秒〜1分ほどかかります）。</p>`;
    return;
  }
  const toneLabel = { good: "好調", warning: "注意", critical: "要対応", info: "参考" };
  const prioLabel = { high: "優先度 高", medium: "優先度 中", low: "優先度 低" };
  el.innerHTML = `${head}
    <p class="summary">${esc(advice.summary)}</p>
    <div class="grid grid-2">
      <div><h3>気づき</h3><ul class="findings">${advice.findings
        .map((f) => `<li><strong><span class="tone ${esc(f.tone)}">${toneLabel[f.tone] ?? ""}</span>${esc(f.title)}</strong>${esc(f.detail)}</li>`)
        .join("")}</ul></div>
      <div><h3>改善アクション</h3><ul class="actions">${advice.actions
        .map((a) => `<li><strong><span class="prio ${esc(a.priority)}">${prioLabel[a.priority] ?? ""}</span>${esc(a.title)}</strong>${esc(a.detail)}<div class="muted small">追う指標: ${esc(a.metric)}</div></li>`)
        .join("")}</ul></div>
    </div>`;
}

function drawTrend(g) {
  const canvas = $("#trend");
  if (!canvas) return;
  const existing = state.charts.find((c) => c.canvas === canvas);
  if (existing) {
    existing.destroy();
    state.charts = state.charts.filter((c) => c !== existing);
  }
  const key = state.metric;
  const label = { activeUsers: "ユーザー", sessions: "セッション", keyEvents: "キーイベント" }[key];
  lineChart(
    canvas,
    g.daily.map((d) => md(d.date)),
    [
      { label: `${label}（今期間）`, data: g.daily.map((d) => d[key]), borderColor: cssVar("--series-1"), backgroundColor: cssVar("--series-1") },
      {
        label: `${label}（前期間）`,
        data: g.dailyPrevious.map((d) => d[key]),
        borderColor: cssVar("--series-prev"),
        backgroundColor: cssVar("--series-prev"),
        borderDash: [4, 4],
      },
    ],
    fmtInt,
  );
}

async function renderSite(siteId) {
  const site = state.sites.find((s) => s.id === siteId);
  const view = $("#view");
  view.innerHTML = `<p class="muted">読み込み中…</p>`;

  const draw = (report, stale) => {
    if (state.tab !== siteId) return;
    destroyCharts();
    const errors = [report.ga4Error && `GA4: ${report.ga4Error}`, report.adsError && `Google広告: ${report.adsError}`].filter(Boolean);
    view.innerHTML = `
      <div class="statusline"><h2 style="margin:0">${esc(site.name)}</h2>${site.url ? `<a class="small" href="${esc(site.url)}" target="_blank" rel="noopener">${esc(site.url)}</a>` : ""}</div>
      ${statusLine(report, stale)}
      ${errors.map((e) => `<div class="alert">${esc(e)}</div>`).join("")}
      ${site.hasGa4 ? `<div class="tiles today" id="today">${todayTiles(report.ga4)}</div>` : ""}
      <div class="card advice" id="advice"><p class="muted">AIアドバイスを読み込み中…</p></div>
      ${report.ga4 ? renderGa4(report.ga4) : ""}
      ${report.ads ? renderAds(report.ads) : ""}
      ${!site.hasAds ? `<p class="muted small">このサイトにはGoogle広告アカウントが紐付いていません。</p>` : ""}`;
    if (report.ga4) drawTrend(report.ga4);
    if (report.ads) {
      const labels = report.ads.daily.map((d) => md(d.date));
      barChart($("#ads-cost"), labels, report.ads.daily.map((d) => d.cost), "費用", fmtYen);
      barChart($("#ads-conv"), labels, report.ads.daily.map((d) => d.conversions), "コンバージョン", fmtDec);
    }
    $("#metric-seg")?.addEventListener("click", (e) => {
      const m = e.target.closest("button")?.dataset.metric;
      if (!m) return;
      state.metric = m;
      $("#metric-seg").querySelectorAll("button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.metric === m)));
      drawTrend(report.ga4);
    });
    api(`/api/advice?site=${encodeURIComponent(siteId)}`)
      .then(({ advice }) => renderAdvice(advice, siteId))
      .catch((e) => ($("#advice").innerHTML = `<div class="alert">${esc(e.message)}</div>`));
    if (site.hasGa4) startRealtime(siteId);
  };

  try {
    await loadReportFresh(siteId, draw);
  } catch (e) {
    view.innerHTML = `<div class="alert">${esc(e.message)}</div>`;
  }
}

function todayTiles(g) {
  const t = g?.today ?? { activeUsers: 0, sessions: 0, keyEvents: 0 };
  return `
    ${tile("リアルタイム（直近30分）", `<span class="live-dot"></span><span id="rt-users">-</span>`, `<span class="muted small">1分ごとに更新</span>`)}
    ${tile("今日のユーザー（速報）", fmtInt(t.activeUsers))}
    ${tile("今日のセッション（速報）", fmtInt(t.sessions))}
    ${tile("今日のキーイベント（速報）", fmtInt(t.keyEvents))}`;
}

function startRealtime(siteId) {
  clearInterval(state.realtimeTimer);
  const tick = async () => {
    if (state.tab !== siteId || document.hidden) return;
    try {
      const rt = await api(`/api/realtime?site=${encodeURIComponent(siteId)}`);
      const el = $("#rt-users");
      if (el) el.textContent = fmtInt(rt.activeUsers);
    } catch {
      const el = $("#rt-users");
      if (el) el.textContent = "取得失敗";
    }
  };
  tick();
  state.realtimeTimer = setInterval(tick, 60_000);
}

function render() {
  clearInterval(state.realtimeTimer);
  destroyCharts();
  renderTabs();
  document.querySelectorAll("[data-range]").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.range === state.range)));
  if (state.tab === "summary" || !state.sites.some((s) => s.id === state.tab)) {
    state.tab = "summary";
    renderTabs();
    return renderSummary();
  }
  return renderSite(state.tab);
}

// ---------- events ----------
document.addEventListener("click", async (e) => {
  const tab = e.target.closest("[data-tab]");
  if (tab) {
    state.tab = tab.dataset.tab;
    remember();
    return render();
  }
  const go = e.target.closest("[data-goto]");
  if (go) {
    state.tab = go.dataset.goto;
    remember();
    return render();
  }
  const r = e.target.closest("[data-range]");
  if (r) {
    state.range = r.dataset.range;
    remember();
    return render();
  }
  if (e.target.id === "refresh") {
    const btn = e.target;
    btn.disabled = true;
    btn.textContent = "更新中…";
    try {
      const ids = state.tab === "summary" ? state.sites.map((s) => s.id) : [state.tab];
      await Promise.all(ids.map((id) => loadReport(id, { force: true })));
      await render();
    } catch (err) {
      alertBox(err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = "最新に更新";
    }
  }
  if (e.target.id === "advice-gen") {
    const btn = e.target;
    const siteId = btn.dataset.site;
    btn.disabled = true;
    btn.textContent = "生成中…";
    try {
      const { advice, cooldown } = await api(`/api/advice?site=${encodeURIComponent(siteId)}&range=${state.range}`, { method: "POST" });
      renderAdvice(advice, siteId);
      if (cooldown) $("#advice").insertAdjacentHTML("beforeend", `<p class="muted small">直前に作成済みのため、5分以内の再生成は行いません。</p>`);
    } catch (err) {
      $("#advice").insertAdjacentHTML("beforeend", `<div class="alert">${esc(err.message)}</div>`);
      btn.disabled = false;
      btn.textContent = "もう一度試す";
    }
  }
});

function alertBox(msg) {
  $("#view").insertAdjacentHTML("afterbegin", `<div class="alert">${esc(msg)}</div>`);
}

// ---------- boot ----------
(async () => {
  try {
    const { sites, demo, user } = await api("/api/sites");
    state.sites = sites;
    state.demo = demo;
    $("#demo-badge").hidden = !demo;
    $("#user").textContent = user;
    await render();
  } catch (e) {
    $("#view").innerHTML = `<div class="alert">${esc(e.message)}</div>`;
  }
})();
