// ============================================
// ai-generate.ts
// OpenAI互換APIを使ったブログ本文自動生成
// Cloudflare Workers環境からfetch APIで直接呼び出す（openai SDK不使用）
// ============================================

import type { Bindings } from '../types'

const DEFAULT_MODEL = 'gpt-4o-mini'

// ============================================
// ブログ自動投稿機能(Phase 1):
// カテゴリ別プロンプト・画像1枚=記事1本の生成に対応する関数群。
// fetchベース・JSON strict出力パターンを踏襲する。
// ============================================

export type BlogReferenceArticle = {
  title: string | null
  excerpt: string
}

export type SalonProfileForGeneration = {
  salon_name: string | null
  area_label: string | null
  concept: string | null
  target_customer: string | null
  strengths: string | null
  price_range: string | null
  writing_tone: string | null
  first_person: string | null
  sentence_ending: string | null
  ng_words: string | null
  reference_text: string | null
  // 2026-08-17追記: 文章スタイル選択ドロップダウン(style_mode)を廃止し、
  // 「サロンボードから読み込む」で取得したHPB公開ページの情報を常に
  // 参考材料として使う方式に変更した。未取得ならnull。
  hpb_catch: string | null
  hpb_copy: string | null
  hpb_message: string | null
  // 2026-08-17追記: 「来てくれる人」「価格帯」の材料が不足していたため、
  // HPB公開ページの平均予約金額・来店者の性別/年代比率も参考材料に追加。
  hpb_avg_price_first: string | null
  hpb_avg_price_repeat: string | null
  hpb_customer_ratio: string | null
  // 2026-08-21追記(ユーザー指定): 「サロン情報」機能。HPB公開ページの
  // 「〜の雰囲気」「〜のサロンデータ」「特集」「こだわり」も、hpb_catch等と
  // 同じくAI記事生成の参考材料として使う。
  hpb_atmosphere_text: string | null
  hpb_salon_data_text: string | null
  hpb_specials_text: string | null
  hpb_kodawari_text: string | null
  hpb_coupons_text: string | null
  reference_articles: BlogReferenceArticle[]
} | null

// 記事カテゴリに設定された季節パラメータ(「1・2月」のような二月セットの
// チェックボックス)を、生成AIへの季節柄の指示として1行にする。
function buildSeasonLine(seasonMonths?: number[] | null): string[] {
  if (!seasonMonths || seasonMonths.length === 0) return []
  const months = [...seasonMonths].sort((a, b) => a - b).map((m) => `${m}月`)
  return [`季節感: ${months.join('・')}ごろに投稿する記事です。この時期らしい話題や言葉を自然に織り交ぜてください。`]
}

function buildSalonPersonaLines(profile: SalonProfileForGeneration): string[] {
  const lines: string[] = []
  if (profile?.salon_name) lines.push(`サロン名: ${profile.salon_name}`)
  if (profile?.area_label) lines.push(`エリア: ${profile.area_label}`)
  if (profile?.concept) lines.push(`サロンのコンセプト: ${profile.concept}`)
  if (profile?.strengths) lines.push(`得意なこと・強み: ${profile.strengths}`)
  if (profile?.target_customer) lines.push(`来てくれる人（読み手）: ${profile.target_customer}`)
  if (profile?.price_range) lines.push(`価格帯: ${profile.price_range}`)
  if (profile?.writing_tone) lines.push(`文体・トーン: ${profile.writing_tone}`)
  if (profile?.first_person) lines.push(`一人称: ${profile.first_person}`)
  if (profile?.sentence_ending) lines.push(`語尾: ${profile.sentence_ending}`)
  if (profile?.ng_words) lines.push(`避けるべき表現・NGワード: ${profile.ng_words}`)
  return lines
}

