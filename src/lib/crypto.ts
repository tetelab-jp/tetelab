// ============================================
// crypto.ts
// Cloudflare Workers (Web Crypto API) だけで動く
// パスワードハッシュ化 & AES-GCM暗号化ユーティリティ
// Node.jsの`crypto`モジュールは使用不可のため、すべてWeb Crypto APIで実装
// ============================================

const PBKDF2_ITERATIONS = 100_000
const ENC = new TextEncoder()
const DEC = new TextDecoder()

function bufToBase64(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  let binary = ''
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

function base64ToBuf(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

// ---------- パスワードハッシュ化 (PBKDF2) ----------

/**
 * パスワードをPBKDF2でハッシュ化する。
 * 戻り値形式: "base64(salt):base64(hash)"
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    ENC.encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  )
  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256'
    },
    keyMaterial,
    256
  )
  return `${bufToBase64(salt)}:${bufToBase64(derivedBits)}`
}

/**
 * パスワードが保存済みハッシュと一致するか検証する。
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [saltB64, hashB64] = stored.split(':')
  if (!saltB64 || !hashB64) return false
  const salt = base64ToBuf(saltB64)
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    ENC.encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  )
  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256'
    },
    keyMaterial,
    256
  )
  const derivedB64 = bufToBase64(derivedBits)
  // タイミング攻撃を避けるため定数時間比較
  return timingSafeEqual(derivedB64, hashB64)
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let result = 0
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return result === 0
}

// ---------- サロンボードID/Pass暗号化 (AES-GCM) ----------

/**
 * ENCRYPTION_KEY (base64, 32byte推奨) からAES-GCM鍵をインポートする。
 */
async function getAesKey(encryptionKeyBase64: string): Promise<CryptoKey> {
  const rawKey = base64ToBuf(encryptionKeyBase64)
  return crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['encrypt', 'decrypt'])
}

/**
 * 平文をAES-GCMで暗号化する。
 * 戻り値: base64(iv(12byte) + ciphertext)
 */
export async function encryptSecret(plainText: string, encryptionKeyBase64: string): Promise<string> {
  const key = await getAesKey(encryptionKeyBase64)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    ENC.encode(plainText)
  )
  const combined = new Uint8Array(iv.byteLength + ciphertext.byteLength)
  combined.set(iv, 0)
  combined.set(new Uint8Array(ciphertext), iv.byteLength)
  return bufToBase64(combined)
}

/**
 * encryptSecretで暗号化された文字列を復号する。
 */
export async function decryptSecret(encoded: string, encryptionKeyBase64: string): Promise<string> {
  const key = await getAesKey(encryptionKeyBase64)
  const combined = base64ToBuf(encoded)
  const iv = combined.slice(0, 12)
  const ciphertext = combined.slice(12)
  const plainBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext)
  return DEC.decode(plainBuf)
}

/**
 * 32byteのランダムなENCRYPTION_KEY(base64)を生成する（初期セットアップ用ヘルパー）。
 */
export function generateEncryptionKeyBase64(): string {
  const key = crypto.getRandomValues(new Uint8Array(32))
  return bufToBase64(key)
}
