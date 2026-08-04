// ============================================
// ai-generate.ts
// OpenAI互換APIを使ったブログ本文自動生成
// Cloudflare Workers環境からfetch APIで直接呼び出す（openai SDK不使用）
// ============================================

import type { Bindings } from '../types'

type SalonProfile = {
  concept: string
  target_customer: string
  writing_tone: string
  ng_words: string
} | null

export interface GeneratedBlog {
  title: string
  content: string
}

const DEFAULT_MODEL = 'gpt-5-mini'

export async function generateBlogContent(
  env: Bindings,
  keywords: string,
  profile: SalonProfile
): Promise<GeneratedBlog> {
  const apiKey = env.OPENAI_API_KEY
  const baseUrl = env.OPENAI_BASE_URL || 'https://api.openai.com/v1'

  if (!apiKey) {
    throw new Error('OPENAI_API_KEYが設定されていません。管理者に連絡してください。')
  }

  const systemPrompt = buildSystemPrompt(profile)
  const userPrompt = `以下のキーワードを含めて、美容サロンのブログ記事を作成してください。
キーワード: ${keywords}

出力は必ず以下のJSON形式のみで返してください（説明文やコードブロックは不要）:
{"title": "記事タイトル（30文字程度）", "content": "本文（400〜600文字程度、改行を含む）"}`

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
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

  const data = await res.json<any>()
  const rawContent = data?.choices?.[0]?.message?.content
  if (!rawContent) {
    throw new Error('AI生成結果が空でした')
  }

  try {
    const parsed = JSON.parse(rawContent)
    return {
      title: String(parsed.title || '').trim(),
      content: String(parsed.content || '').trim()
    }
  } catch {
    // JSON形式で返ってこなかった場合のフォールバック：そのまま本文として扱う
    return {
      title: keywords.slice(0, 30),
      content: rawContent.trim()
    }
  }
}

function buildSystemPrompt(profile: SalonProfile): string {
  const lines = [
    'あなたは美容サロン（美容室）のブログ記事を書く専門ライターです。',
    'ホットペッパービューティーのサロンブログに掲載する記事を作成します。'
  ]

  if (profile?.concept) {
    lines.push(`サロンのコンセプト: ${profile.concept}`)
  }
  if (profile?.target_customer) {
    lines.push(`ターゲット顧客層: ${profile.target_customer}`)
  }
  if (profile?.writing_tone) {
    lines.push(`文体・トーン: ${profile.writing_tone}`)
  }
  if (profile?.ng_words) {
    lines.push(`避けるべき表現・NGワード: ${profile.ng_words}`)
  }

  lines.push('お客様の来店意欲を高める、親しみやすく説得力のある文章にしてください。')
  lines.push('必ず指定されたJSON形式のみで出力してください。')

  return lines.join('\n')
}
