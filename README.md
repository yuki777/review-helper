# review-helper

AIが生成した大きな差分を、人間が現実的にレビューするための「解説つきレビュー画面」ジェネレータ。
Claude Codeプラグインとして配布する（Codex CLIからも同じ手順書で使える）。

## 課題

コーディングエージェントに実装を任せると、100ファイル級の差分が一度に届く。
`git diff` を上から読む方法では、変更の意図が分からないまま眺めることになり、
レビューが形骸化する。

## 仕組み

役割を「機械」と「LLM」で分離している。

```
extract（機械） → diff.json（全hunkにID付番・統計を機械集計）
                 → LLMが annotations.json を書く（グループ分け・意図・指摘。hunk IDで参照）
render（機械）  → 検証（全hunkの割り当て漏れ・重複をチェック） → review.html
serve（機械）   → 画面を配信し、「質問/指摘を送信」を受信箱（comments.json）へ保存
```

- LLMはdiff本文を書き写さないため、差分表示と統計値は常に正確。
- レビュー画面では、変更を意図単位のグループで確認し、グループごとに「確認して承認」する。
- 冒頭の「00 / 背景とコンテキスト」に、PRの背景・解決する問題・要望元・関連リンク
  （GitHub Issue / DocBase / Backlog 等）・初見の人向け用語メモを表示できる
  （annotations.json の `context` 欄。急にレビューへ呼ばれた人の前提知識を補う）。
- 「00 / 背景とコンテキスト」には、機能やPRの必要性を含むレビュー全体への質問・指摘を書ける。
  気になる差分には、hunk全体へのメモに加えて、行クリック／行番号の縦ドラッグ（範囲選択）で
  行コメントを書ける。「質問/指摘をコピー」で全件をプロンプトにまとめてコピーできる。
- serve モードでは、画面の「質問/指摘を送信」で一式が
  `$XDG_DATA_HOME/review-helper/<review-id>/comments.json`
  （受信箱）に保存される。送信のたびに最新スナップショットで上書きされる。
- 送り先（受信するエージェント）は固定されていない。
  - 待機型: `serve --once` を実行したエージェント自身が受信者になる（既存セッションが「待つ」形）
  - プル型: 送信後に画面の「受信箱パスをコピー」でパスをコピーし、
    Codex / Claude Code など好きなエージェントに貼り付けて対応させる

## インストール

### Claude Code（プラグインとして）

```
# GitHubで配布する場合（リポジトリをpush後）
/plugin marketplace add <owner>/review-helper
/plugin install review-helper@review-helper-marketplace

# ローカルで試す場合
/plugin marketplace add ~/tmp/review-helper
/plugin install review-helper@review-helper-marketplace
```

導入後は次のどちらでも使える。

- スラッシュコマンド:
  - `/review-helper:review`: 未コミット差分（HEAD比較）と未追跡ファイル
  - `/review-helper:review https://github.com/owner/repo/pull/123`: 指定PRの差分
  - `/review-helper:review main...feature`: 指定した `git diff` の範囲
- 自然言語: 「この差分のレビュー画面を作って」（skills/review-helper が自動起動する）

### Codex CLI（Agent Skillsとして）

`skills/review-helper/` はAgent Skills互換（frontmatter付きSKILL.md）なので、
共有スキルディレクトリに置くだけでよい。

```sh
mkdir -p ~/.agents/skills
ln -s <クローン先>/skills/review-helper ~/.agents/skills/review-helper
```

以後、Codexに「この差分のレビュー画面を作って」と頼めばスキルとして参照される。
（リポジトリを移動した場合はシンボリックリンクを張り直すこと）

`commands/review.md` と、その中の `${CLAUDE_PLUGIN_ROOT}` はClaude Codeの
スラッシュコマンド専用である。Codexは `skills/review-helper/SKILL.md` を直接読むため、
Codexへの配布では参照されず、問題にならない。

### 前提

