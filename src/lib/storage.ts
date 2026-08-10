// ============================================
// storage.ts
// AWS S3を、Cloudflare R2(R2Bucket)と同じ呼び出しインターフェースで
// 使えるようにする互換シム。
//
// 実際の使用箇所(get/put/deleteのシグネチャ根拠):
//   - get:    src/routes/style.tsx:434-439 (object.body / object.httpMetadata.contentType),
//             src/routes/automation.tsx:292 (object.arrayBuffer())
//   - put:    src/routes/style.tsx:866, src/lib/salonboard-import.ts:371
//             (put(key, data, { httpMetadata: { contentType } }))
//   - delete: src/routes/style.tsx:877,1009,1155 (delete(key).catch(() => {}))
// ============================================

import { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3'
import { fromHttp } from '@aws-sdk/credential-provider-http'
import { Readable } from 'node:stream'

export type R2LikeObject = {
  body: ReadableStream
  arrayBuffer: () => Promise<ArrayBuffer>
  httpMetadata?: { contentType?: string }
}

export type R2LikePutOptions = {
  httpMetadata?: { contentType?: string }
}

export class S3Storage {
  constructor(
    private s3: S3Client,
    private bucket: string
  ) {}

  async get(key: string): Promise<R2LikeObject | null> {
    try {
      const res = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }))
      const bodyStream = res.Body as unknown as Readable & {
        transformToByteArray: () => Promise<Uint8Array>
      }
      // .body(ストリーム読み出し)と.arrayBuffer()(バッファ読み出し)は
      // 実際の呼び出し箇所ではどちらか一方しか使われないが、同じ元ストリームを
      // 二重に消費しないよう、実際にアクセスされた方だけ変換するgetterにする。
      return {
        get body(): ReadableStream {
          return Readable.toWeb(bodyStream) as unknown as ReadableStream
        },
        arrayBuffer: async () => {
          const bytes = await bodyStream.transformToByteArray()
          return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
        },
        httpMetadata: { contentType: res.ContentType }
      }
    } catch (err: any) {
      if (err?.name === 'NoSuchKey' || err?.$metadata?.httpStatusCode === 404) return null
      throw err
    }
  }

  async put(key: string, data: ArrayBuffer | Uint8Array, options?: R2LikePutOptions): Promise<void> {
    const body = data instanceof Uint8Array ? data : new Uint8Array(data)
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: options?.httpMetadata?.contentType
      })
    )
  }

  async delete(key: string): Promise<void> {
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }))
  }
}

export function createStorage(bucket: string, region: string): S3Storage {
  // ECS RunTask署名専用のAWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY(この
  // アプリのタスク実行ロールとは別の、ecs:RunTask権限のみを持つIAMユーザーの
  // アクセスキー、src/lib/style-post-runner.ts参照)がプロセスのenvに存在すると、
  // AWS SDKの標準クレデンシャルチェーンはS3クライアント作成時にもそれを
  // 拾ってしまい、S3権限が無いためAccessDeniedになる(実際に画像アップロードで
  // 発生した不具合)。ECSタスクロール(このバケットへのS3権限を持つ、
  // infra/ecs-app.tf の app_task ロール)の認証情報を明示的に使うことで、
  // 上記の意図しない資格情報の混線を避ける。
  return new S3Storage(new S3Client({ region, credentials: fromHttp() }), bucket)
}
