# ---------- ECSタスク実行ロール(ECRからのpull・CloudWatch Logsへの書き込みのみ) ----------

data "aws_iam_policy_document" "ecs_task_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "task_execution" {
  name               = "${var.project_name}-task-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_task_assume.json
}

resource "aws_iam_role_policy_attachment" "task_execution_managed" {
  role       = aws_iam_role.task_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# ---------- タスクロール(コンテナ自身の実行時権限) ----------
# ワーカーはsalonboard.comとCloudflare Pagesへのアウトバウンド通信のみで、
# 他のAWS APIを一切呼ばないため、権限は付与しない(空ロール)。

resource "aws_iam_role" "task" {
  name               = "${var.project_name}-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_task_assume.json
}

# ---------- Cloudflare(Workers)からECS RunTaskを呼ぶためのIAMユーザー ----------
# aws4fetchでのSigV4署名にアクセスキーを使うため、ロールではなくユーザーにする。
# 権限はこのタスク定義ファミリーへのRunTaskと、2つのロールへのPassRoleのみに絞る。

resource "aws_iam_user" "cloudflare_caller" {
  name = var.cloudflare_iam_user_name
}

data "aws_iam_policy_document" "cloudflare_caller" {
  statement {
    sid       = "RunStylePostTask"
    actions   = ["ecs:RunTask"]
    resources = [aws_ecs_task_definition.worker.arn_without_revision]
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
}

resource "aws_iam_user_policy" "cloudflare_caller" {
  name   = "${var.project_name}-run-task"
  user   = aws_iam_user.cloudflare_caller.name
  policy = data.aws_iam_policy_document.cloudflare_caller.json
}

resource "aws_iam_access_key" "cloudflare_caller" {
  user = aws_iam_user.cloudflare_caller.name
}

# ---------- GitHub Actions用OIDC(ECRへのpush・タスク定義登録のみ) ----------
# アカウントに既にtoken.actions.githubusercontent.comのOIDCプロバイダが
# 存在する場合(他のリポジトリで作成済み等)は、このresourceではなく
# `terraform import` で既存プロバイダを取り込むこと(1アカウントにつき
# 同一URLのプロバイダは1つしか作成できない)。

resource "aws_iam_openid_connect_provider" "github" {
  url             = "https://token.actions.githubusercontent.com"
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = ["6938fd4d98bab03faadb97b34396831e3780aea1"]
}

data "aws_iam_policy_document" "github_actions_assume" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github.arn]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }
    condition {
      test     = "StringLike"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:${var.github_repository}:*"]
    }
  }
}

resource "aws_iam_role" "github_actions_deploy" {
  name               = "${var.project_name}-github-deploy"
  assume_role_policy = data.aws_iam_policy_document.github_actions_assume.json
}

data "aws_iam_policy_document" "github_actions_deploy" {
  statement {
    sid       = "EcrAuth"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }
  statement {
    sid = "EcrPush"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:GetDownloadUrlForLayer",
      "ecr:BatchGetImage",
      "ecr:PutImage",
      "ecr:InitiateLayerUpload",
      "ecr:UploadLayerPart",
      "ecr:CompleteLayerUpload"
    ]
    resources = [aws_ecr_repository.worker.arn, aws_ecr_repository.app.arn]
  }
  statement {
    sid       = "EcsTaskDef"
    actions   = ["ecs:DescribeTaskDefinition", "ecs:RegisterTaskDefinition"]
    resources = ["*"] # RegisterTaskDefinitionはリソースレベル制御に対応していないため
  }
  statement {
    sid       = "EcsServiceDeploy"
    actions   = ["ecs:UpdateService", "ecs:DescribeServices"]
    resources = [aws_ecs_service.app.id]
  }
  statement {
    sid       = "PassWorkerRolesForRegister"
    actions   = ["iam:PassRole"]
    resources = [aws_iam_role.task_execution.arn, aws_iam_role.task.arn, aws_iam_role.app_task.arn]
  }
}

resource "aws_iam_role_policy" "github_actions_deploy" {
  name   = "${var.project_name}-deploy"
  role   = aws_iam_role.github_actions_deploy.name
  policy = data.aws_iam_policy_document.github_actions_deploy.json
}
