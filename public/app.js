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
// 社内では「期」が年度を指すため、「前期」「今期」とは書かない
const COMPARE_LABEL = { prev: "直前比", yoy: "前年比" };
const COMPARE_NAME = { prev: "直前の同じ日数", yoy: "前年の同じ日付" };
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

/** 状況を顔の表情で表す（線は currentColor）。好調ほど笑顔、要対策ほど困り顔 */
const FACE_PARTS = {
  good: '<path d="M7.5 10.2q1.5-2 3 0M13.5 10.2q1.5-2 3 0"/><path d="M7 14q5 5.5 10 0z" fill="currentColor"/>',
  steady: '<circle cx="9" cy="10" r="1.2" fill="currentColor" stroke="none"/><circle cx="15" cy="10" r="1.2" fill="currentColor" stroke="none"/><path d="M8 14.5q4 3.5 8 0"/>',
  flat: '<circle cx="9" cy="10" r="1.2" fill="currentColor" stroke="none"/><circle cx="15" cy="10" r="1.2" fill="currentColor" stroke="none"/><path d="M8.5 15.5h7"/>',
  caution: '<path d="M7.5 8.2l3 .8M16.5 8.2l-3 .8"/><circle cx="9" cy="11" r="1.1" fill="currentColor" stroke="none"/><circle cx="15" cy="11" r="1.1" fill="currentColor" stroke="none"/><path d="M8.5 16q1.75-1.5 3.5 0t3.5 0"/><path class="sweat" d="M18.6 5.2q1.4 2 0 2.8q-1.4-.8 0-2.8z" fill="currentColor" stroke="none"/>',
  bad: '<path d="M7.5 9l3-1.2M16.5 9l-3-1.2"/><circle cx="9" cy="11.2" r="1.1" fill="currentColor" stroke="none"/><circle cx="15" cy="11.2" r="1.1" fill="currentColor" stroke="none"/><path d="M8 17q4-3.8 8 0"/>',
};
function face(level, cls = "") {
  const parts = FACE_PARTS[level];
  if (!parts) return "";
  return `<svg class="face face-${level} ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><g class="face-eyes">${parts}</g></svg>`;
}

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
  return l ? `<span class="lv lv-${level}"><i>${face(level)}</i>${prefix}${l.label}</span>` : "";
}

/** 5段階のメーター。今の位置を強調する */
function meter(level) {
  return `<div class="meter" role="img" aria-label="判定 ${LEVELS[level].label}">${LEVEL_ORDER.map(
    (k) => `<span class="seg-${k}${k === level ? " on" : ""}">${face(k)}${LEVELS[k].label}</span>`,
  ).join("")}</div>`;
}

function healthHero(report) {
  const h = health(report);
  if (!h) return "";
  const l = LEVELS[h.level];
  const list = (items, cls) => items.slice(0, 3).map((x) => `<li class="${cls}">${esc(x.text)}</li>`).join("");
  return `<section class="hero lv-${h.level}">
    <div class="hero-main">
      <div class="hero-icon" aria-hidden="true">${face(h.level, "face-live")}</div>
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

const REDUCED = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
const ANIM = REDUCED ? false : { duration: 900, easing: "easeOutQuart" };

/**
 * 注目点のマーカー。Chart.js が描いた点・棒の位置に、点滅するHTMLの印を重ねる。
 * options.plugins.highlight.points = [{ index, tone, title, reason }]
 */
const highlightPlugin = {
  id: "highlight",
  afterDraw(chart, _args, opts) {
    const points = opts?.points ?? [];
    const box = chart.canvas.parentElement;
    let layer = box.querySelector(".hl-layer");
    if (!points.length) return layer?.remove();
    if (!layer) {
      layer = document.createElement("div");
      layer.className = "hl-layer";
      layer.innerHTML = points
        .map((p, i) => `<button type="button" class="hl-dot tone-${p.tone}" data-hl="${i}" aria-label="${esc(p.title)}"><span>${i + 1}</span></button>`)
        .join("");
      box.appendChild(layer);
    }
    const meta = chart.getDatasetMeta(0);
    points.forEach((p, i) => {
      const el = meta.data[p.index];
      const dot = layer.querySelector(`[data-hl="${i}"]`);
      if (!el || !dot) return;
      dot.style.left = `${el.x}px`;
      dot.style.top = `${Math.min(el.y, chart.chartArea.bottom - 6)}px`;
    });
  },
};

/** 注目点の説明リスト。マーカーや項目にカーソルを当てると、グラフ上の値も表示する */
function attachHighlightList(chart, points) {
  const box = chart.canvas.parentElement;
  box.parentElement.querySelector(`.hl-list[data-for="${chart.canvas.id}"]`)?.remove();
  if (!points.length) return;
  box.insertAdjacentHTML(
    "afterend",
    `<ol class="hl-list" data-for="${chart.canvas.id}">${points
      .map((p, i) => `<li class="tone-${p.tone}" data-hl="${i}"><span class="hl-num">${i + 1}</span><span><b>${esc(p.title)}</b><span class="hl-reason">${esc(p.reason)}</span></span></li>`)
      .join("")}</ol>`,
  );
  const show = (i) => {
    const p = points[i];
    if (!p) return;
    chart.setActiveElements([{ datasetIndex: 0, index: p.index }]);
    chart.tooltip.setActiveElements([{ datasetIndex: 0, index: p.index }], { x: 0, y: 0 });
    chart.update("none");
    box.parentElement.querySelectorAll(`[data-hl="${i}"]`).forEach((e) => e.classList.add("on"));
  };
  const hide = () => {
    chart.setActiveElements([]);
    chart.tooltip.setActiveElements([], { x: 0, y: 0 });
    chart.update("none");
    box.parentElement.querySelectorAll("[data-hl].on").forEach((e) => e.classList.remove("on"));
  };
  box.parentElement.addEventListener("mouseover", (e) => {
    const i = e.target.closest("[data-hl]")?.dataset.hl;
    if (i != null) show(Number(i));
  });
  box.parentElement.addEventListener("mouseout", (e) => {
    if (e.target.closest("[data-hl]")) hide();
  });
}

function lineChart(canvas, labels, datasets, format, points = []) {
  const chart = new Chart(canvas, {
    type: "line",
    data: { labels, datasets },
    plugins: [highlightPlugin],
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: ANIM,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${format(c.parsed.y)}` } },
        highlight: { points },
      },
      elements: { point: { radius: 0, hoverRadius: 4 }, line: { borderWidth: 2, tension: 0.25 } },
      scales: chartScales(format),
    },
  });
  state.charts.push(chart);
  attachHighlightList(chart, points);
  return chart;
}

