# cron-trigger-worker(Cloudflare Worker)の置き換え。1分間隔で
# /api/cron/run-style-posts をBearer認証付きで呼ぶ。
#
# EventBridge API DestinationはHTTPSエンドポイントのみ受け付けるため、
# ドメイン未指定(HTTPのみ)のテスト構成では作成しない。ドメインを設定して
# 再度applyすると自動的に作成される。それまでは「手動実行する」ボタンで
# 動作確認する。
#
# ⚠️ EventBridge Scheduler(aws_scheduler_schedule)はAPI Destinationを
# 直接ターゲットにできない(ValidationException: Provided Arn is not in
# correct format)ため、API Destinationを公式にサポートしているEventBridge
# ルール(aws_cloudwatch_event_rule/aws_cloudwatch_event_target)を使う。

resource "aws_iam_role" "cron_invoke" {
  count = local.has_domain ? 1 : 0
  name  = "${var.project_name}-cron-invoke"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "events.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

# EventBridge ConnectionのAPI_KEY認証で"Authorization: Bearer <CRON_SECRET>"
# ヘッダを自動付与させる(automation.tsx側の既存のBearer認証方式と一致させる)。
resource "aws_cloudwatch_event_connection" "cron" {
  count              = local.has_domain ? 1 : 0
  name               = "${var.project_name}-cron-auth"
  authorization_type = "API_KEY"
  auth_parameters {
    api_key {
      key   = "Authorization"
      value = "Bearer ${random_id.cron_secret.hex}"
    }
  }
}

resource "aws_cloudwatch_event_api_destination" "cron" {
  count               = local.has_domain ? 1 : 0
  name                = "${var.project_name}-cron-target"
  invocation_endpoint = "${local.app_public_url}/api/cron/run-style-posts"
  http_method         = "POST"
  connection_arn      = aws_cloudwatch_event_connection.cron[0].arn
}

resource "aws_iam_role_policy" "cron_invoke" {
  count = local.has_domain ? 1 : 0
  name  = "${var.project_name}-cron-invoke"
  role  = aws_iam_role.cron_invoke[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = "events:InvokeApiDestination"
      Resource = aws_cloudwatch_event_api_destination.cron[0].arn
    }]
  })
}

resource "aws_cloudwatch_event_rule" "cron" {
  count               = local.has_domain ? 1 : 0
  name                = "${var.project_name}-run-style-posts"
  schedule_expression = "rate(1 minute)"
}

resource "aws_cloudwatch_event_target" "cron" {
  count    = local.has_domain ? 1 : 0
  rule     = aws_cloudwatch_event_rule.cron[0].name
  arn      = aws_cloudwatch_event_api_destination.cron[0].arn
  role_arn = aws_iam_role.cron_invoke[0].arn
}
