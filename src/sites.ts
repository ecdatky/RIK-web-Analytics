import type { DateRange, Ga4Report, MeasurementGap, SiteConfig, SiteRole } from "./types";

// サイトごとの対象と目的（2026-10-26 マーケティンググループで整理）。
// 診断ルールとAIアドバイスは、ここに書いた目的に沿った指標で評価する。

export interface SiteProfile {
  role: SiteRole;
  /** 画面に出す短い名前 */
  label: string;
  audience: string;
  purpose: string;
  /** 重視する指標（重い順） */
  kpis: string[];
  /** 送客先として数えるドメイン（www. を除く）。コーポレートサイトから各サイトへの入口の働きを見る */
  sendTo?: string[];
}

const PROFILES: Record<SiteRole, SiteProfile> = {
  corporate: {
    role: "corporate",
    label: "会社の情報を正しく伝え、各サイトへの入口になる",
    audience: "当社に興味を持って訪問するすべての人（既存ユーザー、今後ユーザーになる可能性のある層、ステークホルダー、求職者など）",
    purpose:
      "RIKのイベント・ニュースや、どんな会社か・なんの会社かを調べたい人に会社の情報を正しく伝える。RIKの各種サービスを紹介し、詳しいサイト（製品サイトなど）への入口になる。RIKCADやその他製品に興味がある人に、このサイトを通じてRIKの信頼性と興味を高め、将来の顧客に育てる。",
    kpis: ["製品サイトなど各サイトへの送客（リンクのクリック）", "サイト内の回遊（1訪問あたりのページ数・エンゲージメント率）", "訪問者数", "問い合わせ（主目的ではない）"],
    sendTo: ["products.rikcorp.jp", "info.rikcorp.jp", "share.rikcorp.jp", "rik-support.net", "open-ex.jp"],
  },
  product: {
    role: "product",
    label: "製品の魅力を伝え、問い合わせ・資料請求につなげる",
    audience: "RIK製品に興味を持って情報を調べにくる人（代理店、既存ユーザー、旧RIKCADバージョンのユーザー、他社CADの利用者）",
    purpose: "RIKCADやその他の製品・サービスの情報や魅力を正しく伝え、興味を持ってもらい、問い合わせや資料請求につなげる。",
    kpis: ["問い合わせ・資料請求（キーイベント）の件数", "訪問が問い合わせ・資料請求につながる割合", "広告の1件あたりの費用", "訪問者数"],
  },
  media: {
    role: "media",
    label: "RIKCADユーザーに正しい情報・最新の情報を届ける",
    audience: "RIKCADユーザー",
    purpose: "RIKCADユーザーに正しい情報や最新の情報を伝える。投稿はRIKCAD起動時のお知らせ画面に自動で表示される。",
    kpis: ["RIKCADお知らせ経由の閲覧（訪問・ユーザー数）", "記事がしっかり読まれた割合（エンゲージメント率）", "訪問者数", "問い合わせ・資料請求は目的にしない"],
  },
  // OPEN EX 業務管理（https://open-ex.jp/）。2026-11-12 追加。対象・目的は仮置きで、マーケティンググループの確認待ち
  service: {
    role: "service",
    label: "サービスの魅力を伝え、無料のアカウント登録・問い合わせにつなげる",
    audience: "外構・エクステリアの販売・施工店（RIKCADユーザーを含む）で、案件・顧客・図面・写真・発注・工程の管理を効率化したい経営者・担当者",
    purpose:
      "外構案件の業務管理クラウド「OPEN EX 業務管理」の機能・導入事例・料金（無料で始められること）を伝え、無料のアカウント登録（open-ex.net）、資料ダウンロード、問い合わせ・セミナー申込につなげる。",
    kpis: ["無料アカウント登録への遷移（キーイベント）", "資料ダウンロード・問い合わせ", "訪問が登録・問い合わせにつながる割合", "広告の1件あたりの費用", "訪問者数"],
  },
};

/** OPEN EX 業務管理のサイト（open-ex.jp）。登録・ログイン後のサービス本体は open-ex.net */
export const OPENEX_URL = /open-ex\.jp/;

