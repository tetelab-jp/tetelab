# SalonAtelier(salonatelier.jp)向けのSES設定。ses.tf(SalonMotion本体)と
# 同じ考え方・同じパターンを踏襲する。
#
# 2026-08-20追記: aws_ses_domain_identity.atelier / aws_ses_domain_dkim.atelier は
# 既にAWSコンソール側(またはTerraform管理外の経路)でドメイン検証・DKIM有効化が
# 完了済み(`aws ses get-identity-dkim-attributes`で実機確認済み、DkimVerificationStatus=Success)。
# 新規に検証をやり直す(=新しいDKIMトークンが発行され、既存のDNS CNAMEレコードと
# 不整合になる)事故を避けるため、この2リソースは`terraform import`で既存の状態を
# 取り込んでから適用すること。
#   terraform import 'aws_ses_domain_identity.atelier[0]' salonatelier.jp
#   terraform import 'aws_ses_domain_dkim.atelier[0]' salonatelier.jp
#
# MAIL FROMドメイン・バウンス/苦情通知(SNS)は、実機確認の結果
# 未設定だったため新規に追加する(こちらはimport不要、通常のcreateでよい)。

resource "aws_ses_domain_identity" "atelier" {
  count  = local.atelier_has_domain ? 1 : 0
  domain = var.atelier_domain_name
}

resource "aws_ses_domain_dkim" "atelier" {
  count  = local.atelier_has_domain ? 1 : 0
  domain = aws_ses_domain_identity.atelier[0].domain
}

# ドメイン所有権検証用TXTレコード(_amazonses.<domain>)
resource "aws_route53_record" "atelier_ses_verification" {
  count   = local.atelier_has_domain && var.atelier_manage_dns_in_route53 ? 1 : 0
  zone_id = data.aws_route53_zone.atelier[0].zone_id
  name    = "_amazonses.${var.atelier_domain_name}"
  type    = "TXT"
  ttl     = 600
  records = [aws_ses_domain_identity.atelier[0].verification_token]
}

# DKIM署名用CNAMEレコード(3件)
resource "aws_route53_record" "atelier_ses_dkim" {
  count   = local.atelier_has_domain && var.atelier_manage_dns_in_route53 ? 3 : 0
  zone_id = data.aws_route53_zone.atelier[0].zone_id
  name    = "${aws_ses_domain_dkim.atelier[0].dkim_tokens[count.index]}._domainkey.${var.atelier_domain_name}"
  type    = "CNAME"
  ttl     = 600
  records = ["${aws_ses_domain_dkim.atelier[0].dkim_tokens[count.index]}.dkim.amazonses.com"]
}

# カスタムMAIL FROMドメイン(mail.<atelier_domain_name>)
resource "aws_ses_domain_mail_from" "atelier" {
  count            = local.atelier_has_domain ? 1 : 0
  domain           = aws_ses_domain_identity.atelier[0].domain
  mail_from_domain = "mail.${var.atelier_domain_name}"
}

resource "aws_route53_record" "atelier_ses_mail_from_mx" {
  count   = local.atelier_has_domain && var.atelier_manage_dns_in_route53 ? 1 : 0
  zone_id = data.aws_route53_zone.atelier[0].zone_id
  name    = aws_ses_domain_mail_from.atelier[0].mail_from_domain
  type    = "MX"
  ttl     = 600
  records = ["10 feedback-smtp.${var.aws_region}.amazonses.com"]
}

resource "aws_route53_record" "atelier_ses_mail_from_spf" {
  count   = local.atelier_has_domain && var.atelier_manage_dns_in_route53 ? 1 : 0
  zone_id = data.aws_route53_zone.atelier[0].zone_id
  name    = aws_ses_domain_mail_from.atelier[0].mail_from_domain
  type    = "TXT"
  ttl     = 600
  records = ["v=spf1 include:amazonses.com ~all"]
}

# バウンス・苦情通知。SalonMotion本体と同じ共通SNSトピック(aws_sns_topic.alerts)を
# 再利用する。SESからのpublish許可はmonitoring.tf側のトピックポリシーで
# ドメイン単位ではなくアカウント単位(SourceAccount条件)に許可済みのため、
# atelier用に追加のポリシー変更は不要。
resource "aws_ses_identity_notification_topic" "atelier_bounce" {
  count                    = local.atelier_has_domain ? 1 : 0
  identity                 = aws_ses_domain_identity.atelier[0].domain
  notification_type        = "Bounce"
  topic_arn                = aws_sns_topic.alerts.arn
  include_original_headers = true
}

resource "aws_ses_identity_notification_topic" "atelier_complaint" {
  count                    = local.atelier_has_domain ? 1 : 0
  identity                 = aws_ses_domain_identity.atelier[0].domain
  notification_type        = "Complaint"
  topic_arn                = aws_sns_topic.alerts.arn
  include_original_headers = true
}
