import Anthropic from "@anthropic-ai/sdk";
import type { Advice, Env, SiteConfig, SiteReport } from "../types";
import type { Diagnosis } from "../diagnosis";
import { siteProfile } from "../sites";
import { buildDigest } from "./advice";

// ダッシュボードの利用者が、表示中のサイト・期間のデータや画面の見方について自由に質問し、AIが答える。
// 会話は画面側で持ち、毎回の質問と一緒に送られてくる（サーバーには保存しない）。

const DEFAULT_MODEL = "claude-opus-5-5";
/** 送られてくる会話のうち、AIに渡すのは直近のこの件数まで */
export const MAX_TURNS = 12;
export const MAX_QUESTION_CHARS = 1000;

export interface AskTurn {
  role: "user" | "assistant";
  content: string;
}

/** 1サイト分の文脈。サマリー画面では全サイト分を並べる */
export interface AskSiteContext {
  site: SiteConfig;
  report: SiteReport | null;
  diagnosis: Diagnosis | null;
  advice: Advice | null;
}

const SCREEN_GUIDE = `## ダッシュボードの画面構成
- 上部: サイトのタブ（サマリー／コーポレートサイト／製品サイト／RIKシェア）、集計日数（7日・28日・90日）、比較方法（直前と比較＝同じ日数のすぐ前の期間、前年と比較＝同じ日付の1年前）、「最新に更新」（APIから取り直す。通常は自動更新なので押さなくてよい）、ログオフ。
- 集計は昨日までの完了日。「今日（速報）」とリアルタイム（直近30分のユーザー、1分ごとに更新）は途中値。データは30分ごとに自動で取り直し、開いた時に10分以上古ければ裏で取り直す。
- サマリー: 3サイトの「いまの状況」カード（判定・気になる点・診断の要対応件数）と、ユーザー・セッション・キーイベント・CVR・Google広告/Meta広告の広告費・CV・CPA・AIのひとことの一覧表。カードを押すとそのサイトの画面へ移る。
- 各サイトの画面（上から）:
  1. いまの状況: 5段階（好調・順調・横ばい・注意・要対策）の自動判定と、良くなった点・気になる点。各指標の比較期間比を重み付けして合算した点数で決める（5%未満の変化は横ばい扱い、件数10未満の指標は重みを1/3に下げて「参考」と表示）。重く見る指標はサイトの目的で違う（下の「サイトの目的」）。
  2. 今日の速報とリアルタイム。
  3. AIのひとこと: AIが期間の状況を短くまとめたもの（判定・見出し・要約・用語）。「28日・直前と比較」は毎朝7時に自動で作られ、他の組み合わせは「AIの総評を作る」を押すと30秒〜1分でできる。作ったものは全員の画面に出て、日付が変わると消える。5分以内の作り直しはしない。
  4. 診断・次の行動: 決まったルールで数字をチェックし、問題点・根拠・次にできる行動・操作する場所を優先度（高・中・低）付きで出す。AIではないので毎回同じ基準。データを取り直すたびに自動で作り直し、「最新データで再診断」でもやり直せる。
  5. サイトのアクセス解析（GA4、オレンジ）: ユーザー・新規ユーザー・セッション・表示回数・エンゲージメント率・平均セッション時間・キーイベント、日別推移グラフ（比較期間の線と、目立った日の注記付き）、チャネル別・デバイス別、参照元/メディア、よく見られているページ、ランディングページ、他サイトへのリンクのクリック。RIKシェアは「RIKCADお知らせ」経由の閲覧も出る。
  6. 検索・ディスプレイ広告の成果（Google広告、緑）: 費用・クリック・成果・CPA、日別の広告費と成果、キャンペーン別の費用対効果（インプレッションシェア、予算・広告ランクによる損失）、配信した広告、キーワード、実際に検索された語句、デバイス別。
  7. SNS広告の成果（Meta広告＝Facebook・Instagram、紫）: 費用・リーチ・フリークエンシー・クリック・CTR・CPC・CPM・成果・CPA、配信面別、キャンペーン別、配信した広告、リンク先、GA4で計測した広告経由のサイトでの成果。
  8. 用語解説。
  GA4と各広告の欄には、そのデータについてのAIによる総評（気づき・改善アドバイス）も付く。広告を出していないサイトには広告の欄が出ない。各数字の横の「?」にマウスを当てると用語の説明が出る。
- 色: 増減は良い方向が緑、悪い方向が赤。広告費は増減そのものに良し悪しが無いので色を付けない。CPAなど低いほど良い指標は色を反転している。
- 閲覧専用のツールで、ここから広告やGA4の設定は変わらない。不具合や「こんな数字も見たい」という要望は、マーケティンググループの石田へ。

## 計測について知っておくこと
- 製品サイトの成果（キーイベント）は、無料相談フォーム送信と、Kairos3フォーム（info.rikcorp.jp/form/ の資料請求・導入問い合わせ・点群・AI補助金）の完了。
- コーポレートサイトのMeta広告はPeatix（イベント申込）に誘導しているため、申込はこの画面では数えられない。申込数はPeatixの主催者管理画面で確認する。
- RIKシェアの「RIKCADお知らせ」は、RIKCAD起動時のお知らせ画面から記事を開いた訪問（参照元/メディア rss / rss）。タブを開いたまま30分以上たって再開した分も数えるので、実際のクリック数より多めに出る。
- GA4の管理画面と数字が少し違うのは、集計日（昨日までの完了日）の違いがほとんど。

## 用語
ユーザー（期間中に来た人の数、同じ人は1人）、新規ユーザー、セッション（訪問1回分）、表示回数、エンゲージメント率（10秒以上見る・2ページ以上見る・成果につながる行動をした訪問の割合）、平均セッション時間、キーイベント（問い合わせ送信や資料請求など成果として数える行動、GA4での呼び名）、コンバージョン（CV、広告やサイトで得た成果）、CVR（成果につながった割合）、CPA（成果1件あたりの広告費）、ROAS（広告費1円あたりの成果の金額）、CTR（表示のうちクリックされた割合）、CPC（1クリックあたりの費用）、CPM（1,000回表示あたりの費用）、インプレッションシェア（出せたはずの機会のうち表示できた割合）、予算による損失、広告ランクによる損失、リーチ（広告を見た人の数）、フリークエンシー（1人あたりの表示回数、3回を超えると見飽きやすい）。`;

