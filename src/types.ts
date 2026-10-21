export interface Env {
  ASSETS: Fetcher;
  CACHE: KVNamespace;

  // vars
  SITES_JSON?: string;
  DEMO_MODE?: string;
  AUTH_DISABLED?: string;
  ACCESS_TEAM_DOMAIN?: string; // 例: rikcorp.cloudflareaccess.com
  ACCESS_AUD?: string; // Cloudflare Access アプリケーションの AUD タグ
  GOOGLE_ADS_API_VERSION?: string;
  META_API_VERSION?: string;
  CACHE_TTL_SECONDS?: string;
  ADVICE_MODEL?: string;

  // secrets
  GOOGLE_SERVICE_ACCOUNT_JSON?: string;
  GOOGLE_ADS_DEVELOPER_TOKEN?: string;
  GOOGLE_ADS_CLIENT_ID?: string;
  GOOGLE_ADS_CLIENT_SECRET?: string;
  GOOGLE_ADS_REFRESH_TOKEN?: string;
  GOOGLE_ADS_LOGIN_CUSTOMER_ID?: string;
  META_ACCESS_TOKEN?: string; // システムユーザーのアクセストークン（ads_read）
  META_APP_SECRET?: string; // 任意。設定すると appsecret_proof を付けて呼ぶ
  ANTHROPIC_API_KEY?: string;
}

export interface SiteConfig {
  id: string;
  name: string;
  url?: string;
  ga4PropertyId?: string;
  adsCustomerIds?: string[];
  /** Google広告APIを使わず、GA4にリンクされたGoogle広告の費用・クリックをGA4から取る */
  googleAdsViaGa4?: boolean;
  /** Meta広告アカウントID（act_ は付けても付けなくてもよい） */
  metaAdAccountIds?: string[];
  /** Meta広告でCVとして数える action_type。既定は ["lead"] */
  metaConversionActions?: string[];
  /** AIアドバイスに渡すサイトの目的・KPIなど（任意） */
  goal?: string;
}

export type RangeKey = "7d" | "28d" | "90d";
/** prev: 直前の同じ日数 / yoy: 前年同期（同じ日付の1年前） */
export type CompareKey = "prev" | "yoy";

export interface DateRange {
  startDate: string; // YYYY-MM-DD
  endDate: string;
}

export interface Kpi {
  current: number;
  previous: number;
}

export interface Ga4Report {
  totals: Record<
    "activeUsers" | "newUsers" | "sessions" | "screenPageViews" | "engagementRate" | "averageSessionDuration" | "keyEvents",
    Kpi
  >;
  daily: { date: string; activeUsers: number; sessions: number; keyEvents: number }[];
  dailyPrevious: { date: string; activeUsers: number; sessions: number; keyEvents: number }[];
  channels: { channel: string; sessions: number; engagementRate: number; keyEvents: number }[];
  devices: { device: string; sessions: number }[];
  topPages: { path: string; title: string; views: number; users: number; engagementRate: number }[];
  landingPages: { path: string; sessions: number; engagementRate: number; keyEvents: number }[];
  sourceMedium: { sourceMedium: string; sessions: number; keyEvents: number }[];
  today: { activeUsers: number; sessions: number; keyEvents: number };
}

export interface AdsKpis {
  impressions: Kpi;
  clicks: Kpi;
  cost: Kpi;
  conversions: Kpi;
  conversionsValue: Kpi;
}

export interface AdsCampaign {
  accountId: string;
  id: string;
  name: string;
  status: string;
  channelType: string;
  impressions: number;
  clicks: number;
  cost: number;
  conversions: number;
  conversionsValue: number;
  /** 検索広告のみ。0〜1、取得できない場合は null */
  searchImpressionShare: number | null;
  searchBudgetLostIs: number | null;
  searchRankLostIs: number | null;
}

export interface AdsKeyword {
  text: string;
  matchType: string;
  campaign: string;
  impressions: number;
  clicks: number;
  cost: number;
  conversions: number;
}

export interface AdsSearchTerm {
  term: string;
  campaign: string;
  impressions: number;
  clicks: number;
  cost: number;
  conversions: number;
}

export interface AdsReport {
  accounts: string[];
  /** ga4: GA4のGoogle広告リンク経由。CVはGA4のキーイベント、インプレッションシェアは無し */
  source?: "api" | "ga4";
  totals: AdsKpis;
  daily: { date: string; cost: number; clicks: number; conversions: number }[];
  campaigns: AdsCampaign[];
  devices: { device: string; cost: number; clicks: number; conversions: number }[];
  keywords: AdsKeyword[];
  searchTerms: AdsSearchTerm[];
  /** 広告ごとの見た目と成果（Google広告APIで取得した時だけ。GA4経由では取れない） */
  ads?: AdsAd[];
}

