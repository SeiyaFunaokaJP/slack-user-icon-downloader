# Slack User Icon Downloader

Slack Web (app.slack.com) 上で、ワークスペースのメンバーのアイコンを**元画像**で一括ダウンロードするユーザースクリプトです。
Slack App の作成や管理者権限は不要で、ブラウザでログイン中の自分のセッションを使います。

## インストール

1. [Tampermonkey](https://www.tampermonkey.net/) または [Violentmonkey](https://violentmonkey.github.io/) をブラウザに入れる
2. [slack-icon-downloader.user.js](https://github.com/SeiyaFunaokaJP/slack-user-icon-downloader/raw/refs/heads/main/slack-icon-downloader.user.js) を開いてインストール

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
| ファイル名 | `{real}[_{display}]` | 保存ファイル名のテンプレート (下記)。入力すると表の「保存ファイル名」に即反映 |

### ファイル名テンプレート

| プレースホルダー | 内容 |
|---|---|
| `{real}` | 氏名 |
| `{display}` | 表示名 |
| `{username}` | ユーザー名 (@ の後ろ) |
| `{id}` | ユーザーID (`U...`) |
| `{title}` | 役職 |

`[ ]` で囲んだ部分は、中のプレースホルダーが**空**、または**すでに名前に入っている値と同じ**なら丸ごと省略されます。

| テンプレート | 氏名 Tanaka Taro / 表示名 taro | 氏名 山田 花子 / 表示名なし | 氏名・表示名とも suzuki |
|---|---|---|---|
| `{real}[_{display}]` (既定) | `Tanaka Taro_taro` | `山田 花子` | `suzuki` |
| `{display}[ ({real})]` | `taro (Tanaka Taro)` | `(山田 花子)` | `suzuki` |
| `[{display}_]{real}` | `taro_Tanaka Taro` | `山田 花子` | `suzuki` |
| `{id}_{real}` | `U01AAAAAAAA_Tanaka Taro` | `U02BBBBBBBB_山田 花子` | `U03CCCCCCCC_suzuki` |

- 拡張子は元画像の形式 (`.jpg` / `.png` など) が自動で付きます
- ファイル名に使えない文字 (`\ / : * ? " < > |`) は `_` に置換、結果が空ならユーザーID
- 未知のプレースホルダー (`{foo}` など) はそのまま残ります

### 出力

- 画像: テンプレートに従った名前 + 元画像の拡張子 (同名が重複した場合は ` (ユーザーID)` を付加)
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
