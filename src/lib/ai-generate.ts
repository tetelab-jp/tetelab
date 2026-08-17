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
  if (profile?.hpb_catch) lines.push(`サロンのキャッチコピー: ${profile.hpb_catch}`)
  if (profile?.hpb_copy) lines.push(`サロンの紹介文: ${profile.hpb_copy}`)
  if (profile?.hpb_message) lines.push(`サロンからの一言メッセージ: ${profile.hpb_message}`)
  if (profile?.hpb_avg_price_first || profile?.hpb_avg_price_repeat) {
    const first = profile.hpb_avg_price_first ? `初回${profile.hpb_avg_price_first}` : null
    const repeat = profile.hpb_avg_price_repeat ? `2回目以降${profile.hpb_avg_price_repeat}` : null
    lines.push(`平均予約金額（HPB実績）: ${[first, repeat].filter(Boolean).join(' / ')}`)
  }
  if (profile?.hpb_customer_ratio) lines.push(`来店者の性別・年代比率（HPB実績）: ${profile.hpb_customer_ratio}`)
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

function buildPersonaSourceLines(profile: SalonProfileForGeneration): string[] {
  const lines: string[] = []
  if (profile?.salon_name) lines.push(`サロン名: ${profile.salon_name}`)
  if (profile?.area_label) lines.push(`エリア: ${profile.area_label}`)
  if (profile?.hpb_catch) lines.push(`HPBキャッチコピー: ${profile.hpb_catch}`)
  if (profile?.hpb_copy) lines.push(`HPB紹介文: ${profile.hpb_copy}`)
  if (profile?.hpb_message) lines.push(`サロンからの一言メッセージ: ${profile.hpb_message}`)
  if (profile?.hpb_avg_price_first || profile?.hpb_avg_price_repeat) {
    const first = profile.hpb_avg_price_first ? `初回${profile.hpb_avg_price_first}` : null
    const repeat = profile.hpb_avg_price_repeat ? `2回目以降${profile.hpb_avg_price_repeat}` : null
    lines.push(`平均予約金額（HPB実績）: ${[first, repeat].filter(Boolean).join(' / ')}`)
  }
  if (profile?.hpb_customer_ratio) lines.push(`来店者の性別・年代比率（HPB実績）: ${profile.hpb_customer_ratio}`)
  if (profile?.concept) lines.push(`現在の「コンセプト」欄（参考。書き直して構いません）: ${profile.concept}`)
  if (profile?.strengths) lines.push(`現在の「得意なこと・強み」欄（参考。書き直して構いません）: ${profile.strengths}`)
  if (profile?.target_customer) lines.push(`現在の「来てくれる人」欄（参考。書き直して構いません）: ${profile.target_customer}`)
  if (profile?.price_range) lines.push(`現在の「価格帯」欄（参考。書き直して構いません）: ${profile.price_range}`)
  return lines
}

export type GeneratedSalonPersona = {
  concept: string
  strengths: string
  target_customer: string
  price_range: string
}

/**
 * 「サロンボードから読み込む」で取得したHPB公開情報(キャッチ・コピー・
 * メッセージ・平均予約金額・来店者比率)をもとに、「サロンの人格」
 * (コンセプト・強み・来てくれる人・価格帯)をAIに下書きさせる。
 */
export async function generateSalonPersona(env: Bindings, profile: SalonProfileForGeneration): Promise<GeneratedSalonPersona> {
  const sourceLines = buildPersonaSourceLines(profile)
  const hasHpbMaterial = Boolean(
    profile?.hpb_catch || profile?.hpb_copy || profile?.hpb_message || profile?.hpb_avg_price_first || profile?.hpb_avg_price_repeat || profile?.hpb_customer_ratio
  )
  if (!hasHpbMaterial) {
    throw new Error('参考材料が見つかりません。先に「サロンボードから読み込む」を実行してください')
  }

  const systemLines = [
    'あなたは美容サロンのブランディングを考える専門プランナーです。',
    '与えられたサロンの公開情報だけを根拠に、ブログ記事のAI生成に使う「サロンの人格」を作成します。',
    '与えられた情報に無い事実(数値・エピソードなど)を創作しないでください。',
    ...sourceLines,
    ...buildReferenceArticleLines(profile),
    '必ず指定されたJSON形式のみで出力してください。'
  ]
  const userPrompt = `以下の4項目を日本語で作成してください。
- concept: サロンのコンセプト(2〜3文)
- strengths: 得意なこと・強み(2〜3文)
- target_customer: 来てくれる人・読み手の客層(1〜2文。来店者の性別・年代の傾向がわかればそれも自然に触れる)
- price_range: 価格帯(1文。平均予約金額の情報があれば具体的な金額帯を含める)

出力は必ず以下のJSON形式のみで返してください（説明文やコードブロックは不要）:
{"concept": "...", "strengths": "...", "target_customer": "...", "price_range": "..."}`

  const parsed = await callChatJson(env, systemLines.join('\n'), userPrompt, 'salon_persona')
  return {
    concept: String(parsed.concept || '').trim(),
    strengths: String(parsed.strengths || '').trim(),
    target_customer: String(parsed.target_customer || '').trim(),
    price_range: String(parsed.price_range || '').trim()
  }
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
    ...buildSeasonLine(seasonMonths),
    '必ず指定されたJSON形式のみで出力してください。'
  ]
  const userPrompt = `カテゴリ「${categoryName}」のブログ記事で繰り返し伝えるべき、サロンの強み・こだわりを2〜3文でまとめてください。
出力は必ず以下のJSON形式のみで返してください:
{"draft": "伝えたいこと（2〜3文）"}`

  const parsed = await callChatJson(env, systemLines.join('\n'), userPrompt, 'category_draft')
  return String(parsed.draft || '').trim()
}

export type ArticleGenerationInput = {
  categoryName: string
  keyMessage: string | null
  bodyPrompt: string | null
  imageDescription: string | null
  stylistName: string | null
  couponName: string | null
  bodyMaxChars: number
  profile: SalonProfileForGeneration
  seasonMonths?: number[] | null
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

  // 2026-08-17追記(ユーザー指定): 写真の説明を本文のメインテーマとして扱い、
  // サロンの人格・季節感などの情報は軽く触れる程度に留める(重み付けの指示)。
  if (input.imageDescription) {
    systemLines.push(
      '写真の説明に関連する具体的な内容(髪型・カラー・質感・スタイリングなど)を本文の中心テーマとし、' +
        '本文全体の8〜9割程度をその内容に割いてください。サロンのコンセプト・強み・来てくれる人・季節感などの' +
        '情報は、残り1〜2割程度の軽い触れ方(一文程度)に留めてください。'
    )
  }

  systemLines.push(...buildReferenceArticleLines(input.profile))

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

  systemLines.push('必ず指定されたJSON形式のみで出力してください。')

  const bodyInstruction = fillPromptVariables(input.bodyPrompt || DEFAULT_BODY_PROMPT, input)
  const userPrompt = `${bodyInstruction}

出力は必ず以下のJSON形式のみで返してください（説明文やコードブロックは不要）:
{"title": "記事タイトル（25文字以内）", "body": "本文（${input.bodyMaxChars}文字以内、改行を含む）"}`

  const parsed = await callChatJson(env, systemLines.join('\n'), userPrompt, 'article_content')
  return {
    title: String(parsed.title || '').trim().slice(0, 25),
    body: String(parsed.body || '').trim().slice(0, input.bodyMaxChars)
  }
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
