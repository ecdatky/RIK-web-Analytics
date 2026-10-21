import type { AdsReport, Ga4Report, MetaReport, SiteReport } from "./types";

// レポートの数字から、GA4・Google広告・Meta広告の問題点と「次にできる行動」を決まったルールで洗い出す。
// AIの総評と違って毎回同じ基準で判定するので、改善したかどうかを日々の診断で追える。

export type DiagnosisSeverity = "high" | "medium" | "low";
export type DiagnosisArea = "ga4" | "ads" | "meta" | "measure";

export interface DiagnosisItem {
  id: string;
  area: DiagnosisArea;
  severity: DiagnosisSeverity;
  /** 何が起きているか（一行） */
  title: string;
  /** 根拠の数字 */
  evidence: string;
  /** 次にできる行動 */
  action: string;
  /** 操作する場所（管理画面のメニュー） */
  where: string;
}

export interface Diagnosis {
  siteId: string;
  checkedAt: string;
  /** 診断に使ったデータの期間 */
  period: { startDate: string; endDate: string };
  dataFetchedAt: string;
  items: DiagnosisItem[];
  /** 問題がなかった点（安心材料として表示） */
  passed: string[];
}

const yen = (n: number) => `¥${Math.round(n).toLocaleString("ja-JP")}`;
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
const int = (n: number) => Math.round(n).toLocaleString("ja-JP");
const dec = (n: number) => (Math.round(n * 10) / 10).toLocaleString("ja-JP");
const ratio = (a: number, b: number) => (b ? a / b : 0);
const change = (cur: number, prev: number) => (prev ? (cur - prev) / prev : 0);
const SEVERITY_ORDER: Record<DiagnosisSeverity, number> = { high: 0, medium: 1, low: 2 };

const DEVICE_LABEL: Record<string, string> = { mobile: "スマホ", desktop: "PC", tablet: "タブレット", MOBILE: "スマホ", DESKTOP: "PC", TABLET: "タブレット" };
const isMobile = (d: string) => /mobile/i.test(d);
const isDesktop = (d: string) => /desktop/i.test(d);

