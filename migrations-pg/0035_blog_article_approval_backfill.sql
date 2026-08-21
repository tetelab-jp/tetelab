-- 登録ブログ一覧(GET /blog/articles)にstatus='approved'のみを表示するように変更。
-- blog_articles.status/approved_at列は元々このための設計だったが、これまで
-- 一覧クエリ側で一切使われておらず、AI生成/新規作成の時点(status='unapproved')で
-- 即座に一覧へ表示されてしまっていた(「投稿一覧に追加」を押す前でも一覧に出る不具合)。
-- 既存記事(現状すべてstatus='unapproved')は一括で承認済みへ移行する。
-- 実際のUPDATEはsrc/index.tsxの起動時マイグレーションで
-- schema_migration_flags('blog_article_approval_backfill_v1')により一度だけ実行される。
-- このファイルは記録用。

UPDATE blog_articles SET status = 'approved', approved_at = COALESCE(approved_at, created_at)
WHERE status != 'approved';
