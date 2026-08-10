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

## 追記(2026-08-09 再調査): window上の主要関数一括検証は未完了(要フォローアップ)

`dologin` / `editStyle` / `addStyle` / `delStyle` / `unpresentStyle` / `presentStyle` /
`doSelectFirst` / `doSelectPrevious` / `doSelectLink` / `doSelectNext` / `doSelectLast` を
Playwright(非headless)で一つずつ実機検証する試みを行ったが、**この日のうちに
salonboard.comへ何度もPlaywright/curlでアクセスした結果、Akamai系のボット対策と
思われる仕組みによって接続がほぼ完全にブロックされる状態になった**(ログイン後の
スタイル一覧ページへの`page.goto`が繰り返しタイムアウトし、素の`curl`でも
0バイトのままタイムアウトする状態を確認)。そのため、今回は以下の1点のみ確定し、
残りは**未確認のまま**である。

### 確定した事実(本番エラーより)

- 本番(Cloudflare Browser Rendering)で `window.doSelectNext()` を偽のevent無しで
  直接呼び出すと、実際に **`Cannot read properties of undefined (reading 'target')`**
  というエラーが発生することを確認した。
- これは `dologin`/`editStyle` と同様、`doSelectNext` の実装内部が `event`(おそらく
  `event.target`)を参照する作りになっていることを強く示唆する。

### 上記を踏まえた対応方針(⚠️ 類推による修正・実HTML未確認)

`src/lib/salonboard-import.ts` の `fetchExistingStyles()` 内のページ送り処理を、
`window.doSelectNext()` の直接呼び出しから、**`a[onclick*="doSelectNext"], span[onclick*="doSelectNext"]`
にマッチする実要素を探して `page.click()` でネイティブクリックする方式**に変更した。
これは `dologin`・`editStyle` で既に実機確認・修正済みの「実要素をclickする」パターンを
そのまま踏襲したものであり、**「次へ」リンクの実際のonclick文字列・class名・タグ名は
今回まだ実機確認できていない**(`a[onclick*="doSelectNext"]`という部分一致セレクタで
実際にヒットするかどうかも未確認)。

このため、安全策として以下を実装した:
- 上記セレクタで実要素が見つからない場合、または見つかったがクリック/遷移待ちで
  例外が発生した場合は、**エラーにせず「次のページなし」として扱い**、
  それまでに取得できたページの結果だけを返して処理を継続する。
- これにより、たとえ推測(セレクタ)が外れていたとしても、少なくとも1ページ目分の
  取り込みは失敗せずに完了する。

### 次回実機検証が必要な項目(まとめ)

1. `doSelectNext`(および `doSelectFirst`/`doSelectPrevious`/`doSelectLink`/`doSelectLast`)
   に対応する実要素の実際のタグ・class・onclick文字列。複数ページが存在するアカウントで
   実際に「次へ」をクリックし、遷移後の1件目のstyleIdが変化することの確認。
2. `addStyle`(新規スタイル追加ボタン)の実HTML・クリック後の画面。
3. `delStyle`・`unpresentStyle`・`presentStyle` の関数ソース(`toString()`)による
   event依存の有無の確認(**破壊的操作のため実際に呼び出してはいけない**。ソースの
   静的確認のみに留めること)。
4. `reflectedButton` 系が非 `--disabled` になった際の実際のHTML/クリックハンドラの中身。
5. `editStyle` 実行後の画面遷移がPOSTベースかAjaxベースか(ネットワークログのキャプチャは未実施)。

**方針:** 同日中の salonboard.com への追加アクセス(Playwright/curl問わず)は、
ブロックがさらに長引くリスクを避けるため見送り、実機での最終確認は
時間を置いてから(翌日以降を目安に)改めて行う。

---

## 4. 画像アップロードモーダル (2026-08-09、ユーザー本人のDevToolsスクリーンショットにより確定)

スタイル編集画面で画像プレースホルダー(`#FRONT_IMG_ID_IMG`)をクリックすると開く
「画像アップロード」ポップアップの内部構造。

