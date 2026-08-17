# SalonAtelier用IAM。
# - GitHub Actions(tetelab-jp/salon-atelierリポジトリ)からのデプロイ用OIDCロール
#   (SalonMotion本体のgithub_actions_deployロールとは分離し、atelierのECR/ECSのみ
#   操作可能にする)。OIDCプロバイダ自体はAWSアカウントに1つしか作成できないため、
#   iam.tfで作成済みのaws_iam_openid_connect_provider.githubを再利用する。
# - 調査・デバッグ用の読み取り専用IAMユーザー(既存log_readerと同じパターン)。

data "aws_iam_policy_document" "atelier_github_actions_assume" {
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
      values = [
        "repo:${var.atelier_github_repository}:*",
        "repo:${split("/", var.atelier_github_repository)[0]}@*/${split("/", var.atelier_github_repository)[1]}@*:*"
      ]
    }
  }
}

resource "aws_iam_role" "atelier_github_actions_deploy" {
  name               = "${var.atelier_project_name}-github-deploy"
  assume_role_policy = data.aws_iam_policy_document.atelier_github_actions_assume.json
}

data "aws_iam_policy_document" "atelier_github_actions_deploy" {
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
    resources = [aws_ecr_repository.atelier_app.arn, aws_ecr_repository.atelier_worker.arn]
  }
  statement {
    sid       = "EcsTaskDef"
    actions   = ["ecs:DescribeTaskDefinition", "ecs:RegisterTaskDefinition"]
    resources = ["*"] # RegisterTaskDefinitionはリソースレベル制御に対応していないため
  }
  statement {
    sid       = "EcsServiceDeploy"
    actions   = ["ecs:UpdateService", "ecs:DescribeServices"]
    resources = [aws_ecs_service.atelier_app.id]
  }
  statement {
    sid       = "PassAtelierRolesForRegister"
    actions   = ["iam:PassRole"]
    resources = [aws_iam_role.atelier_task_execution.arn, aws_iam_role.atelier_app_task.arn, aws_iam_role.atelier_worker_task.arn]
  }
}

resource "aws_iam_role_policy" "atelier_github_actions_deploy" {
  name   = "${var.atelier_project_name}-deploy"
  role   = aws_iam_role.atelier_github_actions_deploy.name
  policy = data.aws_iam_policy_document.atelier_github_actions_deploy.json
}

# ---------- CloudWatch Logs閲覧専用ユーザー(調査・デバッグ用) ----------

resource "aws_iam_user" "atelier_log_reader" {
  name = "${var.atelier_project_name}-log-reader"
}

data "aws_iam_policy_document" "atelier_log_reader" {
  statement {
    sid       = "ListLogGroups"
    actions   = ["logs:DescribeLogGroups"]
    resources = ["*"]
  }
  statement {
    sid = "ReadAtelierLogs"
    actions = [
      "logs:DescribeLogStreams",
      "logs:GetLogEvents",
      "logs:FilterLogEvents"
    ]
    resources = [
      "${aws_cloudwatch_log_group.atelier_app.arn}:*",
      "${aws_cloudwatch_log_group.atelier_worker.arn}:*"
    ]
  }
  statement {
    sid       = "ReadAtelierEcsStatus"
    actions   = ["ecs:DescribeServices", "ecs:DescribeTasks", "ecs:ListTasks"]
    resources = ["*"]
  }
}

resource "aws_iam_user_policy" "atelier_log_reader" {
  name   = "${var.atelier_project_name}-log-reader"
  user   = aws_iam_user.atelier_log_reader.name
  policy = data.aws_iam_policy_document.atelier_log_reader.json
}

resource "aws_iam_access_key" "atelier_log_reader" {
  user = aws_iam_user.atelier_log_reader.name
}
