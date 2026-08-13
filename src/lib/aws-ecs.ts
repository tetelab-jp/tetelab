// ============================================
// aws-ecs.ts
// AWS ECSのRunTask/StopTask APIを呼び出し、SALON BOARD投稿ジョブ1件分の
// Fargateタスクを起動・停止する。
//
// 2026-08-10追記: 元はCloudflare Pages Functions(Workers)からの呼び出しを
// 想定し、Workersでは使えない重量級のAWS SDKを避けてWeb Crypto APIベースの
// 軽量ライブラリaws4fetchで手動SigV4署名していたが、AWS ECS/Fargate(Node
// 常駐サーバー)へ移行済みのため、その制約はもう無い。型安全・保守性の
// 高い公式SDK(@aws-sdk/client-ecs、既存のstorage.tsの@aws-sdk/client-s3と
// 同じ方針)に置き換えた。
//
// 2026-08-13追記(重大な監査指摘の是正): このアプリ自身が既にECSタスク
// (task role: app_task、ecs:RunTask/iam:PassRole権限あり)として動いている
// にも関わらず、cloudflare_callerユーザーの長期静的アクセスキーを
// AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEYとして明示的に渡していた
// (Cloudflare Workers時代、タスクロールという概念自体が存在しなかった頃の
// 名残)。storage.ts(S3)は既にfromHttp()でタスクロールのアンビエント認証
// 情報を使う設計になっており、それと同じ方式に統一する。静的キーが漏洩
// しても実害が生じないよう、呼び出し側では一切キーを渡さない。
// ============================================

import { ECSClient, RunTaskCommand, StopTaskCommand } from '@aws-sdk/client-ecs'
import { fromHttp } from '@aws-sdk/credential-provider-http'

export type RunStylePostTaskParams = {
  awsRegion: string
  cluster: string
  taskDefinition: string
  containerName: string
  subnetIds: string[]
  securityGroupIds: string[]
  jobApiBase: string
  jobId: number
  jobToken: string
}

export type RunStylePostTaskResult = {
  taskArn: string | null
}

/**
 * SALON BOARD投稿ジョブ1件分のFargateタスクを起動する。
 * タスクはcontainerOverrides.environmentで渡されたJOB_ID/JOB_TOKENを使って
 * 自らジョブ内容を取得し(GET /api/automation/jobs/:id)、実行後に結果を
 * コールバックする(POST /api/automation/jobs/:id/result)。
 */
export async function runStylePostTask(params: RunStylePostTaskParams): Promise<RunStylePostTaskResult> {
  const client = new ECSClient({
    region: params.awsRegion,
    credentials: fromHttp()
  })

  const result = await client.send(
    new RunTaskCommand({
      cluster: params.cluster,
      taskDefinition: params.taskDefinition,
      launchType: 'FARGATE',
      count: 1,
      networkConfiguration: {
        awsvpcConfiguration: {
          subnets: params.subnetIds,
          securityGroups: params.securityGroupIds,
          // 2026-08-13追記: workerタスクをNATゲートウェイ経由の固定IP
          // (infra/nat-gateway.tf)を持つプライベートサブネットに移したため、
          // タスク自体に公開IPを割り当てる必要は無くなった(むしろプライベート
          // サブネットでは公開IPを割り当てても外部到達性が無く意味が無い)。
          assignPublicIp: 'DISABLED'
        }
      },
      overrides: {
        containerOverrides: [
          {
            name: params.containerName,
            environment: [
              { name: 'JOB_API_BASE', value: params.jobApiBase },
              { name: 'JOB_ID', value: String(params.jobId) },
              { name: 'JOB_TOKEN', value: params.jobToken }
            ]
          }
        ]
      }
    })
  )

  if (result.failures && result.failures.length > 0) {
    throw new Error(`ECS RunTaskがタスクを起動できませんでした: ${JSON.stringify(result.failures)}`)
  }

  const taskArn = result.tasks?.[0]?.taskArn ?? null
  return { taskArn }
}

export type StopStylePostTaskParams = {
  awsRegion: string
  cluster: string
  taskArn: string
  reason?: string
}

/**
 * 2026-08-13追記(重大な監査指摘の是正): sweepStaleJobs()が10分応答なしの
 * ジョブをDB上で'timeout'扱いにする際、実際のFargateタスクはStopTaskを
 * 呼ぶまで動き続けてしまい、タイムアウト後に(アプリ側が既に諦めた後で)
 * 登録・反映申請が完了してしまうことがあった。この状態でユーザーが
 * 「再実行」すると、既に成功済みの投稿へもう一度別タスクが登録処理を
 * 行い、実質的な二重投稿になる。タイムアウト判定と同時に実タスクへ
 * 明示的な停止を要求し、この競合を防ぐ。
 */
export async function stopStylePostTask(params: StopStylePostTaskParams): Promise<void> {
  const client = new ECSClient({
    region: params.awsRegion,
    credentials: fromHttp()
  })
  await client.send(
    new StopTaskCommand({
      cluster: params.cluster,
      task: params.taskArn,
      reason: params.reason || 'タイムアウトのため停止'
    })
  )
}
