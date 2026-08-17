# SalonAtelier専用のS3バケット(生成画像用)。
# 運用方針(style_app_brief.md §8-1): 入稿画像は生成後に削除、生成結果は保持。
# アプリ側の実装がキーを"input/..."(入稿画像)と"results/..."(生成結果)の
# プレフィックスで分けることを前提に、input/のみ有効期限ルールを設定する。

resource "aws_s3_bucket" "atelier_images" {
  bucket = "${var.atelier_project_name}-images"
}

resource "aws_s3_bucket_public_access_block" "atelier_images" {
  bucket                  = aws_s3_bucket.atelier_images.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "atelier_images" {
  bucket = aws_s3_bucket.atelier_images.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "atelier_images" {
  bucket = aws_s3_bucket.atelier_images.id

  rule {
    id     = "expire-input-images"
    status = "Enabled"
    filter {
      prefix = "input/"
    }
    expiration {
      days = 1
    }
    noncurrent_version_expiration {
      noncurrent_days = 1
    }
  }
}
