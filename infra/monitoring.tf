# ---------- 通知先(SNS + メール) ----------
# アプリの異常(タスク停止・5xx増加・DB逼迫等)をメールで受け取るための
# 共通トピック。サブスクリプションはSNSからの確認メールをクリックする
# まで有効化されない(AWS標準の仕組み)。

resource "aws_sns_topic" "alerts" {
  name = "${var.project_name}-alerts"
}

resource "aws_sns_topic_subscription" "alerts_email" {
  count     = var.alert_email != "" ? 1 : 0
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

# ---------- ALB: 5xxエラー増加・ターゲット異常 ----------

resource "aws_cloudwatch_metric_alarm" "alb_5xx" {
  alarm_name          = "${var.project_name}-alb-5xx"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "HTTPCode_Target_5XX_Count"
  namespace           = "AWS/ApplicationELB"
  period              = 300
  statistic           = "Sum"
  threshold           = 10
  treat_missing_data  = "notBreaching"
  alarm_description   = "ALB配下で5xxエラーが増加しています"
  dimensions = {
    LoadBalancer = aws_lb.app.arn_suffix
  }
  alarm_actions = [aws_sns_topic.alerts.arn]
  ok_actions    = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "alb_unhealthy_hosts" {
  alarm_name          = "${var.project_name}-alb-unhealthy-hosts"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "UnHealthyHostCount"
  namespace           = "AWS/ApplicationELB"
  period              = 60
  statistic           = "Maximum"
  threshold           = 0
  treat_missing_data  = "notBreaching"
  alarm_description   = "ALBのターゲット(appタスク)が異常状態です"
  dimensions = {
    TargetGroup  = aws_lb_target_group.app.arn_suffix
    LoadBalancer = aws_lb.app.arn_suffix
  }
  alarm_actions = [aws_sns_topic.alerts.arn]
  ok_actions    = [aws_sns_topic.alerts.arn]
}

# ---------- ECS app サービス: 高負荷 ----------
# 「起動タスク数がdesired_countを下回っている」状態はContainer Insightsを
# 有効化しないとメトリクスが取得できない(追加コストが発生する)ため、
# 代わりにALBのUnHealthyHostCountアラーム(下記)でサービス断を検知する。

resource "aws_cloudwatch_metric_alarm" "app_cpu_high" {
  alarm_name          = "${var.project_name}-app-cpu-high"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  metric_name         = "CPUUtilization"
  namespace           = "AWS/ECS"
  period              = 300
  statistic           = "Average"
  threshold           = 85
  treat_missing_data  = "notBreaching"
  alarm_description   = "appサービスのCPU使用率が高い状態が続いています"
  dimensions = {
    ClusterName = aws_ecs_cluster.worker.name
    ServiceName = aws_ecs_service.app.name
  }
  alarm_actions = [aws_sns_topic.alerts.arn]
  ok_actions    = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "app_memory_high" {
  alarm_name          = "${var.project_name}-app-memory-high"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  metric_name         = "MemoryUtilization"
  namespace           = "AWS/ECS"
  period              = 300
  statistic           = "Average"
  threshold           = 85
  treat_missing_data  = "notBreaching"
  alarm_description   = "appサービスのメモリ使用率が高い状態が続いています"
  dimensions = {
    ClusterName = aws_ecs_cluster.worker.name
    ServiceName = aws_ecs_service.app.name
  }
  alarm_actions = [aws_sns_topic.alerts.arn]
  ok_actions    = [aws_sns_topic.alerts.arn]
}

# ---------- RDS: CPU・空き容量・接続数 ----------

resource "aws_cloudwatch_metric_alarm" "rds_cpu_high" {
  alarm_name          = "${var.project_name}-rds-cpu-high"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  metric_name         = "CPUUtilization"
  namespace           = "AWS/RDS"
  period              = 300
  statistic           = "Average"
  threshold           = 85
  treat_missing_data  = "notBreaching"
  alarm_description   = "RDSのCPU使用率が高い状態が続いています"
  dimensions = {
    DBInstanceIdentifier = aws_db_instance.main.identifier
  }
  alarm_actions = [aws_sns_topic.alerts.arn]
  ok_actions    = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "rds_storage_low" {
  alarm_name          = "${var.project_name}-rds-storage-low"
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 1
  metric_name         = "FreeStorageSpace"
  namespace           = "AWS/RDS"
  period              = 300
  statistic           = "Average"
  threshold           = 2147483648 # 2GiB
  treat_missing_data  = "notBreaching"
  alarm_description   = "RDSの空きストレージが少なくなっています"
  dimensions = {
    DBInstanceIdentifier = aws_db_instance.main.identifier
  }
  alarm_actions = [aws_sns_topic.alerts.arn]
  ok_actions    = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "rds_connections_high" {
  alarm_name          = "${var.project_name}-rds-connections-high"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  metric_name         = "DatabaseConnections"
  namespace           = "AWS/RDS"
  period              = 300
  statistic           = "Average"
  threshold           = 80
  treat_missing_data  = "notBreaching"
  alarm_description   = "RDSへの接続数が多くなっています"
  dimensions = {
    DBInstanceIdentifier = aws_db_instance.main.identifier
  }
  alarm_actions = [aws_sns_topic.alerts.arn]
  ok_actions    = [aws_sns_topic.alerts.arn]
}

# ---------- SALON BOARD投稿ワーカー: タスク異常終了の通知 ----------
# ECS RunTaskで都度起動される投稿ワーカー(worker task definition)が
# 異常終了(非ゼロ終了コード)した場合に通知する。正常完了(exitCode=0)
# では発火しないよう、EventBridgeのイベントパターン側でexitCode!=0を
# 直接絞り込むことはできないため、Lambdaを介さずSNSへ直接流し、
# メール本文で内容を確認する簡易構成とする。

resource "aws_cloudwatch_event_rule" "worker_task_stopped" {
  name        = "${var.project_name}-worker-task-stopped"
  description = "投稿ワーカータスクが停止した際に発火する(正常/異常問わず全件)"
  event_pattern = jsonencode({
    source      = ["aws.ecs"]
    detail-type = ["ECS Task State Change"]
    detail = {
      clusterArn = [aws_ecs_cluster.worker.arn]
      lastStatus = ["STOPPED"]
      # ":"を末尾に付けて、"salonboard-worker-app"等の別ファミリーを
      # 前方一致で誤って拾わないようにする(family名のみの前方一致だと
      # "salonboard-worker" が "salonboard-worker-app:1" にもマッチしてしまうため)
      taskDefinitionArn = [{ prefix = "${aws_ecs_task_definition.worker.arn_without_revision}:" }]
    }
  })
}

resource "aws_cloudwatch_event_target" "worker_task_stopped_sns" {
  rule      = aws_cloudwatch_event_rule.worker_task_stopped.name
  target_id = "sns"
  arn       = aws_sns_topic.alerts.arn
  input_transformer {
    input_paths = {
      taskArn       = "$.detail.taskArn"
      stopCode      = "$.detail.stopCode"
      stoppedReason = "$.detail.stoppedReason"
      containers    = "$.detail.containers"
    }
    input_template = "\"SALON BOARD投稿ワーカーが停止しました: taskArn=<taskArn> stopCode=<stopCode> reason=<stoppedReason> containers=<containers>\""
  }
}

resource "aws_sns_topic_policy" "alerts_allow_eventbridge" {
  arn = aws_sns_topic.alerts.arn
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "AllowEventBridgePublish"
        Effect    = "Allow"
        Principal = { Service = "events.amazonaws.com" }
        Action    = "SNS:Publish"
        Resource  = aws_sns_topic.alerts.arn
      }
    ]
  })
}