/** Google広告の広告1件（P-MAXはアセットグループ単位） */
export interface AdsAd {
  campaign: string;
  adGroup: string;
  /** RESPONSIVE_SEARCH_AD / RESPONSIVE_DISPLAY_AD / IMAGE_AD / ASSET_GROUP など */
  type: string;
  headlines: string[];
  descriptions: string[];
  imageUrl?: string;
  finalUrl?: string;
  impressions: number;
  clicks: number;
  cost: number;
  conversions: number;
}

export interface MetaKpis {
  spend: Kpi;
  impressions: Kpi;
  /** アカウントをまたぐ場合は単純合算（重複を除けないため目安） */
  reach: Kpi;
  /** リンククリック */
  clicks: Kpi;
  conversions: Kpi;
  conversionsValue: Kpi;
}

export interface MetaCampaign {
  accountId: string;
  id: string;
  name: string;
  objective: string;
  spend: number;
  impressions: number;
  reach: number;
  clicks: number;
  conversions: number;
  conversionsValue: number;
}

export interface MetaAd {
  /** 旧バージョンのデータには無い */
  id?: string;
  name: string;
  campaign: string;
  /** 広告の画像（動画・カルーセルはサムネイル）。取れなかった場合は無い。URLは数日で期限切れになる */
  imageUrl?: string;
  /** 広告を押した先のURL（クリエイティブから取得）。取れなかった場合は無い */
  link?: string;
  spend: number;
  impressions: number;
  reach: number;
  clicks: number;
  conversions: number;
}

export interface MetaReport {
  accounts: string[];
  /** CVとして数えた action_type */
  conversionActions: string[];
  totals: MetaKpis;
  daily: { date: string; spend: number; clicks: number; conversions: number }[];
  campaigns: MetaCampaign[];
  /** facebook / instagram / audience_network / messenger など */
  platforms: { platform: string; spend: number; impressions: number; clicks: number; conversions: number }[];
  ads: MetaAd[];
  /** 広告のリンク先ドメイン別の費用（費用の多い広告から最大20件分）。旧データには無い */
  destinations?: MetaDestination[];
  /** Meta広告から来た訪問の、サイトでの成果（GA4で計測）。Metaピクセルが無くても分かる */
  ga4?: MetaGa4Results;
}

export interface MetaDestination {
  /** www. を除いたドメイン（例: peatix.com） */
  host: string;
  spend: number;
  clicks: number;
  ads: number;
  /** そのドメインのリンク先の例 */
  example: string;
}

export interface MetaGa4Results {
  sessions: Kpi;
  keyEvents: Kpi;
  /** GA4のキャンペーン名（MetaのUTM）別。対象期間のみ */
  campaigns: { name: string; sessions: number; keyEvents: number }[];
}

export interface SiteReport {
  siteId: string;
  range: RangeKey;
  compare: CompareKey;
  current: DateRange;
  previous: DateRange;
  fetchedAt: string;
  demo: boolean;
  ga4?: Ga4Report;
  ga4Error?: string;
  ads?: AdsReport;
  adsError?: string;
  meta?: MetaReport;
  metaError?: string;
}

/** good: 好調 / steady: 順調 / flat: 横ばい / caution: 注意 / bad: 要対策 */
export type AdviceStatus = "good" | "steady" | "flat" | "caution" | "bad";

export interface AdviceSection {
  /** 旧バージョンで作られたアドバイスには無い */
  status?: AdviceStatus;
  /** 総評（2〜3文） */
  review: string;
  findings: { title: string; detail: string; tone: "good" | "warning" | "critical" | "info" }[];
  actions: { title: string; detail: string; priority: "high" | "medium" | "low"; metric: string }[];
}

export interface Advice {
  siteId: string;
  generatedAt: string;
  model: string;
  demo: boolean;
  range: RangeKey;
  compare: CompareKey;
  /** 旧バージョンで作られたアドバイスには無い */
  status?: AdviceStatus;
  /** ひと目でわかる見出し（1文） */
  headline?: string;
  /** サイト全体のひとこと */
  summary: string;
  /** 本文に出てくる専門用語の説明 */
  glossary?: { term: string; meaning: string }[];
  ga4: AdviceSection | null;
  ads: AdviceSection | null;
  /** 旧バージョンで作られたアドバイスには無い */
  meta?: AdviceSection | null;
}
