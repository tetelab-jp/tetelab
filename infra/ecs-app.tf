resource "aws_ecr_repository" "app" {
  name                 = "${var.project_name}-app"
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_ecr_lifecycle_policy" "app" {
  repository = aws_ecr_repository.app.name

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

resource "aws_cloudwatch_log_group" "app" {
  name              = "/ecs/${var.project_name}-app"
  retention_in_days = 30
}

resource "aws_security_group" "app_task" {
  name        = "${var.project_name}-app-task"
  description = "App task SG - allow 3000 from ALB only"
  vpc_id      = data.aws_vpc.default.id

  ingress {
    description     = "Allow from ALB only"
    from_port       = 3000
    to_port         = 3000
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_iam_role" "app_task" {
  name               = "${var.project_name}-app-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_task_assume.json
}

data "aws_iam_policy_document" "app_task" {
  statement {
    sid       = "StyleImagesBucket"
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
    resources = ["${aws_s3_bucket.style_images.arn}/*"]
  }
  statement {
    sid     = "RunStylePostTask"
    actions = ["ecs:RunTask"]
    # infra/iam.tf の cloudflare_caller ポリシーと同じ理由(リビジョン番号なしの
    # ARNは実際のRunTask呼び出しと一致せず常にAccessDeniedになる)で:*を付与。
    resources = ["${aws_ecs_task_definition.worker.arn_without_revision}:*"]
    condition {
      test     = "ArnEquals"
      variable = "ecs:cluster"
      values   = [aws_ecs_cluster.worker.arn]
    }
  }
  statement {
    sid       = "PassWorkerRoles"
    actions   = ["iam:PassRole"]
    resources = [aws_iam_role.task_execution.arn, aws_iam_role.task.arn]
  }
  # 2026-08-13追記(監査指摘の是正に伴う追加): 管理者サイト(/admin/status)の
  # 連続失敗検知アラート送信(src/lib/sns-alert.ts)が、廃止したcloudflare_caller
  # ユーザーの静的キーではなくこのタスクロールのアンビエント認証情報を使う
  # よう切り替わったため、同ロールにsns:Publish権限を追加する(これが無いと
  # アラート送信がAccessDeniedで静かに失敗し続ける)。
  statement {
    sid       = "PublishAlerts"
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.alerts.arn]
  }
  # 2026-08-15追記: パスワード再設定メール送信(src/lib/ses-email.ts)用。
  # SESの送信先はユーザーが入力したメールアドレスで動的に決まるため
  # (SNSのトピックARNのような固定リソースが無い)、resourcesは*にする。
  statement {
    sid       = "SendPasswordResetEmail"
    actions   = ["ses:SendEmail", "ses:SendRawEmail"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "app_task" {
  name   = "${var.project_name}-app-task"
  role   = aws_iam_role.app_task.name
  policy = data.aws_iam_policy_document.app_task.json
}

resource "aws_ecs_task_definition" "app" {
  family                   = "${var.project_name}-app"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.app_task_cpu
  memory                   = var.app_task_memory
  execution_role_arn       = aws_iam_role.task_execution.arn
  task_role_arn            = aws_iam_role.app_task.arn

  container_definitions = jsonencode([
    {
      name  = "app"
      image = var.app_initial_image
      portMappings = [
        { containerPort = 3000, protocol = "tcp" }
      ]
      environment = [
        { name = "AWS_REGION", value = var.aws_region },
        { name = "STYLE_IMAGES_BUCKET", value = aws_s3_bucket.style_images.bucket },
        { name = "APP_BASE_URL", value = local.app_public_url },
        { name = "ECS_CLUSTER", value = aws_ecs_cluster.worker.name },
        { name = "ECS_TASK_DEFINITION", value = aws_ecs_task_definition.worker.family },
        { name = "ECS_CONTAINER_NAME", value = "worker" },
        { name = "ECS_SUBNET_IDS", value = join(",", data.aws_subnets.default_public.ids) },
        { name = "ECS_SECURITY_GROUP_IDS", value = aws_security_group.worker_task.id },
        { name = "SNS_ALERT_TOPIC_ARN", value = aws_sns_topic.alerts.arn },
        { name = "SES_FROM_EMAIL", value = local.has_domain ? "noreply@${var.route53_zone_name}" : "" }
      ]
      secrets = [
        { name = "DATABASE_URL", valueFrom = aws_secretsmanager_secret.database_url.arn },
        { name = "JWT_SECRET", valueFrom = aws_secretsmanager_secret.jwt_secret.arn },
        { name = "ENCRYPTION_KEY", valueFrom = aws_secretsmanager_secret.encryption_key.arn },
        { name = "CRON_SECRET", valueFrom = aws_secretsmanager_secret.cron_secret.arn },
        { name = "ADMIN_JWT_SECRET", valueFrom = aws_secretsmanager_secret.admin_jwt_secret.arn },
        { name = "ADMIN_INITIAL_PASSWORD", valueFrom = aws_secretsmanager_secret.admin_initial_password.arn }
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.app.name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "app"
        }
      }
    }
  ])

  # GitHub Actionsが新しいリビジョンを登録し続けるため、worker用タスク定義と
  # 同様にTerraform側ではimageの差分を無視する。
  lifecycle {
    ignore_changes = [container_definitions]
  }
}

resource "aws_ecs_service" "app" {
  name            = "${var.project_name}-app"
  cluster         = aws_ecs_cluster.worker.id
  task_definition = aws_ecs_task_definition.app.arn
  desired_count   = var.app_desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = data.aws_subnets.default_public.ids
    security_groups  = [aws_security_group.app_task.id]
    assign_public_ip = true
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.app.arn
    container_name   = "app"
    container_port   = 3000
  }

  # 2026-08-13追記(監査指摘の是正): デプロイサーキットブレーカーが未設定
  # だったため、壊れたイメージをデプロイしても自動ロールバックされず、
  # ヘルスチェックに失敗し続けるタスク定義がACTIVEのまま残って手動介入が
  # 必須になっていた。ロールアウトが安定しない場合は自動的に直前の
  # 正常なタスク定義へロールバックする。
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  depends_on = [aws_lb_listener.https]

  lifecycle {
    ignore_changes = [task_definition]
  }
}