// 2026-08-22追記(ユーザー指定): 「HPBに掲載している情報を参考にする」
// チェックボックス(AI記事生成画面)でON/OFFを切り替えられるよう、HPB公開
// ページから取得した項目をbuildSalonPersonaLinesから分離した。
// generateCategoryDraft/generateReviewReplyは従来通り常に含める。
function buildHpbPersonaLines(profile: SalonProfileForGeneration): string[] {
  const lines: string[] = []
  if (profile?.hpb_catch) lines.push(`サロンのキャッチコピー: ${profile.hpb_catch}`)
  if (profile?.hpb_copy) lines.push(`サロンの紹介文: ${profile.hpb_copy}`)
  if (profile?.hpb_message) lines.push(`サロンからの一言メッセージ: ${profile.hpb_message}`)
  if (profile?.hpb_avg_price_first || profile?.hpb_avg_price_repeat) {
    const first = profile.hpb_avg_price_first ? `初回${profile.hpb_avg_price_first}` : null
    const repeat = profile.hpb_avg_price_repeat ? `2回目以降${profile.hpb_avg_price_repeat}` : null
    lines.push(`平均予約金額（HPB実績）: ${[first, repeat].filter(Boolean).join(' / ')}`)
  }
  if (profile?.hpb_customer_ratio) lines.push(`来店者の性別・年代比率（HPB実績）: ${profile.hpb_customer_ratio}`)
  if (profile?.hpb_atmosphere_text) lines.push(`サロンの雰囲気: ${profile.hpb_atmosphere_text}`)
  if (profile?.hpb_salon_data_text) lines.push(`サロンデータ: ${profile.hpb_salon_data_text}`)
  if (profile?.hpb_specials_text) lines.push(`サロンの特集・強み: ${profile.hpb_specials_text}`)
  if (profile?.hpb_kodawari_text) lines.push(`サロンのこだわり: ${profile.hpb_kodawari_text}`)
  if (profile?.hpb_coupons_text) lines.push(`サロンのクーポン例: ${profile.hpb_coupons_text}`)
  return lines
}

/**
 * 「サロンボードから読み込む」で取得した過去のブログ記事の抜粋を、
 * 文体を真似るための参考材料としてsystemプロンプトに渡す。
 * 全件(最大100件)を渡すとトークン消費が大きくなるため、直近の数件のみ使う。
 */
const MAX_REFERENCE_ARTICLES_IN_PROMPT = 6

function buildReferenceArticleLines(profile: SalonProfileForGeneration): string[] {
  const articles = profile?.reference_articles?.slice(0, MAX_REFERENCE_ARTICLES_IN_PROMPT) || []
  if (articles.length === 0) return []
  const lines: (string | null)[] = ['以下はこのサロンが過去に投稿したブログ記事の抜粋です。文体・言い回し・雰囲気の参考にしてください(内容そのものを引用・流用しないこと):']
  for (const a of articles) {
    lines.push(`---`, a.title ? `タイトル: ${a.title}` : null, a.excerpt.slice(0, 300))
  }
  return lines.filter((l): l is string => l !== null)
}

function logTokenUsage(label: string, data: any): void {
  const usage = data?.usage
  if (!usage) return
  console.log(
    `[ai-generate] usage label=${label} model=${data.model || DEFAULT_MODEL} ` +
      `prompt_tokens=${usage.prompt_tokens} completion_tokens=${usage.completion_tokens} total_tokens=${usage.total_tokens}`
  )
}

async function callChatJson(env: Bindings, systemPrompt: string, userPrompt: string, label: string): Promise<any> {
  const apiKey = env.OPENAI_API_KEY
  const baseUrl = env.OPENAI_BASE_URL || 'https://api.openai.com/v1'
  if (!apiKey) {
    throw new Error('OPENAI_API_KEYが設定されていません。管理者に連絡してください。')
  }

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: DEFAULT_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      response_format: { type: 'json_object' }
    })
  })

  if (!res.ok) {
    const errText = await res.text()
    throw new Error(`AI生成APIエラー (${res.status}): ${errText.slice(0, 200)}`)
  }

  const data = (await res.json()) as any
  logTokenUsage(label, data)
  const rawContent = data?.choices?.[0]?.message?.content
  if (!rawContent) {
    throw new Error('AI生成結果が空でした')
  }
  return JSON.parse(rawContent)
}

/**
 * カテゴリの「伝えたいこと」をサロンプロフィールから下書きする。
 */