function diagnoseAds(a: AdsReport, ga4: Ga4Report | undefined, items: DiagnosisItem[], passed: string[]) {
  const t = a.totals;
  const viaGa4 = a.source === "ga4";
  const cvName = viaGa4 ? "成果（GA4のキーイベント）" : "コンバージョン";
  const cost = t.cost.current;
  if (cost <= 0) return;
  const cpa = ratio(cost, t.conversions.current);
  const cpaPrev = ratio(t.cost.previous, t.conversions.previous);

  // 1. デバイスの偏り：スマホに費用が偏っているのに、成果はPCで出ている
  const mob = a.devices.filter((d) => isMobile(d.device));
  const desk = a.devices.filter((d) => isDesktop(d.device));
  const sum = (xs: typeof a.devices, k: "cost" | "clicks" | "conversions") => xs.reduce((s, x) => s + x[k], 0);
  const mCost = sum(mob, "cost");
  const mConv = sum(mob, "conversions");
  const dCost = sum(desk, "cost");
  const dConv = sum(desk, "conversions");
  if (mCost >= cost * 0.4 && dConv > 0) {
    const mCpa = mConv ? mCost / mConv : Infinity;
    const dCpa = dCost / dConv;
    if (mCpa >= dCpa * 2) {
      const save = mConv ? mCost - mConv * dCpa * 1.5 : mCost * 0.5;
      items.push({
        id: "ads-device-mobile",
        area: "ads",
        severity: "high",
        title: "スマホに広告費が偏っているのに、成果はPCで出ています",
        evidence: `スマホ ${yen(mCost)}（費用の${pct(mCost / cost)}）で${cvName} ${dec(mConv)}件、PC ${yen(dCost)}で${dec(dConv)}件。1件あたりはスマホ ${mConv ? yen(mCpa) : "−（0件）"}、PC ${yen(dCpa)}。`,
        action: `スマホの入札単価を−50%前後に下げ、ディスプレイ配信がある場合はアプリ面を除外する。期間あたり最大${yen(Math.max(save, 0))}ほど浮く見込み。`,
        where: "Google広告 > キャンペーン > 対象キャンペーン > 分析情報とレポート > デバイス",
      });
    }
  }

  // 2. 成果0のキャンペーン
  const zeroThreshold = Math.max(cpa || 0, cost * 0.1);
  const zeros = a.campaigns.filter((c) => c.conversions === 0 && c.cost >= zeroThreshold).sort((x, y) => y.cost - x.cost);
  for (const c of zeros.slice(0, 3)) {
    items.push({
      id: `ads-zero-${c.name}`,
      area: viaGa4 ? "measure" : "ads",
      severity: "high",
      title: `キャンペーン「${c.name}」が成果0件です`,
      evidence: `${yen(c.cost)}・${int(c.clicks)}クリックで${cvName}は0件（費用全体の${pct(c.cost / cost)}）。`,
      action: viaGa4
        ? "まずリンク先ページのフォーム送信や資料ダウンロードがGA4のキーイベントとして計測されているか確認する。計測されていて本当に0件なら、予算を半分にして広告文とリンク先を見直す。"
        : "リンク先ページで成果が計測されているか確認し、計測に問題がなければ予算を半分にして広告文とリンク先を見直す。",
      where: viaGa4 ? "GA4 > 管理 > イベント（キーイベント） / Google広告 > キャンペーン" : "Google広告 > キャンペーン",
    });
  }

  // 3. 成果のない検索語句
  const wasteLine = cpa ? cpa * 0.5 : cost * 0.05;
  const waste = a.searchTerms.filter((s) => s.conversions === 0 && s.cost >= wasteLine).sort((x, y) => y.cost - x.cost);
  if (waste.length) {
    const total = waste.reduce((s, x) => s + x.cost, 0);
    items.push({
      id: "ads-negative-terms",
      area: "ads",
      severity: total >= cost * 0.1 ? "high" : "medium",
      title: `成果のない検索語句に${yen(total)}使っています`,
      evidence: waste
        .slice(0, 5)
        .map((s) => `「${s.term}」${yen(s.cost)}`)
        .join("、"),
      action: "関係の薄い語句を除外キーワードに追加する（フレーズ一致で登録すると似た語句もまとめて止められる）。",
      where: "Google広告 > 分析情報とレポート > 検索語句",
    });
  } else if (a.searchTerms.length) {
    passed.push("費用をかけたのに成果のない検索語句は見つかりませんでした。");
  }

  // 4. 獲得単価の悪化
  if (cpa && cpaPrev && change(cpa, cpaPrev) >= 0.2) {
    items.push({
      id: "ads-cpa-up",
      area: "ads",
      severity: change(cpa, cpaPrev) >= 0.5 ? "high" : "medium",
      title: `1件あたりの費用が${pct(change(cpa, cpaPrev))}上がっています`,
      evidence: `${yen(cpaPrev)} → ${yen(cpa)}（広告費 ${yen(t.cost.previous)} → ${yen(cost)}、${cvName} ${dec(t.conversions.previous)} → ${dec(t.conversions.current)}件）。`,
      action: "費用が増えたキャンペーンと成果が減ったキャンペーンを比べ、増額分が成果につながっていなければ予算を前の水準に戻す。",
      where: "Google広告 > キャンペーン（期間比較をオン）",
    });
  } else if (cpa && cpaPrev) {
    passed.push(`Google広告の1件あたりの費用は直前の28日から大きく悪化していません（${yen(cpaPrev)} → ${yen(cpa)}）。`);
  }

  // 5. 広告のクリックとGA4の訪問数のずれ（リンク先にGA4が入っていない・自動タグ設定漏れ）
  if (ga4) {
    const cpc = ga4.sourceMedium.find((s) => s.sourceMedium === "google / cpc");
    const clicks = t.clicks.current;
    if (clicks >= 100) {
      const sessions = cpc?.sessions ?? 0;
      const r = sessions / clicks;
      if (r < 0.5) {
        items.push({
          id: "measure-ads-sessions",
          area: "measure",
          severity: "high",
          title: "広告のクリック数に比べて、GA4に記録された訪問が少なすぎます",
          evidence: `Google広告のクリック ${int(clicks)}回に対し、GA4の google / cpc の訪問は ${int(sessions)}回（${pct(r)}）。通常は7〜9割程度です。`,
          action: "リンク先のLPにGA4のタグが入っているか、Google広告の自動タグ設定がオンか、LPが別ドメインならクロスドメイン設定があるかを確認する。",
          where: "Google広告 > 管理者 > アカウント設定 > 自動タグ設定 / GA4 > 管理 > データストリーム > タグ設定",
        });
      } else {
        passed.push(`広告のクリックはGA4でも訪問として記録されています（${pct(Math.min(r, 1))}）。`);
      }
    }
  }

  // 6. GA4連携のみで取り込んでいる場合は、コンバージョンの取り込みをすすめる
  if (viaGa4) {
    items.push({
      id: "ads-import-conversions",
      area: "ads",
      severity: "low",
      title: "Google広告の自動入札が、実際の問い合わせ・資料請求を目標にできていない可能性があります",
      evidence: "このダッシュボードではGA4のキーイベントを成果として数えていますが、Google広告側に取り込まれているかは確認できません。",
      action: "GA4のキーイベント（問い合わせ送信・資料請求など）をGoogle広告のコンバージョンとして取り込み、入札戦略の目標に設定する。",
      where: "Google広告 > 目標 > コンバージョン > 概要 > ＋新しいコンバージョン アクション > インポート > Google アナリティクス 4",
    });
  }
}