```html
<div class="imageUploaderModalInner">
  <div class="imageUploaderModalDropArea jscImageUploaderModalDropArea is-Active">
    <div id="uploadError" class="dn"></div>
    <div class="imageUploaderModalDropAreaIcon jscImageUploaderModalDropAreaIcon">...</div>
    <p class="imageUploaderModalDropAreaText">...</p>
    <label class="imageUploaderModalInput">
      ファイルを選択
      <input type="file" name="formFile" id="formFile" class="jscImageUploaderModalInput">
    </label>
  </div>
  <div class="imageUploaderModalThumbnailArea jscImageUploaderModalThumbnailArea">...</div>
  <p class="imageUploaderModalCopyrightText">...</p>
  <div class="imageUploaderModalBottomButton">
    <!-- 「閉じる」「登録する」ボタン。「登録する」はファイル未選択時グレーアウト(disabled) -->
  </div>
</div>
```

- **`#imageUploaderModalBody`という要素IDは実際には存在しない**(旧実装の推測が誤りだった)。
- 実際のファイル入力は `#formFile`(`input[name="formFile"]`)。

### 4-1. モーダル内「登録する」ボタン(2026-08-09、ユーザーがHTMLを直接貼付・確定)

```html
<input type="button" class="imageUploaderModalSubmitButton jscImageUploaderModalSubmitButton isActive" value="登録する">
```

**`<button>`/`<a>`ではなく`<input type="button">`だった。** 旧実装は
`.imageUploaderModalBottomButton button, .imageUploaderModalBottomButton a`
というセレクタで探していたため、このボタンには絶対にヒットしていなかった
(画像アップロードが完了しない実際の原因だったと考えられる)。
正しいセレクタは`input.jscImageUploaderModalSubmitButton`。`isActive`クラスの
有無で活性化状態を判定する。

### 4-2. フォーム全体の最終「登録」ボタン(2026-08-09確定)

```html
<img src="https://imgbp.salonboard.com/CNB/img/bns_btn4_toroku_B.gif" border="0" alt="登録">
```

画像ベースのボタン。おそらく`<a onclick="doRegister(event); return false;">`に
包まれている(login/editStyle等、このサイトの他のボタンと同じパターン)。
現行コードは属性セレクタ`[onclick*="doRegister("]`(タグ種別を問わない)を
使っているため、この点は修正不要と判断。

---

## 追記(2026-08-09、本番実行ログから判明: 「登録失敗」の真因は画像アップロード完了待ちのタイムアウト)

本番のTETE AOUT(`https://hotpepper-automation.pages.dev`)で「手動実行する」を
繰り返し実行し、これまで握りつぶされていた`draftRegisterStyle()`内部の
診断ログ(送信前セルフチェック・登録確認失敗時の詳細)を実際に記録するよう
修正した上で再実行したところ、以下が判明した:

- 送信直前のセルフチェックで **`frontImgId`(=`#FRONT_IMG_ID`隠しフィールドの値)が
  空文字列** のまま`doRegister()`まで進んでいた。
- その直前のログに **「警告: 画像アップロード完了の検知がタイムアウトしました。
  処理は続行しますが要確認です。」** が記録されていた。
- つまり、`uploadFrontImage()`内の完了待ち(`#FRONT_IMG_ID`が非空になるのを
  最大20秒待つ`waitForFunction`)がタイムアウトし、警告ログのみで処理を
  「続行」してしまい、画像が実際には設定されないまま残りのフィールドを
  埋めて送信 → salonboard.com側のサーバーバリデーションで(必須の画像が
  無いため)確実に弾かれ、`/CNB/draft/styleEdit/`(同じ編集フォーム)に
  差し戻される、という流れだった。
- 差し戻された画面には`#styleId`(空のまま)と、無関係な固定文言
  (「※ヘアスタイル特集を設定しているスタイル枚数が上限を超えている場合...」)
  のみが見え、一見原因不明に見えていたが、実際の原因は「そもそも画像が
  アップロードされていなかった」といういたってシンプルな話だった。
