# SalonAtelierを、SalonMotion本体と共用の既存ALB(aws_lb.app)にホストヘッダー
# ベースで相乗りさせる。ドメイン未定の間はターゲットグループ・ECSサービスまでは
# 作るが、リスナールール・ACM証明書・Route53レコードは作らない
# (atelier_domain_nameが決まってから2回目のapplyで有効化する。
# SalonMotion本体のdomain_name未指定時と同じ考え方)。
#
# SalonMotion本体のドメイン(var.domain_name)とは別ドメインになる想定のため、
# 証明書はSAN追加ではなく独立したACM証明書として作成する。

locals {
  atelier_has_domain = var.atelier_domain_name != ""
}

data "aws_route53_zone" "atelier" {
  count        = local.atelier_has_domain && var.atelier_manage_dns_in_route53 ? 1 : 0
  name         = var.atelier_route53_zone_name != "" ? var.atelier_route53_zone_name : var.atelier_domain_name
  private_zone = false
}

resource "aws_acm_certificate" "atelier" {
  count             = local.atelier_has_domain ? 1 : 0
  domain_name       = var.atelier_domain_name
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_route53_record" "atelier_cert_validation" {
  for_each = local.atelier_has_domain && var.atelier_manage_dns_in_route53 ? {
    for dvo in aws_acm_certificate.atelier[0].domain_validation_options : dvo.domain_name => {
      name  = dvo.resource_record_name
      type  = dvo.resource_record_type
      value = dvo.resource_record_value
    }
  } : {}

  zone_id = data.aws_route53_zone.atelier[0].zone_id
  name    = each.value.name
  type    = each.value.type
  ttl     = 300
  records = [each.value.value]
}

resource "aws_acm_certificate_validation" "atelier" {
  count                   = local.atelier_has_domain && var.atelier_manage_dns_in_route53 ? 1 : 0
  certificate_arn         = aws_acm_certificate.atelier[0].arn
  validation_record_fqdns = [for r in aws_route53_record.atelier_cert_validation : r.fqdn]
}

# manage_dns_in_route53=false の場合は、terraform outputで確認できる
# aws_acm_certificate.atelierのdomain_validation_optionsを、自分のDNSに
# 手動でCNAME追加してから apply をもう一度実行して検証を完了させること。

resource "aws_lb_target_group" "atelier_app" {
  name        = "${var.atelier_project_name}-app"
  port        = 3000
  protocol    = "HTTP"
  vpc_id      = data.aws_vpc.default.id
  target_type = "ip"

  health_check {
    path                = "/health"
    matcher             = "200"
    interval            = 30
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
}

# 共用ALBの既存HTTPSリスナー(SalonMotion本体のdomain_name設定時のみ存在)に、
# ホストヘッダーがatelier_domain_nameと一致する場合だけこのターゲットグループへ
# 振り分けるルールを追加する。SalonMotion本体側のドメインが未設定
# (aws_lb_listener.httpsが存在しない)場合は、atelier側のドメインが決まっても
# ルールを作れないため、その場合はSalonMotion本体のドメイン設定を先に行うこと。
resource "aws_lb_listener_rule" "atelier_app" {
  count        = local.atelier_has_domain && length(aws_lb_listener.https) > 0 ? 1 : 0
  listener_arn = aws_lb_listener.https[0].arn
  priority     = 100

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.atelier_app.arn
  }

  condition {
    host_header {
      values = [var.atelier_domain_name]
    }
  }
}

resource "aws_route53_record" "atelier_app" {
  count   = local.atelier_has_domain && var.atelier_manage_dns_in_route53 ? 1 : 0
  zone_id = data.aws_route53_zone.atelier[0].zone_id
  name    = var.atelier_domain_name
  type    = "A"

  alias {
    name                   = aws_lb.app.dns_name
    zone_id                = aws_lb.app.zone_id
    evaluate_target_health = true
  }
}
