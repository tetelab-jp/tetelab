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
  description = "RDS PostgreSQL - allow 5432 from app task SG only"
  vpc_id      = data.aws_vpc.default.id

  ingress {
    description     = "Allow from app task SG only"
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
  identifier        = "${var.project_name}-db"
  engine            = "postgres"
  engine_version    = "16"
  instance_class    = "db.t4g.micro"
  allocated_storage = 20
  storage_type      = "gp3"
  # 2026-08-13追記(監査指摘の是正・重要): サロン資格情報等を扱うDBが保存時
  # 暗号化されていなかったため有効化する。
  #
  # 【重要】RDSは稼働中のインスタンスに対して保存時暗号化を後から有効化
  # できず、この変更はterraform applyの際にインスタンスの「削除→再作成」
  # (force replacement)を引き起こす。既に本番データが入っている状態で
  # そのままapplyするとデータが失われる。適用前に必ず以下のいずれかの
  # 手順を踏むこと:
  #   (a) 現行DBの手動スナップショットを取得 → そのスナップショットを
  #       「暗号化してコピー」→ 暗号化済みスナップショットから新インスタンスを
  #       復元し、terraform importでこのリソースに紐付け直す
  #   (b) pg_dump等で論理バックアップを取得 → 新規(暗号化済み)インスタンスを
  #       作成 → リストア → アプリの接続先を切り替え
  # 何も本番データが入っていない新規構築の場合はそのままapplyしてよい。
  storage_encrypted      = true
  db_name                = var.db_name
  username               = var.db_username
  password               = random_password.db.result
  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.rds.id]
  publicly_accessible    = false
  # 2026-08-13追記(監査指摘の是正): deletion_protection=trueで誤destroyは
  # ある程度防げるが、保護解除後の削除・置換を伴う変更時に最終スナップショットが
  # 残らず、自動バックアップ以外のデータ復旧手段が無かった。
  skip_final_snapshot       = false
  final_snapshot_identifier = "${var.project_name}-db-final"
  backup_retention_period   = 7
  deletion_protection       = true
}
