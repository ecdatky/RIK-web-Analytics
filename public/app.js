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
const PLATFORM_LABEL = { facebook: "Facebook", instagram: "Instagram", audience_network: "Audience Network", messenger: "Messenger", threads: "Threads" };
const OBJECTIVE_LABEL = {
  OUTCOME_LEADS: "リード獲得",
  OUTCOME_TRAFFIC: "トラフィック",
  OUTCOME_AWARENESS: "認知",
  OUTCOME_ENGAGEMENT: "エンゲージメント",
  OUTCOME_SALES: "売上",
  OUTCOME_APP_PROMOTION: "アプリ",
};
// CVで評価しない目的（認知など）は「CVなし」の判定を付けない
const NON_CV_OBJECTIVES = new Set(["OUTCOME_AWARENESS", "OUTCOME_ENGAGEMENT", "OUTCOME_TRAFFIC"]);

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

/** 比較期間比の色（good / bad）をタイル全体の縁取りにも使う。説明は用語集から自動で付ける */
function tile(label, value, deltaHtml = "", hint = "") {
  const tone = /delta (good|bad)/.exec(deltaHtml)?.[1];
  const help = hint || termHelp(label);
  return `<div class="tile${tone ? ` tile-${tone}` : ""}"${help ? ` title="${esc(help)}"` : ""}><div class="label">${esc(label)}${help ? '<span class="help" aria-hidden="true">?</span>' : ""}</div><div class="value">${value}</div>${deltaHtml}</div>`;
}

// ---------- 用語集 ----------
const GLOSSARY = [
  ["ユーザー", "期間中にサイトに来た人の数。同じ人が何回来ても1人と数えます。"],
  ["新規ユーザー", "期間中に初めてサイトに来た人の数。"],
  ["セッション", "サイトへの訪問1回分。同じ人が2回来れば2セッションです。"],
  ["表示回数", "ページや広告が表示された回数。"],
  ["エンゲージメント率", "10秒以上見る・2ページ以上見る・成果につながる行動をした訪問の割合。高いほどしっかり見られています。"],
  ["平均セッション時間", "1回の訪問でサイトに滞在した平均時間。"],
  ["キーイベント", "問い合わせ送信や資料請求など、成果として数えている行動の回数（GA4での呼び名）。"],
  ["コンバージョン", "広告やサイトで得た成果（問い合わせ・資料請求など）。CVと略します。"],
  ["CVR", "訪問や広告クリックのうち、成果（CV）につながった割合。高いほど良い状態です。"],
  ["CPA", "成果1件を得るのにかかった広告費。低いほど効率が良い状態です。"],
  ["ROAS", "広告費1円あたりに得た成果の金額。高いほど効率が良い状態です。"],
  ["CTR", "広告が表示された回数のうち、クリックされた割合。広告の反応の良さを表します。"],
  ["CPC", "広告1クリックあたりの費用。"],
  ["CPM", "広告を1,000回表示するのにかかった費用。"],
  ["広告費", "期間中に広告に使った金額。増えること自体は良し悪しではないので色は付けていません。"],
  ["クリック", "広告がクリックされた回数。"],
  ["インプレッションシェア", "広告を出せたはずの機会のうち、実際に表示できた割合。"],
  ["予算による損失", "予算が足りずに広告を出せなかった割合。"],
  ["広告ランクによる損失", "入札額や広告の質が足りずに出せなかった割合。"],
  ["リーチ", "広告を見た人の数。"],
  ["フリークエンシー", "1人あたりに広告が表示された回数。3回を超えると見飽きて効率が落ちやすくなります。"],
];
const BY_LENGTH = [...GLOSSARY].sort((a, b) => b[0].length - a[0].length);
/** ラベルの先頭の用語を優先し、無ければラベル中の用語で引く（長い用語から） */
function termHelp(label) {
  const hit = BY_LENGTH.find(([t]) => label.startsWith(t)) ?? BY_LENGTH.find(([t]) => label.includes(t));
  return hit?.[1] ?? "";
}

