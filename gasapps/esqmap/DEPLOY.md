# esqmap デプロイ手順書 (clasp)

国土地理院の淡色地図にマークを配置する GAS Web アプリ。データはスプレッドシートに保存されます。

## ファイル構成

```
gasapps/esqmap/
├── DEPLOY.md           … この手順書
├── spec.md             … 要件定義書
├── .gitignore          … .clasp.json などを除外
└── src/                … clasp の rootDir (この中だけが GAS に push される)
    ├── appsscript.json … マニフェスト (V8 / Webアプリ設定)
    ├── コード.gs        … バックエンド (doGet / getAllMarks / createMark / updateMark / deleteMark / setup)
    └── index.html      … フロントエンド (Leaflet + Tailwind CSS + Vanilla JS)
```

## 0. 前提

- Node.js 20 以上
- clasp 3.x: `npm install -g @google/clasp`
- Apps Script API を有効化: <https://script.google.com/home/usersettings> で「Google Apps Script API」をオンにする

```bash
clasp login
```

## 1. GAS プロジェクトの作成

以降のコマンドはすべて `gasapps/esqmap/` で実行します。

```bash
cd gasapps/esqmap
```

### 方法A: clasp でスプレッドシートごと作成 (推奨)

`clasp create` は作成直後にリモートのファイルを rootDir に pull するため、`src/` を直接指定すると
`src/appsscript.json` が上書きされます。一時ディレクトリに作成してから rootDir を `src` に付け替えます。

```bash
clasp create --type sheets --title esqmap --rootDir .clasp-init
rm -rf .clasp-init
sed -i 's/"rootDir": ".clasp-init"/"rootDir": "src"/' .clasp.json   # macOS は sed -i ''
```

出力された「Created new document」の URL がデータ保存用スプレッドシートです。

### 方法B: 既存スプレッドシートを使う

1. スプレッドシートを開き「拡張機能 > Apps Script」でスクリプトを作成
2. スクリプトエディタの「プロジェクトの設定」でスクリプト ID をコピー
3. `.clasp.json` を作成

```json
{
  "scriptId": "<スクリプトID>",
  "rootDir": "src"
}
```

## 2. コードの push

```bash
clasp push --force
```

`--force` はリモートのマニフェストを `src/appsscript.json` で上書きするために指定します。
`clasp show-file-status` で push 対象 (`appsscript.json`, `コード.gs`, `index.html`) を確認できます。

## 3. 初期セットアップ (初回のみ)

```bash
clasp open-script
```

スクリプトエディタで関数 `setup` を選択して「実行」し、権限を承認します。

- `Marks` シートとヘッダー行 (`id, title, memo, shape, color, lat, lng, createdAt, updatedAt`) を作成
- 使用するスプレッドシート ID をスクリプトプロパティ `SPREADSHEET_ID` に保存
- スタンドアロンスクリプトの場合は「esqmap データ」スプレッドシートを新規作成 (URL は実行ログに出力)

> Web アプリは「デプロイしたユーザー」として実行されるため、デプロイ前にこの承認を済ませておく必要があります。

## 4. デプロイ

```bash
clasp deploy --description "v1"
```

出力された Deployment ID を控えます。Web アプリの URL は次の形式です。

```
https://script.google.com/macros/s/<DeploymentID>/exec
```

`clasp open-web-app <DeploymentID>` でブラウザを開けます。`clasp deployments` で一覧を確認できます。

### アクセス権限

`src/appsscript.json` の `webapp` で設定しています。

| 項目 | 値 | 意味 |
| --- | --- | --- |
| `executeAs` | `USER_DEPLOYING` | スプレッドシートへはデプロイしたユーザーの権限でアクセス |
| `access` | `ANYONE` | Google アカウントでログインした全員が利用可 |

必要に応じて `access` を `MYSELF` (自分のみ) / `DOMAIN` (同一 Workspace ドメイン) /
`ANYONE_ANONYMOUS` (ログイン不要。URL を知っていれば誰でも編集可能になる点に注意) に変更してください。

## 5. 更新時の再デプロイ

URL を変えずに更新するには、既存の Deployment ID を指定します。

```bash
clasp push --force
clasp deploy --deploymentId <DeploymentID> --description "v2"
```

`--deploymentId` を省略すると新しい URL のデプロイが作成されます。
動作確認だけなら、スクリプトエディタの「デプロイ > デプロイをテスト」で最新コードの `/dev` URL を利用できます。

## ローカルでの UI 確認

`src/index.html` は `google.script.run` が無い環境では開発用のインメモリモックで動作します
(データはリロードで消えます)。

```bash
cd src && python3 -m http.server 8000
# http://localhost:8000/index.html を開く
```

## トラブルシューティング

| 症状 | 対処 |
| --- | --- |
| `User has not enabled the Apps Script API` | 「0. 前提」の Apps Script API を有効化 |
| 「スプレッドシートが見つかりません」 | スクリプトエディタで `setup` を実行 |
| 「サーバーが混み合っています」 | 同時書き込みでロック (10秒) を取得できなかった。少し待って再操作 |
| 現在地ボタンが動かない | ブラウザ/OS の位置情報許可を確認 (HTTPS の `/exec` URL で開く) |
| 他端末の変更が見えない | 一覧ドロワーの「再読込」でサーバーの最新状態を取得 |
