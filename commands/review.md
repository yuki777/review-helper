---
description: 解説つきレビュー画面を生成し、人間の質問/指摘に対応する
argument-hint: "[git diffの範囲 または PRのURL（省略時: 未コミット差分＋未追跡ファイル）]"
---

${CLAUDE_PLUGIN_ROOT}/skills/review-helper/SKILL.md を読み、その手順に従ってください。

- レビュー対象: $ARGUMENTS （未指定なら未コミット差分＋未追跡ファイル。
  `https://github.com/<org>/<repo>/pull/<番号>` 形式のPR URLなら extract がそのまま自動判別する）
- 手順6（`serve --once` での送信待ち）まで実行し、受信した**質問には回答し、指摘には対応**してください。
- **送信を受け取る前にターンを終えないこと**。`serve --once` は実行時間制限を最大にして
  フォアグラウンドで待つ。待ちきれない場合はバックグラウンド起動＋`comments.json` 出現の
  ポーリング待ちに切り替え、受信に応答してから終了する（SKILL.mdの「待機の注意」参照）。
