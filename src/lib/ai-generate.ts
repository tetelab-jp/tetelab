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
} | null

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

async function callChatJson(env: Bindings, systemPrompt: string, userPrompt: string): Promise<any> {
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
  profile: SalonProfileForGeneration
): Promise<string> {
  const systemLines = [
    'あなたは美容サロンのブログ企画を考える専門プランナーです。',
    ...buildSalonPersonaLines(profile),
    '必ず指定されたJSON形式のみで出力してください。'
  ]
  const userPrompt = `カテゴリ「${categoryName}」のブログ記事で繰り返し伝えるべき、サロンの強み・こだわりを2〜3文でまとめてください。
出力は必ず以下のJSON形式のみで返してください:
{"draft": "伝えたいこと（2〜3文）"}`

  const parsed = await callChatJson(env, systemLines.join('\n'), userPrompt)
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
    .replaceAll('{スタイリスト}', input.stylistName || '')
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
    'お客様の来店意欲を高める、親しみやすく説得力のある文章にしてください。',
    '必ず指定されたJSON形式のみで出力してください。'
  ]

  const bodyInstruction = fillPromptVariables(input.bodyPrompt || DEFAULT_BODY_PROMPT, input)
  const userPrompt = `${bodyInstruction}

出力は必ず以下のJSON形式のみで返してください（説明文やコードブロックは不要）:
{"title": "記事タイトル（25文字以内）", "body": "本文（${input.bodyMaxChars}文字以内、改行を含む）"}`

  const parsed = await callChatJson(env, systemLines.join('\n'), userPrompt)
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
  const text = data?.choices?.[0]?.message?.content
  if (!text) throw new Error('AI画像説明の生成結果が空でした')
  return String(text).trim().slice(0, 100)
}
