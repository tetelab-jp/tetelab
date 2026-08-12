// ============================================
// sns-alert.ts
// 管理者サイト(/admin/status)の連続失敗検知アラート送信。
//
// 新たにSES等のメール送信基盤を用意する代わりに、既存のCloudWatch
// アラーム通知と同じSNSトピック(infra/monitoring.tf、inc.tete@gmail.com
// 購読済み・稼働実績あり)を使い回す。認証情報もaws-ecs.tsと同じ
// AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY(cloudflare_callerユーザー)を
// 流用する(このユーザーにsns:Publish権限を追加済み、infra/iam.tf参照)。
// ============================================

import { SNSClient, PublishCommand } from '@aws-sdk/client-sns'
import type { Bindings } from '../types'

export async function publishAlert(env: Bindings, subject: string, message: string): Promise<void> {
  const topicArn = env.SNS_ALERT_TOPIC_ARN
  const accessKeyId = env.AWS_ACCESS_KEY_ID
  const secretAccessKey = env.AWS_SECRET_ACCESS_KEY
  const region = env.AWS_REGION
  if (!topicArn || !accessKeyId || !secretAccessKey || !region) {
    console.error('アラート通知をスキップしました: SNS関連の環境変数が未設定です')
    return
  }

  const client = new SNSClient({ region, credentials: { accessKeyId, secretAccessKey } })
  await client.send(
    new PublishCommand({
      TopicArn: topicArn,
      // SNSのSubjectは100文字制限があるため切り詰める
      Subject: subject.slice(0, 100),
      Message: message
    })
  )
}
