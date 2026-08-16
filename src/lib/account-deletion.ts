// ============================================
// account-deletion.ts
// 管理者サイト(/admin/salons)で、あるアカウントの「有効化」サロンが
// 1件も無くなる(全サロンを無効化する)と、即時削除ではなく3日間の
// 猶予期間(users.deletion_requested_at)を置く。猶予中にいずれかの
// サロンを有効化し直せば削除は自動的にキャンセルされる。猶予経過後の
// 実削除を行うスイープ処理がこのファイル。
//
// DB側は外部キーが全てON DELETE CASCADE(usersを参照する19テーブル、
// salonboard_salonsを参照する17テーブル、ローカルPostgresで実制約を確認済み)
// のため、usersの行を1回DELETEするだけで紐づく全サロン・全データが
// 自動的に消える。S3(スタイル画像・ブログ画像)だけはDBのカスケードで
// 消えないため、削除前にDBから対象キーを列挙し、行を消した後に
// ベストエフォートで削除する。
//
// 2026-08-14追記(ユーザー指定): 当初はサロン単位の個別削除ボタンだったが、
// 管理者サイトのサロン一覧が見づらくなったため撤去し、既存の「契約」
// トグル(アカウント単位のis_active)に削除操作を一本化した。
// 2026-08-16追記(ユーザー指定): その後「契約」トグルも撤去し、有効な
// サロンの有無から自動的に判定するようにした(admin.tsxのtoggle-workspace参照)。
// ============================================

import type { Bindings } from '../types'

export const GRACE_PERIOD_DAYS = 3

async function collectImageKeysForUser(env: Bindings, userId: number): Promise<string[]> {
  const { results } = await env.DB.prepare(
    `SELECT si.r2_key AS key FROM style_images si
       JOIN styles s ON s.id = si.style_id
       JOIN salonboard_salons sb ON sb.id = s.salon_id
      WHERE sb.user_id = ?
     UNION ALL
     SELECT ba.image_r2_key AS key FROM blog_articles ba
       JOIN salonboard_salons sb ON sb.id = ba.salon_id
      WHERE sb.user_id = ? AND ba.image_r2_key IS NOT NULL`
  )
    .bind(userId, userId)
    .all<{ key: string }>()
  return (results || []).map((r) => r.key)
}

async function deleteImageKeys(env: Bindings, keys: string[]): Promise<void> {
  for (const key of keys) {
    await env.STYLE_IMAGES.delete(key).catch(() => {})
  }
}

async function logExecution(
  env: Bindings,
  adminId: number | null,
  action: string,
  targetType: string,
  targetId: number,
  detail: string
): Promise<void> {
  if (!adminId) return
  await env.DB.prepare(
    'INSERT INTO admin_audit_logs (admin_id, action, target_type, target_id, detail) VALUES (?, ?, ?, ?, ?)'
  )
    .bind(adminId, action, targetType, targetId, detail)
    .run()
    .catch(() => {})
}

/**
 * 3日間の削除猶予(有効なサロンが0件になってから)を過ぎたアカウントを実際に削除する。
 */
export async function sweepPendingAccountDeletions(env: Bindings): Promise<void> {
  const { results: dueAccounts } = await env.DB.prepare(
    `SELECT id, email, deletion_requested_by_admin_id FROM users
     WHERE deletion_requested_at IS NOT NULL AND deletion_requested_at <= NOW() - INTERVAL '${GRACE_PERIOD_DAYS} days'`
  ).all<{
    id: number
    email: string
    deletion_requested_by_admin_id: number | null
  }>()

  for (const account of dueAccounts || []) {
    try {
      const keys = await collectImageKeysForUser(env, account.id)
      await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(account.id).run()
      await deleteImageKeys(env, keys)
      await logExecution(
        env,
        account.deletion_requested_by_admin_id,
        'execute_account_deletion',
        'user',
        account.id,
        `email=${account.email}`
      )
      console.log(`[account-deletion] アカウント削除実行 user_id=${account.id} email=${account.email}`)
    } catch (err) {
      console.error(`[account-deletion] アカウント削除猶予チェックに失敗しました(id=${account.id}):`, err)
    }
  }
}
