// ============================================
// ses-email.ts
// パスワード再設定メール等、ユーザー個別宛のメール送信。
//
// src/lib/sns-alert.ts(管理者向けアラート通知)と同様、このアプリ自身が
// 既にECSタスクロールとして動いているため、そのアンビエント認証情報を
// fromHttp()で使う(専用の静的キーは発行しない)。
//
// SES_FROM_EMAIL・SESの送信ドメイン検証(SPF/DKIM)はinfra/ses.tfで
// Terraform管理する。ドメイン未検証・サンドボックスモードのままだと
// 送信は失敗するため、その場合はエラーをログに残すだけに留め、
// 呼び出し側の処理(サインアップ等)自体は失敗させない。
// ============================================

import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses'
import { fromHttp } from '@aws-sdk/credential-provider-http'
import type { Bindings } from '../types'

export async function sendEmail(
  env: Bindings,
  to: string,
  subject: string,
  bodyText: string
): Promise<{ success: boolean; error?: string }> {
  const fromEmail = env.SES_FROM_EMAIL
  const region = env.AWS_REGION
  if (!fromEmail || !region) {
    const msg = 'メール送信をスキップしました: SES関連の環境変数(SES_FROM_EMAIL/AWS_REGION)が未設定です'
    console.error(msg)
    return { success: false, error: msg }
  }

  try {
    const client = new SESClient({ region, credentials: fromHttp() })
    await client.send(
      new SendEmailCommand({
        Source: fromEmail,
        Destination: { ToAddresses: [to] },
        Message: {
          Subject: { Data: subject, Charset: 'UTF-8' },
          Body: { Text: { Data: bodyText, Charset: 'UTF-8' } }
        }
      })
    )
    return { success: true }
  } catch (err: any) {
    const msg = `メール送信に失敗しました(to=${to}): ${String(err?.message || err)}`
    console.error(msg)
    return { success: false, error: msg }
  }
}
