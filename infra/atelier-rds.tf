# SalonAtelier専用の小型RDS(SalonMotionのRDSとは完全に別インスタンス)。
#
# 共有RDSに別スキーマ+別ユーザーを作る案(依頼書style_app_infra_request.mdの
# 推奨案)ではなく専用インスタンスにした理由:
# SalonMotionのRDSはpublicly_accessible=falseかつセキュリティグループがapp task
# のSGからの5432番のみ許可しており、Terraformを実行するCloudShellはVPC外にある
# ためDBへネットワーク到達できない(postgresqlプロバイダでスキーマ/ロールを
# 直接作成できない)。唯一到達できるSalonMotionのappコンテナにはpsqlが
# 入っておらず、本番稼働中のコンテナに新アプリのブートストラップ用SQL実行
# 経路を追加するのはリスクが大きい。専用インスタンスであればSalonAtelier
# 自身のコンテナが自分のマスター認証情報で起動時マイグレーションを行うだけで
# 済み、SalonMotion自体の構築手法をそのまま踏襲できる。

resource "random_password" "atelier_db" {
  length  = 24
  special = false
}

resource "aws_db_subnet_group" "atelier" {
  name       = "${var.atelier_project_name}-db"
  subnet_ids = data.aws_subnets.default_public.ids
}

resource "aws_security_group" "atelier_rds" {
  name        = "${var.atelier_project_name}-rds"
  description = "SalonAtelier RDS PostgreSQL - allow 5432 from atelier app/worker task SG only"
  vpc_id      = data.aws_vpc.default.id

  ingress {
    description     = "Allow from atelier app/worker task SG only"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.atelier_task.id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_db_instance" "atelier" {
  identifier             = "${var.atelier_project_name}-db"
  engine                 = "postgres"
  engine_version         = "16"
  instance_class         = "db.t4g.micro"
  allocated_storage      = 20
  storage_type           = "gp3"
  storage_encrypted      = true # 新規構築のため、SalonMotion本体のような後追い暗号化移行問題は発生しない
  db_name                = var.atelier_db_name
  username               = var.atelier_db_username
  password               = random_password.atelier_db.result
  db_subnet_group_name   = aws_db_subnet_group.atelier.name
  vpc_security_group_ids = [aws_security_group.atelier_rds.id]
  publicly_accessible    = false

  skip_final_snapshot       = false
  final_snapshot_identifier = "${var.atelier_project_name}-db-final"
  backup_retention_period   = 7
  deletion_protection       = true
}
