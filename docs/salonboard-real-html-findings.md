# SALON BOARD 実HTML調査結果

調査日: 2026-08-09
調査方法: Playwright(ローカル, 非headless Chrome)で実際にログインし、DOMを取得・解析。
対象アカウント: 管理者用ID `CE23455`（サロン: Voler -カラー専門店-, STORE_ID: `H000750928`）

> 認証情報(ID/パスワード)は本ファイルには記載していません。

---

## 1. ログイン画面 (`https://salonboard.com/login/`)

- ID入力欄: `input[name="userId"]`
- パスワード入力欄: `input[name="password"]`(`id="jsiPwInput"`)
- **ログイン実行は `<button>` や `input[type=submit]` ではない。** 実際は以下の `<a>` タグの `onclick`:
  ```html
  <a href="javascript:void(0);" class="common-CNCcommon__primaryBtn loginBtnSize"
     onclick="dologin(event); return false;">ログイン</a>
  ```
  → セレクタとしては `a.loginBtnSize` または `a[onclick*="dologin"]` を使う必要がある。
- ログインボタンクリック後、`https://salonboard.com/CNC/login/doLogin/` へ遷移し、その後ダッシュボード配下の画面が認証済み状態でレンダリングされることを確認。
- ページ内にはこの他に `id="loginGuideForm"` (action=`/CNC/mgr/loginGuide/`) という別フォームが存在するが、これは「ログインできない場合はこちら」用 (`send_loginGuide(event)`) で、通常ログインとは無関係。

---

## 2. スタイル一覧ページ (`https://salonboard.com/CNB/draft/styleList/`)

### 全体構造

```html
<form id="sortStyleForm" method="POST" action="/CNB/draft/styleList/doSort">
  ...
  <table class="table_list_store">
    <tbody>
      <tr><th colspan="8">スタイル一覧 ...</th></tr>
      <tr><th>順番</th><th>Pick Up</th><th>写真/動画</th>
          <th colspan="3">スタイル名/長さ/担当/チェック/ヘアスタイル特集/クーポン</th>
          <th>詳細</th><th>非掲載/削除</th></tr>

      <!-- 1スタイル = 4つの<tr>のセット（同じ index の rowspan=4 で列を共有） -->
      <tr> ... 1行目(サムネ・詳細リンク・非掲載/削除リンクなど, rowspan="4") ... </tr>
      <tr> ... 2行目(長さ・担当・チェック状態) ... </tr>
      <tr> ... 3行目(ヘアスタイル特集) ... </tr>
      <tr class="coupon-data-contents"> ... 4行目(クーポン情報) ... </tr>

      <!-- 次のスタイルも同様に4<tr>ずつ繰り返す -->
    </tbody>
  </table>
</form>
```

- 単純な `tr` セレクタでは1スタイルにつき **4行** ヒットするため、「4行で1スタイル」という前提でグルーピングする必要がある(1行目の `rowspan="4"` の有無で先頭行を判定するのが確実)。
- フォーム全体が `frmStyleListStyleInfoDtoList[N]` という配列形式のフィールド名になっている(Struts的な命名)。`N` はスタイルの表示順インデックス(0始まり)。

### スタイルID (`L`+9桁) の出現箇所

実際に確認できた出現パターン(1スタイルあたり):

| 場所 | 例 |
|---|---|
| hidden input (styleId) | `<input type="hidden" name="frmStyleListStyleInfoDtoList[0].styleId" value="L244286488">` |
| hidden input (最終更新日時、`unpresentStyle`の第2引数と同値) | `<input type="hidden" name="frmStyleListStyleInfoDtoList[0].styleLastUpDate" value="20250722153607000">` |
| 詳細へリンク(編集) | `<a href="javascript:void();" onclick="editStyle(event, 'L244286488'); return false;">` |
| 非掲載リンク | `<a href="javascript:void();" onclick="unpresentStyle(event, 'L244286488', '20250722153607000'); return false;">` |
| 削除リンク | `<a href="javascript:void();" onclick="delStyle(event, 'L244286488', '0', '0'); return false;">` |
| 「要確認」ステータスリンク | `<a href="javascript:showErrorPopup('H000750928', 'L244286488');">要確認</a>` |

→ **hidden inputの value からもリンクの onclick 引数からも同じ `L+9桁` が取得できる。** 最も安定して取れるのは hidden input `frmStyleListStyleInfoDtoList[N].styleId` の value。

### ページネーション(「次のページ」)