export async function generateCategoryDraft(
  env: Bindings,
  categoryName: string,
  profile: SalonProfileForGeneration,
  seasonMonths?: number[] | null
): Promise<string> {
  const systemLines = [
    'あなたは美容サロンのブログ企画を考える専門プランナーです。',
    ...buildSalonPersonaLines(profile),
    ...buildHpbPersonaLines(profile),
    ...buildSeasonLine(seasonMonths),
    '必ず指定されたJSON形式のみで出力してください。'
  ]
  const userPrompt = `カテゴリ「${categoryName}」のブログ記事で繰り返し伝えるべき、サロンの強み・こだわりを2〜3文でまとめてください。
出力は必ず以下のJSON形式のみで返してください:
{"draft": "伝えたいこと（2〜3文）"}`

  const parsed = await callChatJson(env, systemLines.join('\n'), userPrompt, 'category_draft')
  return normalizeGeneratedText(String(parsed.draft || '')).trim()
}

export type ArticleGenerationInput = {
  categoryName: string
  keyMessage: string | null
  bodyPrompt: string | null
  imageDescription: string | null
  stylistName: string | null
  // 2026-08-21追記(ユーザー指定): 「サロン情報」機能。HPB公開のスタイリスト
  // 個別ページから取得した「得意なイメージ・得意な技術・趣味/マイブーム」等
  // (stylists.hpb_bio_text)。担当スタイリストが選ばれていて、かつ取得済み
  // の場合のみ渡される。
  stylistBio: string | null
  couponName: string | null
  bodyMaxChars: number
  profile: SalonProfileForGeneration
  seasonMonths?: number[] | null
  // 2026-08-21追記(ユーザー指定): カテゴリ単位の「過去のブログの文章を
  // 参考にする」トグル。falseの場合はbuildReferenceArticleLines(過去記事の
  // 抜粋)を一切システムプロンプトに含めず、テンプレートの情報(サロンの
  // 人格・季節感・本文の生成指示)のみで生成する。
  // 2026-08-22追記(ユーザー指定): AI記事生成画面(/blog/generate)の
  // 「HPBの過去のブログの文章パターンを参考にする」チェックボックスから
  // 生成のたびに指定される(カテゴリ設定のデフォルト値を上書きする)。
  useReferenceArticles: boolean
  // 2026-08-22追記(ユーザー指定): AI記事生成画面の「HPBに掲載している情報を
  // 参考にする」チェックボックス。falseの場合はbuildHpbPersonaLines(HPB公開
  // ページから取得したキャッチコピー・雰囲気・こだわり等)を一切含めない。
  includeHpbInfo: boolean
}

export interface GeneratedArticle {
  title: string
  body: string
}

const DEFAULT_BODY_PROMPT = `{サロン名}のブログとして、{カテゴリ}について書いてください。
写真の内容: {画像の説明}
伝えたいこと: {伝えたいこと}
読み手は{客層}。{文体}で、{本文上限}文字以内。
最後は来店を促す一文で締めてください。`

/**
 * スタイリスト名(SalonBoard由来のフリーテキスト)から苗字だけを取り出す。
 * 全角/半角スペースで姓名が区切られている場合のみ先頭(姓)を採用し、
 * 区切りが無く姓名の境界を判別できない場合はそのまま返す。
 */
function extractLastName(name: string): string {
  const trimmed = name.trim()
  const parts = trimmed.split(/[\s　]+/).filter(Boolean)
  return parts.length >= 2 ? parts[0] : trimmed
}

function fillPromptVariables(template: string, input: ArticleGenerationInput): string {
  const toneLabel = [input.profile?.writing_tone, input.profile?.first_person, input.profile?.sentence_ending]
    .filter(Boolean)
    .join('・')
  return template
    .replaceAll('{サロン名}', input.profile?.salon_name || 'サロン')
    .replaceAll('{エリア}', input.profile?.area_label || '')
    .replaceAll('{カテゴリ}', input.categoryName)
    .replaceAll('{伝えたいこと}', input.keyMessage || '')
    .replaceAll('{画像の説明}', input.imageDescription || '')
    .replaceAll('{客層}', input.profile?.target_customer || '幅広いお客様')
    .replaceAll('{文体}', toneLabel || '親しみやすい文体')
    .replaceAll('{スタイリスト}', input.stylistName ? extractLastName(input.stylistName) : '')
    .replaceAll('{クーポン名}', input.couponName || '')
    .replaceAll('{本文上限}', String(input.bodyMaxChars))
}