/** RIKシェアのURL。2026-11-02 に www.rik-support.net/share/ から share.rikcorp.jp に移設した（旧URLは新URLへ転送） */
export const RIKSHARE_URL = /rik-support\.net\/share|share\.rikcorp\.jp/;
const RIKSHARE_NEW_URL = "https://share.rikcorp.jp/";

/** SITES_JSON の url が移設前のままでも、画面とAIには新しいURLを出す */
export function withCurrentUrl(site: SiteConfig): SiteConfig {
  if (site.url && /rik-support\.net\/share/.test(site.url)) return { ...site, url: RIKSHARE_NEW_URL };
  return site;
}

/** SITES_JSON の role、なければ id・URL からサイトの種類を決める。決められなければ製品サイトと同じ評価にする */
export function siteRole(site: Pick<SiteConfig, "id" | "url" | "role">): SiteRole {
  if (site.role) return site.role;
  const id = site.id.toLowerCase();
  const url = site.url ?? "";
  if (id === "rikshare" || RIKSHARE_URL.test(url)) return "media";
  if (id === "openex" || OPENEX_URL.test(url)) return "service";
  if (id === "corp" || id === "corporate" || /\/\/(www\.)?rikcorp\.jp/.test(url)) return "corporate";
  return "product";
}

export function siteProfile(site: Pick<SiteConfig, "id" | "url" | "role">): SiteProfile {
  return PROFILES[siteRole(site)];
}

// 計測が止まっていた期間。この期間をまたぐ比較では、増減で良し悪しを判定しない。
// SITES_JSON の measurementGaps で上書き・追加できる。
const MEDIA_GAPS: MeasurementGap[] = [
  {
    start: "2026-10-23",
    end: "2026-11-01",
    reason: "RIKシェアを share.rikcorp.jp へ移設する作業",
  },
];

export function measurementGaps(site: Pick<SiteConfig, "id" | "url" | "role" | "measurementGaps">): MeasurementGap[] {
  if (site.measurementGaps) return site.measurementGaps;
  return siteRole(site) === "media" ? MEDIA_GAPS : [];
}

const overlaps = (gap: MeasurementGap, r: DateRange) => gap.start <= r.endDate && gap.end >= r.startDate;

/** 対象期間か比較期間に重なる、計測が止まっていた期間 */
export function gapsInRanges(gaps: MeasurementGap[], current: DateRange, previous: DateRange): MeasurementGap[] {
  return gaps.filter((g) => overlaps(g, current) || overlaps(g, previous));
}

/** 「10/23〜11/1」の形 */
export function gapLabel(g: MeasurementGap): string {
  const md = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;
  return `${md(g.start)}〜${md(g.end)}`;
}

/** 移設前の /share/ 付きのパスを新しいパスにそろえる（同じ記事を1行にまとめる） */
export function normalizeRikSharePath(path: string): string {
  return path.replace(/^\/share(?=\/|$)/, "") || "/";
}

/** RIKシェアのページ一覧で、移設前後の同じ記事をまとめる。users は足し算なので重複を含む */
export function mergeMovedPages(g: Ga4Report): Ga4Report {
  const pages = new Map<string, Ga4Report["topPages"][number]>();
  for (const p of g.topPages) {
    const path = normalizeRikSharePath(p.path);
    const a = pages.get(path);
    if (!a) {
      pages.set(path, { ...p, path });
      continue;
    }
    const views = a.views + p.views;
    a.engagementRate = views ? (a.engagementRate * a.views + p.engagementRate * p.views) / views : 0;
    a.views = views;
    a.users += p.users;
    if (!a.title && p.title) a.title = p.title;
  }
  const landing = new Map<string, Ga4Report["landingPages"][number]>();
  for (const p of g.landingPages) {
    const path = normalizeRikSharePath(p.path);
    const a = landing.get(path);
    if (!a) {
      landing.set(path, { ...p, path });
      continue;
    }
    const sessions = a.sessions + p.sessions;
    a.engagementRate = sessions ? (a.engagementRate * a.sessions + p.engagementRate * p.sessions) / sessions : 0;
    a.sessions = sessions;
    a.keyEvents += p.keyEvents;
  }
  return {
    ...g,
    topPages: [...pages.values()].sort((a, b) => b.views - a.views),
    landingPages: [...landing.values()].sort((a, b) => b.sessions - a.sessions),
  };
}
