// ============================================
// aws-ecs.ts
// Cloudflare Pages Functions(Workers)からAWS ECSのRunTask APIを直接呼び出す。
//
// AWS SDKは使わず、Web Crypto APIベースの軽量ライブラリ aws4fetch で
// SigV4署名したfetchを行う(Workers環境で動作確認済みの定番手法)。
// 呼び出すIAMユーザーは ecs:RunTask と対象ロールへの iam:PassRole のみに
// 絞った権限で作成すること(HANDOFF/要件資料参照)。
// ============================================

import { AwsClient } from 'aws4fetch'

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
  const aws = new AwsClient({
    accessKeyId: params.awsAccessKeyId,
    secretAccessKey: params.awsSecretAccessKey,
    region: params.awsRegion,
    service: 'ecs'
  })

  const body = {
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
  }

  const res = await aws.fetch(`https://ecs.${params.awsRegion}.amazonaws.com/`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-amz-json-1.1',
      'X-Amz-Target': 'AmazonEC2ContainerServiceV20141113.RunTask'
    },
    body: JSON.stringify(body)
  })

  const json = await res.json<any>()

  if (!res.ok) {
    throw new Error(`ECS RunTaskの呼び出しに失敗しました(status=${res.status}): ${JSON.stringify(json)}`)
  }
  if (Array.isArray(json.failures) && json.failures.length > 0) {
    throw new Error(`ECS RunTaskがタスクを起動できませんでした: ${JSON.stringify(json.failures)}`)
  }

  const taskArn: string | null = json.tasks?.[0]?.taskArn ?? null
  return { taskArn }
}
