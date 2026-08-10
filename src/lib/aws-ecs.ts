// ============================================
// aws-ecs.ts
// AWS ECSのRunTask APIを呼び出し、SALON BOARD投稿ジョブ1件分の
// Fargateタスクを起動する。
//
// 2026-08-10追記: 元はCloudflare Pages Functions(Workers)からの呼び出しを
// 想定し、Workersでは使えない重量級のAWS SDKを避けてWeb Crypto APIベースの
// 軽量ライブラリaws4fetchで手動SigV4署名していたが、AWS ECS/Fargate(Node
// 常駐サーバー)へ移行済みのため、その制約はもう無い。型安全・保守性の
// 高い公式SDK(@aws-sdk/client-ecs、既存のstorage.tsの@aws-sdk/client-s3と
// 同じ方針)に置き換えた。
//
// 呼び出すIAMユーザーは ecs:RunTask と対象ロールへの iam:PassRole のみに
// 絞った権限で作成すること(HANDOFF/要件資料参照)。
// ============================================

import { ECSClient, RunTaskCommand } from '@aws-sdk/client-ecs'

export type RunStylePostTaskParams = {
  awsAccessKeyId: string
  awsSecretAccessKey: string
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
    credentials: {
      accessKeyId: params.awsAccessKeyId,
      secretAccessKey: params.awsSecretAccessKey
    }
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
          assignPublicIp: 'ENABLED'
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
