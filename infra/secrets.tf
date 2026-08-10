resource "random_id" "jwt_secret" {
  byte_length = 32
}

resource "random_id" "cron_secret" {
  byte_length = 24
}

# encryption_key変数が空(まだ本番データが無いテスト環境)の場合のみ
# 新しい鍵を生成する。crypto.ts(AES-GCM, 32byte鍵をbase64で保持)と
# 同じ形式に合わせている。
resource "random_bytes" "encryption_key" {
  length = 32
}

locals {
  encryption_key = var.encryption_key != "" ? var.encryption_key : random_bytes.encryption_key.base64
}

resource "aws_secretsmanager_secret" "database_url" {
  name = "${var.project_name}/database-url"
}
resource "aws_secretsmanager_secret_version" "database_url" {
  secret_id     = aws_secretsmanager_secret.database_url.id
  secret_string = "postgres://${var.db_username}:${random_password.db.result}@${aws_db_instance.main.address}:5432/${var.db_name}"
}

resource "aws_secretsmanager_secret" "jwt_secret" {
  name = "${var.project_name}/jwt-secret"
}
resource "aws_secretsmanager_secret_version" "jwt_secret" {
  secret_id     = aws_secretsmanager_secret.jwt_secret.id
  secret_string = random_id.jwt_secret.hex
}

# 既存Cloudflare側で使っていたENCRYPTION_KEYと同じ値を引き継ぐ必要がある
# (異なる鍵にすると既存の暗号化済みsalon_credentialsが復号できなくなるため、
# ここでは新規生成せず変数で受け取る)。
resource "aws_secretsmanager_secret" "encryption_key" {
  name = "${var.project_name}/encryption-key"
}
resource "aws_secretsmanager_secret_version" "encryption_key" {
  secret_id     = aws_secretsmanager_secret.encryption_key.id
  secret_string = local.encryption_key
}

resource "aws_secretsmanager_secret" "cron_secret" {
  name = "${var.project_name}/cron-secret"
}
resource "aws_secretsmanager_secret_version" "cron_secret" {
  secret_id     = aws_secretsmanager_secret.cron_secret.id
  secret_string = random_id.cron_secret.hex
}

# aws-ecs.ts(アプリ本体)がECS RunTaskをSigV4署名で呼ぶための静的アクセスキー。
# 発行元のIAMユーザーは iam.tf の aws_iam_user.cloudflare_caller。
resource "aws_secretsmanager_secret" "aws_access_key_id" {
  name = "${var.project_name}/aws-access-key-id"
}
resource "aws_secretsmanager_secret_version" "aws_access_key_id" {
  secret_id     = aws_secretsmanager_secret.aws_access_key_id.id
  secret_string = aws_iam_access_key.cloudflare_caller.id
}

resource "aws_secretsmanager_secret" "aws_secret_access_key" {
  name = "${var.project_name}/aws-secret-access-key"
}
resource "aws_secretsmanager_secret_version" "aws_secret_access_key" {
  secret_id     = aws_secretsmanager_secret.aws_secret_access_key.id
  secret_string = aws_iam_access_key.cloudflare_caller.secret
}

# ECSタスク実行ロール(task_execution)は、コンテナ起動時にこれらのSecretsを
# 読み取ってenvironmentへ注入する必要があるため、AmazonECSTaskExecutionRolePolicy
# (デフォルトではSecrets Manager権限を含まない)に加えて明示的に許可する。
data "aws_iam_policy_document" "task_execution_secrets" {
  statement {
    actions = ["secretsmanager:GetSecretValue"]
    resources = [
      aws_secretsmanager_secret.database_url.arn,
      aws_secretsmanager_secret.jwt_secret.arn,
      aws_secretsmanager_secret.encryption_key.arn,
      aws_secretsmanager_secret.cron_secret.arn,
      aws_secretsmanager_secret.aws_access_key_id.arn,
      aws_secretsmanager_secret.aws_secret_access_key.arn
    ]
  }
}

resource "aws_iam_role_policy" "task_execution_secrets" {
  name   = "${var.project_name}-task-execution-secrets"
  role   = aws_iam_role.task_execution.name
  policy = data.aws_iam_policy_document.task_execution_secrets.json
}
