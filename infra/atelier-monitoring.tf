# SalonAtelier用CloudWatchアラーム。通知先はSalonMotion本体と同じSNSトピック
# (aws_sns_topic.alerts、monitoring.tf)を再利用し、通知先を一本化する。

resource "aws_cloudwatch_metric_alarm" "atelier_alb_5xx" {
  alarm_name          = "${var.atelier_project_name}-alb-5xx"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "HTTPCode_Target_5XX_Count"
  namespace           = "AWS/ApplicationELB"
  period              = 300
  statistic           = "Sum"
  threshold           = 10
  treat_missing_data  = "notBreaching"
  alarm_description   = "SalonAtelier配下で5xxエラーが増加しています"
  dimensions = {
    LoadBalancer = aws_lb.app.arn_suffix
    TargetGroup  = aws_lb_target_group.atelier_app.arn_suffix
  }
  alarm_actions = [aws_sns_topic.alerts.arn]
  ok_actions    = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "atelier_alb_healthy_hosts_low" {
  alarm_name          = "${var.atelier_project_name}-alb-healthy-hosts-low"
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 2
  metric_name         = "HealthyHostCount"
  namespace           = "AWS/ApplicationELB"
  period              = 60
  statistic           = "Minimum"
  threshold           = 1
  treat_missing_data  = "breaching"
  alarm_description   = "SalonAtelierのappタスクが1台も正常稼働していません(サービス全断の可能性)"
  dimensions = {
    TargetGroup  = aws_lb_target_group.atelier_app.arn_suffix
    LoadBalancer = aws_lb.app.arn_suffix
  }
  alarm_actions = [aws_sns_topic.alerts.arn]
  ok_actions    = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "atelier_app_cpu_high" {
  alarm_name          = "${var.atelier_project_name}-app-cpu-high"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  metric_name         = "CPUUtilization"
  namespace           = "AWS/ECS"
  period              = 300
  statistic           = "Average"
  threshold           = 85
  treat_missing_data  = "notBreaching"
  alarm_description   = "SalonAtelier appサービスのCPU使用率が高い状態が続いています"
  dimensions = {
    ClusterName = aws_ecs_cluster.worker.name
    ServiceName = aws_ecs_service.atelier_app.name
  }
  alarm_actions = [aws_sns_topic.alerts.arn]
  ok_actions    = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "atelier_app_memory_high" {
  alarm_name          = "${var.atelier_project_name}-app-memory-high"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  metric_name         = "MemoryUtilization"
  namespace           = "AWS/ECS"
  period              = 300
  statistic           = "Average"
  threshold           = 85
  treat_missing_data  = "notBreaching"
  alarm_description   = "SalonAtelier appサービスのメモリ使用率が高い状態が続いています"
  dimensions = {
    ClusterName = aws_ecs_cluster.worker.name
    ServiceName = aws_ecs_service.atelier_app.name
  }
  alarm_actions = [aws_sns_topic.alerts.arn]
  ok_actions    = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "atelier_rds_cpu_high" {
  alarm_name          = "${var.atelier_project_name}-rds-cpu-high"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  metric_name         = "CPUUtilization"
  namespace           = "AWS/RDS"
  period              = 300
  statistic           = "Average"
  threshold           = 85
  treat_missing_data  = "notBreaching"
  alarm_description   = "SalonAtelier RDSのCPU使用率が高い状態が続いています"
  dimensions = {
    DBInstanceIdentifier = aws_db_instance.atelier.identifier
  }
  alarm_actions = [aws_sns_topic.alerts.arn]
  ok_actions    = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "atelier_rds_storage_low" {
  alarm_name          = "${var.atelier_project_name}-rds-storage-low"
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 1
  metric_name         = "FreeStorageSpace"
  namespace           = "AWS/RDS"
  period              = 300
  statistic           = "Average"
  threshold           = 2147483648 # 2GiB
  treat_missing_data  = "notBreaching"
  alarm_description   = "SalonAtelier RDSの空きストレージが少なくなっています"
  dimensions = {
    DBInstanceIdentifier = aws_db_instance.atelier.identifier
  }
  alarm_actions = [aws_sns_topic.alerts.arn]
  ok_actions    = [aws_sns_topic.alerts.arn]
}
