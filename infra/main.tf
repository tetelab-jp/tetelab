# TETE AOUT インフラ全体(アプリ本体+SALON BOARD投稿ワーカー)の定義。
# 2026-08-10、AWSアカウント(102798329434, ap-northeast-1)へ実際にapply済み。
# state は S3(salonboard-worker-tfstate-102798329434)で管理している。
# 以後の変更は `terraform init && terraform plan/apply` を実行すること。

terraform {
  required_version = ">= 1.5.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  backend "s3" {
    bucket  = "salonboard-worker-tfstate-102798329434"
    key     = "salonboard-worker/terraform.tfstate"
    region  = "ap-northeast-1"
    encrypt = true
  }
}

provider "aws" {
  region = var.aws_region
}