const SYSTEM = `あなたは株式会社ユニマットリック（エクステリア・ガーデン製品メーカー）のマーケティンググループが使う「RIK web解析ダッシュボード」の案内役で、Web解析と広告運用の専門家です。
利用者はダッシュボードを見ながら、分からないところや気になるデータについて質問してきます。読み手はマーケティンググループのメンバーと、Web広告の専門家ではない営業・経営層です。

答え方
- 質問に直接、結論から答えます。前置き・あいさつ・質問の繰り返しは不要です。
- 短く答えます。ふつうは3〜8文、必要なら箇条書き（「- 」）を使います。見出しは付けません。強調したい語句は **太字** にできます。
- 数字は渡されたデータから引き、「1,234人」「56件」「1件あたり8,900円」のように具体的に書きます。増減は率と実数を並べます。データに無い数字は作りません。分からないこと・データに無いことは、無いとはっきり言い、どこで確かめられるか（GA4の管理画面、Google広告・Meta広告の管理画面、Peatixの管理画面など）を書きます。
- 数値の裏付けがない推測には「推測」と明記します。「〜と考えられる」を重ねません。
- 英字略語は初出で意味を添えます。
- 社内では「期」が年度を指すため、「前期」「今期」「前期間」とは書かず、「直前の28日」「前年の同じ日付」のように具体的に書きます。
- 良し悪しは、そのサイトの目的（site.profile）に照らして判断します。コーポレートサイトは送客と回遊、製品サイトは問い合わせ・資料請求、RIKシェアはRIKCADお知らせ経由の閲覧と記事の読まれ方が主な評価軸です。コーポレートサイトとRIKシェアで問い合わせが少ないことを問題にしません。
- 画面の見方の質問には、下の画面構成に沿って、どこを見ればよいか（欄の名前）を答えます。
- ダッシュボードやサイト運営と関係の無い依頼には、このダッシュボードの質問に答える用途だと一言伝えて断ります。

${SCREEN_GUIDE}

データについて
最初のメッセージに、利用者がいま見ている画面のデータ（JSON）があります。view.tab が "summary" ならサマリー画面で全サイト分、そうでなければそのサイトだけです。各サイトには、集計データ（report）、ルールによる診断結果（diagnosis）、その期間のAIのひとこと（advice、無ければ null）が入っています。
- report.period.current が対象期間、comparison が比較用の期間です。ga4.today は今日の速報値です。
- ads.source が "ga4" の場合は、GA4にリンクされたGoogle広告の費用・クリックと、GA4で計測した成果です。インプレッションシェアは取れません。
- Meta広告の destinations は広告のリンク先別の費用です。peatix.com などイベント受付サービス行きが大半なら、Meta側のCVが0なのは計測上当然です。`;