/** extra を渡すとその用語だけ（AIの本文に出てきた用語）、無ければ標準の用語集すべて */
function glossaryBlock(extra) {
  const items = extra ? extra.map((g) => [g.term, g.meaning]) : GLOSSARY;
  return `<details class="glossary"><summary>${extra ? "この文章に出てくる用語" : "用語の説明"}</summary><dl>${items
    .map(([t, m]) => `<div><dt>${esc(t)}</dt><dd>${esc(m)}</dd></div>`)
    .join("")}</dl></details>`;
}

// ---------- 状況の判定（数値から自動判定） ----------
const LEVELS = {
  good: { label: "好調", icon: "↑", text: "成果がはっきり伸びています" },
  steady: { label: "順調", icon: "↗", text: "おおむね良い方向です" },
  flat: { label: "横ばい", icon: "→", text: "大きな変化はありません" },
  caution: { label: "注意", icon: "↘", text: "悪化の兆しがあります" },
  bad: { label: "要対策", icon: "↓", text: "成果が落ちています。手を打つ必要があります" },
};
const LEVEL_ORDER = ["bad", "caution", "flat", "steady", "good"];

/**
 * 各指標の比較期間比を重み付けして合算し、5段階で判定する。
 * 訪問者数より成果（キーイベント・CV）とその効率を重く見る。件数が少ない指標は重みを下げる。
 */
function health(report) {
  const sig = [];
  const add = (name, cur, prev, weight, { lowerIsBetter = false, count = false, fmt = fmtInt } = {}) => {
    if (!prev || cur == null) return;
    const d = (cur - prev) / prev;
    const small = count && Math.max(cur, prev) < 10;
    const w = small ? weight / 3 : weight;
    let dir = Math.abs(d) < 0.05 ? 0 : d > 0 ? 1 : -1;
    if (lowerIsBetter) dir = -dir;
    const diff = cur - prev;
    const sign = diff > 0 ? "+" : diff < 0 ? "−" : "±";
    sig.push({
      name,
      dir,
      w,
      small,
      text: `${name} ${fmt(cur)}（${COMPARE_NAME[report.compare]}より${Math.abs(d * 100).toFixed(0)}%${d >= 0 ? "増" : "減"}、${sign}${fmt(Math.abs(diff))}）${small ? "※件数が少ないため参考" : ""}`,
    });
  };
  const g = report.ga4?.totals;
  if (g) {
    add("サイトに来た人", g.activeUsers.current, g.activeUsers.previous, 1, { count: true });
    add("成果（問い合わせ・資料請求など）", g.keyEvents.current, g.keyEvents.previous, 3, { count: true });
    add("訪問が成果につながる割合", ratio(g.keyEvents.current, g.sessions.current), ratio(g.keyEvents.previous, g.sessions.previous), 2, { fmt: fmtPct });
  }
  const a = report.ads?.totals;
  if (a) {
    add("Google広告からの成果", a.conversions.current, a.conversions.previous, 3, { count: true, fmt: fmtDec });
    if (a.conversions.current && a.conversions.previous) {
      add("Google広告の1件あたり費用", ratio(a.cost.current, a.conversions.current), ratio(a.cost.previous, a.conversions.previous), 2, { lowerIsBetter: true, fmt: fmtYen });
    }
  }
  const m = report.meta?.totals;
  if (m) {
    if (m.conversions.current || m.conversions.previous) {
      add("SNS広告からの成果", m.conversions.current, m.conversions.previous, 3, { count: true, fmt: fmtDec });
      if (m.conversions.current && m.conversions.previous) {
        add("SNS広告の1件あたり費用", ratio(m.spend.current, m.conversions.current), ratio(m.spend.previous, m.conversions.previous), 2, { lowerIsBetter: true, fmt: fmtYen });
      }
    } else {
      // CVを計測していない（投稿の宣伝など）場合はクリックの量と単価で見る
      add("SNS広告のクリック", m.clicks.current, m.clicks.previous, 1, { count: true });
      add("SNS広告のクリック単価", ratio(m.spend.current, m.clicks.current), ratio(m.spend.previous, m.clicks.previous), 1, { lowerIsBetter: true, fmt: fmtYen });
    }
  }
  const total = sig.reduce((s, x) => s + x.w, 0);
  if (!total) return null;
  const score = sig.reduce((s, x) => s + x.dir * x.w, 0) / total;
  const level = score >= 0.5 ? "good" : score >= 0.15 ? "steady" : score > -0.15 ? "flat" : score > -0.5 ? "caution" : "bad";
  const byWeight = (x, y) => y.w - x.w;
  return {
    level,
    score,
    goods: sig.filter((x) => x.dir > 0).sort(byWeight),
    bads: sig.filter((x) => x.dir < 0).sort(byWeight),
    flats: sig.filter((x) => x.dir === 0).sort(byWeight),
  };
}

