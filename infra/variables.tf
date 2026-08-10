variable "aws_region" {
  description = "デプロイ先AWSリージョン"
  type        = string
  default     = "ap-northeast-1"
}

variable "project_name" {
  description = "リソース名のプレフィックス"
  type        = string
  default     = "salonboard-worker"
}

variable "task_cpu" {
  description = "Fargateタスクに割り当てるCPU(単位: 1024 = 1vCPU)"
  type        = string
  default     = "1024"
}

variable "task_memory" {
  description = "Fargateタスクに割り当てるメモリ(MiB)"
  type        = string
  default     = "3072"
}

# 初回のタスク定義登録に使うイメージ。ECRにまだ何もpushしていない段階では
# 実在しないタグでも登録自体はできる(RunTaskで実際に使われるイメージは、
# GitHub Actionsが新しいリビジョンを登録した後のものになるため)。
# 例: "<repository_url>:init" のようなダミータグを指定してよい。
variable "initial_image" {
  description = "タスク定義の初回登録時に使うコンテナイメージ"
  type        = string
}

variable "github_repository" {
  description = "GitHub ActionsのOIDC信頼関係を許可するリポジトリ(例: tetelab-jp/tetelab)"
  type        = string
}

variable "cloudflare_iam_user_name" {
  description = "アプリ本体からECS RunTaskを呼ぶためのIAMユーザー名(旧: Cloudflare Workersから呼んでいた頃の名残。今はアプリ自身がAWS上で動くためこのユーザーの意味合いは変わったが、aws-ecs.tsの実装(静的アクセスキーでSigV4署名)を変えずに済むようそのまま流用している)"
  type        = string
  default     = "salonboard-worker-app-caller"
}

# ---- アプリ本体(常時稼働サービス)関連 ----

variable "domain_name" {
  description = "アプリを公開するホスト名(例: app.example.com)。ACM証明書とALBのリスナーに使う。"
  type        = string
}

variable "route53_zone_name" {
  description = "domain_nameを含むRoute53ホストゾーン名(例: example.com)。manage_dns_in_route53=trueの場合のみ使用。"
  type        = string
  default     = ""
}

variable "manage_dns_in_route53" {
  description = "trueならRoute53(既存ホストゾーン)にACM検証レコードとALBへのAレコードを自動作成する。falseならterraform output で出力される検証レコードを自分のDNSへ手動追加する。"
  type        = bool
  default     = true
}

variable "db_name" {
  type    = string
  default = "tetelab"
}

variable "db_username" {
  type    = string
  default = "tetelab"
}

variable "app_task_cpu" {
  type    = string
  default = "512"
}

variable "app_task_memory" {
  type    = string
  default = "1024"
}

variable "app_desired_count" {
  type    = number
  default = 1
}

# 初回のアプリタスク定義登録に使うイメージ(initial_imageと同様、ダミータグでよい)
variable "app_initial_image" {
  type = string
}

# 移行前にCloudflare Pages側で使っていたENCRYPTION_KEYと同じ値を渡すこと。
# 異なる値にすると、既存のsalon_credentials(暗号化済みID/パスワード)が
# 復号できなくなる。
variable "encryption_key" {
  type      = string
  sensitive = true
}