function barChart(canvas, labels, data, label, format, points = []) {
  const base = cssVar("--series-1");
  const marked = new Map(points.map((p) => [p.index, p.tone]));
  const toneColor = { up: cssVar("--good"), down: cssVar("--critical"), info: cssVar("--ads") };
  const chart = new Chart(canvas, {
    type: "bar",
    data: {
      labels,
      datasets: [{ label, data, backgroundColor: data.map((_, i) => (marked.has(i) ? toneColor[marked.get(i)] || base : base)), borderRadius: 4, maxBarThickness: 18 }],
    },
    plugins: [highlightPlugin],
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: ANIM && { ...ANIM, delay: (c) => (c.type === "data" ? c.dataIndex * 18 : 0) },
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => `${label}: ${format(c.parsed.y)}` } }, highlight: { points } },
      scales: chartScales(format),
    },
  });
  state.charts.push(chart);
  attachHighlightList(chart, points);
  return chart;
}

/** 画面に入ったときに一度だけ実行する（グラフのアニメーションを見える位置で始めるため） */
function whenVisible(el, fn) {
  if (!el) return;
  if (REDUCED || !("IntersectionObserver" in window)) return fn();
  const io = new IntersectionObserver(
    (entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        io.disconnect();
        fn();
      }
    },
    { threshold: 0.25 },
  );
  io.observe(el);
}

// ---------- 注目点の判定 ----------
const WEEKDAY = ["日", "月", "火", "水", "木", "金", "土"];
const dow = (date) => new Date(`${date}T12:00:00Z`).getUTCDay();
const dayLabel = (date) => `${md(date)}（${WEEKDAY[dow(date)]}）`;
const isWeekend = (date) => [0, 6].includes(dow(date));
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** アクセスの日別推移から、最多日・最少日・急増/急減日を最大3つ選ぶ */
function trendHighlights(dates, values, prevValues, label, format) {
  const n = values.length;
  if (n < 5 || Math.max(...values) <= 0) return [];
  const avg = mean(values);
  const out = [];
  const used = new Set();
  const add = (p) => {
    if (used.has(p.index) || out.length >= 3) return;
    used.add(p.index);
    out.push(p);
  };
  const iMax = values.indexOf(Math.max(...values));
  const iMin = values.indexOf(Math.min(...values));

  // 前日比の最大変化（小さい値どうしのブレは除く）
  let jump = null;
  for (let i = 1; i < n; i++) {
    const a = values[i - 1];
    const b = values[i];
    if (Math.max(a, b) < avg * 0.3 || a <= 0) continue;
    const r = (b - a) / a;
    if (!jump || Math.abs(r) > Math.abs(jump.r)) jump = { i, r, a, b };
  }

  const peakRatio = avg ? values[iMax] / avg : 0;
  if (peakRatio >= 1.25) {
    add({
      index: iMax,
      tone: "up",
      title: `${dayLabel(dates[iMax])} ${label}が期間中で最多（${format(values[iMax])}）`,
      reason: `1日平均（${format(avg)}）の${peakRatio.toFixed(1)}倍です。広告の配信強化、メルマガ・SNS投稿、展示会やニュース掲載など、この日に集客のきっかけがあった可能性があります。`,
    });
  }
  if (jump && Math.abs(jump.r) >= 0.4 && jump.i !== iMax && jump.i !== iMin) {
    const up = jump.r > 0;
    add({
      index: jump.i,
      tone: up ? "up" : "down",
      title: `${dayLabel(dates[jump.i])} 前日から${up ? "+" : ""}${Math.round(jump.r * 100)}%`,
      reason: `${format(jump.a)} → ${format(jump.b)} と大きく${up ? "増えて" : "減って"}います。${
        up ? "集客施策の効果が出た日かもしれません。" : isWeekend(dates[jump.i]) ? "週末に入ったことによる自然な減少と考えられます。" : "平日の急な減少です。広告の停止やページの不具合がなかったか確認をおすすめします。"
      }`,
    });
  }
  if (avg && values[iMin] <= avg * 0.6) {
    add({
      index: iMin,
      tone: isWeekend(dates[iMin]) ? "info" : "down",
      title: `${dayLabel(dates[iMin])} ${label}が期間中で最少（${format(values[iMin])}）`,
      reason: isWeekend(dates[iMin])
        ? "土日は企業の担当者の閲覧が減るため、下がりやすい日です。"
        : `平日なのに1日平均の${Math.round((values[iMin] / avg) * 100)}%まで落ちています。祝日・休業日か、計測やサイトの不具合がないか確認してください。`,
    });
  }
  // 比較期間との差が最も大きい日
  if (out.length < 3 && prevValues?.length === n) {
    let best = null;
    for (let i = 0; i < n; i++) {
      const pv = prevValues[i];
      if (pv <= 0 || used.has(i)) continue;
      const r = (values[i] - pv) / pv;
      if (!best || Math.abs(r) > Math.abs(best.r)) best = { i, r, pv };
    }
    if (best && Math.abs(best.r) >= 0.5) {
      const up = best.r > 0;
      add({
        index: best.i,
        tone: up ? "up" : "down",
        title: `${dayLabel(dates[best.i])} ${COMPARE_NAME[state.compare]}の同じ日より${up ? "+" : ""}${Math.round(best.r * 100)}%`,
        reason: `比較期間の同じ位置の日（${format(best.pv)}）と比べて大きく${up ? "上回って" : "下回って"}います。曜日の並びや祝日の違いも影響します。`,
      });
    }
  }
  return out.sort((a, b) => a.index - b.index);
}

