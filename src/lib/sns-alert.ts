// ============================================
// sns-alert.ts
// 管理者サイト(/admin/status)の連続失敗検知アラート送信。
//
// 新たにSES等のメール送信基盤を用意する代わりに、既存のCloudWatch
// アラーム通知と同じSNSトピック(infra/monitoring.tf、inc.tete@gmail.com
// 購読済み・稼働実績あり)を使い回す。
//
// 2026-08-13追記(重大な監査指摘の是正): 認証情報は元々aws-ecs.tsと同じ
// cloudflare_callerユーザーの長期静的キーを流用していたが、このアプリ
// 自身が既にECSタスクロール(sns:Publish権限あり)として動いているため
// 不要。storage.ts(S3)と同じfromHttp()でタスクロールのアンビエント
// 認証情報を使う方式に統一する。
// ============================================

import { SNSClient, PublishCommand } from '@aws-sdk/client-sns'
import { fromHttp } from '@aws-sdk/credential-provider-http'
import type { Bindings } from '../types'

export async function publishAlert(env: Bindings, subject: string, message: string): Promise<void> {
  const topicArn = env.SNS_ALERT_TOPIC_ARN
  const region = env.AWS_REGION
  if (!topicArn || !region) {
    console.error('アラート通知をスキップしました: SNS関連の環境変数が未設定です')
    return
  }

  const client = new SNSClient({ region, credentials: fromHttp() })
  await client.send(
    new PublishCommand({
      TopicArn: topicArn,
      // SNSのSubjectは100文字制限があるため切り詰める
      Subject: subject.slice(0, 100),
      Message: message
    })
  )
}
