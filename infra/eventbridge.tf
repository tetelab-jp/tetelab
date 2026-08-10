# cron-trigger-worker(Cloudflare Worker)の置き換え。1分間隔で
# /api/cron/run-style-posts をBearer認証付きで呼ぶ。

resource "aws_scheduler_schedule_group" "app" {
  name = "${var.project_name}-cron"
}

resource "aws_iam_role" "scheduler" {
  name = "${var.project_name}-scheduler"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "scheduler.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

# EventBridge ConnectionのAPI_KEY認証で"Authorization: Bearer <CRON_SECRET>"
# ヘッダを自動付与させる(automation.tsx側の既存のBearer認証方式と一致させる)。
resource "aws_cloudwatch_event_connection" "cron" {
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
  name                = "${var.project_name}-cron-target"
  invocation_endpoint = "${local.app_public_url}/api/cron/run-style-posts"
  http_method         = "POST"
  connection_arn      = aws_cloudwatch_event_connection.cron.arn
}

resource "aws_iam_role_policy" "scheduler_invoke" {
  name = "${var.project_name}-scheduler-invoke"
  role = aws_iam_role.scheduler.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = "events:InvokeApiDestination"
      Resource = aws_cloudwatch_event_api_destination.cron.arn
    }]
  })
}

resource "aws_scheduler_schedule" "cron" {
  name       = "${var.project_name}-run-style-posts"
  group_name = aws_scheduler_schedule_group.app.name

  flexible_time_window {
    mode = "OFF"
  }
  schedule_expression = "rate(1 minute)"

  target {
    arn      = aws_cloudwatch_event_api_destination.cron.arn
    role_arn = aws_iam_role.scheduler.arn
  }
}
