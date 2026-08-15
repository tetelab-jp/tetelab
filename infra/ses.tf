# メール送信(パスワード再設定リンク等、src/lib/ses-email.ts参照)用のSES設定。
# alb.tfのACM証明書と同じ考え方で、var.manage_dns_in_route53に応じて
# Route53へ自動でレコードを作るか、terraform outputで手動追加用のレコードを
# 出力するかを切り替える。domain_name(var.domain_name)を設定していない
# テスト構成では何も作らない(local.has_domainはalb.tfで定義済み)。
#
# 送信元アドレスはノーリプライの自動送信用に固定でnoreply@<ルートドメイン>とする
# (問い合わせ返信を受けたい用途が別途あれば、受信側の設定と合わせて追加検討する)。
#
# 注意: ここで作成するのはドメインの検証設定のみ。実際にサロン顧客宛へ送信
# できるようにするには、AWSサポートへ「SESサンドボックス解除」の申請が別途
# 必要(AWSアカウント側の作業、Terraformでは自動化できない)。申請が完了する
# までは検証済みメールアドレス宛にしか送信できない。

resource "aws_ses_domain_identity" "main" {
  count  = local.has_domain ? 1 : 0
  domain = var.route53_zone_name
}

resource "aws_ses_domain_dkim" "main" {
  count  = local.has_domain ? 1 : 0
  domain = aws_ses_domain_identity.main[0].domain
}

# ドメイン所有権検証用TXTレコード(_amazonses.<domain>)
resource "aws_route53_record" "ses_verification" {
  count   = local.has_domain && var.manage_dns_in_route53 ? 1 : 0
  zone_id = data.aws_route53_zone.primary[0].zone_id
  name    = "_amazonses.${var.route53_zone_name}"
  type    = "TXT"
  ttl     = 600
  records = [aws_ses_domain_identity.main[0].verification_token]
}

# DKIM署名用CNAMEレコード(3件)。SESが送信メールに正しくDKIM署名するために必要
# (無いと送信自体は可能な場合があるが、Gmail等で迷惑メール判定されやすくなる)。
resource "aws_route53_record" "ses_dkim" {
  count   = local.has_domain && var.manage_dns_in_route53 ? 3 : 0
  zone_id = data.aws_route53_zone.primary[0].zone_id
  name    = "${aws_ses_domain_dkim.main[0].dkim_tokens[count.index]}._domainkey.${var.route53_zone_name}"
  type    = "CNAME"
  ttl     = 600
  records = ["${aws_ses_domain_dkim.main[0].dkim_tokens[count.index]}.dkim.amazonses.com"]
}