- StylePost(競合製品)の同期履歴でも「画像アップロードがアクセス集中のため
  失敗しました」という記録が複数見られており、salonboard.com側の画像
  アップロード処理自体が本質的に低速/不安定な可能性が高い。20秒という
  待機時間はそもそも短すぎた可能性がある。

### 対応(コード修正)

`uploadFrontImage()`(`src/lib/salonboard-automation.ts`)を以下のように修正:
1. アップロード完了待ちのタイムアウトを20秒→45秒に延長。
2. タイムアウトしても警告ログのみで処理を続行していたのをやめ、
   明確に例外を投げて即座に失敗として扱うように変更(画像なしでの
   確実に失敗する送信を防ぎ、実行1回分の浪費を避けるため)。

### 今後の検討事項(未着手)

- 45秒でも足りない場合に備え、アップロード自体のリトライ処理の追加。
- アップロードモーダルの「登録する」ボタン(`input.jscImageUploaderModalSubmitButton`)
  クリック後、実際にどんなネットワークリクエストが飛んでいるか(URL・
  レスポンス)をDevTools Networkタブで確認できると、真の原因(salonboard側の
  遅延なのか、こちらの実装の不備なのか)をより確実に切り分けられる
  (今回は実施できていない)。

---

## 追記(2026-08-09、StylePost調査から発見: `?styleId=`クエリパラメータ直リンクが機能する)

ユーザー指示によりStylePost(競合製品)のスタイル一覧ページ
(`https://style-post.com/w/style/style-list`、閲覧のみ・変更操作なし)を
再調査したところ、全118件のスタイル行が
`https://salonboard.com/CNB/draft/styleEdit/?styleId=Lxxxxxxxxx`
という**salonboard.com本物への直リンク**になっていることを確認した。

自アカウントの既知styleId(`L244286488`)でこのURLパターンを実機検証した結果:
```json
{
  "url": "https://salonboard.com/CNB/draft/styleEdit/?styleId=L244286488",
  "formFound": true,
  "styleIdValue": "L244286488",
  "styleNameValue": "白髪もキレイに魅せる、大人の艶カラーショート"
}
```
**正しく該当スタイルの編集画面が開き、`#styleId`・`#styleNameTxt`とも実データと
一致することを確認した。** つまり、一覧ページを開いて`editStyle(event, styleId)`
リンクを探してクリックする(ページネーションの影響を受ける)従来方式に代えて、
`page.goto('.../CNB/draft/styleEdit/?styleId=' + styleId)` で直接遷移すれば
確実に対象の編集画面を開ける。

### 対応(コード修正)

- `fetchStyleDetail()`(`src/lib/salonboard-import.ts`): 一覧ページ経由の
  クリック方式から、この直リンクへのgoto()に置き換えた。これにより
  「対象スタイルが一覧の何ページ目にあるか探す」という、doSelectNext等の
  ページネーション実装の不確実性に一切依存しなくなった。
- `draftRegisterStyle()`の登録成功判定(`src/lib/salonboard-automation.ts`):
  `#styleId`隠しフィールドに加えて、現在のURLに`styleId=L\d{9}`パターンが
  含まれるかも確認するようにし、どちらか一方で確認できれば成功とする
  冗長化を行った(doRegister()成功時にこのURL形式へ遷移する可能性がある
  ため)。

### 応用の余地(今後の検討)

- `unpresentStyle`/`delStyle`等、他のstyleId操作についても、同様の
  クエリパラメータ形式のURLが使えないか調査の価値がある。
- StylePostは「オリジナルID」という独自の内部連番IDと、salonboardの
  styleId(L+9桁)を並べて管理しており(スタイル一覧のスクリーンショット参照)、
  これは弊アプリの`styles.id`(内部ID)と`source_salonboard_style_key`
  (salonboard側styleId)の関係と概ね同じ設計。特に目新しい実装の余地は
  見当たらなかったが、設計方針が近いことの確認にはなった。

---

## 追記(2026-08-09、画像アップロードをUI操作からfetch()直接呼び出しに全面変更)

