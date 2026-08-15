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
      Effect = "Allow"
      Action = "events:InvokeApiDestination"
      Resource = [
        aws_cloudwatch_event_api_destination.cron[0].arn,
        aws_cloudwatch_event_api_destination.cron_ranking[0].arn,
        aws_cloudwatch_event_api_destination.cron_blog[0].arn
      ]
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

# 検索順位計測の定期測定。/api/cron/run-ranking を5分間隔で叩く。
# エンドポイント側で「今日/今週まだ未実行かつ run_time を過ぎたユーザー」だけを
# 実行するため、頻繁に叩いても実際の計測は設定時刻に1回だけ走る。
# 認証は既存のcron接続(Bearer CRON_SECRET)を流用する。
resource "aws_cloudwatch_event_api_destination" "cron_ranking" {
  count               = local.has_domain ? 1 : 0
  name                = "${var.project_name}-cron-ranking-target"
  invocation_endpoint = "${local.app_public_url}/api/cron/run-ranking"
  http_method         = "POST"
  connection_arn      = aws_cloudwatch_event_connection.cron[0].arn
}

resource "aws_cloudwatch_event_rule" "cron_ranking" {
  count               = local.has_domain ? 1 : 0
  name                = "${var.project_name}-run-ranking"
  schedule_expression = "rate(5 minutes)"
}

resource "aws_cloudwatch_event_target" "cron_ranking" {
  count    = local.has_domain ? 1 : 0
  rule     = aws_cloudwatch_event_rule.cron_ranking[0].name
  arn      = aws_cloudwatch_event_api_destination.cron_ranking[0].arn
  role_arn = aws_iam_role.cron_invoke[0].arn
}

# ブログ記事の自動投稿。/api/cron/run-blog-posts を1分間隔で叩く。
# 実際の投稿間隔・ブラックアウト時間帯・一時停止判定はrunNextArticleForUser内の
# shouldPostNowで行うため(styleのcronと同じパターン)、頻繁に叩いても
# 実際の投稿はスケジュールに従って間隔を空けて実行される。
# 認証は既存のcron接続(Bearer CRON_SECRET)を流用する。
resource "aws_cloudwatch_event_api_destination" "cron_blog" {
  count               = local.has_domain ? 1 : 0
  name                = "${var.project_name}-cron-blog-target"
  invocation_endpoint = "${local.app_public_url}/api/cron/run-blog-posts"
  http_method         = "POST"
  connection_arn      = aws_cloudwatch_event_connection.cron[0].arn
}

resource "aws_cloudwatch_event_rule" "cron_blog" {
  count               = local.has_domain ? 1 : 0
  name                = "${var.project_name}-run-blog-posts"
  schedule_expression = "rate(1 minute)"
}

resource "aws_cloudwatch_event_target" "cron_blog" {
  count    = local.has_domain ? 1 : 0
  rule     = aws_cloudwatch_event_rule.cron_blog[0].name
  arn      = aws_cloudwatch_event_api_destination.cron_blog[0].arn
  role_arn = aws_iam_role.cron_invoke[0].arn
}