function siteBlock(c: AskSiteContext) {
  const p = siteProfile(c.site);
  return {
    site: { id: c.site.id, name: c.site.name, url: c.site.url },
    profile: { role: p.role, label: p.label, audience: p.audience, purpose: p.purpose, kpis: p.kpis },
    report: c.report
      ? { ...buildDigest(c.site, c.report), today: c.report.ga4?.today, fetchedAt: c.report.fetchedAt, demo: c.report.demo }
      : null,
    diagnosis: c.diagnosis && {
      checkedAt: c.diagnosis.checkedAt,
      items: c.diagnosis.items.map(({ id: _id, ...i }) => i),
      passed: c.diagnosis.passed,
    },
    advice: c.advice && {
      generatedAt: c.advice.generatedAt,
      status: c.advice.status,
      headline: c.advice.headline,
      summary: c.advice.summary,
      ga4: c.advice.ga4,
      ads: c.advice.ads,
      meta: c.advice.meta,
    },
  };
}

/** AIに渡す、いま見ている画面の文脈 */
export function buildAskContext(view: { tab: string; range: string; compare: string }, sites: AskSiteContext[]) {
  return {
    view: { tab: view.tab, range: view.range, compare: view.compare === "yoy" ? "前年の同じ日付と比較" : "直前の同じ日数と比較" },
    sites: sites.map(siteBlock),
  };
}

/** 画面から届いた会話を整える。最後は利用者の質問で終わり、長すぎるものは切る */
export function normalizeTurns(input: unknown): AskTurn[] {
  if (!Array.isArray(input)) throw new Error("messages が不正です");
  const turns = input
    .filter((t): t is AskTurn => !!t && (t.role === "user" || t.role === "assistant") && typeof t.content === "string" && !!t.content.trim())
    .map((t) => ({ role: t.role, content: t.content.slice(0, t.role === "user" ? MAX_QUESTION_CHARS : 6000) }))
    .slice(-MAX_TURNS);
  // 先頭は利用者の発言から始める
  while (turns.length && turns[0].role !== "user") turns.shift();
  if (!turns.length || turns[turns.length - 1].role !== "user") throw new Error("質問が空です");
  return turns;
}

/** onText には、AIが書いた文章が少しずつ渡される */
export async function answerQuestion(
  env: Env,
  context: ReturnType<typeof buildAskContext>,
  turns: AskTurn[],
  onText: (delta: string) => void,
): Promise<{ model: string }> {
  if (!env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY が未設定です");
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const model = env.ASK_MODEL || env.ADVICE_MODEL || DEFAULT_MODEL;

  // 画面のデータは最初の質問の前に置き、同じ画面での続けての質問はキャッシュから読む
  const [first, ...rest] = turns;
  const stream = client.beta.messages.stream({
    model,
    max_tokens: 4000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "low" },
    system: SYSTEM,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `いま見ている画面のデータです。\n${JSON.stringify(context)}`,
            cache_control: { type: "ephemeral" },
          },
          { type: "text", text: first.content },
        ],
      },
      ...rest,
    ],
  });
  stream.on("text", onText);
  const response = await stream.finalMessage();
  if (response.stop_reason === "refusal") throw new Error("AIが回答を返しませんでした");
  return { model: response.model };
}
