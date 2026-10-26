import type { SiteConfig, SiteRole } from "./types";

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
    sendTo: ["products.rikcorp.jp", "info.rikcorp.jp", "rik-support.net"],
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
};

/** SITES_JSON の role、なければ id・URL からサイトの種類を決める。決められなければ製品サイトと同じ評価にする */
export function siteRole(site: Pick<SiteConfig, "id" | "url" | "role">): SiteRole {
  if (site.role) return site.role;
  const id = site.id.toLowerCase();
  const url = site.url ?? "";
  if (id === "rikshare" || /rik-support\.net\/share/.test(url)) return "media";
  if (id === "corp" || id === "corporate" || /\/\/(www\.)?rikcorp\.jp/.test(url)) return "corporate";
  return "product";
}

export function siteProfile(site: Pick<SiteConfig, "id" | "url" | "role">): SiteProfile {
  return PROFILES[siteRole(site)];
}
