# ============================================
# NATゲートウェイ + 専用プライベートサブネット
#
# 2026-08-13追記(ユーザー指定・通信安定化調査): DataImpulseの「ホワイトリストIP」
# 認証(登録した固定IPからはID/パスワード不要でアクセスできる機能)を使うには、
# 投稿ワーカー(worker)のFargateタスクが「常に同じ送信元IPから」外部へ接続する
# 必要がある。しかし現状(network.tf参照)は、タスクがデフォルトVPCの
# パブリックサブネットに直接置かれ、起動のたびにAWSがランダムな公開IPを
# 割り当てる方式(assignPublicIp=ENABLED)のため、送信元IPが毎回変わってしまう。
#
# これを解決するため、投稿ワーカー専用の「プライベートサブネット」を新設し、
# そこからの外向き通信をすべて固定IP(Elastic IP)を持つNATゲートウェイ経由に
# する。これにより外部(DataImpulse)から見た送信元IPが常に一定になる。
#
# 影響範囲: 投稿ワーカー(worker)タスクのみ。アプリ本体(app、常時稼働サービス)は
# 引き続き既存のパブリックサブネットを使うため、この変更による影響は無い。
#
# コスト: NATゲートウェイは時間課金(目安 月額$32程度)+データ処理量課金
# (1GBあたり$0.045)が別途発生する。不要になった場合はこのファイルの内容を
# 削除してterraform applyすれば、その時点で課金が止まる。
# ============================================

data "aws_subnet" "worker_nat_az_source" {
  id = data.aws_subnets.default_public.ids[0]
}

# NATゲートウェイ自体はパブリックサブネット(既存のデフォルトVPCのもの)に置く。
# プライベートサブネットと同じAZにすることでクロスAZのデータ転送料を避ける。
resource "aws_eip" "worker_nat" {
  domain = "vpc"
  tags = {
    Name = "${var.project_name}-worker-nat"
  }
}

resource "aws_nat_gateway" "worker" {
  allocation_id = aws_eip.worker_nat.id
  subnet_id     = data.aws_subnets.default_public.ids[0]
  tags = {
    Name = "${var.project_name}-worker-nat"
  }
  depends_on = [aws_eip.worker_nat]
}

# 投稿ワーカー専用のプライベートサブネット。デフォルトVPCの空いているCIDR
# レンジを切り出す(既存のパブリックサブネット群と重複しないよう、範囲の
# 末尾寄りのブロックを使う)。実際に重複が無いかはterraform planで確認すること。
resource "aws_subnet" "worker_private" {
  vpc_id            = data.aws_vpc.default.id
  cidr_block        = cidrsubnet(data.aws_vpc.default.cidr_block, 4, 15)
  availability_zone = data.aws_subnet.worker_nat_az_source.availability_zone
  tags = {
    Name = "${var.project_name}-worker-private"
  }
}

resource "aws_route_table" "worker_private" {
  vpc_id = data.aws_vpc.default.id

  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.worker.id
  }

  tags = {
    Name = "${var.project_name}-worker-private"
  }
}

resource "aws_route_table_association" "worker_private" {
  subnet_id      = aws_subnet.worker_private.id
  route_table_id = aws_route_table.worker_private.id
}

output "worker_nat_gateway_ip" {
  description = "投稿ワーカーの固定送信元IP。DataImpulseのホワイトリストIP設定にこの値を登録する。"
  value       = aws_eip.worker_nat.public_ip
}

output "worker_private_subnet_id" {
  description = "投稿ワーカー専用のプライベートサブネットID。deploy-app.ymlのECS_SUBNET_IDS修正時に使う。"
  value       = aws_subnet.worker_private.id
}
