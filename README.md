# Slack User Icon Downloader

Slack Web (app.slack.com) 上で、ワークスペースのメンバーのアイコンを**元画像**で一括ダウンロードするユーザースクリプトです。
Slack App の作成や管理者権限は不要で、ブラウザでログイン中の自分のセッションを使います。

## インストール

1. [Tampermonkey](https://www.tampermonkey.net/) または [Violentmonkey](https://violentmonkey.github.io/) をブラウザに入れる
2. [slack-icon-downloader.user.js](https://raw.githubusercontent.com/SeiyaFunaokaJP/slack-user-icon-downloader/main/slack-icon-downloader.user.js) を開いてインストール

## アップデート

- 上記リンクからインストールした場合、Tampermonkey / Violentmonkey が GitHub の最新版 (`@version`) を定期的に確認して自動更新します
- すぐ更新したい場合: Tampermonkey のダッシュボード → 本スクリプトの「最終更新」欄をクリック、または「ユーティリティ → 更新を確認」
- 手動でコードを貼り付けてインストールした場合は自動更新されないので、一度削除して上記リンクから入れ直してください
- 変更内容は [CHANGELOG.md](CHANGELOG.md) を参照

## 使い方

1. `https://app.slack.com/client/...` を開く
2. 上部ヘッダー右側の **⤓ アイコンDL** を押す
3. 条件を設定して **ユーザー一覧を取得**
4. 表からダウンロードしたいユーザーにチェック (すべて選択 / ページ単位の選択あり)
5. **ダウンロード開始** → `slack-icons_<ワークスペース名>_<日付>.zip` が保存される

### 設定 (ページを開くたびに既定値に戻ります)

| 設定 | 既定 | 説明 |
|---|---|---|
| デフォルトアイコンを除外 | ON | 未設定アイコンの人を一覧から除く |
| 退会済みを含める | OFF | |
| Bot を含める | OFF | |
| 1ページ | 20 人 | 表の1ページあたりの人数 |
| 同時DL | 2 | 並列ダウンロード数 (1〜4) |
| 間隔 | 0.5 秒 | 画像リクエストの最小間隔。全体共通 (最短 0.2 秒) |

### 出力

- 画像: `氏名_表示名.jpg` / `.png` (元画像の形式のまま。片方が空・同じなら片方のみ、同名は ID を付加)
- `_index.csv`: ファイル名・ユーザーID・表示名・氏名・取得元 URL
- `_failed.txt`: 取得できなかったユーザー (ある場合のみ)

## 仕組み

- メンバー一覧: Slack Web クライアントが保持するセッショントークンで `users.list` を呼ぶ (読み取りのみ)
- 画像: `image_original` (アップロードされた元画像) を優先し、無ければ 1024 → 512 … の順
- 429 / 5xx が返った場合は全体を一時停止して再試行

投稿・リアクション・既読など書き込み系の操作は一切行いません。

## 注意

- 大規模ワークスペースではメンバー一覧の取得に時間がかかります
- 取得した画像の権利は各ユーザーに帰属します。利用は各自の責任で、所属ワークスペースの規約に従ってください

## License

[MIT](LICENSE) © 2026 Seiya Funaoka

依存関係のライセンスは [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) を参照 (外部ライブラリの同梱・読み込みはありません)。
