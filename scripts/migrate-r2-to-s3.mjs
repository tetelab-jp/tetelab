#!/usr/bin/env node
// ============================================
// migrate-r2-to-s3.mjs
//
// Cloudflare R2(style_images.r2_keyが指すオブジェクト群)をAWS S3へコピーする。
// R2はS3互換APIを持つため、AWS SDK(@aws-sdk/client-s3)でR2側もS3側も
// 同じクライアントクラスで扱える。
//
// 実行前提:
//   - CloudflareダッシュボードでR2用の管理用APIトークン(アクセスキーID/
//     シークレットアクセスキー)を発行しておく
//
// 実行方法:
//   R2_ACCOUNT_ID=... R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=... \
//   R2_BUCKET=hotpepper-automation-style-images \
//   AWS_REGION=ap-northeast-1 S3_BUCKET=... \
//   node scripts/migrate-r2-to-s3.mjs
// ============================================

import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  PutObjectCommand,
  HeadObjectCommand
} from '@aws-sdk/client-s3'

function requireEnv(name) {
  const v = process.env[name]
  if (!v) throw new Error(`環境変数 ${name} が必要です`)
  return v
}

const r2AccountId = requireEnv('R2_ACCOUNT_ID')
const r2Bucket = requireEnv('R2_BUCKET')
const s3Bucket = requireEnv('S3_BUCKET')
const CONCURRENCY = 5

const r2 = new S3Client({
  region: 'auto',
  endpoint: `https://${r2AccountId}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: requireEnv('R2_ACCESS_KEY_ID'),
    secretAccessKey: requireEnv('R2_SECRET_ACCESS_KEY')
  }
})

const s3 = new S3Client({ region: requireEnv('AWS_REGION') })

async function* listAllKeys() {
  let continuationToken
  do {
    const res = await r2.send(new ListObjectsV2Command({ Bucket: r2Bucket, ContinuationToken: continuationToken }))
    for (const obj of res.Contents ?? []) {
      if (obj.Key) yield obj.Key
    }
    continuationToken = res.NextContinuationToken
  } while (continuationToken)
}

async function copyOne(key) {
  const alreadyExists = await s3
    .send(new HeadObjectCommand({ Bucket: s3Bucket, Key: key }))
    .then(() => true)
    .catch(() => false)
  if (alreadyExists) {
    console.log(`SKIP(既に存在): ${key}`)
    return
  }

  const got = await r2.send(new GetObjectCommand({ Bucket: r2Bucket, Key: key }))
  const bytes = await got.Body.transformToByteArray()

  await s3.send(
    new PutObjectCommand({
      Bucket: s3Bucket,
      Key: key,
      Body: bytes,
      ContentType: got.ContentType
    })
  )
  console.log(`COPIED: ${key} (${bytes.byteLength} bytes)`)
}

async function main() {
  const keys = []
  for await (const key of listAllKeys()) keys.push(key)
  console.log(`対象: ${keys.length}件`)

  let success = 0
  let failed = 0
  for (let i = 0; i < keys.length; i += CONCURRENCY) {
    const batch = keys.slice(i, i + CONCURRENCY)
    const results = await Promise.allSettled(batch.map(copyOne))
    for (const r of results) {
      if (r.status === 'fulfilled') success++
      else {
        failed++
        console.error('失敗:', r.reason)
      }
    }
  }

  console.log(`完了: 成功 ${success}件 / 失敗 ${failed}件`)
  if (failed > 0) process.exit(1)
}

main().catch((err) => {
  console.error('予期しないエラー:', err)
  process.exit(1)
})
