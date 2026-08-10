# SALON BOARD投稿ワーカー(AWS ECS/Fargate)のインフラ定義。
#
# 適用対象はPhase 0(要件資料参照)の手作業をコード化したもの:
#   - ECRリポジトリ
#   - ECSクラスタ・タスク定義(初回リビジョン。以降はGitHub Actionsが更新)
#   - タスク実行ロール / タスクロール
#   - Cloudflare(Workers)からECS RunTaskを呼ぶためのIAMユーザー
#   - GitHub ActionsからECR push・タスク定義登録を行うためのOIDC IAMロール
#
# 適用はこのセッションでは実行できないため、AWS認証情報を持つ環境で
# `terraform init && terraform apply` を実行すること。

terraform {
  required_version = ">= 1.5.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
}
