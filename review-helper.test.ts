/**
 * stateKey安定性の回帰テスト。
 * 「同じ差分なら、extractを再実行しても承認・メモのキー（stateKey）と注釈が維持される」
 * という契約を守る。stateKeyの算出にcreatedAt等の揮発値が混入すると失敗する。
 */
import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  appendFileSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const CLI = join(import.meta.dir, "skills/review-helper/review-helper.ts");
const TEST_DATA_HOME = mkdtempSync(join(tmpdir(), "review-helper-xdg-tests-"));

afterAll(() => {
  rmSync(TEST_DATA_HOME, { recursive: true, force: true });
});

function repoRootOf(repo: string): string {
  const top = Bun.spawnSync(
    ["git", "-c", "core.quotePath=false", "rev-parse", "--show-toplevel"],
    { cwd: repo, stdout: "pipe", stderr: "pipe" },
  );
  if (top.exitCode !== 0) throw new Error(`GitリポジトリPathを取得できません: ${repo}`);
  return top.stdout.toString().trim();
}

function pointerPathOf(repo: string, dataHome = TEST_DATA_HOME): string {
  const repoRoot = repoRootOf(repo);
  const pointerKey = createHash("sha256").update(repoRoot).digest("hex").slice(0, 16);
  return join(dataHome, "review-helper", ".current", `${pointerKey}.json`);
}

function reviewDir(repo: string, dataHome = TEST_DATA_HOME): string {
  const pointer = JSON.parse(readFileSync(pointerPathOf(repo, dataHome), "utf-8")) as {
    reviewId: string;
  };
  return join(dataHome, "review-helper", pointer.reviewId);
}

function run(args: string[], cwd: string, env: Record<string, string> = {}): { code: number; out: string } {
  const p = Bun.spawnSync(["bun", CLI, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, XDG_DATA_HOME: TEST_DATA_HOME, ...env },
  });
  return { code: p.exitCode ?? 1, out: p.stdout.toString() + p.stderr.toString() };
}

function stateKeyOf(repo: string): string {
  const html = readFileSync(join(reviewDir(repo), "review.html"), "utf-8");
  const m = html.match(/"stateKey":"([0-9a-f]+)"/);
  if (!m) throw new Error("review.html に stateKey が見つかりません");
  return m[1];
}

/** diff.json の全hunkを1グループに割り当てた最小の注釈を書く */
function writeAnnotations(repo: string, extra: Record<string, unknown> = {}) {
  const diff = JSON.parse(readFileSync(join(reviewDir(repo), "diff.json"), "utf-8"));
  const ids = diff.files.flatMap((f: { hunks: { id: string }[] }) => f.hunks.map((h) => h.id));
  writeFileSync(
    join(reviewDir(repo), "annotations.json"),
    JSON.stringify({
      title: "テストレビュー",
      groups: [{ title: "全変更", risk: "low", intent: "テスト用の注釈", hunks: ids }],
      ...extra,
    }),
  );
}

