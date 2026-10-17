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
  CACHE_TTL_SECONDS?: string;
  ADVICE_MODEL?: string;

  // secrets
  GOOGLE_SERVICE_ACCOUNT_JSON?: string;
  GOOGLE_ADS_DEVELOPER_TOKEN?: string;
  GOOGLE_ADS_CLIENT_ID?: string;
  GOOGLE_ADS_CLIENT_SECRET?: string;
  GOOGLE_ADS_REFRESH_TOKEN?: string;
  GOOGLE_ADS_LOGIN_CUSTOMER_ID?: string;
  ANTHROPIC_API_KEY?: string;
}

export interface SiteConfig {
  id: string;
  name: string;
  url?: string;
  ga4PropertyId?: string;
  adsCustomerIds?: string[];
  /** AIアドバイスに渡すサイトの目的・KPIなど（任意） */
  goal?: string;
}

export type RangeKey = "7d" | "28d" | "90d";

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
}

export interface AdsReport {
  accounts: string[];
  totals: AdsKpis;
  daily: { date: string; cost: number; clicks: number; conversions: number }[];
  campaigns: AdsCampaign[];
}

export interface SiteReport {
  siteId: string;
  range: RangeKey;
  current: DateRange;
  previous: DateRange;
  fetchedAt: string;
  demo: boolean;
  ga4?: Ga4Report;
  ga4Error?: string;
  ads?: AdsReport;
  adsError?: string;
}

export interface Advice {
  siteId: string;
  generatedAt: string;
  model: string;
  demo: boolean;
  summary: string;
  findings: { title: string; detail: string; tone: "good" | "warning" | "critical" | "info" }[];
  actions: { title: string; detail: string; priority: "high" | "medium" | "low"; metric: string }[];
}
