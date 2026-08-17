# SalonAtelier(tetelab-jp/salon-atelierリポジトリ)側のGitHub Actions/README等に
# 設定する値。機密情報(アクセスキー等)はterraform output -rawで個別に取得し、
# ファイル・issue・コミットには書かないこと(生成アプリ側からの指摘に基づく方針)。

output "atelier_app_ecr_repository_url" {
  description = "salon-atelierリポジトリのGitHub Actions(deploy-app.yml)のECR_REPOSITORYに設定する値"
  value       = aws_ecr_repository.atelier_app.repository_url
}

output "atelier_worker_ecr_repository_url" {
  description = "salon-atelierリポジトリのGitHub Actions(deploy-worker.yml)のECR_REPOSITORYに設定する値"
  value       = aws_ecr_repository.atelier_worker.repository_url
}

output "atelier_ecs_cluster_name" {
  description = "SalonMotion本体と共用のECSクラスター名"
  value       = aws_ecs_cluster.worker.name
}

output "atelier_app_task_definition_family" {
  value = aws_ecs_task_definition.atelier_app.family
}

output "atelier_worker_task_definition_family" {
  value = aws_ecs_task_definition.atelier_worker.family
}

output "atelier_app_ecs_service_name" {
  description = "salon-atelierリポジトリのGitHub Actions(deploy-app.yml)のECS_SERVICEに設定する値"
  value       = aws_ecs_service.atelier_app.name
}

output "atelier_github_actions_deploy_role_arn" {
  description = "salon-atelierリポジトリ側のsecrets.AWS_DEPLOY_ROLE_ARNに設定する値"
  value       = aws_iam_role.atelier_github_actions_deploy.arn
}

output "atelier_images_bucket" {
  value = aws_s3_bucket.atelier_images.bucket
}

output "atelier_alb_dns_name" {
  description = "atelier_manage_dns_in_route53=false の場合、自分のDNSでatelier_domain_nameをこのALBへ向けること(CNAME)"
  value       = aws_lb.app.dns_name
}

output "atelier_acm_certificate_validation_records" {
  description = "atelier_manage_dns_in_route53=false の場合、自分のDNSに追加が必要なACM検証用CNAMEレコード(ドメイン未指定時は空)"
  value = local.atelier_has_domain ? [
    for dvo in aws_acm_certificate.atelier[0].domain_validation_options : {
      name  = dvo.resource_record_name
      type  = dvo.resource_record_type
      value = dvo.resource_record_value
    }
  ] : []
}

# ---- 以下は機密情報。terraform output -raw <name> で個別に取得し、
#      ファイル・issue・コミットには書かないこと。----

output "atelier_database_url" {
  description = "SalonAtelierアプリ側のDATABASE_URL(ローカル動作確認・データ投入時などに使用)"
  value       = "postgres://${var.atelier_db_username}:${random_password.atelier_db.result}@${aws_db_instance.atelier.address}:5432/${var.atelier_db_name}"
  sensitive   = true
}

output "atelier_log_reader_access_key_id" {
  description = "CloudWatch Logs閲覧専用ユーザーのアクセスキーID(調査・デバッグ用)"
  value       = aws_iam_access_key.atelier_log_reader.id
  sensitive   = true
}

output "atelier_log_reader_secret_access_key" {
  description = "CloudWatch Logs閲覧専用ユーザーのシークレットアクセスキー(調査・デバッグ用)"
  value       = aws_iam_access_key.atelier_log_reader.secret
  sensitive   = true
}
