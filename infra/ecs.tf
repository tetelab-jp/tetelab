resource "aws_ecs_cluster" "worker" {
  name = var.project_name
}

resource "aws_cloudwatch_log_group" "worker" {
  name              = "/ecs/${var.project_name}"
  retention_in_days = 30
}

resource "aws_ecs_task_definition" "worker" {
  family                   = var.project_name
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.task_cpu
  memory                   = var.task_memory
  execution_role_arn       = aws_iam_role.task_execution.arn
  task_role_arn            = aws_iam_role.task.arn

  # containerOverrides(JOB_API_BASE/JOB_ID/JOB_TOKEN)はCloudflare側のRunTask呼び出し
  # 時に都度上書きされるため、ここでのenvironmentは空でよい。
  container_definitions = jsonencode([
    {
      name  = "worker"
      image = var.initial_image
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.worker.name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "worker"
        }
      }
    }
  ])

  # GitHub Actionsが新しいリビジョンを登録し続けるため、Terraform側では
  # container_definitions(image)の差分を無視する(CIとTerraformで
  # 取り合いにならないようにする)。
  lifecycle {
    ignore_changes = [container_definitions]
  }
}