ユーザーが自身のブラウザのDevTools NetworkタブでdoUploadリクエストの
リクエスト内容・レスポンス内容の両方を実際にキャプチャして提供してくれた。
これにより、画像アップロードモーダルのUI操作(クリック・ファイル選択・
「登録する」ボタン)を一切経由しない、確実な実装に切り替えられた。

### リクエスト仕様(実機DevToolsで確認済み)

```
POST https://salonboard.com/CNB/imgreg/imgUpload/doUpload?wFlg=true
Content-Type: multipart/form-data

formFile: (画像バイナリ)
setImgId: FRONT_IMG_ID
dataKey: (空文字)
targetActionId: ABNKD3600_FRONT
org.apache.struts.taglib.html.TOKEN: (ページ内の同名隠しフィールドの値。
  スタイル編集画面内の複数フォームすべてで同一値であることを実機確認済み
  なので、ページ内のどのフォームから拾っても良い)
STORE_ID: (ページ内の同名隠しフィールドの値、例: H000750928)
modified: 0
pubManageId: undefined  (リテラル文字列。理由不明だが観測された挙動を
  そのまま再現)
```

### レスポンス仕様(実機DevToolsで確認済み)

モーダルHTML片(`wFlg=false`版)が返るが、その中の非表示div内に以下の
隠しフィールドとして必要な情報が全て含まれている:

```html
<div class="dn">
  <input type="hidden" name="userErrorFlg" value="0" id="userErrorFlg">
  <input type="hidden" name="imageId" value="B267912835" id="imageId">
  <input type="hidden" name="setImgId" value="FRONT_IMG_ID" id="elementName">
  <input type="hidden" name="meetStandardFlg" value="false" id="meetStandardFlg">
  <input type="hidden" name="lengthSizeOrg" value="1600" id="lengthSizeOrg">
  <input type="hidden" name="sideSizeOrg" value="1200" id="sideSizeOrg">
  <input type="hidden" name="resolutionOrg" value="72" id="resolutionOrg">
  <input type="hidden" name="imageFilePath"
    value="https://imgbp.salonboard.com/IMGDB_HD/28/35/B267912835/B267912835.jpg?impolicy=SB_policy_default&amp;w=180&amp;h=240"
    id="imageFilePath">
</div>
```

これはページ内に実在するJSコールバック関数
`setUploadImage(imageId, setImgId, meetStandardFlg, lengthSize, sideSize, resolution, imageFilePath)`
(HANDOFF.md 4-5に既出)の引数と完全に一致する形式である。

### 対応(コード修正)

`uploadFrontImage()`(`src/lib/salonboard-automation.ts`)を全面書き換え:
1. `page.evaluate()`内で上記フィールドを組み立て、`fetch()`で直接POST。
2. レスポンスHTMLを`DOMParser`でパースし、上記の値を抽出。
3. DOM更新(サムネイル表示・隠しフィールド更新等)を自前で再実装せず、
   ページ上に実在する`window.setUploadImage()`をそのまま呼び出すことで
   サイト本来の更新ロジックに委ねる。

これにより、プレースホルダークリック→モーダル検出待ち→ファイル注入→
「登録する」ボタンの活性化待ち・クリック→完了検知のポーリング、という
一連のUI操作(と、それに伴うisTrusted関連の不確実性)が全て不要になった。

⚠️ 本番実機での動作確認はまだ(salonboard.comへの直接アクセスを控える
方針のため、ユーザーによるTETE AOUT本番サイトでの「手動実行する」経由の
確認が必要)。

---

## 旧: 未検証・要フォローアップ(2026-08-09 初回調査時点)

1. 複数ページが存在するアカウントでの「次へ」リンクの実onclick文字列(現アカウントはスタイル数が少なく1ページに収まるため未確認)。
2. `reflectedButton` 系が非 `--disabled` になった際の実際のHTML/クリックハンドラの中身。
3. `editStyle` 実行後の画面遷移がPOSTベースかAjaxベースか(ネットワークログのキャプチャは今回未実施)。
