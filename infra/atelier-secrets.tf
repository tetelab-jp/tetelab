# SalonAtelier用Secrets Manager。SalonMotion本体(secrets.tf)と同じ構成・命名規則。

resource "random_id" "atelier_jwt_secret" {
  byte_length = 32
}

resource "aws_secretsmanager_secret" "atelier_database_url" {
  name = "${var.atelier_project_name}/database-url"
}
resource "aws_secretsmanager_secret_version" "atelier_database_url" {
  secret_id     = aws_secretsmanager_secret.atelier_database_url.id
  secret_string = "postgres://${var.atelier_db_username}:${random_password.atelier_db.result}@${aws_db_instance.atelier.address}:5432/${var.atelier_db_name}"
}

resource "aws_secretsmanager_secret" "atelier_jwt_secret" {
  name = "${var.atelier_project_name}/jwt-secret"
}
resource "aws_secretsmanager_secret_version" "atelier_jwt_secret" {
  secret_id     = aws_secretsmanager_secret.atelier_jwt_secret.id
  secret_string = random_id.atelier_jwt_secret.hex
}

resource "aws_secretsmanager_secret" "atelier_openai_api_key" {
  name = "${var.atelier_project_name}/openai-api-key"
}
resource "aws_secretsmanager_secret_version" "atelier_openai_api_key" {
  secret_id     = aws_secretsmanager_secret.atelier_openai_api_key.id
  secret_string = var.atelier_openai_api_key
}
