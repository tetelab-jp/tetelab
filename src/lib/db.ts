// ============================================
// db.ts
// AWS RDS(PostgreSQL)を、Cloudflare D1と同じ呼び出しインターフェースで
// 使えるようにする互換シム。
//
// 既存コードは全て
//   env.DB.prepare(sql).bind(...args).run() / .first<T>() / .all<T>()
// という形でD1を呼んでおり、この形さえ維持すればルート/ライブラリ側の
// 約130箇所のSQL呼び出しは一切書き換えずに済む。
//
// D1との差異を吸収している点:
//   - `?`プレースホルダを`$1,$2,...`へ変換する
//   - INSERT文には自動でRETURNING idを付与し、run()の戻り値に
//     meta.last_row_id を含める(D1の自動採番ID取得と同じ使い方ができる)
//   - COUNT(*)等が返すbigint(int8)をJSのnumberとして受け取れるよう
//     型パーサを上書きする(pgのデフォルトはbigintを文字列で返すため)
//   - timestamp/date列を、D1がそうしていたのと同じく生の文字列
//     ("YYYY-MM-DD HH:MM:SS"形式)のまま返す(pgのデフォルトはJSのDate
//     オブジェクトに変換するため、date-format.ts等の既存の文字列処理と
//     食い違ってしまう)
// ============================================

import { Pool, types } from 'pg'

// int8(bigint, COUNT(*)の戻り値型) をnumberとして受け取る。
// このアプリの行数規模ではNumber.MAX_SAFE_INTEGERを超える心配はない。
types.setTypeParser(20, (val: string) => parseInt(val, 10))
// timestamp / timestamptz / date は文字列のまま返す(D1と同じ挙動に合わせる)
types.setTypeParser(1114, (val: string) => val) // timestamp without time zone
types.setTypeParser(1184, (val: string) => val) // timestamp with time zone
types.setTypeParser(1082, (val: string) => val) // date

export type D1LikeRunResult = {
  success: boolean
  meta: { last_row_id?: number }
}

export type D1LikeAllResult<T> = { results: T[] }

class PgPreparedStatement {
  private params: unknown[] = []

  constructor(
    private pool: Pool,
    private sql: string
  ) {}

  bind(...args: unknown[]): PgPreparedStatement {
    const stmt = new PgPreparedStatement(this.pool, this.sql)
    stmt.params = args
    return stmt
  }

  private toPgQuery(): string {
    let i = 0
    return this.sql.replace(/\?/g, () => `$${++i}`)
  }

  async run(): Promise<D1LikeRunResult> {
    const isInsert = /^\s*INSERT\b/i.test(this.sql)
    const hasReturning = /\bRETURNING\b/i.test(this.sql)
    const pgSql = this.toPgQuery()
    const autoAppendReturning = isInsert && !hasReturning
    try {
      const res = await this.pool.query(pgSql + (autoAppendReturning ? ' RETURNING id' : ''), this.params)
      return {
        success: true,
        meta: { last_row_id: isInsert ? (res.rows[0]?.id as number | undefined) : undefined }
      }
    } catch (err: any) {
      // 2026-08-17追記(至急・重大バグ修正): 上のRETURNING id自動付与は、主キー列名が
      // "id"ではないテーブル(例: schema_migration_flags、主キーはflag_key)への
      // INSERTに対して常に"column \"id\" does not exist"(SQLSTATE 42703)で失敗して
      // いた。この失敗は呼び出し元のtry/catchで黙って握りつぶされることが多く、
      // 「一度だけ実行して完了フラグを記録する」はずのマイグレーションが、フラグの
      // 記録自体に毎回失敗するせいでコンテナ起動のたびに再実行される、という重大な
      // 副作用を引き起こしていた(例: 管理者が手動で有効化した機能フラグが、頻繁な
      // デプロイのたびに古いデフォルト値へ強制的に巻き戻されていた)。id列が原因の
      // エラーだけを検知し、RETURNING無しで再試行する(last_row_idは取得できないが、
      // このエラーが起きる時点でそのテーブルはid列を持たないため、元々last_row_id
      // を使う用途では呼ばれ得ない)。
      if (autoAppendReturning && err?.code === '42703') {
        const res = await this.pool.query(pgSql, this.params)
        return { success: true, meta: { last_row_id: undefined } }
      }
      throw err
    }
  }

  async first<T = unknown>(): Promise<T | null> {
    const res = await this.pool.query(this.toPgQuery(), this.params)
    return (res.rows[0] as T) ?? null
  }

  async all<T = unknown>(): Promise<D1LikeAllResult<T>> {
    const res = await this.pool.query(this.toPgQuery(), this.params)
    return { results: res.rows as T[] }
  }
}

export class PgDatabase {
  constructor(private pool: Pool) {}

  prepare(sql: string): PgPreparedStatement {
    return new PgPreparedStatement(this.pool, sql)
  }
}

let sharedPool: Pool | null = null

/** モジュールレベルで1つだけ生成して使い回す(リクエスト毎の再生成をしない) */
export function createDb(connectionString: string): PgDatabase {
  if (!sharedPool) {
    // D1/SQLiteのCURRENT_TIMESTAMPは常にUTCの素朴な文字列を返す。
    // PostgreSQLのCURRENT_TIMESTAMP/now()はセッションのtimezone設定に
    // 依存するため、接続確立時(最初のクエリが走る前)にUTCへ固定して
    // 同じ挙動に揃える(date-format.ts等がタイムスタンプ文字列を
    // 「UTCとして」パースする前提で書かれているため)。
    // Pool の 'connect' イベントで別途 client.query() すると、既に
    // 待機中のクエリと競合し得るため、接続時オプションとして渡す。
    sharedPool = new Pool({
      connectionString,
      // -c statement_timeout: 1本のクエリが異常に長時間ブロックし続けて
      // プールのコネクションを占有し続ける(=他リクエストがコネクション
      // 枯渇で無制限に待たされる)事態を避けるための上限。
      options: '-c TimeZone=UTC -c statement_timeout=30000',
      // RDSはSSL接続を必須にしているため有効化する(自己署名扱いのRDS CA
      // チェーンを都度検証する構成は今回のスコープでは行わず簡略化する)
      ssl: { rejectUnauthorized: false },
      // 2026-08-13追記(監査指摘の是正): 全てpg既定値(max=10、idle/connection
      // timeoutは実質無制限)任せだったため、コネクションプール枯渇時に
      // リクエストが無制限に滞留するリスクがあった。明示的に上限を設ける。
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000
    })
    // 2026-08-13追記(重大バグ修正): pgのPoolはidle中のクライアントで
    // エラー(RDSのフェイルオーバー・アイドル接続の切断等)が起きると
    // 'error'イベントを発行する。リスナーが無いとNode.jsは未処理の
    // 'error'イベントを例外として扱いプロセス全体をクラッシュさせるため、
    // ログ出力のみ行い揉み消す(pgは内部でそのクライアントをプールから
    // 破棄し、次回利用時に新しい接続を張り直す)。
    sharedPool.on('error', (err) => {
      console.error('DBコネクションプールでエラーが発生しました(接続は自動的に張り直されます):', err)
    })
  }
  return new PgDatabase(sharedPool)
}