function levelBadge(level, prefix = "") {
  const l = LEVELS[level];
  return l ? `<span class="lv lv-${level}"><i>${l.icon}</i>${prefix}${l.label}</span>` : "";
}

/** 5段階のメーター。今の位置を強調する */
function meter(level) {
  return `<div class="meter" role="img" aria-label="判定 ${LEVELS[level].label}">${LEVEL_ORDER.map(
    (k) => `<span class="seg-${k}${k === level ? " on" : ""}">${LEVELS[k].label}</span>`,
  ).join("")}</div>`;
}

function healthHero(report) {
  const h = health(report);
  if (!h) return "";
  const l = LEVELS[h.level];
  const list = (items, cls) => items.slice(0, 3).map((x) => `<li class="${cls}">${esc(x.text)}</li>`).join("");
  return `<section class="hero lv-${h.level}">
    <div class="hero-main">
      <div class="hero-icon" aria-hidden="true">${l.icon}</div>
      <div>
        <div class="hero-label">いまの状況：<strong>${l.label}</strong></div>
        <div class="hero-text" id="hero-headline">${esc(l.text)}</div>
        <div class="muted small">${RANGE_LABEL[report.range]}間を${COMPARE_NAME[report.compare]}と比べて、成果（問い合わせ・資料請求など）を重く見て自動判定しています。</div>
      </div>
    </div>
    ${meter(h.level)}
    <div class="hero-points">
      <div><h3>良くなった点</h3><ul>${list(h.goods, "up") || '<li class="none">特になし</li>'}</ul></div>
      <div><h3>気になる点</h3><ul>${list(h.bads, "down") || '<li class="none">特になし</li>'}</ul></div>
    </div>
  </section>`;
}

const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function destroyCharts() {
  state.charts.forEach((c) => c.destroy());
  state.charts = [];
}

if (window.Chart) {
  Chart.defaults.font.family = getComputedStyle(document.documentElement).getPropertyValue("--font").trim() || "sans-serif";
  Chart.defaults.font.size = 12;
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
    ads: { chip: "Google広告", title: "検索・ディスプレイ広告の成果", sub: "Google広告｜広告費と、そこから得た成果" },
    meta: { chip: "Meta広告", title: "SNS広告の成果", sub: "Facebook・Instagram広告｜広告費と、そこから得た成果" },
  }[kind];
  return `<header class="src-head">
    <span class="src-chip">${conf.chip}</span>
    <div><h2>${conf.title}</h2><div class="muted small">${conf.sub}${extra ? `｜${extra}` : ""}</div></div>
  </header>`;
}

