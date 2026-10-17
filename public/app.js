// RIK Web解析ダッシュボード（フロント）
// データは /api/* から取得。キャッシュが古ければまず即表示し、裏で最新を取り直して差し替える。

const state = {
  sites: [],
  demo: false,
  tab: "summary",
  range: "28d",
  compare: "prev",
  metric: "activeUsers",
  charts: [],
  realtimeTimer: null,
};

try {
  const saved = JSON.parse(localStorage.getItem("rik-dash") || "{}");
  if (saved.range) state.range = saved.range;
  if (saved.compare) state.compare = saved.compare;
  if (saved.tab) state.tab = saved.tab;
} catch {}
const remember = () => {
  try {
    localStorage.setItem("rik-dash", JSON.stringify({ range: state.range, compare: state.compare, tab: state.tab }));
  } catch {}
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
const COMPARE_LABEL = { prev: "前期間比", yoy: "前年同期比" };
const COMPARE_NAME = { prev: "前期間", yoy: "前年同期" };
const RANGE_LABEL = { "7d": "7日", "28d": "28日", "90d": "90日" };
const DEVICE_LABEL = { mobile: "スマホ", desktop: "PC", tablet: "タブレット", MOBILE: "スマホ", DESKTOP: "PC", TABLET: "タブレット", CONNECTED_TV: "テレビ", OTHER: "その他" };
const CHANNEL_TYPE_LABEL = {
  SEARCH: "検索",
  DISPLAY: "ディスプレイ",
  PERFORMANCE_MAX: "P-MAX",
  DEMAND_GEN: "デマンドジェネレーション",
  VIDEO: "動画",
  SHOPPING: "ショッピング",
  SMART: "スマート",
};
const MATCH_LABEL = { EXACT: "完全一致", PHRASE: "フレーズ一致", BROAD: "部分一致" };

async function api(path, opts) {
  const res = await fetch(path, opts);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

/**
 * 比較期間比。higherIsBetter=false の指標（CPAなど）は色を反転、null は色を付けない
 */
function delta(cur, prev, higherIsBetter = true) {
  const label = COMPARE_LABEL[state.compare];
  if (!prev) return `<span class="delta flat">${COMPARE_NAME[state.compare]}データなし</span>`;
  const d = (cur - prev) / prev;
  const arrow = d > 0.005 ? "▲" : d < -0.005 ? "▼" : "→";
  let cls = "flat";
  if (Math.abs(d) > 0.005 && higherIsBetter !== null) cls = (d > 0) === higherIsBetter ? "good" : "bad";
  return `<span class="delta ${cls}">${arrow} ${(Math.abs(d) * 100).toFixed(1)}% <span class="muted">${label}</span></span>`;
}

function tile(label, value, deltaHtml = "", hint = "") {
  return `<div class="tile"${hint ? ` title="${esc(hint)}"` : ""}><div class="label">${esc(label)}</div><div class="value">${value}</div>${deltaHtml}</div>`;
}

const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function destroyCharts() {
  state.charts.forEach((c) => c.destroy());
  state.charts = [];
}

function chartScales(format) {
  const grid = cssVar("--border");
  const text = cssVar("--text-secondary");
  return {
    x: { grid: { display: false }, ticks: { color: text, maxRotation: 0, autoSkip: true, maxTicksLimit: 8 } },
    y: { beginAtZero: true, grid: { color: grid }, border: { display: false }, ticks: { color: text, callback: format } },
  };
}

function lineChart(canvas, labels, datasets, format) {
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
      scales: chartScales(format),
    },
  });
  state.charts.push(chart);
  return chart;
}

function barChart(canvas, labels, data, label, format) {
  const chart = new Chart(canvas, {
    type: "bar",
    data: { labels, datasets: [{ label, data, backgroundColor: cssVar("--series-1"), borderRadius: 4, maxBarThickness: 18 }] },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => `${label}: ${format(c.parsed.y)}` } } },
      scales: chartScales(format),
    },
  });
  state.charts.push(chart);
  return chart;
}

