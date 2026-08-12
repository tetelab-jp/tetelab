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
    sid     = "RunStylePostTask"
    actions = ["ecs:RunTask"]
    # 2026-08-10追記: arn_without_revisionだけ(末尾のリビジョン番号なし)を
    # Resourceに指定すると、実際のRunTask呼び出し時のリソースARN(必ず
    # task-definition/salonboard-worker:6のようにリビジョン番号付き)とは
    # 文字列として一致せず、IAMのARNマッチングはワイルドカード無指定では
    # 完全一致のみのため、常にAccessDeniedになっていた(実機で確認済みの不具合)。
    # 末尾に:*を付け、任意のリビジョンを許可するよう修正。
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
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
  # GitHubの証明書ローテーションに備え、旧・新2つのルートCA thumbprintを両方登録する
  thumbprint_list = ["6938fd4d98bab03faadb97b34396831e3780aea1", "1c58a3a8518e8759bf075b76b750d4f2df264fcd"]
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
      # GitHubがsubクレームにowner/repoのID番号を埋め込む形式(リポジトリ名変更耐性のため)に
      # 変更したため、旧来のプレーンな形式とID付き形式の両方を許可する。
      values = [
        "repo:${var.github_repository}:*",
        "repo:${split("/", var.github_repository)[0]}@*/${split("/", var.github_repository)[1]}@*:*"
      ]
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
  # deploy-app.ymlの「Add admin secrets if missing」ステップがadmin用シークレットの
  # 存在確認(describe-secret)に使う。これが無いと常にAccessDenied→未作成扱いとなり、
  # ADMIN_INITIAL_PASSWORD等がタスク定義に注入されないまま気づかずスキップされ続ける
  # (実機で確認済みの不具合)。
  statement {
    sid       = "DescribeAdminSecrets"
    actions   = ["secretsmanager:DescribeSecret"]
    resources = [aws_secretsmanager_secret.admin_jwt_secret.arn, aws_secretsmanager_secret.admin_initial_password.arn]
  }
}

resource "aws_iam_role_policy" "github_actions_deploy" {
  name   = "${var.project_name}-deploy"
  role   = aws_iam_role.github_actions_deploy.name
  policy = data.aws_iam_policy_document.github_actions_deploy.json
}

# ---------- CloudWatch Logs閲覧専用ユーザー(調査・デバッグ用) ----------
# app/workerのログを読むためだけの最小権限。他のAWSリソースへの権限は一切与えない。
# デバッグ目的の一時的な認証情報のため、不要になったらaws_iam_access_key.log_readerを
# ローテーション(terraform taint等)するか、このリソース自体を削除すること。

resource "aws_iam_user" "log_reader" {
  name = "${var.project_name}-log-reader"
}

data "aws_iam_policy_document" "log_reader" {
  statement {
    sid = "ReadAppAndWorkerLogs"
    actions = [
      "logs:DescribeLogGroups",
      "logs:DescribeLogStreams",
      "logs:GetLogEvents",
      "logs:FilterLogEvents"
    ]
    resources = [
      "${aws_cloudwatch_log_group.app.arn}:*",
      "${aws_cloudwatch_log_group.worker.arn}:*"
    ]
  }
}

resource "aws_iam_user_policy" "log_reader" {
  name   = "${var.project_name}-log-reader"
  user   = aws_iam_user.log_reader.name
  policy = data.aws_iam_policy_document.log_reader.json
}

resource "aws_iam_access_key" "log_reader" {
  user = aws_iam_user.log_reader.name
}
