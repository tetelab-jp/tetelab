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
  description = "CloudflareからECS RunTaskを呼ぶためのIAMユーザー名"
  type        = string
  default     = "salonboard-worker-cloudflare-caller"
}