const md = (date) => `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;

// ---------- data ----------
async function loadReport(siteId, { force = false } = {}) {
  const q = `/api/report?site=${encodeURIComponent(siteId)}&range=${state.range}&compare=${state.compare}${force ? "&refresh=1" : ""}`;
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
  const parts = [
    `<span class="muted small">期間 ${report.current.startDate} 〜 ${report.current.endDate}（${COMPARE_NAME[report.compare]} ${report.previous.startDate} 〜 ${report.previous.endDate}）</span>`,
  ];
  parts.push(`<span class="muted small">取得 ${fmtTime(report.fetchedAt)}</span>`);
  if (stale) parts.push(`<span class="badge badge-info">最新データを取得中…</span>`);
  if (report.demo) parts.push(`<span class="badge badge-warn">デモデータ</span>`);
  return `<div class="statusline">${parts.join("")}</div>`;
}

/** GA4 / Google広告 の見出し。色と名称で出どころを区別する */
function sourceHeader(kind, extra = "") {
  const conf = {
    ga4: { chip: "GA4", title: "サイトのアクセス解析", sub: "Googleアナリティクス4｜サイトに来た人の数と行動" },
    ads: { chip: "Google広告", title: "広告の成果", sub: "Google広告｜広告費と、そこから得た成果" },
  }[kind];
  return `<header class="src-head">
    <span class="src-chip">${conf.chip}</span>
    <div><h2>${conf.title}</h2><div class="muted small">${conf.sub}${extra ? `｜${extra}` : ""}</div></div>
  </header>`;
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
      if (error) return `<tr><td>${esc(s.name)}</td><td colspan="9" class="muted">${esc(error)}</td></tr>`;
      const g = report.ga4?.totals;
      const a = report.ads?.totals;
      const cpa = a ? ratio(a.cost.current, a.conversions.current) : 0;
      const cpaPrev = a ? ratio(a.cost.previous, a.conversions.previous) : 0;
      return `<tr>
        <td><button class="btn" data-goto="${esc(s.id)}">${esc(s.name)}</button></td>
        <td class="r ga4-col">${g ? fmtInt(g.activeUsers.current) : "-"}<br>${g ? delta(g.activeUsers.current, g.activeUsers.previous) : ""}</td>
        <td class="r ga4-col">${g ? fmtInt(g.sessions.current) : "-"}</td>
        <td class="r ga4-col">${g ? fmtInt(g.keyEvents.current) : "-"}<br>${g ? delta(g.keyEvents.current, g.keyEvents.previous) : ""}</td>
        <td class="r ga4-col">${g ? fmtPct(ratio(g.keyEvents.current, g.sessions.current)) : "-"}</td>
        <td class="r ads-col">${a ? fmtYen(a.cost.current) : "-"}<br>${a ? delta(a.cost.current, a.cost.previous, null) : ""}</td>
        <td class="r ads-col">${a ? fmtDec(a.conversions.current) : "-"}</td>
        <td class="r ads-col">${a && a.conversions.current ? `${fmtYen(cpa)}<br>${delta(cpa, cpaPrev, false)}` : "-"}</td>
        <td style="white-space:normal;min-width:260px">${advice ? esc(advice.summary) : '<span class="muted">未生成</span>'}</td>
      </tr>`;
    })
    .join("");
  $("#sum-body").innerHTML = `<table class="summary-table">
    <thead>
      <tr><th></th><th colspan="4" class="grp ga4-grp">GA4｜サイトのアクセス</th><th colspan="3" class="grp ads-grp">Google広告｜広告の成果</th><th></th></tr>
      <tr><th>サイト</th><th class="r">ユーザー</th><th class="r">セッション</th><th class="r">キーイベント</th><th class="r">CVR</th><th class="r">広告費</th><th class="r">広告CV</th><th class="r">CPA</th><th>AIのひとこと</th></tr>
    </thead>
    <tbody>${body}</tbody></table>`;
}

function renderGa4(g) {
  const t = g.totals;
  const cvr = ratio(t.keyEvents.current, t.sessions.current);
  const cvrPrev = ratio(t.keyEvents.previous, t.sessions.previous);
  return `<section class="src src-ga4">
  ${sourceHeader("ga4")}
  <div class="card advice-box" id="advice-ga4"><p class="muted">AIの総評を読み込み中…</p></div>
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
      <div class="legend"><span><i style="background:var(--series-1)"></i>今期間</span><span><i style="background:var(--series-prev)"></i>${COMPARE_NAME[state.compare]}</span></div>
    </div>
    <div class="chart-box"><canvas id="trend" aria-label="日別推移グラフ"></canvas></div>
  </div>

  <div class="grid grid-2">
    <div class="card"><h3>チャネル別セッション</h3>${bars(g.channels.map((c) => [c.channel, c.sessions, `${fmtInt(c.sessions)}<span class="muted small"> / CV ${fmtInt(c.keyEvents)}</span>`]))}</div>
    <div class="card"><h3>デバイス別セッション</h3>${bars(g.devices.map((d) => [DEVICE_LABEL[d.device] ?? d.device, d.sessions, `${fmtPct(ratio(d.sessions, t.sessions.current))}`]))}
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
  </div>
  </section>`;
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

/** 検索キャンペーンのインプレッションシェアを、表示可能回数で重み付けして合算する */
function weightedShare(campaigns, key) {
  let eligible = 0;
  let lost = 0;
  let impr = 0;
  for (const c of campaigns) {
    if (!c.searchImpressionShare) continue;
    const e = c.impressions / c.searchImpressionShare;
    eligible += e;
    impr += c.impressions;
    if (key && c[key] != null) lost += e * c[key];
  }
  if (!eligible) return null;
  return key ? lost / eligible : impr / eligible;
}

/** キャンペーンの費用対効果の目安。アカウント平均CPAとの比較で判定する */
function judgeCampaign(c, avgCpa) {
  const tags = [];
  if (!c.conversions) {
    if (avgCpa && c.cost > avgCpa) tags.push(["bad", "CVなし"]);
  } else if (avgCpa) {
    const cpa = c.cost / c.conversions;
    if (cpa <= avgCpa * 0.8) tags.push(["good", "効率良"]);
    else if (cpa >= avgCpa * 1.5) tags.push(["bad", "割高"]);
  }
  if (c.searchBudgetLostIs != null && c.searchBudgetLostIs >= 0.2) tags.push(["warn", "予算不足"]);
  if (c.searchRankLostIs != null && c.searchRankLostIs >= 0.3) tags.push(["warn", "ランク不足"]);
  return tags.map(([cls, label]) => `<span class="judge ${cls}">${label}</span>`).join("");
}

const pctOrDash = (v) => (v == null ? "-" : fmtPct(v));

function renderAds(a) {
  const t = a.totals;
  const ctr = ratio(t.clicks.current, t.impressions.current);
  const ctrPrev = ratio(t.clicks.previous, t.impressions.previous);
  const cpc = ratio(t.cost.current, t.clicks.current);
  const cpcPrev = ratio(t.cost.previous, t.clicks.previous);
  const cvr = ratio(t.conversions.current, t.clicks.current);
  const cvrPrev = ratio(t.conversions.previous, t.clicks.previous);
  const cpa = ratio(t.cost.current, t.conversions.current);
  const cpaPrev = ratio(t.cost.previous, t.conversions.previous);
  const hasValue = t.conversionsValue.current > 0 || t.conversionsValue.previous > 0;
  const roas = ratio(t.conversionsValue.current, t.cost.current);
  const roasPrev = ratio(t.conversionsValue.previous, t.cost.previous);
  const is = weightedShare(a.campaigns);
  const isBudget = weightedShare(a.campaigns, "searchBudgetLostIs");
  const isRank = weightedShare(a.campaigns, "searchRankLostIs");
  const avgCpa = t.conversions.current ? cpa : 0;
  const wasteThreshold = avgCpa ? avgCpa * 0.5 : 0;

  return `<section class="src src-ads">
  ${sourceHeader("ads", `アカウント ${a.accounts.map(esc).join(", ")}`)}
  <div class="card advice-box" id="advice-ads"><p class="muted">AIの総評を読み込み中…</p></div>

  <h3 class="sub">費用と成果</h3>
  <div class="tiles">
    ${tile("広告費", fmtYen(t.cost.current), delta(t.cost.current, t.cost.previous, null))}
    ${tile("コンバージョン（CV）", fmtDec(t.conversions.current), delta(t.conversions.current, t.conversions.previous))}
    ${tile("CPA（1件あたりの獲得単価）", t.conversions.current ? fmtYen(cpa) : "-", t.conversions.current ? delta(cpa, cpaPrev, false) : "", "広告費 ÷ CV。低いほど効率が良い")}
    ${tile("CVR（クリック→CV）", fmtPct(cvr), delta(cvr, cvrPrev), "CV ÷ クリック")}
    ${hasValue ? tile("ROAS（CV値÷広告費）", fmtPct(roas), delta(roas, roasPrev), "広告費1円あたりのコンバージョン値") : ""}
  </div>
  <h3 class="sub">露出とクリック</h3>
  <div class="tiles">
    ${tile("表示回数", fmtInt(t.impressions.current), delta(t.impressions.current, t.impressions.previous))}
    ${tile("クリック", fmtInt(t.clicks.current), delta(t.clicks.current, t.clicks.previous))}
    ${tile("CTR（クリック率）", fmtPct(ctr), delta(ctr, ctrPrev))}
    ${tile("平均CPC（クリック単価）", fmtYen(cpc), delta(cpc, cpcPrev, false))}
    ${is != null ? tile("検索インプレッションシェア", fmtPct(is), `<span class="delta flat">表示できた割合（検索キャンペーン）</span>`) : ""}
    ${isBudget != null ? tile("予算による損失", fmtPct(isBudget), `<span class="delta ${isBudget >= 0.2 ? "bad" : "flat"}">予算不足で表示を逃した割合</span>`) : ""}
    ${isRank != null ? tile("広告ランクによる損失", fmtPct(isRank), `<span class="delta ${isRank >= 0.3 ? "bad" : "flat"}">入札・品質不足で逃した割合</span>`) : ""}
  </div>

  <div class="grid grid-2">
    <div class="card"><h3>日別の広告費</h3><div class="chart-box sm"><canvas id="ads-cost"></canvas></div></div>
    <div class="card"><h3>日別のコンバージョン</h3><div class="chart-box sm"><canvas id="ads-conv"></canvas></div></div>
  </div>

  <div class="card"><h3>キャンペーン別の費用対効果（費用順）</h3>
    <p class="muted small">判定はアカウント平均CPA（${avgCpa ? fmtYen(avgCpa) : "-"}）との比較です。効率良: 平均の0.8倍以下 / 割高: 1.5倍以上 / CVなし: 平均CPA以上使ってCV0 / 予算不足: 予算による損失20%以上 / ランク不足: ランクによる損失30%以上</p>
    <div class="table-wrap"><table>
    <thead><tr><th>キャンペーン</th><th>種類</th><th class="r">費用</th><th class="r">クリック</th><th class="r">CTR</th><th class="r">CV</th><th class="r">CVR</th><th class="r">CPA</th>${hasValue ? '<th class="r">ROAS</th>' : ""}<th class="r">検索IS</th><th class="r">予算損失</th><th class="r">ランク損失</th><th>判定</th></tr></thead>
    <tbody>${a.campaigns
      .map(
        (c) => `<tr><td class="path" title="${esc(c.name)}">${esc(c.name)}${c.status !== "ENABLED" ? ` <span class="muted small">(${esc(c.status)})</span>` : ""}</td>
        <td class="muted small">${esc(CHANNEL_TYPE_LABEL[c.channelType] ?? c.channelType)}</td><td class="r">${fmtYen(c.cost)}</td>
        <td class="r">${fmtInt(c.clicks)}</td><td class="r">${fmtPct(ratio(c.clicks, c.impressions))}</td><td class="r">${fmtDec(c.conversions)}</td>
        <td class="r">${fmtPct(ratio(c.conversions, c.clicks))}</td>
        <td class="r">${c.conversions ? fmtYen(c.cost / c.conversions) : "-"}</td>
        ${hasValue ? `<td class="r">${c.cost ? fmtPct(c.conversionsValue / c.cost) : "-"}</td>` : ""}
        <td class="r">${pctOrDash(c.searchImpressionShare)}</td><td class="r">${pctOrDash(c.searchBudgetLostIs)}</td><td class="r">${pctOrDash(c.searchRankLostIs)}</td>
        <td>${judgeCampaign(c, avgCpa)}</td></tr>`,
      )
      .join("")}</tbody>
  </table></div></div>

  <div class="grid grid-2">
    <div class="card"><h3>デバイス別の費用対効果</h3><div class="table-wrap"><table>
      <thead><tr><th>デバイス</th><th class="r">費用</th><th class="r">クリック</th><th class="r">CV</th><th class="r">CVR</th><th class="r">CPA</th></tr></thead>
      <tbody>${a.devices
        .map(
          (d) => `<tr><td>${esc(DEVICE_LABEL[d.device] ?? d.device)}</td><td class="r">${fmtYen(d.cost)}</td><td class="r">${fmtInt(d.clicks)}</td>
          <td class="r">${fmtDec(d.conversions)}</td><td class="r">${fmtPct(ratio(d.conversions, d.clicks))}</td><td class="r">${d.conversions ? fmtYen(d.cost / d.conversions) : "-"}</td></tr>`,
        )
        .join("")}</tbody>
    </table></div></div>
    <div class="card"><h3>キーワード（費用順）</h3><div class="table-wrap"><table>
      <thead><tr><th>キーワード</th><th class="r">費用</th><th class="r">クリック</th><th class="r">CV</th><th class="r">CPA</th></tr></thead>
      <tbody>${a.keywords
        .map(
          (k) => `<tr><td class="path" title="${esc(k.campaign)}">${esc(k.text)}<small>${esc(MATCH_LABEL[k.matchType] ?? k.matchType)}｜${esc(k.campaign)}</small></td>
          <td class="r">${fmtYen(k.cost)}</td><td class="r">${fmtInt(k.clicks)}</td><td class="r">${fmtDec(k.conversions)}</td>
          <td class="r">${k.conversions ? fmtYen(k.cost / k.conversions) : !k.conversions && wasteThreshold && k.cost >= wasteThreshold ? '<span class="judge bad">除外候補</span>' : "-"}</td></tr>`,
        )
        .join("") || `<tr><td colspan="5" class="muted">データなし</td></tr>`}</tbody>
    </table></div></div>
  </div>

  <div class="card"><h3>実際に検索された語句（費用順）</h3>
    <p class="muted small">「除外候補」は平均CPAの半分以上の費用を使ってCVが0の語句です。</p>
    <div class="table-wrap"><table>
    <thead><tr><th>検索語句</th><th>キャンペーン</th><th class="r">表示回数</th><th class="r">クリック</th><th class="r">費用</th><th class="r">CV</th><th></th></tr></thead>
    <tbody>${a.searchTerms
      .map(
        (s) => `<tr><td class="path">${esc(s.term)}</td><td class="muted small">${esc(s.campaign)}</td><td class="r">${fmtInt(s.impressions)}</td>
        <td class="r">${fmtInt(s.clicks)}</td><td class="r">${fmtYen(s.cost)}</td><td class="r">${fmtDec(s.conversions)}</td>
        <td>${!s.conversions && wasteThreshold && s.cost >= wasteThreshold ? '<span class="judge bad">除外候補</span>' : ""}</td></tr>`,
      )
      .join("") || `<tr><td colspan="7" class="muted">データなし</td></tr>`}</tbody>
  </table></div></div>
  </section>`;
}

const TONE_LABEL = { good: "好調", warning: "注意", critical: "要対応", info: "参考" };
const PRIO_LABEL = { high: "優先度 高", medium: "優先度 中", low: "優先度 低" };

function adviceSection(sec, kindLabel) {
  return `<h3 class="advice-title">AIによる総評（${kindLabel}）</h3>
    <p class="review">${esc(sec.review)}</p>
    <div class="grid grid-2">
      <div><h3>気づき</h3><ul class="findings">${sec.findings
        .map((f) => `<li><strong><span class="tone ${esc(f.tone)}">${TONE_LABEL[f.tone] ?? ""}</span>${esc(f.title)}</strong>${esc(f.detail)}</li>`)
        .join("")}</ul></div>
      <div><h3>改善アドバイス</h3><ul class="actions">${sec.actions
        .map((a) => `<li><strong><span class="prio ${esc(a.priority)}">${PRIO_LABEL[a.priority] ?? ""}</span>${esc(a.title)}</strong>${esc(a.detail)}<div class="muted small">追う指標: ${esc(a.metric)}</div></li>`)
        .join("")}</ul></div>
    </div>`;
}

function renderAdvice(advice, siteId) {
  const meta = advice
    ? `${fmtTime(advice.generatedAt)} 生成｜${RANGE_LABEL[advice.range] ?? ""}・${COMPARE_LABEL[advice.compare] ?? ""}のデータから${advice.demo ? "（サンプル）" : ""}`
    : "";
  const top = $("#advice");
  if (top) {
    top.innerHTML = `<div class="chart-head"><h2 style="margin:0">AIのひとこと</h2>
      <div><span class="muted small">${meta}</span>
      <button class="btn" id="advice-gen" data-site="${esc(siteId)}">${advice ? "今の期間で作り直す" : "AIの総評を作る"}</button></div></div>
      ${advice ? `<p class="summary">${esc(advice.summary)}</p>` : `<p class="muted">まだAIの総評がありません。毎朝7時に自動で作られます。今すぐ作る場合はボタンを押してください（30秒〜1分ほどかかります）。</p>`}`;
  }
  const ga4 = $("#advice-ga4");
  if (ga4) ga4.innerHTML = advice?.ga4 ? adviceSection(advice.ga4, "GA4") : `<p class="muted small">GA4のAI総評はまだありません。</p>`;
  const ads = $("#advice-ads");
  if (ads) ads.innerHTML = advice?.ads ? adviceSection(advice.ads, "Google広告") : `<p class="muted small">Google広告のAI総評はまだありません。</p>`;
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
        label: `${label}（${COMPARE_NAME[state.compare]}）`,
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
      <div class="card advice" id="advice"><p class="muted">AIの総評を読み込み中…</p></div>
      ${report.ga4 ? renderGa4(report.ga4) : ""}
      ${report.ads ? renderAds(report.ads) : ""}
      ${!site.hasAds ? `<p class="muted small">このサイトにはGoogle広告アカウントが紐付いていません。</p>` : ""}`;
    if (report.ga4) drawTrend(report.ga4);
    if (report.ads) {
      const labels = report.ads.daily.map((d) => md(d.date));
      barChart($("#ads-cost"), labels, report.ads.daily.map((d) => d.cost), "広告費", fmtYen);
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
  document.querySelectorAll("[data-compare]").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.compare === state.compare)));
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
  const c = e.target.closest("[data-compare]");
  if (c) {
    state.compare = c.dataset.compare;
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
      const { advice, cooldown } = await api(
        `/api/advice?site=${encodeURIComponent(siteId)}&range=${state.range}&compare=${state.compare}`,
        { method: "POST" },
      );
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
