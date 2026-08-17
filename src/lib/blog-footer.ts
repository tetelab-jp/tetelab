// ============================================
// blog-footer.ts
// ブログ記事末尾に付けるフッター文字列の組み立て。
// 元は src/routes/blog.tsx にプライベート関数として存在していたが、
// 2026-08-16の再設計で「記事ごとにフッターを付けるかどうか選べる」ように
// なり、実際の投稿本文(blog-post-runner.ts)側でも同じロジックが必要に
// なったため、共有ライブラリへ切り出した。
// ============================================

import type { Bindings } from '../types'

export type SalonProfileFooterFields = {
  address: string | null
  nearest_station: string | null
  walk_minutes: string | null
  business_hours: string | null
  closing_days: string | null
  footer_separator: string | null
  footer_keywords_json: string | null
  footer_override_text?: string | null
}

/** サロン基本情報から自動生成したフッター文言(上書きなしの場合の値)。プレビューの「自動生成に戻す」等で使う。 */
export function buildAutoFooterText(salonName: string | null, profile: SalonProfileFooterFields | null): string {
  if (!profile) return ''
  const sep = (profile.footer_separator || '＊').repeat(16)
  const lines = [sep, salonName || '']
  if (profile.address || profile.nearest_station) {
    lines.push('', '【アクセス】')
    if (profile.address) lines.push(profile.address)
    if (profile.nearest_station) lines.push(`${profile.nearest_station}${profile.walk_minutes ? ` 徒歩${profile.walk_minutes}` : ''}`)
  }
  if (profile.business_hours || profile.closing_days) {
    lines.push('', '【営業時間】')
    if (profile.business_hours) lines.push(profile.business_hours)
    if (profile.closing_days) lines.push(`※定休：${profile.closing_days}`)
  }
  const keywords: string[] = JSON.parse(profile.footer_keywords_json || '[]')
  if (keywords.length > 0) lines.push('', `[${keywords.join('/')}]`)
  return lines.join('\n')
}

/**
 * 実際に記事末尾へ付けるフッター文字列。footer_override_text(プレビューを
 * 直接編集して保存した内容)が設定されていればそれをそのまま使い、
 * 未設定(NULL/空文字)ならbuildAutoFooterText()の自動生成結果を使う。
 */
export function buildFooterText(salonName: string | null, profile: SalonProfileFooterFields | null): string {
  const override = profile?.footer_override_text?.trim()
  if (override) return override
  return buildAutoFooterText(salonName, profile)
}

/**
 * bodyの末尾にfooterTextがそのまま(前後の空白のみ挟んで)含まれている場合、その部分を取り除く。
 * 新規作成フォームでは本文欄に最初からフッター文字列を入力済みの状態で表示するため、
 * 保存時にそれをDBへ焼き込んでしまうと投稿時(getArticleRowForJob)のフッター付加と重複するのを防ぐ。
 */
export function stripTrailingFooterText(body: string, footerText: string): string {
  if (!footerText) return body
  const idx = body.lastIndexOf(footerText)
  if (idx === -1) return body
  const tail = body.slice(idx + footerText.length)
  if (tail.trim() !== '') return body
  return body.slice(0, idx).replace(/\s+$/, '')
}

/** user_id/salon_idから、投稿本文に付けるフッター文字列を組み立てる(salon_profiles + salonboard_salons.salon_name を参照)。 */
export async function getFooterTextForSalon(env: Bindings, userId: number, salonId: number | null): Promise<string> {
  const [profile, salon] = await Promise.all([
    env.DB.prepare(
      `SELECT address, nearest_station, walk_minutes, business_hours, closing_days, footer_separator, footer_keywords_json, footer_override_text
       FROM salon_profiles WHERE user_id = ? AND salon_id = ?`
    )
      .bind(userId, salonId)
      .first<SalonProfileFooterFields>(),
    env.DB.prepare('SELECT salon_name FROM salonboard_salons WHERE id = ?')
      .bind(salonId)
      .first<{ salon_name: string | null }>()
  ])
  return buildFooterText(salon?.salon_name || null, profile)
}
