# SalonAtelier(ヘアサロン向けスタイル画像生成サービス、別リポジトリ
# tetelab-jp/salon-atelier)を、SalonMotionと同じAWS環境(VPC/ALB/ECSクラスター)に
# 相乗りさせるための変数群。実施計画は
# /root/.claude/plans/snazzy-fluttering-muffin.md 参照。
#
# 命名は"atelier_"プレフィックスで統一し、SalonMotion本体の変数と衝突しないようにする。

variable "atelier_project_name" {
  description = "SalonAtelier関連リソースの名前プレフィックス"
  type        = string
  default     = "salon-atelier"
}

# ドメイン未定のため既定は空文字。SalonMotion本体のdomain_nameと同じ
# 空文字対応パターン(alb.tfのlocal.has_domain相当)を踏襲し、ドメインが
# 決まってから2回目のapplyで有効化する。
variable "atelier_domain_name" {
  description = "SalonAtelierを公開するホスト名(例: atelier.example.com)。空文字ならACM証明書・ALBルーティングは作らない(バックエンドは起動するが外部到達不可のテスト状態)。"
  type        = string
  default     = ""
}

variable "atelier_manage_dns_in_route53" {
  description = "trueならRoute53(既存または新規ホストゾーン)にACM検証レコードとALBへのAレコードを自動作成する。falseならterraform outputで出力される検証レコードを自分のDNSへ手動追加する。"
  type        = bool
  default     = true
}

variable "atelier_route53_zone_name" {
  description = "atelier_domain_nameを含むRoute53ホストゾーン名。atelier_manage_dns_in_route53=trueの場合のみ使用。空文字ならatelier_domain_name自体をゾーン名とみなす。"
  type        = string
  default     = ""
}

variable "atelier_github_repository" {
  description = "GitHub ActionsのOIDC信頼関係を許可するリポジトリ(owner/repo)"
  type        = string
  default     = "tetelab-jp/salon-atelier"
}

# Webリクエスト受付側(常時稼働)。Puppeteer/Chromium不要でOpenAI API呼び出しと
# DB/S3アクセスが中心のため、SalonMotionのappタスク(Puppeteer同梱、1024/3072)
# より大幅に軽量でよい。
variable "atelier_app_task_cpu" {
  type    = string
  default = "256"
}

variable "atelier_app_task_memory" {
  type    = string
  default = "512"
}

variable "atelier_app_desired_count" {
  type    = number
  default = 1
}

# 生成ジョブ用ワーカー(ecs:RunTaskで都度起動、常時稼働サービスにはしない)。
# 画像リサイズ・圧縮(sharp)とOpenAI応答待ちのため、appより余裕を持たせる。
variable "atelier_worker_task_cpu" {
  type    = string
  default = "512"
}

variable "atelier_worker_task_memory" {
  type    = string
  default = "1024"
}

# 初回のタスク定義登録に使うダミーイメージ(SalonMotion本体と同じ理由)。
variable "atelier_app_initial_image" {
  type    = string
  default = "public.ecr.aws/docker/library/hello-world:latest"
}

variable "atelier_worker_initial_image" {
  type    = string
  default = "public.ecr.aws/docker/library/hello-world:latest"
}

variable "atelier_db_name" {
  type    = string
  default = "salon_atelier"
}

variable "atelier_db_username" {
  type    = string
  default = "salon_atelier"
}

# SalonAtelier用の新規OpenAIプロジェクト・APIキー(SalonMotionとは別)。
# コード内にハードコードせず、terraform apply時に-varで指定する。
variable "atelier_openai_api_key" {
  type      = string
  sensitive = true
}