/** 広告の日別費用から、費用が突出した日・費用をかけたのに成果0の日・成果0が続く期間を選ぶ */
function costHighlights(dates, cost, conv) {
  const n = cost.length;
  if (n < 3 || Math.max(...cost) <= 0) return [];
  const avg = mean(cost);
  const out = [];
  const iMax = cost.indexOf(Math.max(...cost));
  if (cost[iMax] >= avg * 1.4) {
    out.push({
      index: iMax,
      tone: conv[iMax] > 0 ? "info" : "down",
      title: `${dayLabel(dates[iMax])} 広告費が最多（${fmtYen(cost[iMax])}）`,
      reason: `1日平均（${fmtYen(avg)}）の${(cost[iMax] / avg).toFixed(1)}倍です。${
        conv[iMax] > 0 ? `成果は${fmtDec(conv[iMax])}件ありました。` : "この日の成果は0件でした。入札の自動調整や予算の上振れで、成果につながらない配信が増えていないか確認してください。"
      }`,
    });
  }
  // 平均以上の費用で成果0の日（最多日と別の、いちばん費用が大きい日）
  let waste = -1;
  for (let i = 0; i < n; i++) if (i !== iMax && conv[i] === 0 && cost[i] >= avg * 1.1 && (waste < 0 || cost[i] > cost[waste])) waste = i;
  if (waste >= 0) {
    out.push({
      index: waste,
      tone: "down",
      title: `${dayLabel(dates[waste])} ${fmtYen(cost[waste])}使って成果0件`,
      reason: "平均以上の費用をかけたのに成果がありません。この日の検索語句やクリエイティブを見直す手がかりになります。",
    });
  }
  return out.sort((a, b) => a.index - b.index);
}

function convHighlights(dates, conv, cost) {
  const n = conv.length;
  if (n < 3) return [];
  const out = [];
  const total = conv.reduce((a, b) => a + b, 0);
  if (total > 0) {
    const iMax = conv.indexOf(Math.max(...conv));
    if (conv[iMax] >= Math.max(2, mean(conv) * 1.5)) {
      out.push({
        index: iMax,
        tone: "up",
        title: `${dayLabel(dates[iMax])} 成果が最多（${fmtDec(conv[iMax])}件）`,
        reason: `この日の1件あたりの費用は${conv[iMax] ? fmtYen(cost[iMax] / conv[iMax]) : "-"}でした。この日に配信していた広告や検索語句は、伸ばす候補になります。`,
      });
    }
  }
  // 直近で成果0が続いている
  let streak = 0;
  for (let i = n - 1; i >= 0 && conv[i] === 0 && cost[i] > 0; i--) streak++;
  if (streak >= 3) {
    out.push({
      index: n - 1,
      tone: "down",
      title: `直近${streak}日間 成果0件が続いています`,
      reason: `この間に${fmtYen(cost.slice(n - streak).reduce((a, b) => a + b, 0))}を使っています。フォームの不具合、計測タグの外れ、配信先の変化がないか早めに確認してください。`,
    });
  }
  return out.sort((a, b) => a.index - b.index);
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

/** サイトのサムネイル（トップページの画面写真）。取れなければ頭文字で代用する */
function thumb(site, size) {
  const initial = esc((site.name || "?").slice(0, 1));
  if (!site.url) return `<span class="thumb thumb-${size} thumb-empty" aria-hidden="true">${initial}</span>`;
  const w = size === "lg" ? 480 : 320;
  const src = `https://s0.wp.com/mshots/v1/${encodeURIComponent(site.url)}?w=${w}&h=${Math.round(w * 0.625)}`;
  return `<span class="thumb thumb-${size}" aria-hidden="true" data-initial="${initial}"><img src="${src}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.parentElement.classList.add('thumb-empty');this.parentElement.textContent=this.parentElement.dataset.initial"></span>`;
}

/** サイト画面の項目へ移動するボタン列 */
function jumpNav(report) {
  const items = [
    ["sec-status", "いまの状況", ""],
    ["advice", "AIのひとこと", ""],
    ["sec-diagnosis", "診断・次の行動", ""],
    report.ga4 && ["sec-ga4", "アクセス解析", "ga4"],
    report.ads && ["sec-ads", "Google広告", "ads"],
    report.meta && ["sec-meta", "SNS広告", "meta"],
    ["sec-glossary", "用語解説", ""],
  ].filter(Boolean);
  return `<nav class="jump-nav" aria-label="このページの項目">${items
    .map(([id, label, kind]) => `<button type="button" data-jump="${id}" class="${kind ? `jn-${kind}` : ""}">${kind ? '<i aria-hidden="true"></i>' : ""}${label}</button>`)
    .join("")}</nav>`;
}

/** スクロール位置に合わせて、いま見ている項目のボタンを強調する */
function setupJumpNav(view) {
  state.navObserver?.disconnect();
  const nav = view.querySelector(".jump-nav");
  if (!nav || !("IntersectionObserver" in window)) return;
  const top = ($(".topbar")?.offsetHeight ?? 0);
  nav.style.top = `${top}px`;
  // 各データの見出し（色帯）は項目ジャンプのすぐ下に貼り付ける
  view.style.setProperty("--sticky-top", `${top + nav.offsetHeight + 4}px`);
  const visible = new Map();
  state.navObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((e) => visible.set(e.target.id, e.isIntersecting));
      const ids = [...nav.querySelectorAll("[data-jump]")].map((b) => b.dataset.jump);
      const current = ids.find((id) => visible.get(id));
      nav.querySelectorAll("[data-jump]").forEach((b) => b.classList.toggle("on", b.dataset.jump === current));
      const on = nav.querySelector(".on");
      if (on && nav.scrollWidth > nav.clientWidth) {
        const left = nav.scrollLeft + on.getBoundingClientRect().left - nav.getBoundingClientRect().left - 16;
        nav.scrollTo({ left, behavior: REDUCED ? "auto" : "smooth" });
      }
    },
    { rootMargin: `-${top + 60}px 0px -55% 0px` },
  );
  nav.querySelectorAll("[data-jump]").forEach((b) => {
    const el = document.getElementById(b.dataset.jump);
    if (el) state.navObserver.observe(el);
  });
}

