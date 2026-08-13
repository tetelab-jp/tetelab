-- スタイル画像を保存前に規定サイズ・容量へ正規化(圧縮)する機能の導入に伴い、
-- 既に圧縮済みかどうかを記録する列を追加する。NULLの行(圧縮機能導入前に
-- アップロードされた既存画像)は、アプリ起動時にbackfillCompressStyleImages()
-- が一度だけ再圧縮し、このタイムスタンプを埋める。

ALTER TABLE style_images ADD COLUMN IF NOT EXISTS compressed_at TIMESTAMP;