async function renderSummary() {
  const view = $("#view");
  view.innerHTML = `<div id="sum-cards" class="status-cards"></div><div class="card"><h2>全サイトのサマリー</h2><div id="sum-body" class="table-wrap"><p class="muted">読み込み中…</p></div></div>`;
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
  $("#sum-cards").innerHTML = rows
    .map(({ s, report, advice, error }) => {
      const h = !error && health(report);
      if (!h) return "";
      const l = LEVELS[h.level];
      const point = advice?.headline || (h.bads[0] ? `気になる点：${h.bads[0].text}` : h.goods[0] ? `良くなった点：${h.goods[0].text}` : l.text);
      return `<button class="status-card lv-${h.level}" data-goto="${esc(s.id)}">
        <span class="sc-icon" aria-hidden="true">${l.icon}</span>
        <span class="sc-body"><span class="sc-name">${esc(s.name)}</span><span class="sc-label">${l.label}</span><span class="sc-text">${esc(point)}</span></span>
      </button>`;
    })
    .join("");
  const body = rows
    .map(({ s, report, advice, error }) => {
      if (error) return `<tr><td>${esc(s.name)}</td><td colspan="12" class="muted">${esc(error)}</td></tr>`;
      const h = health(report);
      const g = report.ga4?.totals;
      const a = report.ads?.totals;
      const m = report.meta?.totals;
      const cpa = a ? ratio(a.cost.current, a.conversions.current) : 0;
      const cpaPrev = a ? ratio(a.cost.previous, a.conversions.previous) : 0;
      const mCpa = m ? ratio(m.spend.current, m.conversions.current) : 0;
      const mCpaPrev = m ? ratio(m.spend.previous, m.conversions.previous) : 0;
      return `<tr>
        <td><button class="btn" data-goto="${esc(s.id)}">${esc(s.name)}</button></td>
        <td>${h ? levelBadge(h.level) : "-"}</td>
        <td class="r ga4-col">${g ? fmtInt(g.activeUsers.current) : "-"}<br>${g ? delta(g.activeUsers.current, g.activeUsers.previous) : ""}</td>
        <td class="r ga4-col">${g ? fmtInt(g.sessions.current) : "-"}</td>
        <td class="r ga4-col">${g ? fmtInt(g.keyEvents.current) : "-"}<br>${g ? delta(g.keyEvents.current, g.keyEvents.previous) : ""}</td>
        <td class="r ga4-col">${g ? fmtPct(ratio(g.keyEvents.current, g.sessions.current)) : "-"}</td>
        <td class="r ads-col">${a ? fmtYen(a.cost.current) : "-"}<br>${a ? delta(a.cost.current, a.cost.previous, null) : ""}</td>
        <td class="r ads-col">${a ? fmtDec(a.conversions.current) : "-"}</td>
        <td class="r ads-col">${a && a.conversions.current ? `${fmtYen(cpa)}<br>${delta(cpa, cpaPrev, false)}` : "-"}</td>
        <td class="r meta-col">${m ? fmtYen(m.spend.current) : "-"}<br>${m ? delta(m.spend.current, m.spend.previous, null) : ""}</td>
        <td class="r meta-col">${m ? fmtDec(m.conversions.current) : "-"}</td>
        <td class="r meta-col">${m && m.conversions.current ? `${fmtYen(mCpa)}<br>${delta(mCpa, mCpaPrev, false)}` : "-"}</td>
        <td style="white-space:normal;min-width:260px">${advice ? esc(advice.headline || advice.summary) : '<span class="muted">未生成</span>'}</td>
      </tr>`;
    })
    .join("");
  $("#sum-body").innerHTML = `<table class="summary-table">
    <thead>
      <tr><th></th><th></th><th colspan="4" class="grp ga4-grp">GA4｜サイトのアクセス</th><th colspan="3" class="grp ads-grp">Google広告</th><th colspan="3" class="grp meta-grp">Meta広告</th><th></th></tr>
      <tr><th>サイト</th><th>状況</th><th class="r">ユーザー</th><th class="r">セッション</th><th class="r">キーイベント</th><th class="r">CVR</th><th class="r">広告費</th><th class="r">広告CV</th><th class="r">CPA</th><th class="r">広告費</th><th class="r">広告CV</th><th class="r">CPA</th><th>AIのひとこと</th></tr>
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
  const viaGa4 = a.source === "ga4";
  const cvName = viaGa4 ? "成果（GA4のキーイベント）" : "コンバージョン（CV）";

  return `<section class="src src-ads">
  ${sourceHeader("ads", viaGa4 ? "GA4にリンクしたGoogle広告から取得" : `アカウント ${a.accounts.map(esc).join(", ")}`)}
  ${viaGa4 ? `<p class="muted small" style="margin:0">費用・クリック・表示回数はGoogle広告の値、成果はGoogle広告から来た訪問でGA4が計測したキーイベントです。Google広告の管理画面のコンバージョン数とは数え方が異なることがあります。</p>` : ""}
  <div class="card advice-box" id="advice-ads"><p class="muted">AIの総評を読み込み中…</p></div>

  <h3 class="sub">費用と成果</h3>
  <div class="tiles">
    ${tile("広告費", fmtYen(t.cost.current), delta(t.cost.current, t.cost.previous, null))}
    ${tile(cvName, fmtDec(t.conversions.current), delta(t.conversions.current, t.conversions.previous))}
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

/** Meta広告の費用対効果の目安。平均CPAとの比較とフリークエンシーで判定する */
function judgeMeta(x, avgCpa, objective) {
  const tags = [];
  if (!x.conversions) {
    if (avgCpa && x.spend > avgCpa && !NON_CV_OBJECTIVES.has(objective)) tags.push(["bad", "CVなし"]);
  } else if (avgCpa) {
    const cpa = x.spend / x.conversions;
    if (cpa <= avgCpa * 0.8) tags.push(["good", "効率良"]);
    else if (cpa >= avgCpa * 1.5) tags.push(["bad", "割高"]);
  }
  if (x.reach && x.impressions / x.reach >= 3) tags.push(["warn", "表示過多"]);
  return tags.map(([cls, label]) => `<span class="judge ${cls}">${label}</span>`).join("");
}

function renderMeta(m) {
  const t = m.totals;
  const r = (a, b) => [ratio(t[a].current, t[b].current), ratio(t[a].previous, t[b].previous)];
  const [ctr, ctrPrev] = r("clicks", "impressions");
  const [cpc, cpcPrev] = r("spend", "clicks");
  const [cvr, cvrPrev] = r("conversions", "clicks");
  const [cpa, cpaPrev] = r("spend", "conversions");
  const [freq, freqPrev] = r("impressions", "reach");
  const [roas, roasPrev] = r("conversionsValue", "spend");
  const cpm = ratio(t.spend.current * 1000, t.impressions.current);
  const cpmPrev = ratio(t.spend.previous * 1000, t.impressions.previous);
  const hasValue = t.conversionsValue.current > 0 || t.conversionsValue.previous > 0;
  const avgCpa = t.conversions.current ? cpa : 0;
  const cvLabel = m.conversionActions.join(", ");
  const multi = m.accounts.length > 1;

  return `<section class="src src-meta">
  ${sourceHeader("meta", `アカウント ${m.accounts.map(esc).join(", ")}`)}
  <div class="card advice-box" id="advice-meta"><p class="muted">AIの総評を読み込み中…</p></div>

  <h3 class="sub">費用と成果</h3>
  <div class="tiles">
    ${tile("広告費", fmtYen(t.spend.current), delta(t.spend.current, t.spend.previous, null))}
    ${tile("コンバージョン（CV）", fmtDec(t.conversions.current), delta(t.conversions.current, t.conversions.previous), `CVとして数えている指標: ${cvLabel}`)}
    ${tile("CPA（1件あたりの獲得単価）", t.conversions.current ? fmtYen(cpa) : "-", t.conversions.current ? delta(cpa, cpaPrev, false) : "", "広告費 ÷ CV。低いほど効率が良い")}
    ${tile("CVR（リンククリック→CV）", fmtPct(cvr), delta(cvr, cvrPrev), "CV ÷ リンククリック")}
    ${hasValue ? tile("ROAS（CV値÷広告費）", fmtPct(roas), delta(roas, roasPrev)) : ""}
  </div>
  <h3 class="sub">露出と反応</h3>
  <div class="tiles">
    ${tile("表示回数", fmtInt(t.impressions.current), delta(t.impressions.current, t.impressions.previous))}
    ${tile(multi ? "リーチ（アカウント合算）" : "リーチ", fmtInt(t.reach.current), delta(t.reach.current, t.reach.previous), "広告を見た人の数。複数アカウントは重複を除けないため目安")}
    ${tile("フリークエンシー", fmtDec(freq), `<span class="delta ${freq >= 3 ? "bad" : "flat"}">1人あたりの表示回数${freq >= 3 ? "（多め）" : ""}</span>`, "表示回数 ÷ リーチ。3回を超えると見飽きで効率が落ちやすい")}
    ${tile("リンククリック", fmtInt(t.clicks.current), delta(t.clicks.current, t.clicks.previous))}
    ${tile("CTR（リンククリック率）", fmtPct(ctr), delta(ctr, ctrPrev))}
    ${tile("CPC（クリック単価）", fmtYen(cpc), delta(cpc, cpcPrev, false))}
    ${tile("CPM（1,000回表示単価）", fmtYen(cpm), delta(cpm, cpmPrev, false))}
  </div>

  <div class="grid grid-2">
    <div class="card"><h3>日別の広告費</h3><div class="chart-box sm"><canvas id="meta-spend"></canvas></div></div>
    <div class="card"><h3>日別のコンバージョン</h3><div class="chart-box sm"><canvas id="meta-conv"></canvas></div></div>
  </div>

  <div class="card"><h3>キャンペーン別の費用対効果（費用順）</h3>
    <p class="muted small">判定は平均CPA（${avgCpa ? fmtYen(avgCpa) : "-"}）との比較です。効率良: 平均の0.8倍以下 / 割高: 1.5倍以上 / CVなし: 平均CPA以上使ってCV0（認知・トラフィック目的は除く）/ 表示過多: フリークエンシー3回以上</p>
    <div class="table-wrap"><table>
    <thead><tr><th>キャンペーン</th><th>目的</th><th class="r">費用</th><th class="r">リーチ</th><th class="r">頻度</th><th class="r">クリック</th><th class="r">CTR</th><th class="r">CV</th><th class="r">CVR</th><th class="r">CPA</th>${hasValue ? '<th class="r">ROAS</th>' : ""}<th>判定</th></tr></thead>
    <tbody>${m.campaigns
      .map(
        (c) => `<tr><td class="path" title="${esc(c.name)}">${esc(c.name)}</td>
        <td class="muted small">${esc(OBJECTIVE_LABEL[c.objective] ?? c.objective)}</td><td class="r">${fmtYen(c.spend)}</td>
        <td class="r">${fmtInt(c.reach)}</td><td class="r">${c.reach ? fmtDec(c.impressions / c.reach) : "-"}</td>
        <td class="r">${fmtInt(c.clicks)}</td><td class="r">${fmtPct(ratio(c.clicks, c.impressions))}</td><td class="r">${fmtDec(c.conversions)}</td>
        <td class="r">${fmtPct(ratio(c.conversions, c.clicks))}</td><td class="r">${c.conversions ? fmtYen(c.spend / c.conversions) : "-"}</td>
        ${hasValue ? `<td class="r">${c.spend ? fmtPct(c.conversionsValue / c.spend) : "-"}</td>` : ""}
        <td>${judgeMeta(c, avgCpa, c.objective)}</td></tr>`,
      )
      .join("") || `<tr><td colspan="11" class="muted">データなし</td></tr>`}</tbody>
  </table></div></div>

  <div class="grid grid-2">
    <div class="card"><h3>配信面別の費用対効果</h3><div class="table-wrap"><table>
      <thead><tr><th>配信面</th><th class="r">費用</th><th class="r">クリック</th><th class="r">CTR</th><th class="r">CV</th><th class="r">CPA</th></tr></thead>
      <tbody>${m.platforms
        .map(
          (p) => `<tr><td>${esc(PLATFORM_LABEL[p.platform] ?? p.platform)}</td><td class="r">${fmtYen(p.spend)}</td><td class="r">${fmtInt(p.clicks)}</td>
          <td class="r">${fmtPct(ratio(p.clicks, p.impressions))}</td><td class="r">${fmtDec(p.conversions)}</td><td class="r">${p.conversions ? fmtYen(p.spend / p.conversions) : "-"}</td></tr>`,
        )
        .join("") || `<tr><td colspan="6" class="muted">データなし</td></tr>`}</tbody>
    </table></div></div>
    <div class="card"><h3>広告（クリエイティブ）別（費用順）</h3><div class="table-wrap"><table>
      <thead><tr><th>広告</th><th class="r">費用</th><th class="r">CTR</th><th class="r">CV</th><th class="r">CPA</th><th></th></tr></thead>
      <tbody>${m.ads
        .map(
          (x) => `<tr><td class="path" title="${esc(x.name)}">${esc(x.name)}<small>${esc(x.campaign)}</small></td>
          <td class="r">${fmtYen(x.spend)}</td><td class="r">${fmtPct(ratio(x.clicks, x.impressions))}</td><td class="r">${fmtDec(x.conversions)}</td>
          <td class="r">${x.conversions ? fmtYen(x.spend / x.conversions) : "-"}</td><td>${judgeMeta(x, avgCpa)}</td></tr>`,
        )
        .join("") || `<tr><td colspan="6" class="muted">データなし</td></tr>`}</tbody>
    </table></div></div>
  </div>
  </section>`;
}

const TONE_LABEL = { good: "好調", warning: "注意", critical: "要対応", info: "参考" };
const PRIO_LABEL = { high: "優先度 高", medium: "優先度 中", low: "優先度 低" };

function adviceSection(sec, kindLabel) {
  return `<h3 class="advice-title">AIによる総評（${kindLabel}）${sec.status ? levelBadge(sec.status, "AIの判定：") : ""}</h3>
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
    top.innerHTML = `<div class="chart-head"><h2 style="margin:0">AIのひとこと ${advice?.status ? levelBadge(advice.status, "AIの判定：") : ""}</h2>
      <div><span class="muted small">${meta}</span>
      <button class="btn" id="advice-gen" data-site="${esc(siteId)}">${advice ? "今の期間で作り直す" : "AIの総評を作る"}</button></div></div>
      ${
        advice
          ? `${advice.headline ? `<p class="headline">${esc(advice.headline)}</p>` : ""}<p class="summary">${esc(advice.summary)}</p>${
              advice.glossary?.length ? glossaryBlock(advice.glossary) : ""
            }`
          : `<p class="muted">まだAIの総評がありません。毎朝7時に自動で作られます。今すぐ作る場合はボタンを押してください（30秒〜1分ほどかかります）。</p>`
      }`;
  }
  const ga4 = $("#advice-ga4");
  if (ga4) ga4.innerHTML = advice?.ga4 ? adviceSection(advice.ga4, "GA4") : `<p class="muted small">GA4のAI総評はまだありません。</p>`;
  const ads = $("#advice-ads");
  if (ads) ads.innerHTML = advice?.ads ? adviceSection(advice.ads, "Google広告") : `<p class="muted small">Google広告のAI総評はまだありません。</p>`;
  const metaBox = $("#advice-meta");
  if (metaBox) metaBox.innerHTML = advice?.meta ? adviceSection(advice.meta, "Meta広告") : `<p class="muted small">Meta広告のAI総評はまだありません。「今の期間で作り直す」で作成できます。</p>`;
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
    const errors = [
      report.ga4Error && `GA4: ${report.ga4Error}`,
      report.adsError && `Google広告: ${report.adsError}`,
      report.metaError && `Meta広告: ${report.metaError}`,
    ].filter(Boolean);
    const noAds = [!site.hasAds && "Google広告", !site.hasMeta && "Meta広告"].filter(Boolean);
    view.innerHTML = `
      <div class="statusline"><h2 style="margin:0">${esc(site.name)}</h2>${site.url ? `<a class="small" href="${esc(site.url)}" target="_blank" rel="noopener">${esc(site.url)}</a>` : ""}</div>
      ${statusLine(report, stale)}
      ${errors.map((e) => `<div class="alert">${esc(e)}</div>`).join("")}
      ${healthHero(report)}
      ${site.hasGa4 ? `<div class="tiles today" id="today">${todayTiles(report.ga4)}</div>` : ""}
      <div class="card advice" id="advice"><p class="muted">AIの総評を読み込み中…</p></div>
      ${report.ga4 ? renderGa4(report.ga4) : ""}
      ${report.ads ? renderAds(report.ads) : ""}
      ${report.meta ? renderMeta(report.meta) : ""}
      ${noAds.length ? `<p class="muted small">このサイトには${noAds.join("・")}のアカウントが紐付いていません。</p>` : ""}
      <div class="card">${glossaryBlock()}</div>`;
    if (report.ga4) drawTrend(report.ga4);
    if (report.ads) {
      const labels = report.ads.daily.map((d) => md(d.date));
      barChart($("#ads-cost"), labels, report.ads.daily.map((d) => d.cost), "広告費", fmtYen);
      barChart($("#ads-conv"), labels, report.ads.daily.map((d) => d.conversions), "コンバージョン", fmtDec);
    }
    if (report.meta) {
      const labels = report.meta.daily.map((d) => md(d.date));
      barChart($("#meta-spend"), labels, report.meta.daily.map((d) => d.spend), "広告費", fmtYen);
      barChart($("#meta-conv"), labels, report.meta.daily.map((d) => d.conversions), "コンバージョン", fmtDec);
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