// 2026-08-22追記(ユーザー指摘によるバグ修正): gpt-4o-miniがJSON出力の際、
// 改行を実際の制御文字ではなく「\」+「n」という2文字のリテラル(二重エスケープ)
// として書き出すことがあり、JSON.parse後も文字列内に見た目上の「\n」が
// そのまま残って本文にそのまま表示されてしまう不具合が実機で確認された。
// 生成結果に対する後処理として、リテラルな「\n」「\t」を実際の改行・タブに
// 変換する(通常のJSON.parseで正しく改行された文章には影響しない)。
function normalizeGeneratedText(text: string): string {
  return text.replace(/\\n/g, '\n').replace(/\\t/g, '\t')
}

/**
 * カテゴリのプロンプト設定に基づき、1件の記事(タイトル+本文)を生成する。
 * 本文はフッター分の文字数を差し引いた上限(bodyMaxChars)以内に収める。
 */
export async function generateArticleContent(env: Bindings, input: ArticleGenerationInput): Promise<GeneratedArticle> {
  const systemLines = [
    'あなたは美容サロン（美容室）のブログ記事を書く専門ライターです。',
    'ホットペッパービューティーのサロンブログに掲載する記事を作成します。',
    ...buildSalonPersonaLines(input.profile),
    ...buildSeasonLine(input.seasonMonths),
    'お客様の来店意欲を高める、親しみやすく説得力のある文章にしてください。'
  ]

  if (input.seasonMonths && input.seasonMonths.length > 0) {
    systemLines.push(
      '季節感は、本文の一部を割いて説明する話題ではありません。言葉選びや情景描写など、文章全体にさりげなく' +
        '色をつける「味付け」として扱ってください。'
    )
  }
  if (input.stylistBio) {
    systemLines.push(`担当スタイリストの得意分野・人柄: ${input.stylistBio}`)
  }

  // 2026-08-22追記(ユーザー指定): プロンプトに渡す材料の優先度を明示する。
  // 1.伝えたいこと(ユーザープロンプト側の{伝えたいこと}が最優先の指示)
  // 2.過去のブログの文章パターン(トンマナ) 3.サロン情報(HPB掲載テキスト)
  // 4.画像の内容(推測でのミスが生じやすいため最も優先度を低くする)
  if (input.useReferenceArticles) {
    systemLines.push(...buildReferenceArticleLines(input.profile))
  }

  if (input.includeHpbInfo) {
    systemLines.push(...buildHpbPersonaLines(input.profile))
  }

  // 2026-08-17追記(ユーザー指定): 文章スタイル選択ドロップダウン(style_mode)を
  // 廃止したため、サロン基本情報の参考文章(reference_text)はUIから入力できなく
  // なった。過去に入力済みのデータが残っている場合のみ、後方互換として参考にする。
  if (input.profile?.reference_text) {
    systemLines.push(
      '以下は参考文章です。この文章の口調・言い回し・雰囲気に近づけて書いてください(内容そのものを引用・流用しないこと):',
      '---',
      input.profile.reference_text.slice(0, 2000),
      '---'
    )
  }

  // 2026-08-22追記(ユーザー指定): 写真の説明は最も優先度が低い参考材料として
  // 扱う(推測に基づく誤り=ハルシネーションが生じやすいため)。「伝えたいこと」・
  // 過去記事のトンマナ・サロン情報を優先し、写真の説明はその文脈に自然に
  // 触れる程度の補足にとどめる(以前は写真の説明を本文の主題そのものとして
  // 扱っていたが、ユーザー指定によりこの優先度に変更した)。
  if (input.imageDescription) {
    systemLines.push(
      '写真の説明は参考情報の一つですが、他の材料(伝えたいこと・記事のテーマ・過去記事のトンマナ・サロン情報)より' +
        '優先度は低いものとして扱ってください。断定的に書きすぎず、文脈に自然に触れる程度の補足として盛り込んでください。'
    )
    // 2026-08-17追記(ユーザー指定): 写真の説明に無い施術内容を勝手に補って
    // 書かないよう明示する。特に「透明感カラー」は必ずしもブリーチを伴わない
    // ため、ブリーチが明記されていない限り本文に含めない。
    systemLines.push(
      '写真の説明や他の情報に明記されていない施術内容(使用した薬剤・技術など)を推測で補って書かないでください。' +
        '特に「透明感カラー」は必ずしもブリーチを伴うとは限らないため、ブリーチについて明記されていない限り、' +
        '本文にブリーチに関する記述を含めないでください。'
    )
  }

  systemLines.push('必ず指定されたJSON形式のみで出力してください。')

  const bodyInstruction = fillPromptVariables(input.bodyPrompt || DEFAULT_BODY_PROMPT, input)
  const userPrompt = `${bodyInstruction}

出力は必ず以下のJSON形式のみで返してください（説明文やコードブロックは不要）:
{"title": "記事タイトル（25文字以内）", "body": "本文（${input.bodyMaxChars}文字以内、改行を含む）"}`

  const parsed = await callChatJson(env, systemLines.join('\n'), userPrompt, 'article_content')
  return {
    title: normalizeGeneratedText(String(parsed.title || '')).trim().slice(0, 25),
    body: normalizeGeneratedText(String(parsed.body || '')).trim().slice(0, input.bodyMaxChars)
  }
}