test("中間ファイルはXDG_DATA_HOME配下でリポジトリごとに分離される", () => {
  const dataHome = mkdtempSync(join(tmpdir(), "review-helper-custom-xdg-"));
  const parent1 = mkdtempSync(join(tmpdir(), "review-helper-xdg-parent1-"));
  const parent2 = mkdtempSync(join(tmpdir(), "review-helper-xdg-parent2-"));
  const repo1 = join(parent1, "same-name");
  const repo2 = join(parent2, "same-name");
  mkdirSync(repo1);
  mkdirSync(repo2);
  try {
    for (const repo of [repo1, repo2]) {
      expect(Bun.spawnSync(["git", "init", "-q"], { cwd: repo }).exitCode).toBe(0);
      writeFileSync(join(repo, "a.txt"), `${basename(repo)}\n`);
      const result = run(["extract"], repo, { XDG_DATA_HOME: dataHome });
      expect(result.code).toBe(0);
      expect(result.out).toContain(reviewDir(repo, dataHome));
      expect(existsSync(join(reviewDir(repo, dataHome), "diff.json"))).toBe(true);
      expect(existsSync(join(repo, ".git/review-helper"))).toBe(false);
      expect(basename(reviewDir(repo, dataHome))).toMatch(/^--[0-9a-f]{8}$/);
    }
    expect(reviewDir(repo1, dataHome)).not.toBe(reviewDir(repo2, dataHome));

    const fallbackHome = mkdtempSync(join(tmpdir(), "review-helper-fallback-home-"));
    try {
      const fallback = run(["extract"], repo1, {
        XDG_DATA_HOME: "relative/data",
        HOME: fallbackHome,
      });
      expect(fallback.code).toBe(0);
      expect(fallback.out).toContain("相対パスの XDG_DATA_HOME は無効");
      expect(
        existsSync(join(reviewDir(repo1, join(fallbackHome, ".local", "share")), "diff.json")),
      ).toBe(true);
    } finally {
      rmSync(fallbackHome, { recursive: true, force: true });
    }

    const emptyHome = mkdtempSync(join(tmpdir(), "review-helper-empty-xdg-home-"));
    try {
      const emptyFallback = run(["extract"], repo1, {
        XDG_DATA_HOME: "",
        HOME: emptyHome,
      });
      expect(emptyFallback.code).toBe(0);
      expect(emptyFallback.out).toContain(
        reviewDir(repo1, join(emptyHome, ".local", "share")),
      );
    } finally {
      rmSync(emptyHome, { recursive: true, force: true });
    }
  } finally {
    rmSync(dataHome, { recursive: true, force: true });
    rmSync(parent1, { recursive: true, force: true });
    rmSync(parent2, { recursive: true, force: true });
  }
});

