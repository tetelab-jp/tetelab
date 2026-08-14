// ============================================
// account-deletion.ts
// 管理者サイトからの「アカウント削除」「サロン削除」は即時実行ではなく、
// 3日間の猶予期間(deletion_requested_at)を置く。この猶予を過ぎた分を
// 実際に削除するスイープ処理。DB側は外部キーが全てON DELETE CASCADE
// (salonboard_salons.idを参照する17テーブル、users.idを参照する19テーブル、
// いずれもローカルPostgresで実制約を確認済み)のため、salonboard_salons/users
// の行を1回DELETEするだけでDB側の関連データは自動的に消える。
// S3(スタイル画像・ブログ画像)だけはDBのカスケードで消えないため、
// 削除前にDBから対象キーを列挙し、行を消した後にベストエフォートで削除する。
// ============================================

import type { Bindings } from '../types'

export const GRACE_PERIOD_DAYS = 3

async function collectImageKeysForUser(env: Bindings, userId: number): Promise<string[]> {
  const { results } = await env.DB.prepare(
    `SELECT si.r2_key AS key FROM style_images si JOIN styles s ON s.id = si.style_id WHERE s.user_id = ?
     UNION ALL
     SELECT image_r2_key AS key FROM blog_articles WHERE user_id = ? AND image_r2_key IS NOT NULL`
  )
    .bind(userId, userId)
    .all<{ key: string }>()
  return (results || []).map((r) => r.key)
}

async function collectImageKeysForSalon(env: Bindings, salonId: number): Promise<string[]> {
  const { results } = await env.DB.prepare(
    `SELECT si.r2_key AS key FROM style_images si JOIN styles s ON s.id = si.style_id WHERE s.salon_id = ?
     UNION ALL
     SELECT image_r2_key AS key FROM blog_articles WHERE salon_id = ? AND image_r2_key IS NOT NULL`
  )
    .bind(salonId, salonId)
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

async function sweepPendingSalonDeletions(env: Bindings): Promise<void> {
  const { results: dueSalons } = await env.DB.prepare(
    `SELECT id, user_id, salon_key, deletion_requested_by_admin_id FROM salonboard_salons
     WHERE deletion_requested_at IS NOT NULL AND deletion_requested_at <= NOW() - INTERVAL '${GRACE_PERIOD_DAYS} days'`
  ).all<{
    id: number
    user_id: number
    salon_key: string | null
    deletion_requested_by_admin_id: number | null
  }>()

  for (const salon of dueSalons || []) {
    try {
      const keys = await collectImageKeysForSalon(env, salon.id)
      await env.DB.prepare('DELETE FROM salonboard_salons WHERE id = ?').bind(salon.id).run()
      // 削除したサロンがactive_salon_idだった場合(ON DELETE SET NULLで既にNULL化
      // されている)、同ユーザーの他の有効サロンへ re-point して継続利用できるようにする。
      await env.DB.prepare(
        `UPDATE users SET active_salon_id = (
           SELECT id FROM salonboard_salons WHERE user_id = ? AND is_active_workspace = 1 ORDER BY id LIMIT 1
         )
         WHERE id = ? AND active_salon_id IS NULL`
      )
        .bind(salon.user_id, salon.user_id)
        .run()
      await deleteImageKeys(env, keys)
      await logExecution(
        env,
        salon.deletion_requested_by_admin_id,
        'execute_salon_deletion',
        'salonboard_salon',
        salon.id,
        `user_id=${salon.user_id} salon_key=${salon.salon_key || '-'}`
      )
      console.log(`[account-deletion] サロン削除実行 salon_id=${salon.id} user_id=${salon.user_id}`)
    } catch (err) {
      console.error(`[account-deletion] サロン単位の削除猶予チェックに失敗しました(id=${salon.id}):`, err)
    }
  }
}

async function sweepPendingAccountDeletions(env: Bindings): Promise<void> {
  const { results: dueUsers } = await env.DB.prepare(
    `SELECT id, email, deletion_requested_by_admin_id FROM users
     WHERE deletion_requested_at IS NOT NULL AND deletion_requested_at <= NOW() - INTERVAL '${GRACE_PERIOD_DAYS} days'`
  ).all<{ id: number; email: string; deletion_requested_by_admin_id: number | null }>()

  for (const user of dueUsers || []) {
    try {
      const keys = await collectImageKeysForUser(env, user.id)
      await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(user.id).run()
      await deleteImageKeys(env, keys)
      await logExecution(env, user.deletion_requested_by_admin_id, 'execute_account_deletion', 'user', user.id, user.email)
      console.log(`[account-deletion] アカウント削除実行 user_id=${user.id} email=${user.email}`)
    } catch (err) {
      console.error(`[account-deletion] アカウント単位の削除猶予チェックに失敗しました(id=${user.id}):`, err)
    }
  }
}

/**
 * 3日間の削除猶予を過ぎたサロン/アカウントを実際に削除する。
 * サロン単位を先に処理する(アカウント削除で既にカスケード済みの
 * salonboard_salons行はここでは見つからず、二重処理にはならない)。
 */
export async function sweepPendingDeletions(env: Bindings): Promise<void> {
  await sweepPendingSalonDeletions(env)
  await sweepPendingAccountDeletions(env)
}
