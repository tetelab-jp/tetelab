-- ============================================
-- 0003_style_post_template.sql
-- Phase 3: 自動投稿に必要な「投稿テンプレート」設定
--
-- 背景: サロンボードのスタイル投稿フォームは、スタイリスト・カテゴリ・
-- ヘアレングス・メニュー詳細・コメントが必須項目だが、Phase 2の
-- 画像ライブラリではタイトル程度しか収集していなかった。
-- 運用は「事前登録した画像プールから毎日N枚を自動投稿」という設計のため、
-- 画像1枚ごとに毎回これらを個別入力させるのは非現実的。
-- そのため「共通テンプレート」を1つ設定し、全画像に適用する方式とする。
-- （将来的に画像ごとの上書きが必要になった場合は style_images に
--   個別カラムを追加して拡張する）
-- ============================================

CREATE TABLE IF NOT EXISTS style_post_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL UNIQUE,

  -- #stylistCheckCd の <option value>（サロンボード側の実際の値。要ユーザー確認）
  stylist_select_value TEXT,
  -- frmStyleEditStylistCommentDto.stylistComment（最大240文字）
  stylist_comment TEXT,
  -- 'SG01'（レディース）| 'SG02'（メンズ）
  category_cd TEXT NOT NULL DEFAULT 'SG01',
  -- .ladiesHairLengthCd または .mensHairLengthCd の <option value>（要ユーザー確認）
  hair_length_value TEXT,
  -- MC01〜MC04のJSON配列（任意）
  menu_contents_cd_list TEXT DEFAULT '[]',
  -- .menuContents textarea（最大100文字）
  menu_detail_text TEXT,

  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
