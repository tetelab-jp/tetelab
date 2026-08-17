# SalonAtelier: 常時稼働Webサービス(app)+ ジョブ単位でecs:RunTaskを都度呼ぶ
# 使い捨てワーカー(worker)。SalonMotion本体(ecs.tf/ecs-app.tf)と同じ設計を
# 踏襲し、同じ既存ECSクラスター(aws_ecs_cluster.worker)に相乗りする
# (Fargateは各タスクに専用vCPU/メモリが独立割当されるため、相乗りしても
# リソース競合は起きない)。

resource "aws_security_group" "atelier_task" {
  name        = "${var.atelier_project_name}-task"
  description = "SalonAtelier app/worker task SG"
  vpc_id      = data.aws_vpc.default.id

  ingress {
    description     = "Allow from ALB only (app service health check + traffic)"
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

resource "aws_cloudwatch_log_group" "atelier_app" {
  name              = "/ecs/${var.atelier_project_name}-app"
  retention_in_days = 30
}

resource "aws_cloudwatch_log_group" "atelier_worker" {
  name              = "/ecs/${var.atelier_project_name}-worker"
  retention_in_days = 30
}

# ---------- タスク実行ロール(ECRからのpull・CloudWatch Logsへの書き込み・Secrets取得) ----------
# SalonMotion本体のtask_executionロールとは分離する(atelierの秘匿情報のみに
# スコープするため)。

resource "aws_iam_role" "atelier_task_execution" {
  name               = "${var.atelier_project_name}-task-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_task_assume.json
}

resource "aws_iam_role_policy_attachment" "atelier_task_execution_managed" {
  role       = aws_iam_role.atelier_task_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "atelier_task_execution_secrets" {
  statement {
    actions = ["secretsmanager:GetSecretValue"]
    resources = [
      aws_secretsmanager_secret.atelier_database_url.arn,
      aws_secretsmanager_secret.atelier_jwt_secret.arn,
      aws_secretsmanager_secret.atelier_openai_api_key.arn
    ]
  }
}

resource "aws_iam_role_policy" "atelier_task_execution_secrets" {
  name   = "${var.atelier_project_name}-task-execution-secrets"
  role   = aws_iam_role.atelier_task_execution.name
  policy = data.aws_iam_policy_document.atelier_task_execution_secrets.json
}

# ---------- appタスクロール(コンテナ自身の実行時権限) ----------

resource "aws_iam_role" "atelier_app_task" {
  name               = "${var.atelier_project_name}-app-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_task_assume.json
}

data "aws_iam_policy_document" "atelier_app_task" {
  statement {
    sid       = "AtelierImagesBucket"
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
    resources = ["${aws_s3_bucket.atelier_images.arn}/*"]
  }
  statement {
    sid     = "RunAtelierWorkerTask"
    actions = ["ecs:RunTask"]
    # infra/ecs-app.tf(SalonMotion本体)と同じ理由で:*を付与
    # (リビジョン番号なしのARNは実際のRunTask呼び出しと一致せずAccessDeniedになる)。
    resources = ["${aws_ecs_task_definition.atelier_worker.arn_without_revision}:*"]
    condition {
      test     = "ArnEquals"
      variable = "ecs:cluster"
      values   = [aws_ecs_cluster.worker.arn]
    }
  }
  statement {
    sid       = "PassAtelierWorkerRoles"
    actions   = ["iam:PassRole"]
    resources = [aws_iam_role.atelier_task_execution.arn, aws_iam_role.atelier_worker_task.arn]
  }
}

resource "aws_iam_role_policy" "atelier_app_task" {
  name   = "${var.atelier_project_name}-app-task"
  role   = aws_iam_role.atelier_app_task.name
  policy = data.aws_iam_policy_document.atelier_app_task.json
}

# ---------- workerタスクロール ----------

resource "aws_iam_role" "atelier_worker_task" {
  name               = "${var.atelier_project_name}-worker-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_task_assume.json
}

data "aws_iam_policy_document" "atelier_worker_task" {
  statement {
    sid       = "AtelierImagesBucket"
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
    resources = ["${aws_s3_bucket.atelier_images.arn}/*"]
  }
}

resource "aws_iam_role_policy" "atelier_worker_task" {
  name   = "${var.atelier_project_name}-worker-task"
  role   = aws_iam_role.atelier_worker_task.name
  policy = data.aws_iam_policy_document.atelier_worker_task.json
}

# アプリ自身の公開URL(ワーカーへのコールバック先)。ドメイン未指定時は
# 外部到達できないため空文字にしておき、アプリ側の起動を妨げないようにする
# (ドメイン確定後、2回目のapplyで実際のURLに切り替わる)。
locals {
  atelier_app_public_url = local.atelier_has_domain ? "https://${var.atelier_domain_name}" : ""
}

resource "aws_ecs_task_definition" "atelier_app" {
  family                   = "${var.atelier_project_name}-app"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.atelier_app_task_cpu
  memory                   = var.atelier_app_task_memory
  execution_role_arn       = aws_iam_role.atelier_task_execution.arn
  task_role_arn            = aws_iam_role.atelier_app_task.arn

  container_definitions = jsonencode([
    {
      name  = "app"
      image = var.atelier_app_initial_image
      portMappings = [
        { containerPort = 3000, protocol = "tcp" }
      ]
      environment = [
        { name = "AWS_REGION", value = var.aws_region },
        { name = "ATELIER_IMAGES_BUCKET", value = aws_s3_bucket.atelier_images.bucket },
        { name = "APP_BASE_URL", value = local.atelier_app_public_url },
        { name = "ECS_CLUSTER", value = aws_ecs_cluster.worker.name },
        { name = "ECS_TASK_DEFINITION", value = aws_ecs_task_definition.atelier_worker.family },
        { name = "ECS_CONTAINER_NAME", value = "worker" },
        { name = "ECS_SUBNET_IDS", value = join(",", data.aws_subnets.default_public.ids) },
        { name = "ECS_SECURITY_GROUP_IDS", value = aws_security_group.atelier_task.id }
      ]
      secrets = [
        { name = "DATABASE_URL", valueFrom = aws_secretsmanager_secret.atelier_database_url.arn },
        { name = "JWT_SECRET", valueFrom = aws_secretsmanager_secret.atelier_jwt_secret.arn },
        { name = "OPENAI_API_KEY", valueFrom = aws_secretsmanager_secret.atelier_openai_api_key.arn }
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.atelier_app.name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "app"
        }
      }
    }
  ])

  # GitHub Actions(生成アプリ側リポジトリ)が新しいリビジョンを登録し続けるため、
  # SalonMotion本体と同様Terraform側ではimageの差分を無視する。
  lifecycle {
    ignore_changes = [container_definitions]
  }
}

resource "aws_ecs_task_definition" "atelier_worker" {
  family                   = "${var.atelier_project_name}-worker"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.atelier_worker_task_cpu
  memory                   = var.atelier_worker_task_memory
  execution_role_arn       = aws_iam_role.atelier_task_execution.arn
  task_role_arn            = aws_iam_role.atelier_worker_task.arn

  # containerOverrides(ジョブごとのパラメータ)はRunTask呼び出し時に都度
  # 上書きされるため、ここでのenvironmentは空でよい(SalonMotion本体のworkerと同じ)。
  container_definitions = jsonencode([
    {
      name  = "worker"
      image = var.atelier_worker_initial_image
      secrets = [
        { name = "DATABASE_URL", valueFrom = aws_secretsmanager_secret.atelier_database_url.arn },
        { name = "OPENAI_API_KEY", valueFrom = aws_secretsmanager_secret.atelier_openai_api_key.arn }
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.atelier_worker.name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "worker"
        }
      }
    }
  ])

  lifecycle {
    ignore_changes = [container_definitions]
  }
}

resource "aws_ecs_service" "atelier_app" {
  name            = "${var.atelier_project_name}-app"
  cluster         = aws_ecs_cluster.worker.id
  task_definition = aws_ecs_task_definition.atelier_app.arn
  desired_count   = var.atelier_app_desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = data.aws_subnets.default_public.ids
    security_groups  = [aws_security_group.atelier_task.id]
    assign_public_ip = true
  }

  # atelier_domain_name未設定の間はALBリスナールール(atelier-alb.tfの
  # aws_lb_listener_rule.atelier_app)が存在せず、ターゲットグループがどの
  # ロードバランサーにも関連付けられていない状態のため、この段階でECSサービスに
  # load_balancerブロックを渡すとAWS側が
  # "target group does not have an associated load balancer"で拒否する。
  # ドメイン確定後、2回目のapplyでリスナールールが作られてから有効化する。
  dynamic "load_balancer" {
    for_each = local.atelier_has_domain ? [1] : []
    content {
      target_group_arn = aws_lb_target_group.atelier_app.arn
      container_name   = "app"
      container_port   = 3000
    }
  }

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  lifecycle {
    ignore_changes = [task_definition]
  }
}