function diagnoseGa4(g: Ga4Report, items: DiagnosisItem[], passed: string[]) {
  const t = g.totals;
  const sessions = t.sessions.current;
  if (sessions < 50) return;
  const kev = t.keyEvents.current;

  // 1. キーイベントが1件もない
  if (kev === 0) {
    items.push({
      id: "ga4-no-keyevents",
      area: "measure",
      severity: "high",
      title: "成果（キーイベント）が1件も記録されていません",
      evidence: `訪問 ${int(sessions)}回に対してキーイベント 0件。`,
      action: "問い合わせ送信・資料請求の完了などのイベントを、GA4でキーイベントとして設定する。",
      where: "GA4 > 管理 > イベント > 対象イベントの「キーイベントとしてマーク」",
    });
    return;
  }

  // 2. 成果率の低下
  const cvr = ratio(kev, sessions);
  const cvrPrev = ratio(t.keyEvents.previous, t.sessions.previous);
  if (cvrPrev && change(cvr, cvrPrev) <= -0.2) {
    items.push({
      id: "ga4-cvr-down",
      area: "ga4",
      severity: change(cvr, cvrPrev) <= -0.4 ? "high" : "medium",
      title: `訪問が成果につながる割合が${pct(-change(cvr, cvrPrev))}下がっています`,
      evidence: `${pct(cvrPrev)} → ${pct(cvr)}（訪問 ${int(t.sessions.previous)} → ${int(sessions)}、キーイベント ${int(t.keyEvents.previous)} → ${int(kev)}）。`,
      action: "訪問が増えたチャネル（参照元）の質を確認し、問い合わせ・資料請求ページへの導線（ボタンの位置・文言）を見直す。",
      where: "GA4 > レポート > 集客 > トラフィック獲得（期間比較）",
    });
  } else if (cvrPrev) {
    passed.push(`訪問が成果につながる割合は大きく下がっていません（${pct(cvrPrev)} → ${pct(cvr)}）。`);
  }

  // 3. 入口ページの離脱（訪問の多いページでエンゲージメントが低い）
  const weak = g.landingPages
    .filter((p) => p.sessions >= sessions * 0.05 && p.engagementRate < 0.4)
    .sort((a, b) => b.sessions - a.sessions);
  if (weak.length) {
    const p = weak[0];
    items.push({
      id: `ga4-landing-${p.path}`,
      area: "ga4",
      severity: "medium",
      title: `入口ページ「${p.path}」で多くの人がすぐ離れています`,
      evidence: `このページから始まる訪問 ${int(p.sessions)}回（全体の${pct(p.sessions / sessions)}）のうち、しっかり見られた割合は${pct(p.engagementRate)}。${
        weak.length > 1 ? `ほかに${weak.length - 1}ページが同じ状態です。` : ""
      }`,
      action: "ページ上部で何のページかすぐわかるようにし、広告やSNSから来た人が探している情報（製品の特長・価格・事例）への導線を置く。広告のリンク先なら広告文と内容が合っているかも確認する。",
      where: "GA4 > レポート > エンゲージメント > ランディング ページ",
    });
  }

  // 4. スマホで成果が出にくい（デバイス別のキーイベントは無いので、比率で見る）
  const mob = g.devices.find((d) => isMobile(d.device));
  if (mob && mob.sessions >= sessions * 0.6) {
    items.push({
      id: "ga4-mobile-share",
      area: "ga4",
      severity: "low",
      title: `訪問の${pct(mob.sessions / sessions)}がスマホからです`,
      evidence: `スマホ ${int(mob.sessions)}回 / 全体 ${int(sessions)}回。`,
      action: "スマホで問い合わせ・資料請求のボタンが最初の画面に見えているか、フォームが入力しやすいかを実機で確認する。",
      where: "サイトをスマホで開いて確認 / GA4 > レポート > ユーザー属性 > テクノロジー",
    });
  }
}

