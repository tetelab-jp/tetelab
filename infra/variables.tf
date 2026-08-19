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

# 初回のタスク定義登録に使うイメージ。ECRにまだ何もpushしていない段階なので、
# 実在する公開ダミーイメージを既定値にしておく(RunTaskで実際に使われる
# イメージは、GitHub Actionsが新しいリビジョンを登録した後のものになるため)。
variable "initial_image" {
  description = "タスク定義の初回登録時に使うコンテナイメージ"
  type        = string
  default     = "public.ecr.aws/docker/library/hello-world:latest"
}

variable "github_repository" {
  description = "GitHub ActionsのOIDC信頼関係を許可するリポジトリ(例: tetelab-jp/tetelab)"
  type        = string
  default     = "tetelab-jp/tetelab"
}

# ---- アプリ本体(常時稼働サービス)関連 ----

variable "domain_name" {
  description = "アプリを公開するホスト名(例: app.example.com)。空文字のままならACM証明書は作らず、ALBのHTTP(80番)を直接使うテスト構成になる。"
  type        = string
  default     = ""
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

# 2026-08-17追記(ユーザー指定): 管理者サイト(/admin)を本体とは別のホスト名
# (例: www.salonmotion.com)で公開する。理由: ブラウザのフォーム自動補完・
# パスワードマネージャーはオリジン(ホスト名)単位で保存領域が分かれるため、
# 管理者ログインと通常ユーザーのログインが同一ホスト名を共有していると、
# 同じ端末を使い回した際に片方の入力履歴がもう片方の欄に補完されてしまう
# (実際に発生した不具合)。空文字のままなら従来通りdomain_name配下の
# /adminをそのまま使う(別ドメインは作らない)。
variable "admin_domain_name" {
  description = "管理者サイトを公開するホスト名(例: www.salonmotion.com)。domain_nameと同じACM証明書にSubject Alternative Nameとして追加する。空文字なら別ドメインは作らない。"
  type        = string
  default     = ""
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
  description = "appタスクのCPU。sync/import機能がPuppeteer(Chromium)をworkerと同じ経路で起動するため、通常のWebサーバー用サイズではなくworkerと同等の値にしている。"
  type        = string
  default     = "1024"
}

variable "app_task_memory" {
  description = "appタスクのメモリ。理由はapp_task_cpuと同じ(Puppeteer/Chromium用)。"
  type        = string
  default     = "3072"
}

# 2026-08-19追記(至急調査): appサービスがdesiredCount=1(冗長化なし)で
# 稼働していたため、単一タスクが一時的に応答不能になる瞬間(デプロイ時の
# 切り替わり・CPU負荷等)にALBへの新規接続が一過性に確立できなくなり、
# Fargateワーカーからの結果コールバックがConnectTimeoutErrorで失敗する
# 事象が疑われた(失敗タスク・成功タスクが同一AZ・同一サブネットだったため、
# ワーカー側ではなくアプリ側が原因である可能性が高いと判断)。単一障害点の
# 解消も兼ねて2タスクへ冗長化する。
variable "app_desired_count" {
  type    = number
  default = 2
}

# 初回のアプリタスク定義登録に使うイメージ(initial_imageと同様、ダミーでよい)
variable "app_initial_image" {
  type    = string
  default = "public.ecr.aws/docker/library/hello-world:latest"
}

# 移行前にCloudflare Pages側で本番運用していた場合は、そのときの
# ENCRYPTION_KEYと同じ値を渡すこと(異なる値にすると既存のsalon_credentials
# (暗号化済みID/パスワード)が復号できなくなる)。空文字のままなら
# Terraformが新しい鍵を自動生成する(まだ本番データが無いテスト環境向け)。
variable "encryption_key" {
  type      = string
  sensitive = true
  default   = ""
}

# CloudWatchアラーム(ALB 5xx・ECSタスク異常・RDS逼迫・投稿ワーカー異常終了)の
# 通知先メールアドレス。空文字なら通知(SNSサブスクリプション)自体を作らない。
variable "alert_email" {
  type    = string
  default = ""
}

# 管理者サイト(/admin)の初期管理者アカウント(inc.tete@gmail.com)の
# パスワード。コード内にハードコードせず、この変数経由でSecrets Managerへ
# 格納する(terraform apply時に -var 等で指定する。tfvarsファイルはgit管理外にすること)。
# admin_usersテーブルが空の場合のみ、アプリ起動時にこの値をハッシュ化して
# 1件だけ投入する(このTerraform変数自体には平文のまま保持されるため、
# tfstateの取り扱いには注意すること)。
variable "admin_initial_password" {
  type      = string
  sensitive = true
}

# ブログ記事のAI自動生成(src/lib/ai-generate.ts)で使うOpenAI APIキー。
# コード内にハードコードせず、この変数経由でSecrets Managerへ格納する
# (terraform apply時に -var で指定する。tfvarsファイルはgit管理外にすること)。
# admin_initial_password等と同様、意図的にdefaultを設けていない
# (defaultを空文字にすると、この変数を指定し忘れた状態でterraform applyを
# 実行した場合に、既に設定済みの値が空文字で上書きされてしまう事故が起きるため)。
variable "openai_api_key" {
  type      = string
  sensitive = true
}
