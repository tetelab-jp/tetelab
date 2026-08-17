# SalonAtelier用ECRリポジトリ(app: 常時稼働Webサービス、worker: RunTaskで
# 都度起動する生成ジョブ実行コンテナ)。SalonMotion本体(ecs-app.tf/ecs.tf)と
# 同じ構成。

resource "aws_ecr_repository" "atelier_app" {
  name                 = "${var.atelier_project_name}-app"
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_ecr_lifecycle_policy" "atelier_app" {
  repository = aws_ecr_repository.atelier_app.name

  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "直近20イメージのみ保持"
        selection = {
          tagStatus   = "any"
          countType   = "imageCountMoreThan"
          countNumber = 20
        }
        action = { type = "expire" }
      }
    ]
  })
}

resource "aws_ecr_repository" "atelier_worker" {
  name                 = "${var.atelier_project_name}-worker"
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_ecr_lifecycle_policy" "atelier_worker" {
  repository = aws_ecr_repository.atelier_worker.name

  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "直近20イメージのみ保持"
        selection = {
          tagStatus   = "any"
          countType   = "imageCountMoreThan"
          countNumber = 20
        }
        action = { type = "expire" }
      }
    ]
  })
}
