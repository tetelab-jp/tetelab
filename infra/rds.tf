resource "random_password" "db" {
  length  = 24
  special = false
}

resource "aws_db_subnet_group" "main" {
  name       = "${var.project_name}-db"
  subnet_ids = data.aws_subnets.default_public.ids
}

resource "aws_security_group" "rds" {
  name        = "${var.project_name}-rds"
  description = "RDS PostgreSQL。ECSタスク(app/worker)のSGからの5432のみ許可"
  vpc_id      = data.aws_vpc.default.id

  ingress {
    description     = "アプリタスクからのみ許可"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.app_task.id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

# セッションのtimezoneはアプリ側(src/lib/db.ts、接続オプション -c TimeZone=UTC)
# で明示的にUTCへ固定しているため、RDS側のパラメータグループでの追加設定は不要。
resource "aws_db_instance" "main" {
  identifier              = "${var.project_name}-db"
  engine                  = "postgres"
  engine_version          = "16"
  instance_class          = "db.t4g.micro"
  allocated_storage       = 20
  storage_type            = "gp3"
  db_name                 = var.db_name
  username                = var.db_username
  password                = random_password.db.result
  db_subnet_group_name    = aws_db_subnet_group.main.name
  vpc_security_group_ids  = [aws_security_group.rds.id]
  publicly_accessible     = false
  skip_final_snapshot     = true
  backup_retention_period = 7
  deletion_protection     = true
}