- [Bun](https://bun.sh)（CLIの実行に使用。npm依存なし）
- git リポジトリ内で使うこと

## 使い方（CLI直接実行）

```sh
# 1. 抽出（引数なし = 未コミット差分＋未追跡ファイル。引数は git diff にそのまま渡る）
bun skills/review-helper/review-helper.ts extract [main...feature など]

# 1'. 他者の既存PRをレビューする場合（gh CLI必須。checkout不要で作業ツリーも汚さない）
#     PR URLは自動判別されるのでそのまま渡せばよい（番号だけ指定する場合は --pr 123）
bun skills/review-helper/review-helper.ts extract https://github.com/owner/repo/pull/123

# 2. エージェントに skills/review-helper/SKILL.md の手順で annotations.json を書かせる

# 3. 生成（検証エラーがあればIDつきで表示される）
bun skills/review-helper/review-helper.ts render [--no-open]

# 既定ブラウザ以外で開きたい場合（macOS）: アプリ名を環境変数に設定
REVIEW_HELPER_BROWSER=Comet bun skills/review-helper/review-helper.ts render

# 4.（任意）待機型: 送信待ちサーバを起動（実行したエージェント自身が受信者になる）
bun skills/review-helper/review-helper.ts serve --once   # 「質問/指摘を送信」を受けて内容を出力し終了
```

中間ファイルは `$XDG_DATA_HOME/review-helper/<review-id>/` に置く。
`XDG_DATA_HOME` が未設定なら `~/.local/share` を使う。`review-id` は次の人間向け形式になる。

- PR: `ORG-REPO-PR番号`（例: `openai-review-helper-123`）
- Git remoteを取得できるローカル差分: `ORG-REPO-ローカルPathのhash`
- Git remoteがないローカル差分: `--ローカルPathのhash`

PR URLではURL自身、PR番号だけの場合は `gh` が解決したPR URLから `ORG/REPO` を取得する。
まれに別の対象が同じ名前になる場合だけidentity hashを末尾に加え、無言の上書きを防ぐ。
`render` と `serve` は、同じ作業リポジトリで最後に成功した `extract` の保存先を自動的に使う。
そのため複数PRのファイルを保持しながら、通常は保存先を手入力せず利用できる。
`XDG_DATA_HOME` が相対パスの場合はXDG Base Directory仕様に従って無効として扱い、
`~/.local/share` へフォールバックする。

レビュー画面の「対象」には、ローカル差分ならリポジトリの絶対Path、
PRなら指定したPR URLまたは番号を表示する。

## ファイル構成

```
.claude-plugin/
├── plugin.json        # Claude Codeプラグインのマニフェスト
└── marketplace.json   # このリポジトリ自体をマーケットプレイスにする定義
commands/review.md     # /review-helper:review スラッシュコマンド
skills/review-helper/
├── SKILL.md           # エージェント向け手順書（スキーマ・注釈の書き方・実在情報のみ原則）
├── review-helper.ts   # CLI（extract / render / serve）。Bunで動作、npm依存なし
└── template.html      # レビュー画面テンプレート（vanilla JS、外部リソース読み込みなし）
review-helper.test.ts  # 統合テスト（bun test）
```

## セキュリティ上の設計

任意リポジトリの差分（＝任意の文字列）をHTMLに埋め込むため、次を必須要件としている。

- 埋め込みJSONは `<` をすべて `\u003c` にエスケープし、`</script>` によるタグ脱出を防ぐ。
- 画面側の描画は `textContent`（テキストノード）のみ。`innerHTML` に動的文字列を渡さない。
- `context.links` のURLは `http(s)` のみ許可（render検証＋画面側の二重ガード。`javascript:` 注入防止）。
- 外部CDN・外部リソースの読み込みなし。オフラインで開ける単一HTML。
- `serve` は 127.0.0.1 のみにバインドし、他サイト由来のPOST（CSRF）はOriginヘッダ検査で拒否する。
- `serve --once` は最初の1件のみ受理し、終了までの間に届いた重複POSTは409で拒否する。
- 送信は現行diffのstateKeyと照合し、古い画面（再抽出前のタブ）からのPOSTは409で拒否する。

## 制約・未解決事項

- シンタックスハイライトなし（diffの+/-色分けのみ）。
- ローカル差分は作業リポジトリごと、PR差分はPRごとに保持する。`render` / `serve` が扱うのは
  その作業リポジトリで最後に成功した `extract` の1件。
- 同じPRを複数のclone/worktreeから同時に更新する運用は対象外（同じPRの保存先を共有する）。
- 承認状態はブラウザのlocalStorage保存（ブラウザごとに独立）。diff内容が変わると自動リセットされる。
- 「質問/指摘を送信」ボタンは serve（http）経由で開いたときのみ表示される。file:// では「質問/指摘をコピー」を使う。
- `serve` を終了しても `review.html` は削除されない。パスはレビュー画面の
  「00 / 背景とコンテキスト」に常時表示され、送信後はトップバーの「HTMLパスをコピー」でも
  取得できる。ファイルを直接開けば再閲覧でき、「質問/指摘を送信」が必要な場合は
  同じリポジトリで `serve` を再実行する。
- `serve --once` は人間のレビュー完了までブロックするため、エージェントのコマンドタイムアウトが
  短い環境ではバックグラウンド実行＋ログ監視に切り替えること。