/** 数字を0から数え上げる（¥・%・カンマ付きの表示に対応） */
function countUp(el) {
  const m = el.textContent.trim().match(/^(¥?)([\d,]+(?:\.\d+)?)(%?)$/);
  if (!m) return;
  const [, pre, num, post] = m;
  const target = Number(num.replace(/,/g, ""));
  const decimals = (num.split(".")[1] || "").length;
  const fmt = (v) => `${pre}${v.toLocaleString("ja-JP", { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}${post}`;
  const start = performance.now();
  const dur = 900;
  const step = (now) => {
    const t = Math.min(1, (now - start) / dur);
    el.textContent = fmt(target * (1 - Math.pow(1 - t, 3)));
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/** 画面に入った要素を下からふわっと表示し、数字は数え上げる */
function animateIn(root) {
  root.classList.remove("view-in");
  void root.offsetWidth;
  root.classList.add("view-in");
  if (REDUCED || !("IntersectionObserver" in window)) return;
  state.revealObserver?.disconnect();
  const io = new IntersectionObserver(
    (entries) => {
      entries.forEach((e) => {
        if (!e.isIntersecting) return;
        io.unobserve(e.target);
        e.target.classList.add("in");
        e.target.querySelectorAll(".tile .value").forEach((v) => {
          if (!v.querySelector("*")) countUp(v);
        });
      });
    },
    { threshold: 0.12 },
  );
  state.revealObserver = io;
  const targets = root.querySelectorAll(".card, .tiles, .src-head, .hero, .status-card, .jump-nav, .site-head");
  targets.forEach((el) => {
    el.classList.add("reveal");
    // 並んだ要素は少しずつ遅らせる
    const sibs = [...el.parentElement.children].filter((c) => c.classList.contains("reveal"));
    el.style.setProperty("--d", `${Math.min(sibs.indexOf(el), 5) * 60}ms`);
    io.observe(el);
  });
}

async function renderSummary() {
  const view = $("#view");
  view.innerHTML = `<div id="sum-cards" class="status-cards"></div><div class="card"><h2>全サイトのサマリー</h2><div id="sum-body" class="table-wrap"><p class="muted">読み込み中…</p></div></div>`;
  const rows = await Promise.all(
    state.sites.map(async (s) => {
      try {
        const [{ report }, { advice, job }, diagnosis] = await Promise.all([
          loadReport(s.id),
          api(adviceUrl(s.id)),
          api(`/api/diagnosis?site=${encodeURIComponent(s.id)}`).then((r) => r.diagnosis, () => null),
        ]);
        return { s, report, advice, job, diagnosis };
      } catch (e) {
        return { s, error: e.message };
      }
    }),
  );
  if (state.tab !== "summary") return;
  $("#sum-cards").innerHTML = rows
    .map(({ s, report, advice, diagnosis, error }) => {
      const h = !error && health(report);
      const todo = diagnosis?.items.filter((i) => i.severity !== "low").length ?? 0;
      if (!h) return "";
      const l = LEVELS[h.level];
      const point = (adviceMatchesView(advice) && advice.headline) || (h.bads[0] ? `気になる点：${h.bads[0].text}` : h.goods[0] ? `良くなった点：${h.goods[0].text}` : l.text);
      return `<button class="status-card lv-${h.level}" data-goto="${esc(s.id)}">
        ${s.url ? thumb(s, "sm") : ""}
        <span class="sc-icon" aria-hidden="true">${face(h.level, "face-live")}</span>
        <span class="sc-body"><span class="sc-name">${esc(s.name)}</span><span class="sc-label">${l.label}</span><span class="sc-text">${esc(point)}</span>${
          diagnosis ? `<span class="sc-todo${todo ? "" : " none"}">${todo ? `要対応 ${todo}件` : "要対応なし"}・${fmtTime(diagnosis.checkedAt)} 診断</span>` : ""
        }</span>
      </button>`;
    })
    .join("");
  const body = rows
    .map(({ s, report, advice, job, error }) => {
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
        <td style="white-space:normal;min-width:260px">${
          adviceMatchesView(advice)
            ? esc(advice.headline || advice.summary)
            : `<span class="muted">${job ? "作成中…" : "この期間は未作成"}</span>`
        }</td>
      </tr>`;
    })
    .join("");
  $("#sum-body").innerHTML = `<table class="summary-table">
    <thead>
      <tr><th></th><th></th><th colspan="4" class="grp ga4-grp">GA4｜サイトのアクセス</th><th colspan="3" class="grp ads-grp">Google広告</th><th colspan="3" class="grp meta-grp">Meta広告</th><th></th></tr>
      <tr><th>サイト</th><th>状況</th><th class="r">ユーザー</th><th class="r">セッション</th><th class="r">キーイベント</th><th class="r">CVR</th><th class="r">広告費</th><th class="r">広告CV</th><th class="r">CPA</th><th class="r">広告費</th><th class="r">広告CV</th><th class="r">CPA</th><th>AIのひとこと</th></tr>
    </thead>
    <tbody>${body}</tbody></table>`;
  animateIn(view);
}

function renderGa4(g) {
  const t = g.totals;
  const cvr = ratio(t.keyEvents.current, t.sessions.current);
  const cvrPrev = ratio(t.keyEvents.previous, t.sessions.previous);
  return `<section class="src src-ga4" id="sec-ga4">
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
      <div class="legend"><span><i style="background:var(--series-1)"></i>対象期間</span><span><i style="background:var(--series-prev)"></i>${COMPARE_NAME[state.compare]}</span></div>
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

  return `<section class="src src-ads" id="sec-ads">
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

  <div class="card"><h3>配信した広告（キャンペーン別・費用順）</h3>${
    viaGa4
      ? `<p class="muted">広告の画像や見出しは、GA4経由のデータでは取得できません。Google広告APIを接続すると、ここにキャンペーン別の広告を表示します。</p>`
      : `<p class="muted small">画像のない検索広告は、見出しと説明文を検索結果の形で表示しています。P-MAXは広告グループの代わりにアセットグループ単位で、登録されている画像の1枚目を表示しています。</p>${googleAdGallery(a.ads ?? [], avgCpa)}`
  }</div>

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

const AD_TYPE_LABEL = {
  RESPONSIVE_SEARCH_AD: "検索広告",
  EXPANDED_TEXT_AD: "検索広告",
  RESPONSIVE_DISPLAY_AD: "ディスプレイ広告",
  IMAGE_AD: "イメージ広告",
  ASSET_GROUP: "P-MAX",
  DEMAND_GEN_MULTI_ASSET_AD: "デマンドジェネレーション",
  DEMAND_GEN_CAROUSEL_AD: "デマンドジェネレーション",
  DEMAND_GEN_VIDEO_RESPONSIVE_AD: "デマンドジェネレーション",
  VIDEO_RESPONSIVE_AD: "動画広告",
};

const hostOf = (url) => {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
};

/** Google広告の広告をキャンペーンごとにカードで並べる。画像が無い検索広告は検索結果の見た目で出す */
function googleAdGallery(ads, avgCpa) {
  if (!ads.length) return `<p class="muted">データなし</p>`;
  return adGroups(ads, (x) => {
    const img = x.imageUrl
      ? `<div class="adg-img"><img src="${esc(x.imageUrl)}" alt="${esc(x.headlines[0] ?? x.adGroup)}" loading="lazy" referrerpolicy="no-referrer" onerror="this.parentElement.classList.add('adg-noimg');this.remove()"><span class="adg-fallback">画像なし</span></div>`
      : `<div class="adg-img adg-text"><div class="serp">
          <span class="serp-url"><b>スポンサー</b>${esc(hostOf(x.finalUrl))}</span>
          <span class="serp-title">${esc(x.headlines.slice(0, 3).join(" | ") || "（見出しなし）")}</span>
          <span class="serp-desc">${esc(x.descriptions[0] ?? "")}</span>
        </div></div>`;
    const tags = [];
    if (avgCpa && x.conversions && x.cost / x.conversions <= avgCpa * 0.8) tags.push('<span class="judge good">効率良</span>');
    if (avgCpa && x.conversions && x.cost / x.conversions >= avgCpa * 1.5) tags.push('<span class="judge bad">割高</span>');
    if (avgCpa && !x.conversions && x.cost >= avgCpa) tags.push('<span class="judge bad">CVなし</span>');
    return `<figure class="adg-card">${img}
      <figcaption>
        <span class="muted small">${esc(AD_TYPE_LABEL[x.type] ?? x.type)}${x.adGroup ? `｜${esc(x.adGroup)}` : ""}</span>
        <strong title="${esc(x.headlines.join(" / "))}">${esc(x.headlines[0] ?? x.adGroup)}</strong>
        <dl>
          <div><dt>費用</dt><dd>${fmtYen(x.cost)}</dd></div>
          <div><dt>CTR</dt><dd>${fmtPct(ratio(x.clicks, x.impressions))}</dd></div>
          <div><dt>CV</dt><dd>${fmtDec(x.conversions)}</dd></div>
          <div><dt>CPA</dt><dd>${x.conversions ? fmtYen(x.cost / x.conversions) : "-"}</dd></div>
        </dl>
        <div>${tags.join("")}</div>
      </figcaption>
    </figure>`;
  });
}

/** 広告をキャンペーン名でまとめて、キャンペーンごとにカードの列を作る */
function adGroups(ads, card) {
  const groups = new Map();
  for (const ad of ads) {
    const key = ad.campaign || "（キャンペーン名なし）";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(ad);
  }
  return [...groups]
    .map(
      ([campaign, list]) => `<div class="adg">
      <h4 class="adg-campaign"><span>キャンペーン</span>${esc(campaign)}</h4>
      <div class="adg-grid">${list.map(card).join("")}</div></div>`,
    )
    .join("");
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

// 自社のGA4・Metaピクセルを入れられない外部の受付ページ（src/diagnosis.ts と同じ判定）
const OFFSITE_SERVICES = [
  [/(^|\.)peatix\.com$/, "Peatix"],
  [/(^|\.)connpass\.com$/, "connpass"],
  [/(^|\.)eventbrite\.(com|co\.jp)$/, "Eventbrite"],
  [/(^|\.)doorkeeper\.jp$/, "Doorkeeper"],
];
const offsiteLabel = (host) => OFFSITE_SERVICES.find(([re]) => re.test(host))?.[1];

/** 広告費の半分以上が外部の受付ページ行きなら、そのサービス名 */
function metaOffsite(m) {
  const dests = m.destinations ?? [];
  const known = dests.reduce((s, d) => s + d.spend, 0);
  if (!known) return null;
  for (const [, label] of OFFSITE_SERVICES) {
    const share = dests.filter((d) => offsiteLabel(d.host) === label).reduce((s, d) => s + d.spend, 0) / known;
    if (share >= 0.5) return label;
  }
  return null;
}

/** 広告のリンク先ドメイン別の費用 */
function metaDestBlock(m) {
  const dests = m.destinations ?? [];
  if (!dests.length) return "";
  const known = dests.reduce((s, d) => s + d.spend, 0);
  const offsite = metaOffsite(m);
  return `<h3 class="sub">広告のリンク先</h3>
  ${
    offsite
      ? `<p class="muted small" style="margin:0">広告の多くが${esc(offsite)}のページに誘導しています。${esc(offsite)}のページには自社のGA4やMetaピクセルを入れられないため、Meta側のCVやGA4の訪問には申込が出てきません。申込数は${esc(offsite)}の管理画面で確認してください。</p>`
      : ""
  }
  <div class="card"><div class="table-wrap"><table>
    <thead><tr><th>リンク先</th><th class="r">広告数</th><th class="r">費用</th><th class="r">割合</th><th class="r">リンククリック</th></tr></thead>
    <tbody>${dests
      .map(
        (d) =>
          `<tr><td class="path"><a href="${esc(d.example)}" target="_blank" rel="noopener noreferrer">${esc(d.host)}</a>${
            offsiteLabel(d.host) ? ` <span class="judge warn">${esc(offsiteLabel(d.host))}</span>` : ""
          }</td><td class="r">${fmtInt(d.ads)}</td><td class="r">${fmtYen(d.spend)}</td><td class="r">${fmtPct(ratio(d.spend, known))}</td><td class="r">${fmtInt(d.clicks)}</td></tr>`,
      )
      .join("")}</tbody></table></div>
    <p class="muted small">費用の多い広告から最大20件のリンク先をまとめています。</p></div>`;
}

/** Meta広告から来た人のサイトでの成果（GA4）。Meta側でCVが取れていない時の判断材料 */
function metaGa4Block(m) {
  const g = m.ga4;
  if (!g) return "";
  const noPixel = m.totals.conversions.current === 0 && m.totals.conversions.previous === 0 && !metaOffsite(m);
  const rate = ratio(g.keyEvents.current, g.sessions.current);
  const ratePrev = ratio(g.keyEvents.previous, g.sessions.previous);
  return `<h3 class="sub">サイトでの成果（GA4で計測）</h3>
  ${noPixel ? `<p class="muted small" style="margin:0">Meta側の成果が0件のため（Metaピクセル未設置の可能性）、Meta広告から来た人がサイトでどれだけ成果に至ったかをGA4で表示しています。</p>` : ""}
  <div class="tiles">
    ${tile("Meta広告から来た訪問", fmtInt(g.sessions.current), delta(g.sessions.current, g.sessions.previous), "GA4の参照元が ig・fb などで、メディアが paid の訪問")}
    ${tile("そのうちの成果（キーイベント）", fmtInt(g.keyEvents.current), delta(g.keyEvents.current, g.keyEvents.previous))}
    ${tile("訪問→成果の割合", fmtPct(rate), delta(rate, ratePrev))}
    ${tile("成果1件あたりの広告費", g.keyEvents.current ? fmtYen(m.totals.spend.current / g.keyEvents.current) : "-", "", "Meta広告費 ÷ GA4のキーイベント（目安）")}
  </div>
  ${
    g.campaigns.length
      ? `<div class="card"><h3>GA4のキャンペーン名別（Meta広告から来た訪問）</h3><div class="table-wrap"><table>
      <thead><tr><th>キャンペーン（UTM）</th><th class="r">訪問</th><th class="r">キーイベント</th><th class="r">割合</th></tr></thead>
      <tbody>${g.campaigns
        .map((c) => `<tr><td class="path">${esc(c.name)}</td><td class="r">${fmtInt(c.sessions)}</td><td class="r">${fmtInt(c.keyEvents)}</td><td class="r">${fmtPct(ratio(c.keyEvents, c.sessions))}</td></tr>`)
        .join("")}</tbody></table></div></div>`
      : ""
  }`;
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

  return `<section class="src src-meta" id="sec-meta">
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
  ${metaDestBlock(m)}
  ${metaGa4Block(m)}
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

  <div class="card"><h3>配信面別の費用対効果</h3><div class="table-wrap"><table>
    <thead><tr><th>配信面</th><th class="r">費用</th><th class="r">クリック</th><th class="r">CTR</th><th class="r">CV</th><th class="r">CPA</th></tr></thead>
    <tbody>${m.platforms
      .map(
        (p) => `<tr><td>${esc(PLATFORM_LABEL[p.platform] ?? p.platform)}</td><td class="r">${fmtYen(p.spend)}</td><td class="r">${fmtInt(p.clicks)}</td>
        <td class="r">${fmtPct(ratio(p.clicks, p.impressions))}</td><td class="r">${fmtDec(p.conversions)}</td><td class="r">${p.conversions ? fmtYen(p.spend / p.conversions) : "-"}</td></tr>`,
      )
      .join("") || `<tr><td colspan="6" class="muted">データなし</td></tr>`}</tbody>
  </table></div></div>

  <div class="card"><h3>配信した広告（キャンペーン別・費用順）</h3>
    <p class="muted small">費用の多い広告から最大20件。画像は動画やカルーセル広告の場合サムネイルです。</p>
    ${m.creativeError ? `<p class="muted small">広告画像をMetaから取得できませんでした（${esc(m.creativeError)}）</p>` : ""}
    ${metaAdGallery(m.ads, avgCpa)}
  </div>
  </section>`;
}

function hostName(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** 広告をキャンペーンごとにまとめ、画像付きのカードで並べる */
function metaAdGallery(ads, avgCpa) {
  if (!ads.length) return `<p class="muted">データなし</p>`;
  return adGroups(
    ads,
    (x) => `<figure class="adg-card">
          <div class="adg-img${x.imageUrl ? "" : " adg-noimg"}">${
            x.imageUrl
              ? `<img src="${esc(x.imageUrl)}" alt="${esc(x.name)}" loading="lazy" referrerpolicy="no-referrer" onerror="this.parentElement.classList.add('adg-noimg');this.remove()">`
              : ""
          }<span class="adg-fallback">画像なし</span></div>
          <figcaption>
            <strong title="${esc(x.name)}">${esc(x.name)}</strong>
            ${x.link ? `<span class="muted small" title="${esc(x.link)}">リンク先: ${esc(hostName(x.link))}</span>` : ""}
            <dl>
              <div><dt>費用</dt><dd>${fmtYen(x.spend)}</dd></div>
              <div><dt>CTR</dt><dd>${fmtPct(ratio(x.clicks, x.impressions))}</dd></div>
              <div><dt>CV</dt><dd>${fmtDec(x.conversions)}</dd></div>
              <div><dt>CPA</dt><dd>${x.conversions ? fmtYen(x.spend / x.conversions) : "-"}</dd></div>
            </dl>
            <div>${judgeMeta(x, avgCpa)}</div>
          </figcaption>
        </figure>`,
  );
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

/** AIのひとことが、いま表示している期間・比較と同じ条件で作られたか。違うものは消さずに隠す */
// AIのひとことは期間（集計期間×比較方法）ごとにサーバーへ保存され、全員で共有される。
// 生成した日が変わると無効になり、サーバーは今日・今の期間のものだけを返す。
const adviceMatchesView = (advice) => !!advice && advice.range === state.range && advice.compare === state.compare;
const periodLabel = (range, compare) => `${RANGE_LABEL[range] ?? range}・${COMPARE_LABEL[compare] ?? compare}`;
const adviceUrl = (siteId) => `/api/advice?site=${encodeURIComponent(siteId)}&range=${state.range}&compare=${state.compare}`;

const ADVICE_STAGE = {
  start: "生成を始めています",
  data: "集計データを準備しています",
  thinking: "AIがデータを読み込んで分析しています",
  writing: "AIがひとことを書いています",
  saving: "保存しています",
};

/** 生成中の表示（進み具合のバーと経過時間） */
function adviceProgress(p) {
  const sec = Math.max(0, Math.round((Date.now() - p.startedAt) / 1000));
  const who = p.by ? `${esc(p.by)} さんが作成中です。` : "";
  return `<div class="adv-progress" role="status">
    <div class="adv-progress-head"><strong>${ADVICE_STAGE[p.stage] ?? ADVICE_STAGE.start}…</strong><span class="muted small">${p.pct != null ? `${Math.floor(p.pct)}%・` : ""}${sec}秒経過</span></div>
    <div class="adv-bar${p.pct == null ? " indeterminate" : ""}"><i style="width:${p.pct ?? 30}%"></i></div>
    <p class="muted small">${who}ふだんは30秒〜1分ほどで終わります。${p.by ? "できあがると自動で表示されます。" : "この画面を開いたままお待ちください。"}</p>
  </div>`;
}

function renderAdvice(advice, siteId, progress = null) {
  const shown = adviceMatchesView(advice) ? advice : null;
  const meta = shown
    ? `${fmtTime(shown.generatedAt)} 生成｜${periodLabel(shown.range, shown.compare)}のデータから${shown.demo ? "（サンプル）" : ""}`
    : "";
  const busy = !!progress;
  const top = $("#advice");
  if (top) {
    top.innerHTML = `<div class="chart-head"><h2 style="margin:0">AIのひとこと ${shown?.status ? levelBadge(shown.status, "AIの判定：") : ""}</h2>
      <div><span class="muted small">${meta}</span>
      <button class="btn" id="advice-gen" data-site="${esc(siteId)}"${busy ? " disabled" : ""}>${busy ? "生成中…" : shown ? "作り直す" : "AIの総評を作る"}</button></div></div>
      ${busy ? adviceProgress(progress) : ""}
      ${
        shown
          ? `${shown.headline ? `<p class="headline">${esc(shown.headline)}</p>` : ""}<p class="summary">${esc(shown.summary)}</p>${
              shown.glossary?.length ? glossaryBlock(shown.glossary) : ""
            }`
          : busy
            ? ""
            : `<p class="muted">この期間（${periodLabel(state.range, state.compare)}）のAIのひとことは、今日はまだ作られていません。「28日・直前比」は毎朝7時に自動で作られます。今すぐ作る場合はボタンを押してください（30秒〜1分ほどかかります）。作ったひとことは全員の画面に表示され、日付が変わると消えます。</p>`
      }`;
  }
  const none = (label) =>
    busy ? `<p class="muted small">${label}のAI総評を作成中です。</p>` : `<p class="muted small">この期間の${label}のAI総評はまだありません。</p>`;
  const ga4 = $("#advice-ga4");
  if (ga4) ga4.innerHTML = shown?.ga4 ? adviceSection(shown.ga4, "GA4") : none("GA4");
  const ads = $("#advice-ads");
  if (ads) ads.innerHTML = shown?.ads ? adviceSection(shown.ads, "Google広告") : none("Google広告");
  const metaBox = $("#advice-meta");
  if (metaBox) metaBox.innerHTML = shown?.meta ? adviceSection(shown.meta, "Meta広告") : none("Meta広告");
}

/** 表示中のサイト・期間が変わったら、待ち受けをやめる */
const sameView = (siteId, range, compare) => state.tab === siteId && state.range === range && state.compare === compare;

/** 保存済みのひとことを読み込む。誰かが作成中なら、できあがるまで数秒おきに確かめる */
async function loadAdvice(siteId) {
  const { range, compare } = state;
  clearTimeout(state.advicePoll);
  const { advice, job } = await api(adviceUrl(siteId));
  if (!sameView(siteId, range, compare)) return;
  if (advice || !job) return renderAdvice(advice, siteId);
  renderAdvice(null, siteId, { stage: "start", pct: null, startedAt: Date.parse(job.startedAt), by: job.by });
  state.advicePoll = setTimeout(() => loadAdvice(siteId).catch(() => undefined), 4000);
}

/** ひとことを作る。サーバーから届く進み具合（data: JSON の行）を順に表示する */
async function generateAdvice(siteId) {
  const { range, compare } = state;
  clearTimeout(state.advicePoll);
  // 最初の知らせが届くまでは、割合の無い（流れる）バーにする
  const progress = { stage: "start", pct: null, startedAt: Date.now() };
  const show = () => sameView(siteId, range, compare) && renderAdvice(null, siteId, progress);
  show();
  // 「分析中」の間はサーバーから進み具合が来ないので、経過時間の表示だけ1秒ごとに更新する
  const ticker = setInterval(() => {
    if (progress.stage === "thinking") progress.pct = Math.min(19, (progress.pct ?? 15) + 0.25);
    show();
  }, 1000);
  try {
    const res = await fetch(adviceUrl(siteId), { method: "POST" });
    if (!(res.headers.get("content-type") || "").includes("text/event-stream")) {
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      if (body.job) return loadAdvice(siteId);
      if (sameView(siteId, range, compare)) {
        renderAdvice(body.advice, siteId);
        if (body.cooldown) $("#advice").insertAdjacentHTML("beforeend", `<p class="muted small">直前に作成済みのため、5分以内の再生成は行いません。</p>`);
      }
      return;
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const events = buf.split("\n\n");
      buf = events.pop();
      for (const ev of events) {
        const line = ev.split("\n").find((l) => l.startsWith("data: "));
        if (!line) continue;
        const msg = JSON.parse(line.slice(6));
        if (msg.type === "progress") {
          progress.stage = msg.stage;
          progress.pct = Math.max(progress.pct ?? 0, msg.pct);
          show();
        } else if (msg.type === "done") {
          if (sameView(siteId, range, compare)) renderAdvice(msg.advice, siteId);
          return;
        } else if (msg.type === "error") {
          throw new Error(msg.error);
        }
      }
    }
    throw new Error("生成が途中で止まりました。もう一度お試しください。");
  } catch (err) {
    if (!sameView(siteId, range, compare)) return;
    renderAdvice(null, siteId);
    $("#advice").insertAdjacentHTML("beforeend", `<div class="alert">${esc(err.message)}</div>`);
  } finally {
    clearInterval(ticker);
  }
}

// ---------- 診断 ----------

const SEVERITY = {
  high: { label: "優先度 高", short: "高" },
  medium: { label: "優先度 中", short: "中" },
  low: { label: "優先度 低", short: "低" },
};
const AREA = { ga4: "アクセス解析", ads: "Google広告", meta: "SNS広告", measure: "計測" };
const fmtDateTime = (iso) =>
  new Date(iso).toLocaleString("ja-JP", {
    year: "numeric", month: "long", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit",
  });
const fmtDay = (ymd) => {
  const [, m, d] = ymd.split("-").map(Number);
  return `${m}/${d}`;
};

function renderDiagnosis(d, siteId) {
  const box = $("#sec-diagnosis");
  if (!box) return;
  const counts = { high: 0, medium: 0, low: 0 };
  d.items.forEach((i) => counts[i.severity]++);
  const summary = d.items.length
    ? Object.entries(counts)
        .filter(([, n]) => n)
        .map(([k, n]) => `<span class="sev sev-${k}">${SEVERITY[k].label} ${n}件</span>`)
        .join("")
    : `<span class="sev sev-ok">対応が必要な問題は見つかりませんでした</span>`;
  const actions = d.items
    .map(
      (i, n) => `<li class="diag-item sev-${i.severity}">
        <span class="diag-num" aria-hidden="true">${n + 1}</span>
        <div class="diag-body">
          <div class="diag-tags"><span class="sev sev-${i.severity}">${SEVERITY[i.severity].label}</span><span class="area area-${i.area}">${AREA[i.area] ?? ""}</span></div>
          <p class="diag-title">${esc(i.title)}</p>
          <p class="diag-evidence">${esc(i.evidence)}</p>
          <div class="diag-action"><b>次にできる行動</b><p>${esc(i.action)}</p></div>
          <p class="diag-where"><b>操作する場所</b>${esc(i.where)}</p>
        </div>
      </li>`,
    )
    .join("");
  box.innerHTML = `<div class="chart-head"><h2 style="margin:0">診断結果と次にできる行動</h2>
      <div><button class="btn" id="diag-run" data-site="${esc(siteId)}">最新データで再診断</button></div></div>
    <dl class="diag-meta">
      <div><dt>診断日時</dt><dd>${fmtDateTime(d.checkedAt)}</dd></div>
      <div><dt>対象データ</dt><dd>${fmtDay(d.period.startDate)}〜${fmtDay(d.period.endDate)}（直近28日・直前の28日と比較）</dd></div>
      <div><dt>データ取得</dt><dd>${fmtTime(d.dataFetchedAt)}</dd></div>
    </dl>
    <div class="diag-summary">${summary}</div>
    ${d.items.length ? `<ol class="diag-list">${actions}</ol>` : ""}
    ${
      d.passed.length
        ? `<div class="diag-passed"><b>問題なしだった点</b><ul>${d.passed.map((p) => `<li>${esc(p)}</li>`).join("")}</ul></div>`
        : ""
    }
    <p class="muted small">決まった基準で数字を自動チェックした結果です。30分ごとのデータ更新に合わせて診断し直します。広告やGA4の設定は自動では変更しません。</p>`;
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
  const dates = g.daily.map((d) => d.date);
  const values = g.daily.map((d) => d[key]);
  const prev = g.dailyPrevious.map((d) => d[key]);
  lineChart(
    canvas,
    dates.map(md),
    [
      { label: `${label}（対象期間）`, data: g.daily.map((d) => d[key]), borderColor: cssVar("--series-1"), backgroundColor: cssVar("--series-1") },
      {
        label: `${label}（${COMPARE_NAME[state.compare]}）`,
        data: g.dailyPrevious.map((d) => d[key]),
        borderColor: cssVar("--series-prev"),
        backgroundColor: cssVar("--series-prev"),
        borderDash: [4, 4],
      },
    ],
    fmtInt,
    trendHighlights(dates, values, prev, label, fmtInt),
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
      <div class="site-head">
        ${thumb(site, "lg")}
        <div class="site-head-text">
          <h2>${esc(site.name)}</h2>
          ${site.url ? `<a class="small" href="${esc(site.url)}" target="_blank" rel="noopener">${esc(site.url)} ↗</a>` : ""}
          ${statusLine(report, stale)}
        </div>
      </div>
      ${jumpNav(report)}
      ${errors.map((e) => `<div class="alert">${esc(e)}</div>`).join("")}
      <div id="sec-status">${healthHero(report)}</div>
      ${site.hasGa4 ? `<div class="tiles today" id="today">${todayTiles(report.ga4)}</div>` : ""}
      <div class="card advice" id="advice"><p class="muted">AIの総評を読み込み中…</p></div>
      <div class="card diag" id="sec-diagnosis"><p class="muted">診断結果を読み込み中…</p></div>
      ${report.ga4 ? renderGa4(report.ga4) : ""}
      ${report.ads ? renderAds(report.ads) : ""}
      ${report.meta ? renderMeta(report.meta) : ""}
      ${noAds.length ? `<p class="muted small">このサイトには${noAds.join("・")}のアカウントが紐付いていません。</p>` : ""}
      <div class="card" id="sec-glossary">${glossaryBlock()}</div>`;
    setupJumpNav(view);
    if (report.ga4) whenVisible($("#trend"), () => drawTrend(report.ga4));
    const adCharts = (daily, costKey, costId, convId) => {
      const dates = daily.map((d) => d.date);
      const cost = daily.map((d) => d[costKey]);
      const conv = daily.map((d) => d.conversions);
      whenVisible($(costId), () => barChart($(costId), dates.map(md), cost, "広告費", fmtYen, costHighlights(dates, cost, conv)));
      whenVisible($(convId), () => barChart($(convId), dates.map(md), conv, "成果", fmtDec, convHighlights(dates, conv, cost)));
    };
    if (report.ads) adCharts(report.ads.daily, "cost", "#ads-cost", "#ads-conv");
    if (report.meta) adCharts(report.meta.daily, "spend", "#meta-spend", "#meta-conv");
    animateIn(view);
    $("#metric-seg")?.addEventListener("click", (e) => {
      const m = e.target.closest("button")?.dataset.metric;
      if (!m) return;
      state.metric = m;
      $("#metric-seg").querySelectorAll("button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.metric === m)));
      drawTrend(report.ga4);
    });
    api(`/api/diagnosis?site=${encodeURIComponent(siteId)}`)
      .then(({ diagnosis }) => renderDiagnosis(diagnosis, siteId))
      .catch((e) => ($("#sec-diagnosis").innerHTML = `<div class="alert">${esc(e.message)}</div>`));
    loadAdvice(siteId).catch((e) => ($("#advice").innerHTML = `<div class="alert">${esc(e.message)}</div>`));
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
  clearTimeout(state.advicePoll);
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
  const jump = e.target.closest("[data-jump]");
  if (jump) {
    const el = document.getElementById(jump.dataset.jump);
    if (!el) return;
    const offset = ($(".topbar")?.offsetHeight ?? 0) + ($(".jump-nav")?.offsetHeight ?? 0) + 12;
    window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - offset, behavior: REDUCED ? "auto" : "smooth" });
    return;
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
  if (e.target.id === "diag-run") {
    const btn = e.target;
    btn.disabled = true;
    btn.textContent = "診断中…";
    try {
      const { diagnosis } = await api(`/api/diagnosis?site=${encodeURIComponent(btn.dataset.site)}`, { method: "POST" });
      renderDiagnosis(diagnosis, btn.dataset.site);
    } catch (err) {
      $("#sec-diagnosis").insertAdjacentHTML("beforeend", `<div class="alert">${esc(err.message)}</div>`);
      btn.disabled = false;
      btn.textContent = "もう一度試す";
    }
  }
  if (e.target.id === "advice-gen") {
    generateAdvice(e.target.dataset.site);
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
