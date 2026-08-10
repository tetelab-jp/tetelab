# ジョブ単位でRunTaskするだけの構成のため、タスクへの受信(ingress)は不要。
# デフォルトVPCのパブリックサブネット + assignPublicIp:ENABLED で
# アウトバウンドのみを許可する(NAT Gatewayを使わずコストを抑える)。

data "aws_vpc" "default" {
  default = true
}

data "aws_subnets" "default_public" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
}

resource "aws_security_group" "worker_task" {
  name        = "${var.project_name}-task"
  description = "SALON BOARD投稿ワーカー(Fargateタスク)用。受信は許可せず送信のみ許可する"
  vpc_id      = data.aws_vpc.default.id

  egress {
    description = "アウトバウンド全許可(salonboard.com・Cloudflare PagesへのHTTPSアクセスに必要)"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}
