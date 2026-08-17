// ============================================
// jwt.ts
// Web Crypto APIによるシンプルなJWT(HS256)実装
// セッション管理用（httpOnly Cookieに格納する想定）
// ============================================

const ENC = new TextEncoder()

function base64UrlEncode(data: ArrayBuffer | Uint8Array | string): string {
  let bytes: Uint8Array
  if (typeof data === 'string') {
    bytes = ENC.encode(data)
  } else if (data instanceof Uint8Array) {
    bytes = data
  } else {
    bytes = new Uint8Array(data)
  }
  let binary = ''
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function base64UrlDecode(str: string): Uint8Array<ArrayBuffer> {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/')
  const pad = padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4))
  const binary = atob(padded + pad)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

async function getHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    ENC.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  )
}

export interface JwtPayload {
  sub: number // user id
  email: string
  exp: number // unix seconds
  imp?: boolean // 管理者サイトの「なりすましログイン」経由で発行されたセッションか
  [key: string]: unknown
}

/**
 * JWT(HS256)を発行する。
 */
export async function signJwt(payload: JwtPayload, secret: string): Promise<string> {
  const header = { alg: 'HS256', typ: 'JWT' }
  const headerB64 = base64UrlEncode(JSON.stringify(header))
  const payloadB64 = base64UrlEncode(JSON.stringify(payload))
  const signingInput = `${headerB64}.${payloadB64}`
  const key = await getHmacKey(secret)
  const signature = await crypto.subtle.sign('HMAC', key, ENC.encode(signingInput))
  const signatureB64 = base64UrlEncode(signature)
  return `${signingInput}.${signatureB64}`
}

/**
 * JWTを検証し、有効ならペイロードを返す。無効・期限切れならnull。
 */
export async function verifyJwt(token: string, secret: string): Promise<JwtPayload | null> {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [headerB64, payloadB64, signatureB64] = parts
  const signingInput = `${headerB64}.${payloadB64}`
  const key = await getHmacKey(secret)
  const signature = base64UrlDecode(signatureB64)
  const valid = await crypto.subtle.verify('HMAC', key, signature, ENC.encode(signingInput))
  if (!valid) return null

  try {
    const payloadJson = new TextDecoder().decode(base64UrlDecode(payloadB64))
    const payload = JSON.parse(payloadJson) as JwtPayload
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
      return null // expired
    }
    return payload
  } catch {
    return null
  }
}
