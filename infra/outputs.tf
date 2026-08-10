# これらの値をCloudflare Pages secrets/varsに設定する
# (wrangler pages secret put <NAME> / .dev.vars)。
# 対応関係は要件資料の Bindings 拡張(AWS_REGION等)を参照。

output "aws_region" {
  value = var.aws_region
}

output "ecr_repository_url" {
  value = aws_ecr_repository.worker.repository_url
}

output "ecs_cluster_name" {
  value = aws_ecs_cluster.worker.name
}

output "ecs_task_definition_family" {
  description = "Bindings.ECS_TASK_DEFINITION に設定する値(リビジョン固定ではなくfamily名)"
  value       = aws_ecs_task_definition.worker.family
}

output "ecs_container_name" {
  value = "worker"
}

output "ecs_subnet_ids" {
  description = "Bindings.ECS_SUBNET_IDS(カンマ区切り)に設定する値"
  value       = join(",", data.aws_subnets.default_public.ids)
}

output "ecs_security_group_id" {
  description = "Bindings.ECS_SECURITY_GROUP_IDS に設定する値"
  value       = aws_security_group.worker_task.id
}

output "cloudflare_aws_access_key_id" {
  value = aws_iam_access_key.cloudflare_caller.id
}

output "cloudflare_aws_secret_access_key" {
  value     = aws_iam_access_key.cloudflare_caller.secret
  sensitive = true
}

output "github_actions_deploy_role_arn" {
  description = "GitHub Actions側のsecrets.AWS_DEPLOY_ROLE_ARNに設定する値"
  value       = aws_iam_role.github_actions_deploy.arn
}
