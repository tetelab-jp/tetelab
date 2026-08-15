// ============================================
// crypto.ts
// Cloudflare Workers (Web Crypto API) だけで動く
// パスワードハッシュ化 & AES-GCM暗号化ユーティリティ
// Node.jsの`crypto`モジュールは使用不可のため、すべてWeb Crypto APIで実装
// ============================================

// 2026-08-13追記(監査指摘の是正): 100,000回は現行のOWASP推奨(PBKDF2-HMAC-SHA256で
// 60万回程度)より低いため引き上げる。ただし反復回数を単純に定数変更すると、
// 既存ユーザーのハッシュ("salt:hash"形式、100,000回で計算済み)がverifyPassword側の
// 新しい反復回数と一致せず、既存ユーザー全員がログインできなくなってしまう。
// そのため反復回数自体をハッシュ文字列に埋め込み("iterations:salt:hash")、
// 検証時は保存済みの反復回数を使う後方互換方式にする(新規ハッシュのみ新しい
// 回数を使う。旧形式=反復回数省略時は100,000回として扱う)。
const PBKDF2_ITERATIONS = 600_000
const PBKDF2_ITERATIONS_LEGACY = 100_000
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
 * 戻り値形式: "iterations:base64(salt):base64(hash)"
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
  return `${PBKDF2_ITERATIONS}:${bufToBase64(salt)}:${bufToBase64(derivedBits)}`
}

/**
 * パスワードが保存済みハッシュと一致するか検証する。
 * 新形式("iterations:salt:hash")・旧形式("salt:hash"、反変回数省略=100,000回
 * 扱い)の両方を受け付ける。
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split(':')
  let iterations: number
  let saltB64: string | undefined
  let hashB64: string | undefined
  if (parts.length === 3) {
    iterations = Number(parts[0]) || PBKDF2_ITERATIONS_LEGACY
    ;[, saltB64, hashB64] = parts
  } else {
    iterations = PBKDF2_ITERATIONS_LEGACY
    ;[saltB64, hashB64] = parts
  }
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
      iterations,
      hash: 'SHA-256'
    },
    keyMaterial,
    256
  )
  const derivedB64 = bufToBase64(derivedBits)
  // タイミング攻撃を避けるため定数時間比較
  return timingSafeEqual(derivedB64, hashB64)
}

// 2026-08-13追記(監査指摘の是正): 未登録メールの場合はDB検索がヒットせず
// PBKDF2検証自体をスキップして早期returnしていたため、登録済みメール
// (PBKDF2検証まで進む分レスポンスが遅い)との応答時間差でメールアドレスの
// 登録有無が推測できてしまっていた(ユーザー列挙)。呼び出し側で
// stored=nullの場合もこの関数を経由してダミーハッシュに対する検証を
// 走らせることで、両ケースの処理時間を揃える。
const DUMMY_PASSWORD_HASH = `${PBKDF2_ITERATIONS}:${btoa('0'.repeat(16))}:${btoa('0'.repeat(32))}`

/** storedがnull(該当ユーザー無し)でも同じ計算コストを払う版のverifyPassword。 */
export async function verifyPasswordConstantTime(password: string, stored: string | null): Promise<boolean> {
  if (stored === null) {
    await verifyPassword(password, DUMMY_PASSWORD_HASH)
    return false
  }
  return verifyPassword(password, stored)
}

/** Bearerトークン等の比較にも使う定数時間文字列比較。 */
export function timingSafeEqual(a: string, b: string): boolean {
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

// ---------- パスワード再設定トークン ----------
// メールで送るリンクに載せる生トークンと、DBに保存するハッシュを分離する
// (パスワードそのものと違い高エントロピーな乱数のため、低速なPBKDF2ではなく
// 単純なSHA-256ハッシュで十分)。生トークンはDBに保存しないため、メールの
// 盗み見以外の経路(DB漏洩等)では再設定を行えない。

export function generatePasswordResetToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  let binary = ''
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export async function hashPasswordResetToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', ENC.encode(token))
  return bufToBase64(digest)
}
