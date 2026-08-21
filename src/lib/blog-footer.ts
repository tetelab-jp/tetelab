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

/**
 * stripTrailingFooterTextを末尾に何も無くなるまで繰り返す版。
 * 2026-08-21追記(バグ調査): POST /blog/articles/:id/editがこのstripを
 * 呼んでいなかったため、フッター付き本文をそのまま再保存すると、投稿時
 * (getArticleRowForJob)にさらにもう1つフッターが付き、フッターが二重に
 * なって全角1000文字制限を超え投稿失敗する不具合があった。既に二重・
 * 三重に焼き込まれてしまった既存記事も自己修復できるよう、1回のstripでは
 * なく末尾から繰り返し取り除く。
 */
export function stripAllTrailingFooterText(body: string, footerText: string): string {
  if (!footerText) return body
  let current = body
  for (let i = 0; i < 10; i++) {
    const next = stripTrailingFooterText(current, footerText)
    if (next === current) return next
    current = next
  }
  return current
}

/**
 * stripAllTrailingFooterText(完全一致)に加えて、フッター区切り記号
 * (footer_separatorを16回繰り返した行、buildAutoFooterTextが必ず
 * フッター先頭に置く行)を境界マーカーとして検出し、それ以降を丸ごと
 * 取り除く。
 * 2026-08-21追記(ユーザー指定): 完全一致だけに頼ると、本文保存後に
 * サロン基本情報やSEO対策ワードが変更されて現在のフッター文字列が
 * 本文に埋め込まれている文字列と一致しなくなった場合、既存フッターを
 * 検出できずもう1つ付け足してしまう(二重付与の再発)。区切り行は
 * 内容が変わっても位置と文字が変わらないため、より確実な境界として使う。
 * 区切り行が複数回(過去の不具合で二重・三重に焼き込まれた場合)出現する
 * 場合は最初の出現位置から丸ごと取り除き、一度の呼び出しで正常化する。
 */
export function stripTrailingFooterBlock(body: string, footerText: string, footerSeparator: string | null): string {
  const exactStripped = stripAllTrailingFooterText(body, footerText)
  if (exactStripped !== body) return exactStripped

  const sepChar = (footerSeparator || '＊').trim().slice(0, 1) || '＊'
  const escapedSepChar = sepChar.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const markerPattern = new RegExp(`^${escapedSepChar}{16}$`, 'gm')

  let earliestIndex: number | null = null
  let match: RegExpExecArray | null
  while ((match = markerPattern.exec(body)) !== null) {
    if (earliestIndex === null) earliestIndex = match.index
  }
  if (earliestIndex === null) return body
  return body.slice(0, earliestIndex).replace(/\s+$/, '')
}

/** user_id/salon_idから、投稿本文に付けるフッター文字列と区切り記号を組み立てる(salon_profiles + salonboard_salons.salon_name を参照)。 */
export async function getFooterTextAndSeparatorForSalon(
  env: Bindings,
  userId: number,
  salonId: number | null
): Promise<{ text: string; separator: string }> {
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
  return {
    text: buildFooterText(salon?.salon_name || null, profile),
    separator: (profile?.footer_separator || '＊').trim().slice(0, 1) || '＊'
  }
}

/** user_id/salon_idから、投稿本文に付けるフッター文字列を組み立てる(salon_profiles + salonboard_salons.salon_name を参照)。 */
export async function getFooterTextForSalon(env: Bindings, userId: number, salonId: number | null): Promise<string> {
  const { text } = await getFooterTextAndSeparatorForSalon(env, userId, salonId)
  return text
}
