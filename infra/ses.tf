# メール送信(パスワード再設定リンク等、src/lib/ses-email.ts参照)用のSES設定。
# alb.tfのACM証明書と同じ考え方で、var.manage_dns_in_route53に応じて
# Route53へ自動でレコードを作るか、terraform outputで手動追加用のレコードを
# 出力するかを切り替える。domain_name(var.domain_name)を設定していない
# テスト構成では何も作らない(local.has_domainはalb.tfで定義済み)。
#
# 送信元アドレスはノーリプライの自動送信用に固定でnoreply@<ルートドメイン>とする
# (問い合わせ返信を受けたい用途が別途あれば、受信側の設定と合わせて追加検討する)。
#
# 2026-08-17追記(重大バグ修正): 以前はここ全体でvar.route53_zone_nameを
# ドメイン名として使っていたが、route53_zone_nameは「manage_dns_in_route53=true
# の場合のみ使用」する変数(Route53にどのホストゾーンへレコードを書き込むかの
# 指定)であり、お名前.com等でDNSを管理していてmanage_dns_in_route53=falseの
# 構成では未設定のままになる。その結果SESのドメイン検証・送信元アドレスが
# 常に空/不正なドメインになり、パスワード再設定メール等が送信できない不具合が
# 発生していた。公開ホスト名を表すvar.domain_nameに統一する。
#
# 注意: ここで作成するのはドメインの検証設定のみ。実際にサロン顧客宛へ送信
# できるようにするには、AWSサポートへ「SESサンドボックス解除」の申請が別途
# 必要(AWSアカウント側の作業、Terraformでは自動化できない)。申請が完了する
# までは検証済みメールアドレス宛にしか送信できない。

resource "aws_ses_domain_identity" "main" {
  count  = local.has_domain ? 1 : 0
  domain = var.domain_name
}

resource "aws_ses_domain_dkim" "main" {
  count  = local.has_domain ? 1 : 0
  domain = aws_ses_domain_identity.main[0].domain
}

# ドメイン所有権検証用TXTレコード(_amazonses.<domain>)
resource "aws_route53_record" "ses_verification" {
  count   = local.has_domain && var.manage_dns_in_route53 ? 1 : 0
  zone_id = data.aws_route53_zone.primary[0].zone_id
  name    = "_amazonses.${var.domain_name}"
  type    = "TXT"
  ttl     = 600
  records = [aws_ses_domain_identity.main[0].verification_token]
}

# DKIM署名用CNAMEレコード(3件)。SESが送信メールに正しくDKIM署名するために必要
# (無いと送信自体は可能な場合があるが、Gmail等で迷惑メール判定されやすくなる)。
resource "aws_route53_record" "ses_dkim" {
  count   = local.has_domain && var.manage_dns_in_route53 ? 3 : 0
  zone_id = data.aws_route53_zone.primary[0].zone_id
  name    = "${aws_ses_domain_dkim.main[0].dkim_tokens[count.index]}._domainkey.${var.domain_name}"
  type    = "CNAME"
  ttl     = 600
  records = ["${aws_ses_domain_dkim.main[0].dkim_tokens[count.index]}.dkim.amazonses.com"]
}

# 2026-08-20追記(SES本番アクセス再申請の準備): 送信制限引き上げ申請が
# 一度却下された件を受け、審査で重視されるカスタムMAIL FROMドメインと
# バウンス/苦情通知の設定を追加する。ドメイン検証・DKIMのみでは、SESの
# デフォルトMAIL FROM(amazonses.com配下)がSPF発行元として使われ続け、
# 独自ドメインでのSPF整合が取れない状態だった。

# カスタムMAIL FROMドメイン(mail.<domain_name>)。デフォルトの
# amazonses.comサブドメインではなく自ドメイン配下にすることで、
# SPFのenvelope-fromが独自ドメインと一致し、迷惑メール判定・審査の両面で有利になる。
resource "aws_ses_domain_mail_from" "main" {
  count            = local.has_domain ? 1 : 0
  domain           = aws_ses_domain_identity.main[0].domain
  mail_from_domain = "mail.${var.domain_name}"
}

# MAIL FROMドメイン用MXレコード(SESのバウンスメール受信用)
resource "aws_route53_record" "ses_mail_from_mx" {
  count   = local.has_domain && var.manage_dns_in_route53 ? 1 : 0
  zone_id = data.aws_route53_zone.primary[0].zone_id
  name    = aws_ses_domain_mail_from.main[0].mail_from_domain
  type    = "MX"
  ttl     = 600
  records = ["10 feedback-smtp.${var.aws_region}.amazonses.com"]
}

# MAIL FROMドメイン用SPFレコード(このドメインからのSES送信を正当と示す)
resource "aws_route53_record" "ses_mail_from_spf" {
  count   = local.has_domain && var.manage_dns_in_route53 ? 1 : 0
  zone_id = data.aws_route53_zone.primary[0].zone_id
  name    = aws_ses_domain_mail_from.main[0].mail_from_domain
  type    = "TXT"
  ttl     = 600
  records = ["v=spf1 include:amazonses.com ~all"]
}

# バウンス・苦情通知。既存の共通SNSトピック(monitoring.tf の
# aws_sns_topic.alerts、通知先メールは既に購読済み)を再利用し、
# 新規のSNSトピック・購読を増やさない。SESがこのトピックへpublishできるよう
# 許可するIAMポリシーステートメントはmonitoring.tf側のトピックポリシーに追加している。
resource "aws_ses_identity_notification_topic" "bounce" {
  count                    = local.has_domain ? 1 : 0
  identity                 = aws_ses_domain_identity.main[0].domain
  notification_type        = "Bounce"
  topic_arn                = aws_sns_topic.alerts.arn
  include_original_headers = true
}

resource "aws_ses_identity_notification_topic" "complaint" {
  count                    = local.has_domain ? 1 : 0
  identity                 = aws_ses_domain_identity.main[0].domain
  notification_type        = "Complaint"
  topic_arn                = aws_sns_topic.alerts.arn
  include_original_headers = true
}