test("引数なしextractはstaged・unstaged・未追跡ファイルをすべて含む", () => {
  const repo = mkdtempSync(join(tmpdir(), "review-helper-default-range-test-"));
  try {
    expect(Bun.spawnSync(["git", "init", "-q"], { cwd: repo }).exitCode).toBe(0);
    writeFileSync(join(repo, "tracked.txt"), "base\n");
    expect(Bun.spawnSync(["git", "add", "tracked.txt"], { cwd: repo }).exitCode).toBe(0);
    expect(
      Bun.spawnSync(
        ["git", "-c", "user.name=review-helper-test", "-c", "user.email=test@example.com", "commit", "-qm", "initial"],
        { cwd: repo },
      ).exitCode,
    ).toBe(0);

    writeFileSync(join(repo, "tracked.txt"), "base\nunstaged\n");
    writeFileSync(join(repo, "staged.txt"), "staged\n");
    expect(Bun.spawnSync(["git", "add", "staged.txt"], { cwd: repo }).exitCode).toBe(0);
    writeFileSync(join(repo, "untracked.txt"), "untracked\n");

    const result = run(["extract"], repo);
    expect(result.code).toBe(0);
    const diff = JSON.parse(readFileSync(join(reviewDir(repo), "diff.json"), "utf-8"));
    expect(diff.rangeLabel).toContain("未コミット差分");
    expect(diff.files.map((file: { path: string }) => file.path).sort()).toEqual([
      "staged.txt",
      "tracked.txt",
      "untracked.txt",
    ]);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("ローカル差分の保存先はHTTPS・scp・ssh形式のoriginから同じORG/REPOを読める", () => {
  const repo = mkdtempSync(join(tmpdir(), "review-helper-remote-test-"));
  const dataHomes = [
    mkdtempSync(join(tmpdir(), "review-helper-remote-https-")),
    mkdtempSync(join(tmpdir(), "review-helper-remote-scp-")),
    mkdtempSync(join(tmpdir(), "review-helper-remote-ssh-")),
  ];
  const remotes = [
    "https://github.com/acme/widget.git",
    "git@github.com:acme/widget.git",
    "ssh://git@github.com/acme/widget.git",
  ];
  try {
    expect(Bun.spawnSync(["git", "init", "-q"], { cwd: repo }).exitCode).toBe(0);
    writeFileSync(join(repo, "a.txt"), "hello\n");
    expect(
      Bun.spawnSync(["git", "remote", "add", "origin", remotes[0]], { cwd: repo }).exitCode,
    ).toBe(0);

    const ids: string[] = [];
    for (let i = 0; i < remotes.length; i++) {
      expect(
        Bun.spawnSync(["git", "remote", "set-url", "origin", remotes[i]], { cwd: repo })
          .exitCode,
      ).toBe(0);
      expect(run(["extract"], repo, { XDG_DATA_HOME: dataHomes[i] }).code).toBe(0);
      ids.push(basename(reviewDir(repo, dataHomes[i])));
    }
    expect(new Set(ids).size).toBe(1);
    expect(ids[0]).toMatch(/^acme-widget-[0-9a-f]{8}$/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    for (const dataHome of dataHomes) rmSync(dataHome, { recursive: true, force: true });
  }
});

test("壊れた最新レビュー参照はrenderで拒否し、extract失敗では前回参照を維持する", () => {
  const repo = mkdtempSync(join(tmpdir(), "review-helper-pointer-test-"));
  try {
    expect(Bun.spawnSync(["git", "init", "-q"], { cwd: repo }).exitCode).toBe(0);
    writeFileSync(join(repo, "a.txt"), "hello\n");
    expect(run(["extract"], repo).code).toBe(0);
    const pointerPath = pointerPathOf(repo);
    const validPointer = readFileSync(pointerPath, "utf-8");

    const failed = run(["extract", "not-a-valid-revision"], repo);
    expect(failed.code).toBe(1);
    expect(readFileSync(pointerPath, "utf-8")).toBe(validPointer);

    writeFileSync(pointerPath, JSON.stringify({ reviewId: "../escape" }));
    const unsafe = run(["render", "--no-open"], repo);
    expect(unsafe.code).toBe(1);
    expect(unsafe.out).toContain("最新レビューの参照ファイルが壊れています");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("同一diffなら再extract→renderでもstateKeyが変わらず、annotationsも保持される", () => {
  const repo = mkdtempSync(join(tmpdir(), "review-helper-test-"));
  try {
    expect(Bun.spawnSync(["git", "init", "-q"], { cwd: repo }).exitCode).toBe(0);
    writeFileSync(join(repo, "a.txt"), "hello\nworld\n");

    // 初回: extract → 注釈 → render
    expect(run(["extract"], repo).code).toBe(0);
    writeAnnotations(repo);
    expect(run(["render", "--no-open"], repo).code).toBe(0);
    const key1 = stateKeyOf(repo);
    writeFileSync(join(reviewDir(repo), "comments.json"), "{}"); // 受信箱に見立てたダミー

    // 同一内容のまま再extract: 注釈は保持され、stateKeyも同一（承認・メモが維持される）
    const re = run(["extract"], repo);
    expect(re.code).toBe(0);
    expect(re.out).toContain("保持しました");
    expect(existsSync(join(reviewDir(repo), "annotations.json"))).toBe(true);
    expect(existsSync(join(reviewDir(repo), "comments.json"))).toBe(true); // 同一diffでは受信箱も保持
    expect(run(["render", "--no-open"], repo).code).toBe(0);
    expect(stateKeyOf(repo)).toBe(key1);

    // 差分が変わったら: 古い注釈は破棄され、stateKeyも変わる（状態の自動リセット）
    appendFileSync(join(repo, "a.txt"), "changed\n");
    expect(run(["extract"], repo).code).toBe(0);
    expect(existsSync(join(reviewDir(repo), "annotations.json"))).toBe(false);
    expect(existsSync(join(reviewDir(repo), "comments.json"))).toBe(false); // diff変更で古い受信箱も削除
    writeAnnotations(repo);
    expect(run(["render", "--no-open"], repo).code).toBe(0);
    expect(stateKeyOf(repo)).not.toBe(key1);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("serve --once は画面からの送信を受けて指摘プロンプトを出力して終了する", async () => {
  const repo = mkdtempSync(join(tmpdir(), "review-helper-serve-test-"));
  try {
    expect(Bun.spawnSync(["git", "init", "-q"], { cwd: repo }).exitCode).toBe(0);
    writeFileSync(join(repo, "a.txt"), "hello\n");
    expect(run(["extract"], repo).code).toBe(0);
    writeAnnotations(repo);
    expect(run(["render", "--no-open"], repo).code).toBe(0);

    const proc = Bun.spawn(["bun", CLI, "serve", "--once", "--no-open", "--port", "45990"], {
      cwd: repo,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, XDG_DATA_HOME: TEST_DATA_HOME },
    });
    try {
      // 実サーバの起動完了は起動バナーの出力で待つ（実プロセスのI/O待ちのため、fake timerでは代替できない）
      const decoder = new TextDecoder();
      const reader = proc.stdout.getReader();
      let output = "";
      while (!output.includes("レビューサーバ起動")) {
        const { done, value } = await reader.read();
        if (done) break;
        output += decoder.decode(value, { stream: true });
      }
      const m = output.match(/レビューサーバ起動: (http:\/\/127\.0\.0\.1:\d+)\//);
      if (!m) {
        const errorOutput = await new Response(proc.stderr).text();
        throw new Error(`起動バナーが見つかりません: ${output}${errorOutput}`);
      }
      const base = m[1];

      // CSRF対策: 他オリジン由来のPOSTは403で拒否される
      const evil = await fetch(`${base}/api/comments`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://evil.example" },
        body: JSON.stringify({ prompt: "悪意ある注入" }),
      });
      expect(evil.status).toBe(403);

      // 古い画面からの誤送信ガード: stateKey不一致は409で拒否され、受信箱も作られない
      const stale = await fetch(`${base}/api/comments`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: base },
        body: JSON.stringify({ prompt: "古いタブからの送信", stateKey: "deadbeef", items: [] }),
      });
      expect(stale.status).toBe(409);
      const staleBody = await stale.json(); // Response.json() は any を返すためキャスト不要
      expect(staleBody.error).toBe("stale-state");
      expect(existsSync(join(reviewDir(repo), "comments.json"))).toBe(false);

      // 正規の送信: 受理され、--once なのでプロンプトを出力して終了する
      const ok = await fetch(`${base}/api/comments`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: base },
        body: JSON.stringify({
          prompt: "全体質問: この機能は本当に必要ですか？",
          stateKey: stateKeyOf(repo),
          items: [
            {
              scope: "context",
              section: "背景・コンテキスト / レビュー全体",
              memo: "この機能は本当に必要ですか？",
            },
          ],
        }),
      });
      expect(ok.ok).toBe(true);

      expect(await proc.exited).toBe(0);
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        output += decoder.decode(value, { stream: true });
      }
      expect(output).toContain("全体質問: この機能は本当に必要ですか？");
      const inboxPath = join(reviewDir(repo), "comments.json");
      expect(existsSync(inboxPath)).toBe(true);
      const inbox = JSON.parse(readFileSync(inboxPath, "utf-8"));
      expect(inbox.items[0]).toEqual({
        scope: "context",
        section: "背景・コンテキスト / レビュー全体",
        memo: "この機能は本当に必要ですか？",
      });
    } finally {
      proc.kill();
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("serve --once は並行POSTを1件だけ受理し、残りを409で拒否する", async () => {
  const repo = mkdtempSync(join(tmpdir(), "review-helper-dup-test-"));
  try {
    expect(Bun.spawnSync(["git", "init", "-q"], { cwd: repo }).exitCode).toBe(0);
    writeFileSync(join(repo, "a.txt"), "hello\n");
    expect(run(["extract"], repo).code).toBe(0);
    writeAnnotations(repo);
    expect(run(["render", "--no-open"], repo).code).toBe(0);

    const proc = Bun.spawn(["bun", CLI, "serve", "--once", "--no-open", "--port", "45990"], {
      cwd: repo,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, XDG_DATA_HOME: TEST_DATA_HOME },
    });
    try {
      // 実サーバの起動完了は起動バナーの実出力で待つ（実プロセスのI/O待ちのため、fake timerでは代替できない）
      const decoder = new TextDecoder();
      const reader = proc.stdout.getReader();
      let output = "";
      while (!output.includes("レビューサーバ起動")) {
        const { done, value } = await reader.read();
        if (done) break;
        output += decoder.decode(value, { stream: true });
      }
      const m = output.match(/レビューサーバ起動: (http:\/\/127\.0\.0\.1:\d+)\//);
      if (!m) {
        const errorOutput = await new Response(proc.stderr).text();
        throw new Error(`起動バナーが見つかりません: ${output}${errorOutput}`);
      }
      const base = m[1];

      // 3件を同時送信 → 受理はちょうど1件（残りは409、または終了後の接続拒否）
      const key = stateKeyOf(repo);
      const results = await Promise.allSettled(["A", "B", "C"].map(function (label) {
        return fetch(`${base}/api/comments`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: base },
          body: JSON.stringify({ prompt: `重複送信テスト ${label}`, stateKey: key, items: [] }),
        });
      }));
      const okCount = results.filter((r) => r.status === "fulfilled" && r.value.ok).length;
      const dupCount = results.filter((r) => r.status === "fulfilled" && r.value.status === 409).length;
      const refused = results.filter((r) => r.status === "rejected").length;
      expect(okCount).toBe(1);
      expect(okCount + dupCount + refused).toBe(3);

      expect(await proc.exited).toBe(0);
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        output += decoder.decode(value, { stream: true });
      }
      // 受理ログがちょうど1回＝受信箱が二重処理されていない
      expect(output.split("指摘を受信しました").length - 1).toBe(1);
      expect(existsSync(join(reviewDir(repo), "comments.json"))).toBe(true);
    } finally {
      proc.kill();
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("contextの型崩れは例外ではなく検証エラーになり、正しいcontextはrenderできる", () => {
  const repo = mkdtempSync(join(tmpdir(), "review-helper-context-test-"));
  try {
    expect(Bun.spawnSync(["git", "init", "-q"], { cwd: repo }).exitCode).toBe(0);
    writeFileSync(join(repo, "a.txt"), "hello\n");
    expect(run(["extract"], repo).code).toBe(0);

    // terms/links が配列でない → 例外死せず、検証エラーとして報告される
    writeAnnotations(repo, { context: { terms: "これは配列ではない", links: { url: "x" } } });
    const bad = run(["render", "--no-open"], repo);
    expect(bad.code).toBe(1);
    expect(bad.out).toContain("context.terms は配列にしてください");
    expect(bad.out).toContain("context.links は配列にしてください");
    expect(bad.out).not.toContain("TypeError");

    // http(s) 以外のスキームは拒否される
    writeAnnotations(repo, { context: { links: [{ label: "x", url: "javascript:alert(1)" }] } });
    const evil = run(["render", "--no-open"], repo);
    expect(evil.code).toBe(1);
    expect(evil.out).toContain("http(s) のURLのみ許可");

    // 正しいcontextはrenderでき、データが画面に埋め込まれる
    writeAnnotations(repo, {
      summary: "テスト概要",
      context: {
        background: "テスト背景",
        requestedBy: "テスト要望元",
        terms: [{ term: "hunk", desc: "差分の塊" }],
        links: [{ label: "Issue", url: "https://example.com/issues/1" }],
      },
    });
    expect(run(["render", "--no-open"], repo).code).toBe(0);
    const html = readFileSync(join(reviewDir(repo), "review.html"), "utf-8");
    expect(html).toContain("example.com/issues/1");
    expect(html).toContain("テスト概要");
    expect(html).toContain("テスト背景");
    expect(html).toContain("ローカルPath:");
    expect(html).toContain(basename(repo));
    expect(html).toContain('"レビュー対象"');
    expect(html).toContain('h("div", { class: "ctx-h" }, "概要 / 背景")');
    expect(html.split('"概要 / 背景"').length - 1).toBe(1);
    expect(html).not.toContain('h("div", { class: "ctx-h" }, "変更概要")');
    expect(html).not.toContain('h("div", { class: "ctx-h" }, "背景")');
    expect(html).toContain("背景・目的・レビュー全体への質問/指摘");
    expect(html).toContain('contextMemo: ""');
    expect(html).toContain('scope: "context"');
    expect(html).toContain("背景・コンテキスト / レビュー全体");
    expect(html).toContain('h("div", { class: "context-actions" }, mp.btn)');
    expect(html).not.toContain('class: "sec-title"');
    expect(html).toContain("generatedAtLabel");
    expect(html).toContain('"（UTC"');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("PR URLの直渡しは自動判別され、gh pr diff に同じURLが渡りprRefが保存される", () => {
  const repo = mkdtempSync(join(tmpdir(), "review-helper-pr-test-"));
  const bin = mkdtempSync(join(tmpdir(), "review-helper-fakegh-"));
  try {
    expect(Bun.spawnSync(["git", "init", "-q"], { cwd: repo }).exitCode).toBe(0);
    // PATHの先頭に置く偽gh: 呼び出し引数を記録し、固定のunified diffを返す（ネットワーク・認証不要でPR分岐を固定する）
    const ghLog = join(bin, "gh-args.log");
    writeFileSync(join(bin, "gh"), [
      "#!/bin/sh",
      `echo "$@" >> "${ghLog}"`,
      'if [ "$1" = "pr" ] && [ "$2" = "diff" ]; then',
      "  cat <<'EOF'",
      "diff --git a/hello.txt b/hello.txt",
      "index 0000000..1111111 100644",
      "--- a/hello.txt",
      "+++ b/hello.txt",
      "@@ -1,1 +1,2 @@",
      " hello",
      "+world",
      "EOF",
      "  exit 0",
      "fi",
      'if [ "$1" = "pr" ] && [ "$2" = "view" ]; then',
      '  echo "https://github.com/example-org/example-repo/pull/$3"',
      "  exit 0",
      "fi",
      "exit 1",
    ].join("\n"));
    expect(Bun.spawnSync(["chmod", "+x", join(bin, "gh")]).exitCode).toBe(0);
    const env = { PATH: `${bin}:${process.env.PATH ?? ""}` };

    const url = "https://github.com/example-org/example-repo/pull/42";
    const r = run(["extract", url], repo, env);
    expect(r.code).toBe(0);
    expect(readFileSync(ghLog, "utf-8").trim()).toBe(`pr diff ${url}`);
    expect(basename(reviewDir(repo))).toBe("example-org-example-repo-42");
    const diff = JSON.parse(readFileSync(join(reviewDir(repo), "diff.json"), "utf-8"));
    expect(diff.prRef).toBe(url);
    expect(diff.rangeLabel).toContain(url);
    expect(diff.stats.files).toBe(1);
    writeAnnotations(repo);
    expect(run(["render", "--no-open"], repo, env).code).toBe(0);
    expect(readFileSync(join(reviewDir(repo), "review.html"), "utf-8")).toContain(
      `"prRef":"${url}"`,
    );

    // PR番号だけでも、ghが解決したURLからORG/REPOを取得し、人間向けの保存先になる
    const byNumber = run(["extract", "--pr", "43"], repo, env);
    expect(byNumber.code).toBe(0);
    expect(readFileSync(ghLog, "utf-8")).toContain("pr diff 43");
    expect(readFileSync(ghLog, "utf-8")).toContain(
      "pr view 43 --json url --jq .url",
    );
    expect(basename(reviewDir(repo))).toBe("example-org-example-repo-43");

    // 末尾にゴミが付いたURLはPR扱いせず、通常のgit diff引数として失敗する（アンカーの回帰確認）
    const junk = run(["extract", "https://github.com/example-org/example-repo/pull/42x"], repo, env);
    expect(junk.code).toBe(1);
    expect(junk.out).toContain("git diff");

    // --pr に値がない場合は明確なエラー
    const bare = run(["extract", "--pr"], repo, env);
    expect(bare.code).toBe(1);
    expect(bare.out).toContain("--pr には");
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  }
});
