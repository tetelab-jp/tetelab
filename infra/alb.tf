# ドメイン未指定(var.domain_name == "")の場合は、ACM証明書・Route53は
# 作成せず、ALBのHTTPリスナー(80番)だけで動かす。テスト用途向けの構成。
# ドメインを用意できたら var.domain_name を設定してapplyし直すことで、
# ACM証明書・HTTPSリスナー・独自ドメインへの向き先が自動的に追加される。
locals {
  has_domain = var.domain_name != ""
}

data "aws_route53_zone" "primary" {
  count        = local.has_domain && var.manage_dns_in_route53 ? 1 : 0
  name         = var.route53_zone_name
  private_zone = false
}

resource "aws_acm_certificate" "app" {
  count             = local.has_domain ? 1 : 0
  domain_name       = var.domain_name
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_route53_record" "cert_validation" {
  for_each = local.has_domain && var.manage_dns_in_route53 ? {
    for dvo in aws_acm_certificate.app[0].domain_validation_options : dvo.domain_name => {
      name  = dvo.resource_record_name
      type  = dvo.resource_record_type
      value = dvo.resource_record_value
    }
  } : {}

  zone_id = data.aws_route53_zone.primary[0].zone_id
  name    = each.value.name
  type    = each.value.type
  ttl     = 300
  records = [each.value.value]
}

resource "aws_acm_certificate_validation" "app" {
  count                   = local.has_domain && var.manage_dns_in_route53 ? 1 : 0
  certificate_arn         = aws_acm_certificate.app[0].arn
  validation_record_fqdns = [for r in aws_route53_record.cert_validation : r.fqdn]
}

# manage_dns_in_route53=false の場合は、aws_acm_certificate.app の
# domain_validation_options を terraform output 等で確認し、自分のDNSに
# 手動でCNAMEレコードを追加してから apply をもう一度実行して検証を完了させること。

resource "aws_security_group" "alb" {
  name        = "${var.project_name}-alb"
  description = "ALB - public 80/443"
  vpc_id      = data.aws_vpc.default.id

  ingress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  ingress {
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_lb" "app" {
  name               = "${var.project_name}-alb"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = data.aws_subnets.default_public.ids
}

resource "aws_lb_target_group" "app" {
  name        = "${var.project_name}-app"
  port        = 3000
  protocol    = "HTTP"
  vpc_id      = data.aws_vpc.default.id
  target_type = "ip"

  health_check {
    path                = "/login"
    matcher             = "200"
    interval            = 30
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
}

# ドメインありの場合のみHTTPS(443)を開き、HTTP(80)はHTTPSへリダイレクトする。
resource "aws_lb_listener" "https" {
  count             = local.has_domain ? 1 : 0
  load_balancer_arn = aws_lb.app.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = aws_acm_certificate.app[0].arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.app.arn
  }

  depends_on = [aws_acm_certificate_validation.app]
}

resource "aws_lb_listener" "http_redirect" {
  count             = local.has_domain ? 1 : 0
  load_balancer_arn = aws_lb.app.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = "redirect"
    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
}

# ドメイン未指定時は、HTTP(80)からアプリへ直接フォワードする
# (テスト用途。secureでないCookieになるため本番運用では使わない)。
resource "aws_lb_listener" "http_direct" {
  count             = local.has_domain ? 0 : 1
  load_balancer_arn = aws_lb.app.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.app.arn
  }
}

# アプリ自身の公開URL。APP_BASE_URL(Fargateワーカーへのコールバック先)や
# EventBridge Schedulerの呼び出し先に使う。ドメイン未指定時はALBのDNS名を
# HTTPで使う(テスト用途)。
locals {
  app_public_url = local.has_domain ? "https://${var.domain_name}" : "http://${aws_lb.app.dns_name}"
}

resource "aws_route53_record" "app" {
  count   = local.has_domain && var.manage_dns_in_route53 ? 1 : 0
  zone_id = data.aws_route53_zone.primary[0].zone_id
  name    = var.domain_name
  type    = "A"

  alias {
    name                   = aws_lb.app.dns_name
    zone_id                = aws_lb.app.zone_id
    evaluate_target_health = true
  }
}