function diagnoseMeta(m: MetaReport, items: DiagnosisItem[], passed: string[]) {
  const t = m.totals;
  const spend = t.spend.current;
  if (spend <= 0) return;
  // Meta側のCVが2期間とも0なら、ピクセル（データセット）か成果イベントが設定されていない
  if (t.conversions.current === 0 && t.conversions.previous === 0) {
    const g = m.ga4;
    items.push({
      id: "measure-meta-pixel",
      area: "measure",
      severity: "high",
      title: "Meta広告の成果が、Meta側で1件も計測されていません",
      evidence: `広告費 ${yen(spend)}・リンククリック ${int(t.clicks.current)}回に対し、Metaの成果（${m.conversionActions.join(", ")}）は0件。${
        g ? `GA4では、Meta広告から来た訪問 ${int(g.sessions.current)}回のうち ${int(g.keyEvents.current)}件がキーイベントに至っています。` : ""
      }`,
      action:
        "サイトとフォームにMetaピクセル（データセット）を設置し、問い合わせ・資料請求の完了ページで「リード」イベントを送る。設置するまでは、このダッシュボードのGA4側の成果（Meta広告から来た人のキーイベント）で効果を判断する。",
      where: "Meta ビジネスマネージャ > イベントマネージャ > データソース / Google タグマネージャー",
    });
  }
  const cpa = ratio(spend, t.conversions.current);
  const awareness = new Set(["OUTCOME_AWARENESS", "BRAND_AWARENESS", "REACH", "OUTCOME_TRAFFIC", "LINK_CLICKS", "POST_ENGAGEMENT", "OUTCOME_ENGAGEMENT"]);
  const zeros = m.campaigns
    .filter((c) => c.conversions === 0 && !awareness.has(c.objective) && c.spend >= Math.max(cpa || 0, spend * 0.1))
    .sort((a, b) => b.spend - a.spend);
  for (const c of zeros.slice(0, 2)) {
    items.push({
      id: `meta-zero-${c.name}`,
      area: "meta",
      severity: "medium",
      title: `SNS広告「${c.name}」が成果0件です`,
      evidence: `${yen(c.spend)}・${int(c.clicks)}クリックで成果0件。`,
      action: "配信先の年齢・地域・興味関心を絞り直すか、反応の良い別の広告に予算を寄せる。",
      where: "Meta広告マネージャ > キャンペーン > 対象キャンペーン",
    });
  }
  const freq = ratio(t.impressions.current, t.reach.current);
  if (freq >= 3) {
    items.push({
      id: "meta-frequency",
      area: "meta",
      severity: "medium",
      title: `同じ人に平均${dec(freq)}回表示されています`,
      evidence: `表示 ${int(t.impressions.current)}回 / 届いた人 ${int(t.reach.current)}人。3回を超えると飽きられて反応が落ちやすくなります。`,
      action: "広告の画像・文面を差し替えるか、配信先を広げる。",
      where: "Meta広告マネージャ > 広告セット > オーディエンス / 広告",
    });
  } else if (t.reach.current) {
    passed.push(`SNS広告の表示頻度は適正です（1人あたり${dec(freq)}回）。`);
  }
}

export function diagnose(report: SiteReport, now = new Date()): Diagnosis {
  const items: DiagnosisItem[] = [];
  const passed: string[] = [];
  if (report.ga4) diagnoseGa4(report.ga4, items, passed);
  if (report.ads) diagnoseAds(report.ads, report.ga4, items, passed);
  if (report.meta) diagnoseMeta(report.meta, items, passed);
  items.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  return {
    siteId: report.siteId,
    checkedAt: now.toISOString(),
    period: { startDate: report.current.startDate, endDate: report.current.endDate },
    dataFetchedAt: report.fetchedAt,
    items,
    passed,
  };
}

export { DEVICE_LABEL };
