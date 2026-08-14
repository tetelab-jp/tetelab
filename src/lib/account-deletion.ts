// ============================================
// account-deletion.ts
// 管理者サイトからの「サロン削除」は即時実行ではなく、3日間の猶予期間
// (deletion_requested_at)を置く。この猶予を過ぎた分を実際に削除する
// スイープ処理。DB側は外部キーが全てON DELETE CASCADE(salonboard_salons.id
// を参照する17テーブル、ローカルPostgresで実制約を確認済み)のため、
// salonboard_salonsの行を1回DELETEするだけでDB側の関連データは自動的に消える。
// S3(スタイル画像・ブログ画像)だけはDBのカスケードで消えないため、
// 削除前にDBから対象キーを列挙し、行を消した後にベストエフォートで削除する。
//
// 2026-08-14追記(ユーザー指定): 削除操作はサロン単位に一本化し、
// アカウント単位の削除は廃止した(/admin/salonsの「アカウントを削除する」
// ボタンを撤去)。
// ============================================

import type { Bindings } from '../types'

export const GRACE_PERIOD_DAYS = 3

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

/**
 * 3日間の削除猶予を過ぎたサロンを実際に削除する。
 */
export async function sweepPendingDeletions(env: Bindings): Promise<void> {
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
