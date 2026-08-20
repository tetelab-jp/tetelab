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

# ---------- (廃止) Cloudflare(Workers)からECS RunTaskを呼ぶためのIAMユーザー ----------
# 2026-08-13追記(監査指摘の是正): 元はCloudflare Workers時代の名残で、
# アプリ本体がECS RunTask/SNS Publishを呼ぶために長期の静的アクセスキーを
# 発行していた。アプリ自身が既にECSタスクロール(app_task、ecs-app.tf)として
# 動いており、同等の権限(ecs:RunTask/iam:PassRole/sns:Publish)を持つため、
# 静的キーは不要と判断し撤去した(アプリ側のコードも
# fromHttp()でタスクロールのアンビエント認証情報を使うよう既に変更済み)。
# 万一過去にこのユーザーのアクセスキーが漏洩していた場合に備え、
# `aws iam list-access-keys --user-name salonboard-worker-app-caller` で
# 残存キーが無いことを確認すること。

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
  # deploy-app.ymlの「Add admin secrets if missing」「Add OpenAI API key secret if missing」
  # ステップが各シークレットの存在確認(describe-secret)に使う。これが無いと常に
  # AccessDenied→未作成扱いとなり、対象の値がタスク定義に注入されないまま気づかず
  # スキップされ続ける(admin用シークレットで実機確認済みの不具合。OPENAI_API_KEY追加時に
  # このリストへの追加を忘れて同じ不具合を再発させたため、新しいシークレットを
  # describe-secretで存在確認する場合は必ずここにも追加すること)。
  statement {
    sid     = "DescribeAdminSecrets"
    actions = ["secretsmanager:DescribeSecret"]
    resources = [
      aws_secretsmanager_secret.admin_jwt_secret.arn,
      aws_secretsmanager_secret.admin_initial_password.arn,
      aws_secretsmanager_secret.openai_api_key.arn
    ]
  }
}

resource "aws_iam_role_policy" "github_actions_deploy" {
  name   = "${var.project_name}-deploy"
  role   = aws_iam_role.github_actions_deploy.name
  policy = data.aws_iam_policy_document.github_actions_deploy.json
}

# ---------- 読み取り専用調査ユーザー(調査・デバッグ用) ----------
# app/workerのログを読む用途に加え、2026-08-19追記: 「100サロン規模に増えても
# Fargateタスクの同時実行が問題ないか」等の容量調査のため、ECS/EC2/Service Quotasの
# Describe/List系(すべて読み取り専用)を追加した。書き込み・変更系のAPIは一切
# 付与しない。デバッグ目的の認証情報のため、不要になったらaws_iam_access_key.log_readerを
# ローテーション(terraform taint等)するか、このリソース自体を削除すること。

resource "aws_iam_user" "log_reader" {
  name = "${var.project_name}-log-reader"
}

data "aws_iam_policy_document" "log_reader" {
  statement {
    # logs:DescribeLogGroupsはアカウント内一覧取得APIのため、特定のロググループ単位では
    # 権限を絞れず、Resource="*"が必須(実機で確認済み: 特定ARNを指定するとAccessDenied)。
    sid       = "ListLogGroups"
    actions   = ["logs:DescribeLogGroups"]
    resources = ["*"]
  }
  statement {
    sid = "ReadAppAndWorkerLogs"
    actions = [
      "logs:DescribeLogStreams",
      "logs:GetLogEvents",
      "logs:FilterLogEvents"
    ]
    resources = [
      "${aws_cloudwatch_log_group.app.arn}:*",
      "${aws_cloudwatch_log_group.worker.arn}:*"
    ]
  }
  statement {
    # ECSのDescribe/List系APIはリソースレベル制御に対応していないものが多いため
    # Resource="*"が必須。稼働中タスク数・タスク定義の内容(vCPU/メモリ)の確認用。
    sid = "DescribeEcsForCapacityCheck"
    actions = [
      "ecs:DescribeClusters",
      "ecs:DescribeServices",
      "ecs:DescribeTasks",
      "ecs:ListTasks",
      "ecs:DescribeTaskDefinition"
    ]
    resources = ["*"]
  }
  statement {
    # サブネットの空きIP数(ENI容量)確認用。EC2のDescribe系もResource="*"が必須。
    sid       = "DescribeNetworkForCapacityCheck"
    actions   = ["ec2:DescribeSubnets", "ec2:DescribeNetworkInterfaces"]
    resources = ["*"]
  }
  statement {
    # Fargateの同時実行vCPU数等、アカウントのService Quotas確認用。
    sid       = "ReadServiceQuotas"
    actions   = ["servicequotas:GetServiceQuota", "servicequotas:ListServiceQuotas"]
    resources = ["*"]
  }
  # 2026-08-20追記(ユーザー指定): SES本番アクセス(サンドボックス解除)申請が
  # 却下されたため、審査に必要な設定(ドメイン検証・DKIM・MAIL FROM・
  # バウンス/苦情通知)が揃っているかを実機で確認する用途。すべて読み取り専用。
  statement {
    sid = "ReadSesForProductionAccessAudit"
    actions = [
      "ses:GetAccount",
      "ses:GetAccountSendingEnabled",
      "ses:GetSendQuota",
      "ses:GetSendStatistics",
      "ses:ListIdentities",
      "ses:GetIdentityVerificationAttributes",
      "ses:GetIdentityDkimAttributes",
      "ses:GetIdentityMailFromDomainAttributes",
      "ses:GetIdentityNotificationAttributes",
      "sesv2:GetAccount",
      "sesv2:GetDedicatedIpPool",
      "sesv2:ListEmailIdentities",
      "sesv2:GetEmailIdentity"
    ]
    resources = ["*"]
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