- 現在のDOM: `<div id="pagingControl" align="right"><span id="noLink"></span></div>` — このアカウントはスタイル数が少なく(1ページに収まる)、実際に描画された「次へ」リンクのHTMLは確認できなかった。
- ただし `window` オブジェクト上に以下のグローバル関数が実在することを確認済み:
  ```json
  ["doSelectFirst", "doSelectPrevious", "doSelectLink", "doSelectNext", "doSelectLast", "narrowStyle", "sortStyle", "addStyle", "editStyle", "delStyle", "unpresentStyle", "presentStyle"]
  ```
  → **`doSelectNext` という関数名の想定は正しい。** ただし実際のonclick属性の文字列(引数の有無等)は複数ページが存在するアカウントで再検証が必要。

### 行クリック → 編集画面遷移

- 詳細へリンク (`editStyle(event, 'L244286488')`) をクリックすると:
  - `location.href` は **変化しない**(`https://salonboard.com/CNB/draft/styleList/` のまま)。
  - しかしDOM内容は完全に「スタイル掲載情報編集」画面(スタイル名・カテゴリ・長さ・メニュー内容・クーポン・ハッシュタグ・モデル情報などの入力フォーム一式)に差し替わる。
  - → サーバー側のPOSTベースの画面遷移(または同一パスへのフォームPOST)によって画面がまるごと再構築されている可能性が高い。SPA的なAjax部分差し替えではなく、フルページの内容がサーバーサイドで再レンダリングされている(スクリーンショットで確認)。
- **結論: `editStyle(event, styleId)` という想定関数呼び出しは正しい。** 実引数は `styleId` 文字列1つのみ(例: `'L244286488'`)。

---

## 3. 掲載管理TOP (`https://salonboard.com/CNB/reflect/reflectTop/`)

### 現在の「NG」「未確認」表示について

- 今回のアカウントの現在の状態では、**個別項目のライブステータスとして「NG」や「未確認」という文字列は表示されていない。**
- 実際に表示されていたライブステータスは **「要確認」**(赤字リンク、クリックで `showErrorPopup('H000750928', styleId等)` が呼ばれる)。対象: サロン掲載情報 / スタイリスト掲載情報 / スタイル掲載情報 の3項目。
- 画面上部の固定注意書きに以下の文言があり、「NG」「未確認」はこの説明文の中にのみ出現する(個別ステータスバッジではない):
  > ※ 掲載チェックに「NG」がある場合、または「未確認の掲載情報」がある場合、「反映申請」ボタンは押せません。

  → **「NG」「未確認」という文字列だけを画面から素朴に検索するスクレイピングは、この注意書き文にヒットして誤検知する。** 実際のステータス判定には「要確認」リンクの有無(または `#font_alert` 配下のリンクテキスト)を見る方が確実。

### 正常時(要確認なし)の項目の表示

- 「要確認」が無い項目(例: メニュー掲載情報)は、チェック列が空欄。
- 反映済みで再反映不要な項目(例: 特集掲載情報・クーポン掲載情報)は、右側に以下のように表示:
  ```
  反映済み
  [反映申請ボタン]
  (2026/03/04 14:20)  ← 直近の反映日時
  ```

### 反映申請ボタンの実HTML

このアカウントには反映申請ボタンが **3つ独立して存在**する(グループごと):

```html
<!-- サロン/スタイリスト/スタイル/メニュー/こだわり グループ用 -->
<button type="button" id="reflectedButton"
        class="common-CNBcommon__primaryBtn common-CNBcommon__primaryBtn--disabled mt4">反映申請</button>

<!-- 特集 グループ用 -->
<button type="button" id="reflectedButtonSpecial"
        class="common-CNBcommon__primaryBtn common-CNBcommon__primaryBtn--disabled mt4">反映申請</button>

<!-- クーポン グループ用 -->
<button type="button" id="reflectedButtonCpn"
        class="common-CNBcommon__primaryBtn common-CNBcommon__primaryBtn--disabled mt4">反映申請</button>
```

- いずれも **inline `onclick` 属性は無い**(別のJSファイルで `id` を起点に `addEventListener` されている想定。イベントハンドラの中身は今回のDOM取得範囲では未確認)。
- 取得したスナップショット時点では3ボタンとも `--disabled` 修飾クラスが付与されていた(サロン/スタイリスト/スタイルに「要確認」が残っているため `reflectedButton` が無効化されているのは注意書き通り。`reflectedButtonSpecial`・`reflectedButtonCpn` も同時点で `--disabled` だったが、これは「要確認」項目が無いことと無関係に「新たに反映すべき変更が無い」ために無効化されている可能性がある。有効化されたボタンのHTML/クラス差分は、実際に未反映の変更がある状態で再調査が必要)。

---

## 未検証・要フォローアップ

1. 複数ページが存在するアカウントでの「次へ」リンクの実onclick文字列(現アカウントはスタイル数が少なく1ページに収まるため未確認)。
2. `reflectedButton` 系が非 `--disabled` になった際の実際のHTML/クリックハンドラの中身。
3. `editStyle` 実行後の画面遷移がPOSTベースかAjaxベースか(ネットワークログのキャプチャは今回未実施)。
