# アプリ本体がAWS上で動くようになったため、ECS_CLUSTER/AWS_ACCESS_KEY_ID等は
# ecs-app.tfのタスク定義でTerraformが直接環境変数/Secretsとして注入しており、
# 手動でどこかにコピーする必要はない。以下はCI/CD設定やデータ移行など、
# 人がまだ手を動かす必要がある箇所のための出力のみ。

output "worker_ecr_repository_url" {
  description = "GitHub Actions(deploy-worker.yml)のsecrets.ECR_REPOSITORYに設定する値"
  value       = aws_ecr_repository.worker.repository_url
}

output "app_ecr_repository_url" {
  description = "GitHub Actions(deploy-app.yml)のsecrets.ECR_REPOSITORYに設定する値"
  value       = aws_ecr_repository.app.repository_url
}

output "ecs_cluster_name" {
  value = aws_ecs_cluster.worker.name
}

output "worker_task_definition_family" {
  value = aws_ecs_task_definition.worker.family
}

output "app_task_definition_family" {
  value = aws_ecs_task_definition.app.family
}

output "app_ecs_service_name" {
  description = "GitHub Actions(deploy-app.yml)のsecrets.ECS_SERVICEに設定する値"
  value       = aws_ecs_service.app.name
}

output "github_actions_deploy_role_arn" {
  description = "GitHub Actions側のsecrets.AWS_DEPLOY_ROLE_ARNに設定する値"
  value       = aws_iam_role.github_actions_deploy.arn
}

output "alb_dns_name" {
  description = "manage_dns_in_route53=false の場合、自分のDNSでdomain_nameをこのALBへ向けること(CNAMEまたはALIAS)"
  value       = aws_lb.app.dns_name
}

output "acm_certificate_validation_records" {
  description = "manage_dns_in_route53=false の場合、自分のDNSに追加が必要なACM検証用CNAMEレコード(ドメイン未指定時は空。admin_domain_name設定時はそちらの検証レコードも含まれる)"
  value = local.has_domain ? [
    for dvo in aws_acm_certificate.app[0].domain_validation_options : {
      name  = dvo.resource_record_name
      type  = dvo.resource_record_type
      value = dvo.resource_record_value
    }
  ] : []
}

# 2026-08-17追記: manage_dns_in_route53=false の場合、admin_domain_nameを
# ALBへ向けるための自分のDNSに追加が必要なレコード(お名前.com等)。
# ALBはIPアドレスが変動するためAレコードではなくCNAMEでALBのDNS名を指す。
output "admin_domain_alb_record" {
  description = "manage_dns_in_route53=false かつ admin_domain_name設定時、自分のDNSに追加が必要なCNAMEレコード(ALBを指す)"
  value = local.has_admin_domain ? {
    name  = var.admin_domain_name
    type  = "CNAME"
    value = aws_lb.app.dns_name
  } : null
}

output "ses_from_email" {
  description = "アプリのSES_FROM_EMAIL(送信元アドレス)に設定される値"
  value       = local.has_domain ? "noreply@${var.domain_name}" : ""
}

output "ses_domain_verification_record" {
  description = "manage_dns_in_route53=false の場合、自分のDNSに追加が必要なSESドメイン所有権検証用TXTレコード"
  value = local.has_domain ? {
    name  = "_amazonses.${var.domain_name}"
    type  = "TXT"
    value = aws_ses_domain_identity.main[0].verification_token
  } : null
}

output "ses_dkim_records" {
  description = "manage_dns_in_route53=false の場合、自分のDNSに追加が必要なSES DKIM署名用CNAMEレコード(3件)"
  value = local.has_domain ? [
    for token in aws_ses_domain_dkim.main[0].dkim_tokens : {
      name  = "${token}._domainkey.${var.domain_name}"
      type  = "CNAME"
      value = "${token}.dkim.amazonses.com"
    }
  ] : []
}

output "rds_endpoint" {
  description = "データ移行スクリプト実行時などに使う接続先(ホスト:ポート)"
  value       = aws_db_instance.main.endpoint
}

output "database_url" {
  description = "データ移行スクリプト(scripts/migrate-d1-to-postgres.ts)実行時にDATABASE_URLとして渡す値"
  value       = "postgres://${var.db_username}:${random_password.db.result}@${aws_db_instance.main.address}:5432/${var.db_name}"
  sensitive   = true
}

output "style_images_bucket" {
  description = "データ移行スクリプト(scripts/migrate-r2-to-s3.ts)実行時にS3_BUCKETとして渡す値"
  value       = aws_s3_bucket.style_images.bucket
}

output "log_reader_access_key_id" {
  description = "CloudWatch Logs閲覧専用ユーザーのアクセスキーID(調査・デバッグ用)"
  value       = aws_iam_access_key.log_reader.id
  sensitive   = true
}

output "log_reader_secret_access_key" {
  description = "CloudWatch Logs閲覧専用ユーザーのシークレットアクセスキー(調査・デバッグ用)"
  value       = aws_iam_access_key.log_reader.secret
  sensitive   = true
}