// ============================================
// 口コミ自動返信機能: AIによる返信文生成
// ============================================

export type ReviewForReplyGeneration = {
  scoreOverall: number | null
  content: string | null
  stylistNameRaw: string | null
  hpbNickname: string | null
  menuUsed: string | null
}

// 2026-08-22追記(ユーザー指定): 「口コミ設定」ページで設定する返信文章の
// ルール。mustInclude/mustAvoidはAIへの生成指示として渡す(自由記述のため
// 機械的な検証はできない)。サロン名の追加はAI任せだと付け忘れ・表記ゆれが
// 起きるため、生成後にこちら側で機械的に追加する(ブログのフッター追加と
// 同じ考え方)。
export type ReviewReplySettings = {
  mustIncludeText?: string | null
  mustAvoidText?: string | null
  appendSalonName?: boolean
  salonNameText?: string | null
}

// SALON BOARD返信フォームの実際の入力上限(実HTML確認済み。詳細はworker/src/
// salonboard-automation.ts参照): 返信本文(replyContents)は全角500文字以内・
// 改行80回以内。AIには全角換算で余裕を持った400字程度を目安に指示する。
const REVIEW_REPLY_MAX_CHARS_HINT = 400

/**
 * 口コミ本文・評点・サロンの人格(文体・トーン等)をもとに、返信文をAIに
 * 下書きさせる。自動返信(星4以上のみ対象)・手動返信フロー(修正可能な
 * 下書き)の両方から呼ばれる共通関数。
 */
const MAX_PAST_REPLIES_IN_PROMPT = 5

