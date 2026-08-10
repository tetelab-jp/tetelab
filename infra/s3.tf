resource "aws_s3_bucket" "style_images" {
  bucket = "${var.project_name}-style-images"
}

resource "aws_s3_bucket_public_access_block" "style_images" {
  bucket                  = aws_s3_bucket.style_images.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "style_images" {
  bucket = aws_s3_bucket.style_images.id
  versioning_configuration {
    status = "Enabled"
  }
}
