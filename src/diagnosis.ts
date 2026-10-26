import type { AdsReport, CompareKey, Ga4Report, MetaDestination, MetaReport, RangeKey, SiteConfig, SiteReport, SiteRole } from "./types";
import { siteProfile, type SiteProfile } from "./sites";

// レポートの数字から、GA4・Google広告・Meta広告の問題点と「次にできる行動」を決まったルールで洗い出す。
// AIの総評と違って毎回同じ基準で判定するので、改善したかどうかを日々の診断で追える。
// GA4はサイトの目的（src/sites.ts）に合わせた指標で判定する。コーポレートは送客・回遊、製品は問い合わせ・資料請求、RIKシェアはRIKCADお知らせ経由の閲覧。

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
  /** 画面の期間切替（表示中の期間・比較ごとに診断する） */
  range: RangeKey;
  compare: CompareKey;
  /** 判定に使ったサイトの種類と目的。旧データには無い */
  role?: SiteRole;
  purpose?: { label: string; kpis: string[] };
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

function diagnoseAds(a: AdsReport, ga4: Ga4Report | undefined, items: DiagnosisItem[], passed: string[], prevName: string) {
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
    passed.push(`Google広告の1件あたりの費用は${prevName}と比べて大きく悪化していません（${yen(cpaPrev)} → ${yen(cpa)}）。`);
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

function diagnoseGa4(g: Ga4Report, profile: SiteProfile, items: DiagnosisItem[], passed: string[], prevName: string) {
  if (g.totals.sessions.current < 50) return;
  if (profile.role === "corporate") return diagnoseCorporate(g, profile, items, passed, prevName);
  if (profile.role === "media") return diagnoseMedia(g, items, passed, prevName);
  diagnoseConversions(g, items, passed);
}

/** 入口ページの離脱（訪問の多いページでエンゲージメントが低い） */
function weakLanding(g: Ga4Report, items: DiagnosisItem[], action: string) {
  const sessions = g.totals.sessions.current;
  const weak = g.landingPages
    .filter((p) => p.sessions >= sessions * 0.05 && p.engagementRate < 0.4)
    .sort((a, b) => b.sessions - a.sessions);
  if (!weak.length) return;
  const p = weak[0];
  items.push({
    id: `ga4-landing-${p.path}`,
    area: "ga4",
    severity: "medium",
    title: `入口ページ「${p.path}」で多くの人がすぐ離れています`,
    evidence: `このページから始まる訪問 ${int(p.sessions)}回（全体の${pct(p.sessions / sessions)}）のうち、しっかり見られた割合は${pct(p.engagementRate)}。${
      weak.length > 1 ? `ほかに${weak.length - 1}ページが同じ状態です。` : ""
    }`,
    action,
    where: "GA4 > レポート > エンゲージメント > ランディング ページ",
  });
}

/** 製品サイト（と種類の決まらないサイト）：問い合わせ・資料請求につながっているか */
function diagnoseConversions(g: Ga4Report, items: DiagnosisItem[], passed: string[]) {
  const t = g.totals;
  const sessions = t.sessions.current;
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

  // 3. 入口ページの離脱
  weakLanding(
    g,
    items,
    "ページ上部で何のページかすぐわかるようにし、広告やSNSから来た人が探している情報（製品の特長・価格・事例）への導線を置く。広告のリンク先なら広告文と内容が合っているかも確認する。",
  );

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

const matchesDomain = (domain: string, targets: string[]) => targets.some((t) => domain === t || domain.endsWith(`.${t}`));

/** コーポレートサイト：会社の情報が見られているか、製品サイトなど各サイトへの入口として働いているか。問い合わせ件数は主目的ではない */
function diagnoseCorporate(g: Ga4Report, profile: SiteProfile, items: DiagnosisItem[], passed: string[], prevName: string) {
  const t = g.totals;
  const sessions = t.sessions.current;

  // 1. 各サイトへの送客（他ドメインへのリンクのクリック）
  if (g.linkClicks) {
    const targets = profile.sendTo ?? [];
    const sent = g.linkClicks.filter((l) => matchesDomain(l.domain, targets));
    const cur = sent.reduce((s, l) => s + l.clicks.current, 0);
    const prev = sent.reduce((s, l) => s + l.clicks.previous, 0);
    const per100 = (c: number, s: number) => (s ? (c / s) * 100 : 0);
    const rate = per100(cur, sessions);
    const ratePrev = per100(prev, t.sessions.previous);
    const byDomain = sent
      .filter((l) => l.clicks.current)
      .map((l) => `${l.domain} ${int(l.clicks.current)}回`)
      .join("、");
    if (!g.linkClicks.length) {
      items.push({
        id: "measure-corp-link-clicks",
        area: "measure",
        severity: "medium",
        title: "製品サイトなど他のサイトへのリンクのクリックが記録されていません",
        evidence: `訪問 ${int(sessions)}回に対して、他のドメインへのリンクのクリック（click イベント）が0件。このサイトの役目である「各サイトへの入口」の働きを測れていません。`,
        action:
          "GA4の拡張計測機能で「離脱クリック」をオンにする。products.rikcorp.jp などをクロスドメイン設定に入れている場合はクリックとして数えられないので、製品サイト側のGA4で参照元 www.rikcorp.jp の訪問を見る。",
        where: "GA4 > 管理 > データストリーム > 対象ストリーム > 拡張計測機能 / タグ設定 > ドメインの設定",
      });
    } else if (!cur) {
      items.push({
        id: "corp-send-none",
        area: "ga4",
        severity: "medium",
        title: "製品サイトなどへの送客がほとんど記録されていません",
        evidence: `他のドメインへのクリックは記録されていますが、${targets.join("・")} へのクリックは0件。`,
        action: "トップページ・会社案内・サービス紹介のページに、RIKCADや各製品の詳しいページ（製品サイト）へのリンクが見つけやすい位置にあるか確認する。",
        where: "サイトの各ページ / GA4 > レポート > エンゲージメント > イベント > click（link_domain）",
      });
    } else if (prev && change(rate, ratePrev) <= -0.2) {
      items.push({
        id: "corp-send-down",
        area: "ga4",
        severity: change(rate, ratePrev) <= -0.4 ? "high" : "medium",
        title: `製品サイトなどへの送客が${pct(-change(rate, ratePrev))}減っています`,
        evidence: `訪問100回あたりのクリック ${dec(ratePrev)}回 → ${dec(rate)}回（${int(prev)} → ${int(cur)}回）。内訳: ${byDomain}。`,
        action: "よく見られているページ（ニュース・会社案内など）から、関係する製品・サービスのページへのリンクを本文の近くに置く。リンクの位置や文言を最近変えたページがないかも確認する。",
        where: "GA4 > レポート > エンゲージメント > ページとスクリーン / イベント > click",
      });
    } else {
      passed.push(`製品サイトなどへの送客は訪問100回あたり${dec(rate)}回です（${byDomain}）${prev ? `。${prevName}は${dec(ratePrev)}回` : ""}。`);
    }
  }

  // 2. サイト内の回遊（1訪問あたりのページ数）
  const pps = ratio(t.screenPageViews.current, sessions);
  const ppsPrev = ratio(t.screenPageViews.previous, t.sessions.previous);
  if (ppsPrev && change(pps, ppsPrev) <= -0.2) {
    items.push({
      id: "corp-pages-down",
      area: "ga4",
      severity: "medium",
      title: `1回の訪問で見られるページ数が${pct(-change(pps, ppsPrev))}減っています`,
      evidence: `${dec(ppsPrev)}ページ → ${dec(pps)}ページ（ページビュー ${int(t.screenPageViews.previous)} → ${int(t.screenPageViews.current)}、訪問 ${int(t.sessions.previous)} → ${int(sessions)}）。`,
      action: "入口として多いページに、会社案内・サービス紹介・ニュースなど次に読むページへのリンクを置き、会社の全体像がつかめるようにする。",
      where: "GA4 > レポート > エンゲージメント > ランディング ページ",
    });
  } else if (ppsPrev) {
    passed.push(`1回の訪問で見られるページ数は大きく減っていません（${dec(ppsPrev)} → ${dec(pps)}ページ）。`);
  }

  // 3. 入口ページの離脱
  weakLanding(
    g,
    items,
    "ページ上部で何の会社・何のページかすぐわかるようにし、会社案内・サービス紹介や、製品サイトなど詳しいサイトへの入口を近くに置く。",
  );

  // 4. 問い合わせは主目的ではないので、0件でも計測の確認だけにとどめる
  if (t.keyEvents.current === 0) {
    items.push({
      id: "corp-no-contact",
      area: "measure",
      severity: "low",
      title: "問い合わせ（キーイベント）はこの期間0件です",
      evidence: `訪問 ${int(sessions)}回に対してキーイベント 0件。このサイトの主な目的は会社の情報を伝え、各サイトへの入口になることなので、件数そのものは重く見ません。`,
      action: "問い合わせフォームの送信が計測されているか（contact_form_submit）だけ、GA4のリアルタイムやテスト送信で確認する。",
      where: "GA4 > 管理 > イベント / レポート > リアルタイム",
    });
  }

  const mob = g.devices.find((d) => isMobile(d.device));
  if (mob && mob.sessions >= sessions * 0.6) {
    items.push({
      id: "ga4-mobile-share",
      area: "ga4",
      severity: "low",
      title: `訪問の${pct(mob.sessions / sessions)}がスマホからです`,
      evidence: `スマホ ${int(mob.sessions)}回 / 全体 ${int(sessions)}回。`,
      action: "スマホのメニューから会社案内・サービス紹介・製品サイトへのリンクがすぐ見つかるかを実機で確認する。",
      where: "サイトをスマホで開いて確認 / GA4 > レポート > ユーザー属性 > テクノロジー",
    });
  }
}

/** オウンドメディア（RIKシェア）：RIKCADユーザーに記事が届き、読まれているか。問い合わせ・資料請求は目的にしない */
function diagnoseMedia(g: Ga4Report, items: DiagnosisItem[], passed: string[], prevName: string) {
  const t = g.totals;
  const sessions = t.sessions.current;

  // 1. RIKCADお知らせ経由の閲覧
  const news = g.rikcadNews;
  if (news) {
    const cur = news.sessions.current;
    const prev = news.sessions.previous;
    if (!cur) {
      items.push({
        id: "measure-rikcad-news",
        area: "measure",
        severity: "high",
        title: "RIKCADお知らせ経由の訪問が記録されていません",
        evidence: `訪問 ${int(sessions)}回のうち、RIKCADお知らせ（rss / rss）経由は0回。${prev ? `${prevName}は${int(prev)}回ありました。` : ""}`,
        action:
          "RSS（https://www.rik-support.net/share/feed/）に最新の投稿が出ているか、記事リンクに utm_medium=rss が付いているかを確認する。RIKCADを起動してお知らせ画面に記事が表示されるかも見る。",
        where: "ブラウザで https://www.rik-support.net/share/feed/ を開く / RIKCADのお知らせ画面",
      });
    } else if (prev && change(cur, prev) <= -0.2) {
      items.push({
        id: "media-news-down",
        area: "ga4",
        severity: change(cur, prev) <= -0.4 ? "high" : "medium",
        title: `RIKCADお知らせ経由の閲覧が${pct(-change(cur, prev))}減っています`,
        evidence: `訪問 ${int(prev)} → ${int(cur)}回、ユーザー ${int(news.activeUsers.previous)} → ${int(news.activeUsers.current)}人（全訪問の${pct(ratio(cur, sessions))}）。`,
        action:
          "お知らせ画面では記事のタイトルが入口になるので、何の情報か・誰向けかがタイトルで分かるようにする。投稿の間隔が空いていないかも確認し、新しい情報を定期的に出す。",
        where: "WordPress（RIKシェア）の投稿一覧 / GA4 > レポート > 集客 > トラフィック獲得",
      });
    } else {
      passed.push(
        `RIKCADお知らせ経由の閲覧は${int(cur)}回・${int(news.activeUsers.current)}人で、全訪問の${pct(ratio(cur, sessions))}です${prev ? `（${prevName}は${int(prev)}回）` : ""}。`,
      );
    }
  }

  // 2. 読む人の数
  const users = t.activeUsers;
  if (users.previous && change(users.current, users.previous) <= -0.2) {
    items.push({
      id: "media-users-down",
      area: "ga4",
      severity: "medium",
      title: `記事を読む人が${pct(-change(users.current, users.previous))}減っています`,
      evidence: `ユーザー ${int(users.previous)} → ${int(users.current)}人（訪問 ${int(t.sessions.previous)} → ${int(sessions)}回）。`,
      action: "よく読まれた記事のテーマ（操作のコツ・新機能・サポート情報など）を確認し、同じテーマの記事を続けて出す。",
      where: "GA4 > レポート > エンゲージメント > ページとスクリーン",
    });
  } else if (users.previous) {
    passed.push(`記事を読む人の数は大きく減っていません（${int(users.previous)} → ${int(users.current)}人）。`);
  }

  // 3. しっかり読まれた割合
  const er = t.engagementRate;
  if (er.previous && change(er.current, er.previous) <= -0.15) {
    items.push({
      id: "media-engagement-down",
      area: "ga4",
      severity: "medium",
      title: `記事がしっかり読まれた割合が${pct(-change(er.current, er.previous))}下がっています`,
      evidence: `${pct(er.previous)} → ${pct(er.current)}。`,
      action: "記事の冒頭で要点（何ができるようになるか）を先に書き、画像や手順で読み進めやすくする。関連する記事へのリンクを最後に置く。",
      where: "GA4 > レポート > エンゲージメント > ページとスクリーン",
    });
  } else if (er.previous) {
    passed.push(`記事がしっかり読まれた割合は保てています（${pct(er.previous)} → ${pct(er.current)}）。`);
  }

  // 4. 入口ページの離脱
  weakLanding(g, items, "記事の冒頭で要点が分かるようにし、タイトルと内容がずれていないか確認する。関連する記事への導線を置く。");
}

// 自社のGA4・Metaピクセルを入れられない外部の受付ページ。ここに送る広告は、サイト側では成果を測れない
const OFFSITE_SERVICES: { pattern: RegExp; label: string; where: string }[] = [
  { pattern: /(^|\.)peatix\.com$/, label: "Peatix", where: "Peatix 主催者管理画面 > イベント > ホーム（閲覧数・流入元・申込数）" },
  { pattern: /(^|\.)connpass\.com$/, label: "connpass", where: "connpass のイベント管理画面" },
  { pattern: /(^|\.)eventbrite\.(com|co\.jp)$/, label: "Eventbrite", where: "Eventbrite のイベント管理画面" },
  { pattern: /(^|\.)doorkeeper\.jp$/, label: "Doorkeeper", where: "Doorkeeper のイベント管理画面" },
];

/** 広告費の半分以上が外部の受付ページ行きなら、その行き先を返す */
export function offsiteDestination(m: MetaReport): { service: (typeof OFFSITE_SERVICES)[number]; dests: MetaDestination[]; share: number } | undefined {
  const dests = m.destinations ?? [];
  const known = dests.reduce((s, d) => s + d.spend, 0);
  if (!known) return;
  for (const service of OFFSITE_SERVICES) {
    const hit = dests.filter((d) => service.pattern.test(d.host));
    const share = hit.reduce((s, d) => s + d.spend, 0) / known;
    if (share >= 0.5) return { service, dests: hit, share };
  }
}

function diagnoseMeta(m: MetaReport, items: DiagnosisItem[], passed: string[]) {
  const t = m.totals;
  const spend = t.spend.current;
  if (spend <= 0) return;
  const offsite = offsiteDestination(m);
  if (offsite) {
    // Peatix 等に送っている広告は、Meta側の成果0・GA4の訪問なしが正常。ピクセル設置やキャンペーン停止を勧めない
    const { service, dests, share } = offsite;
    const g = m.ga4;
    items.push({
      id: "measure-meta-offsite",
      area: "measure",
      severity: "medium",
      title: `Meta広告の行き先が${service.label}のため、このダッシュボードでは申込数を測れません`,
      evidence: `リンク先が分かった広告の費用のうち${pct(share)}が${service.label}（${dests.map((d) => d.host).join("、")}）行きで、${int(
        dests.reduce((s, d) => s + d.clicks, 0),
      )}クリック。${service.label}のページには自社のGA4やMetaピクセルを入れられないため、Meta側の成果は0件${
        g ? `、GA4でもMeta広告から来た訪問は${int(g.sessions.current)}回` : ""
      }になります。`,
      action: `広告の効果は${service.label}の管理画面で、イベントページの閲覧数・流入元と申込数を見て判断する。広告のリンクにURLパラメーターを付けておくと、流入元で広告からの申込を区別できる。サイトにMetaピクセルを入れても、この広告の申込は計測できない。`,
      where: `${service.where} / Meta広告マネージャ > 広告 > ウェブサイトのURL`,
    });
  } else if (t.conversions.current === 0 && t.conversions.previous === 0) {
    // Meta側のCVが2期間とも0なら、ピクセル（データセット）か成果イベントが設定されていない
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
  // 外部の受付ページに送っている場合、成果0は計測できないだけなので「成果0のキャンペーン」は出さない
  const zeros = (offsite ? [] : m.campaigns)
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

export function diagnose(report: SiteReport, site?: Pick<SiteConfig, "id" | "url" | "role">, now = new Date()): Diagnosis {
  const items: DiagnosisItem[] = [];
  const passed: string[] = [];
  const profile = siteProfile(site ?? { id: report.siteId });
  const prevName = report.compare === "yoy" ? "前年の同じ日付" : "直前の同じ日数";
  if (report.ga4) diagnoseGa4(report.ga4, profile, items, passed, prevName);
  if (report.ads) diagnoseAds(report.ads, report.ga4, items, passed, prevName);
  if (report.meta) diagnoseMeta(report.meta, items, passed);
  items.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  return {
    siteId: report.siteId,
    checkedAt: now.toISOString(),
    range: report.range,
    compare: report.compare,
    role: profile.role,
    purpose: { label: profile.label, kpis: profile.kpis },
    period: { startDate: report.current.startDate, endDate: report.current.endDate },
    dataFetchedAt: report.fetchedAt,
    items,
    passed,
  };
}

export { DEVICE_LABEL };