export async function generateReviewReply(
  env: Bindings,
  review: ReviewForReplyGeneration,
  profile: SalonProfileForGeneration,
  pastReplies: string[] = [],
  settings?: ReviewReplySettings
): Promise<string> {
  const referenceLines =
    pastReplies.length > 0
      ? [
          '以下は過去に実際にこのサロンから投稿した返信文の例です。文体・言い回し・トーンの参考にしてください' +
            '(内容そのものを使い回さないこと。今回の口コミの内容に合わせて書いてください):',
          ...pastReplies.slice(0, MAX_PAST_REPLIES_IN_PROMPT).flatMap((r) => ['---', r.slice(0, 300)])
        ]
      : []

  const systemLines = [
    'あなたは美容サロンのオーナーとして、お客様からの口コミに返信する担当者です。',
    ...buildSalonPersonaLines(profile),
    ...buildHpbPersonaLines(profile),
    `SALON BOARDの返信欄の制約: 全角${REVIEW_REPLY_MAX_CHARS_HINT}文字程度まで(改行は控えめに)。`,
    '返信は必ず日本語の丁寧な言葉遣いで、お客様の口コミ本文の内容(施術・接客で触れられている点)に' +
      '具体的に触れながら感謝を伝えてください。',
    '口コミに書かれていない事実(施術内容やエピソード)を創作しないでください。',
    '定型文の羅列にならないよう、その口コミならではの一言を必ず含めてください。',
    // 2026-08-18追記(ユーザー指定): 冒頭のお客様への呼びかけ(お名前+「様」)は
    // システム側で機械的に付加し改行を挟むため、AIには本文部分のみを
    // 生成させる(AI任せだと呼びかけの有無・改行位置がぶれるため)。
    '出力するのは、お客様への呼びかけ(お名前+「様」等)を含まない、本文部分のみにしてください。呼びかけは別途システム側で自動的に付加します。',
    ...referenceLines,
    ...(settings?.mustIncludeText ? [`返信文章に必ず入れること: ${settings.mustIncludeText}`] : []),
    ...(settings?.mustAvoidText ? [`返信文章で絶対にしてはいけないこと: ${settings.mustAvoidText}`] : []),
    '必ず指定されたJSON形式のみで出力してください。'
  ]

  const reviewLines = [
    review.scoreOverall != null ? `総合評価: 星${review.scoreOverall}` : null,
    review.hpbNickname ? `投稿者のニックネーム: ${review.hpbNickname}` : null,
    review.stylistNameRaw ? `担当スタイリスト: ${review.stylistNameRaw}` : null,
    review.menuUsed ? `利用メニュー: ${review.menuUsed}` : null,
    `口コミ本文: ${review.content || '(本文なし)'}`
  ].filter((l): l is string => l !== null)

  const userPrompt = `以下の口コミへの返信文(本文のみ、呼びかけ無し)を作成してください。
${reviewLines.join('\n')}

出力は必ず以下のJSON形式のみで返してください(説明文やコードブロックは不要):
{"reply": "返信本文"}`

  const parsed = await callChatJson(env, systemLines.join('\n'), userPrompt, 'review_reply')
  const body = normalizeGeneratedText(String(parsed.reply || '')).trim()

  // 2026-08-18追記(ユーザー指定): 口コミ投稿者の名前と本文は必ず改行する。
  // AI生成のばらつきを避けるため、呼びかけ行はここで機械的に組み立てる。
  const greeting = review.hpbNickname ? `${review.hpbNickname}様` : null
  let result = greeting ? `${greeting}\n\n${body}` : body

  // 2026-08-22追記(ユーザー指定): 「サロン名を返信文章最後に追加する」がONなら、
  // AI任せにせずこちらで機械的に末尾へ追加する(ブログのフッター追加と同じ考え方)。
  if (settings?.appendSalonName && settings.salonNameText) {
    result = `${result}\n\n${settings.salonNameText}`
  }

  return result
}

/**
 * アップロードされた画像から、記事生成のプロンプトに使う短い説明文を生成する
 * (gpt-4o-miniのvision入力を使用)。
 */
export async function generateImageDescription(env: Bindings, imageBuffer: Buffer): Promise<string> {
  const apiKey = env.OPENAI_API_KEY
  const baseUrl = env.OPENAI_BASE_URL || 'https://api.openai.com/v1'
  if (!apiKey) {
    throw new Error('OPENAI_API_KEYが設定されていません。管理者に連絡してください。')
  }

  const base64 = imageBuffer.toString('base64')
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: DEFAULT_MODEL,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text:
                'これは美容室のヘアスタイル/ブログ用の写真です。色味・質感・雰囲気を、ブログ記事の材料として使える' +
                '一文（20〜30文字程度）で日本語で説明してください。出力は説明文のみ、前置きや記号は不要です。'
            },
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64}` } }
          ]
        }
      ]
    })
  })

  if (!res.ok) {
    const errText = await res.text()
    throw new Error(`AI画像説明生成APIエラー (${res.status}): ${errText.slice(0, 200)}`)
  }

  const data = (await res.json()) as any
  logTokenUsage('image_description', data)
  const text = data?.choices?.[0]?.message?.content
  if (!text) throw new Error('AI画像説明の生成結果が空でした')
  return String(text).trim().slice(0, 100)
}
