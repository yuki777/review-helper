#!/usr/bin/env bun
/**
 * review-helper — AIが作った差分を人間が確認するための「解説つきレビュー画面」ジェネレータ
 *
 * 使い方:
 *   bun review-helper.ts extract [git diffの引数...]   差分を抽出し、全hunkにIDを付番して diff.json を書き出す
 *   bun review-helper.ts render [--no-open]            annotations.json を検証し、review.html を生成して開く
 *
 * パイプライン:
 *   extract → diff.json → (CC/Codex が annotations.json を書く) → render → review.html
 *
 * 中間ファイルはすべて $XDG_DATA_HOME/review-helper/<review-id>/ に置く
 * （XDG_DATA_HOME 未設定時は ~/.local/share。リポジトリを汚さず、コミット対象にもならない）。
 * 設計方針: diffの本文・統計はこのスクリプトが機械的に扱い、LLMには一切書き写させない（捏造防止）。
 */

import { createHash } from "node:crypto";
import { isAbsolute, join, resolve, sep } from "node:path";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";

// ---------- 型定義 ----------

/** diffの1行。[マーカー(" "|"+"|"-"|"\\"), 本文] */
type DiffLine = [string, string];

interface Hunk {
  id: string;
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
  /** バイナリ等で本文が無い疑似hunkの種別 */
  meta?: "binary" | "meta" | "omitted";
  /** 画面で折りたたむヒント（巨大hunk） */
  collapsed?: boolean;
}

interface FileDiff {
  path: string;
  oldPath?: string;
  status: "added" | "deleted" | "renamed" | "modified";
  binary?: boolean;
  /** 画面で折りたたむヒント（ロックファイル等） */
  collapsed?: boolean;
  hunks: Hunk[];
}

interface DiffDoc {
  createdAt: string;
  repoRoot: string;
  rangeLabel: string;
  /** PRレビューモードのとき、対象PRのURLまたは番号。背景収集はこの値を必ず参照する */
  prRef?: string;
  stats: { files: number; hunks: number; additions: number; deletions: number };
  files: FileDiff[];
}

interface Finding {
  hunk: string;
  note: string;
}

/** グループの比較表（変更前/変更後など、対応関係を構造化して見せる任意項目） */
interface GroupTable {
  headers: string[];
  rows: string[][];
}

interface Group {
  title: string;
  summary?: string;
  kind?: string;
  risk: string;
  intent: string;
  notes?: string[];
  hunks: string[];
  findings?: Finding[];
  table?: GroupTable;
}

interface Annotations {
  title: string;
  summary?: string;
  groups: Group[];
  /** 初見レビュアー向けの背景情報（任意）。PRの背景・要望元・用語・関連リンク */
  context?: {
    background?: string;
    requestedBy?: string;
    terms?: { term: string; desc: string }[];
    links?: { label?: string; url: string }[];
  };
}

const KINDS = ["feature", "fix", "refactor", "test", "docs", "config", "chore", "other"];
const RISKS = ["low", "medium", "high"];

/** 内容確認の価値が低く、既定で折りたたむファイル */
const LOCKFILE_RE =
  /(^|\/)(bun\.lockb?|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|Gemfile\.lock|composer\.lock|go\.sum|poetry\.lock|uv\.lock)$|\.min\.(js|css)$|\.map$/;

/** これを超える行数のhunkは折りたたみヒントを付ける */
const COLLAPSE_HUNK_LINES = 400;
/** これを超える未追跡ファイルは本文を省略する（バイト） */
const MAX_UNTRACKED_BYTES = 1_000_000;

// ---------- 共通ユーティリティ ----------

function die(msg: string): never {
  console.error(`[review-helper] エラー: ${msg}`);
  process.exit(1);
}

function runGit(args: string[], cwd: string): { code: number; out: string; err: string } {
  const p = Bun.spawnSync(["git", "-c", "core.quotePath=false", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: p.exitCode ?? 1, out: p.stdout.toString(), err: p.stderr.toString() };
}

interface RepoPaths {
  repoRoot: string;
  outDir: string;
  reviewId: string;
  pointerPath: string;
  identityKey?: string;
  identityPath?: string;
}

interface RepoPathOptions {
  /** extract時はtrue。prRefに応じた保存先を新しく選ぶ */
  select?: boolean;
  prRef?: string;
  repoRoot?: string;
}

interface RepoIdentity {
  owner: string;
  repo: string;
}

function findRepoRoot(): string {
  const top = runGit(["rev-parse", "--show-toplevel"], process.cwd());
  if (top.code !== 0) die("gitリポジトリ内で実行してください");
  return top.out.trim();
}

function dataHome(): string {
  const configuredDataHome = process.env.XDG_DATA_HOME?.trim();
  if (configuredDataHome && !isAbsolute(configuredDataHome)) {
    console.warn(
      `[review-helper] 警告: 相対パスの XDG_DATA_HOME は無効なため使用しません: ${configuredDataHome}`,
    );
  }
  const validDataHome =
    configuredDataHome && isAbsolute(configuredDataHome) ? configuredDataHome : undefined;
  const userHome = process.env.HOME?.trim();
  if (!validDataHome && !userHome) {
    die("XDG_DATA_HOME または HOME を設定してください");
  }
  return validDataHome || join(userHome!, ".local", "share");
}

/** 人が読める名前を保ちつつ、ディレクトリ区切りや制御文字は持ち込ませない。 */
function safeNamePart(value: string): string | undefined {
  const normalized = value.normalize("NFKC");
  if (
    !normalized ||
    normalized.length > 100 ||
    normalized === "." ||
    normalized === ".." ||
    !/^[A-Za-z0-9._-]+$/.test(normalized)
  ) {
    return undefined;
  }
  return normalized;
}

/** HTTPS / ssh:// / git@host:owner/repo.git から末尾の owner/repo を読む。 */
function ownerRepoFromRemote(remote: string): RepoIdentity | undefined {
  let path = remote.trim();
  if (!path) return undefined;
  try {
    path = new URL(path).pathname;
  } catch {
    const scpLike = path.match(/^[^/:]+@[^:]+:(.+)$/);
    if (!scpLike) return undefined;
    path = scpLike[1];
  }
  const parts = path.split("/").filter(Boolean);
  if (parts.length < 2) return undefined;
  let ownerValue: string;
  let repoValue: string;
  try {
    ownerValue = decodeURIComponent(parts.at(-2)!);
    repoValue = decodeURIComponent(parts.at(-1)!.replace(/\.git$/i, ""));
  } catch {
    return undefined;
  }
  const owner = safeNamePart(ownerValue);
  const repo = safeNamePart(repoValue);
  return owner && repo ? { owner, repo } : undefined;
}

function localRepoIdentity(repoRoot: string): RepoIdentity | undefined {
  const remote = runGit(["remote", "get-url", "origin"], repoRoot);
  return remote.code === 0 ? ownerRepoFromRemote(remote.out) : undefined;
}

function parsePullUrl(
  value: string,
): (RepoIdentity & { host: string; number: string }) | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    const match = url.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/);
    if (!match) return undefined;
    const owner = safeNamePart(decodeURIComponent(match[1]));
    const repo = safeNamePart(decodeURIComponent(match[2]));
    return owner && repo
      ? { owner, repo, host: url.host.toLowerCase(), number: match[3] }
      : undefined;
  } catch {
    return undefined;
  }
}

function prReviewSelection(
  prRef: string,
  repoRoot: string,
): { reviewId: string; identityKey: string } {
  let resolved = parsePullUrl(prRef);
  if (resolved) {
    return {
      reviewId: `${resolved.owner}-${resolved.repo}-${resolved.number}`,
      identityKey: `pr:${resolved.host}/${resolved.owner}/${resolved.repo}#${resolved.number}`,
    };
  }
  if (!/^\d+$/.test(prRef)) {
    die("--pr にはPRのURLまたは番号を指定してください（例: --pr https://github.com/owner/repo/pull/123）");
  }

  // PR番号だけの場合は、ghが実際に解決したPR URLからORG/REPO/番号を読む。originとは限らない。
  const selected = Bun.spawnSync(
    ["gh", "pr", "view", prRef, "--json", "url", "--jq", ".url"],
    { cwd: repoRoot, stdout: "pipe", stderr: "pipe" },
  );
  if ((selected.exitCode ?? 1) === 0) {
    resolved = parsePullUrl(selected.stdout.toString().trim());
  }
  if (!resolved) {
    die(
      `PR番号 ${prRef} のORG/REPOを特定できませんでした。ghで参照できるGitHubリポジトリ内で実行するか、PR URLを指定してください`,
    );
  }
  return {
    reviewId: `${resolved.owner}-${resolved.repo}-${resolved.number}`,
    identityKey: `pr:${resolved.host}/${resolved.owner}/${resolved.repo}#${resolved.number}`,
  };
}

function isSafeReviewId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value !== "." &&
    value !== ".." &&
    value.length <= 240 &&
    /^[A-Za-z0-9._-]+$/.test(value)
  );
}

/**
 * ORG/REPOのハイフン境界やGitHub Enterpriseのhost差で同じ表示名になった場合だけ
 * identity hashを足し、別レビューの無言上書きを防ぐ。通常は人間向けの短い名前のまま。
 */
function collisionSafeReviewId(
  reviewRoot: string,
  baseReviewId: string,
  identityKey: string,
): string {
  const baseDir = resolve(reviewRoot, baseReviewId);
  if (!existsSync(baseDir) || readdirSync(baseDir).length === 0) return baseReviewId;
  const identityPath = join(baseDir, ".review-identity.json");
  try {
    const saved = JSON.parse(readFileSync(identityPath, "utf-8")) as { identityKey?: unknown };
    if (saved.identityKey === identityKey) return baseReviewId;
  } catch {
    // identity不明の既存ディレクトリは上書きせず、衝突時の名前へ分離する
  }
  return `${baseReviewId}-${createHash("sha256").update(identityKey).digest("hex").slice(0, 8)}`;
}

function repoPaths(options: RepoPathOptions = {}): RepoPaths {
  const repoRoot = options.repoRoot ?? findRepoRoot();
  const reviewRoot = resolve(dataHome(), "review-helper");
  const currentDir = join(reviewRoot, ".current");
  mkdirSync(currentDir, { recursive: true, mode: 0o700 });
  const pointerKey = createHash("sha256").update(repoRoot).digest("hex").slice(0, 16);
  const pointerPath = join(currentDir, `${pointerKey}.json`);
  const identity = localRepoIdentity(repoRoot);
  const localHash = fnv1a(repoRoot);
  const localReviewId = identity
    ? `${identity.owner}-${identity.repo}-${localHash}`
    : `--${localHash}`;

  let reviewId = localReviewId;
  let identityKey: string | undefined;
  if (options.select) {
    const selected = options.prRef
      ? prReviewSelection(options.prRef, repoRoot)
      : { reviewId: localReviewId, identityKey: `local:${repoRoot}` };
    reviewId = collisionSafeReviewId(reviewRoot, selected.reviewId, selected.identityKey);
    identityKey = selected.identityKey;
  } else if (existsSync(pointerPath)) {
    try {
      const saved = JSON.parse(readFileSync(pointerPath, "utf-8")) as { reviewId?: unknown };
      if (!isSafeReviewId(saved.reviewId)) throw new Error("reviewIdが不正です");
      reviewId = saved.reviewId;
    } catch {
      die(`最新レビューの参照ファイルが壊れています。再度 extract を実行してください: ${pointerPath}`);
    }
  }

  if (!isSafeReviewId(reviewId)) die("保存先のreview IDが不正です");
  const outDir = resolve(reviewRoot, reviewId);
  if (!outDir.startsWith(`${reviewRoot}${sep}`)) die("保存先がreview-helperディレクトリ外を指しています");
  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  return {
    repoRoot,
    outDir,
    reviewId,
    pointerPath,
    ...(identityKey
      ? { identityKey, identityPath: join(outDir, ".review-identity.json") }
      : {}),
  };
}

function writeJsonAtomically(path: string, value: unknown) {
  const tempPath = `${path}.${process.pid}.tmp`;
  writeFileSync(tempPath, JSON.stringify(value, null, 2), { mode: 0o600 });
  renameSync(tempPath, path);
}

function saveCurrentReview(paths: RepoPaths) {
  if (!paths.identityKey || !paths.identityPath) die("保存先identityがありません");
  writeJsonAtomically(paths.identityPath, { identityKey: paths.identityKey });
  writeJsonAtomically(paths.pointerPath, { reviewId: paths.reviewId });
}

/** FNV-1a 32bit。承認状態のlocalStorageキーに使う */
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * 差分の「安定表現」。createdAtなど実行ごとに変わる値を除外し、
 * 同じ差分なら必ず同じ文字列になることを保証する。
 * extract（前回との同一判定）とrender（stateKey算出）は必ずこの同一射影を使うこと。
 * ※ 3箇所が同じ射影で揃っていないと「再extractで承認・メモが消える」バグが再発する。
 */
function stableDiffJson(d: Pick<DiffDoc, "stats" | "files">): string {
  return JSON.stringify({ stats: d.stats, files: d.files });
}

// ---------- unified diff パーサ ----------

/** 引用符付きパスを外す（core.quotePath=false でも空白等では引用される） */
function stripQuote(p: string): string {
  const s = p.replace(/\t+$/, "");
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
    try {
      return JSON.parse(s);
    } catch {
      return s.slice(1, -1);
    }
  }
  return s;
}

/** `--- a/x` `+++ b/x` 形式のパスから a/ b/ プレフィクスを外す。/dev/null は "" */
function stripAB(p: string): string {
  const s = stripQuote(p);
  if (s === "/dev/null") return "";
  if (s.startsWith("a/") || s.startsWith("b/")) return s.slice(2);
  return s;
}

function parseUnifiedDiff(text: string): FileDiff[] {
  const lines = text.split("\n");
  const files: FileDiff[] = [];
  let cur: FileDiff | null = null;
  let curHunk: Hunk | null = null;

  const flushHunk = () => {
    if (curHunk && cur) cur.hunks.push(curHunk);
    curHunk = null;
  };
  const flushFile = () => {
    flushHunk();
    if (cur) files.push(cur);
    cur = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith("diff --git ")) {
      flushFile();
      cur = { path: "", status: "modified", hunks: [] };
      // ---/+++ が無いケース（バイナリ等）に備えたフォールバック推定
      const m = line.slice("diff --git ".length).match(/^"?a\/(.+?)"? "?b\/(.+?)"?$/);
      if (m) {
        cur.oldPath = m[1];
        cur.path = m[2];
      }
      continue;
    }
    if (!cur) continue;

    // hunk本文の途中（"--- " などがhunk内の削除行と衝突しないよう、最初に判定する）
    if (curHunk) {
      const t = line[0];
      if (t === " " || t === "+" || t === "-" || t === "\\") {
        curHunk.lines.push([t, line.slice(1)]);
        continue;
      }
      if (line === "" && i === lines.length - 1) continue; // 末尾の空行
      flushHunk(); // hunk終了。この行は下の判定に流す
    }

    const hm = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/);
    if (hm) {
      curHunk = {
        id: "",
        header: line,
        oldStart: Number(hm[1]),
        oldLines: hm[2] === undefined ? 1 : Number(hm[2]),
        newStart: Number(hm[3]),
        newLines: hm[4] === undefined ? 1 : Number(hm[4]),
        lines: [],
      };
      continue;
    }
    if (line.startsWith("new file mode")) { cur.status = "added"; continue; }
    if (line.startsWith("deleted file mode")) { cur.status = "deleted"; continue; }
    if (line.startsWith("rename from ")) { cur.oldPath = stripQuote(line.slice("rename from ".length)); continue; }
    if (line.startsWith("rename to ")) { cur.status = "renamed"; cur.path = stripQuote(line.slice("rename to ".length)); continue; }
    if (line.startsWith("--- ")) { const p = stripAB(line.slice(4)); if (p) cur.oldPath = p; continue; }
    if (line.startsWith("+++ ")) { const p = stripAB(line.slice(4)); if (p) cur.path = p; continue; }
    if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) { cur.binary = true; continue; }
    // index行・mode行などは読み飛ばす
  }
  flushFile();

  // 後始末: 削除ファイル（+++ /dev/null）はoldPathを正パスに、リネーム以外の同一oldPathは落とす
  for (const f of files) {
    if (f.oldPath === "dev/null" || f.oldPath === "/dev/null") delete f.oldPath;
    if (!f.path && f.oldPath) f.path = f.oldPath;
    if (f.status !== "renamed" && f.oldPath === f.path) delete f.oldPath;
  }
  return files.filter((f) => f.path);
}

// ---------- extract ----------

function extract(userArgs: string[]) {
  const repoRoot = findRepoRoot();
  const baseFlags = ["--no-color", "--no-ext-diff"];
  // PRモード: --pr <URL|番号>、またはPRのURLを直接渡された場合
  const prIdx = userArgs.indexOf("--pr");
  const prRef =
    prIdx >= 0
      ? userArgs[prIdx + 1]
      : userArgs.length === 1 && parsePullUrl(userArgs[0])
        ? userArgs[0]
        : undefined;
  if (prIdx >= 0 && !prRef) die("--pr にはPRのURLまたは番号を指定してください（例: --pr https://github.com/owner/repo/pull/123）");
  if (prRef && !parsePullUrl(prRef) && !/^\d+$/.test(prRef)) {
    die("--pr にはPRのURLまたは番号を指定してください（例: --pr https://github.com/owner/repo/pull/123）");
  }
  const defaultMode = userArgs.length === 0;

  let rangeLabel: string;
  let diffText: string;

  if (defaultMode) {
    // 既定: HEADとの比較（ステージ済み＋未ステージ）。初回コミット前は空ツリーと比較する
    const head = runGit(["rev-parse", "--verify", "--quiet", "HEAD"], repoRoot);
    let target: string;
    if (head.code === 0) {
      target = "HEAD";
      rangeLabel = "未コミット差分（HEAD比較＋未追跡ファイル）";
    } else {
      target = runGit(["hash-object", "-t", "tree", "/dev/null"], repoRoot).out.trim();
      rangeLabel = "初回コミット前の全変更（未追跡ファイル含む）";
    }
    const d = runGit(["diff", ...baseFlags, target], repoRoot);
    if (d.code !== 0) die(`git diff が失敗しました:\n${d.err}`);
    diffText = d.out;
  } else if (prRef) {
    // 他者のPRをローカルcheckoutせずにレビューする: gh CLIでPRのdiffを取得して同じパーサに通す
    const p = Bun.spawnSync(["gh", "pr", "diff", prRef], { stdout: "pipe", stderr: "pipe" });
    if ((p.exitCode ?? 1) !== 0) {
      die(`gh pr diff が失敗しました（GitHub CLIのインストールと認証が必要です）:\n${p.stderr.toString()}`);
    }
    diffText = p.stdout.toString();
    rangeLabel = `GitHub PR ${prRef}`;
  } else {
    const d = runGit(["diff", ...baseFlags, ...userArgs], repoRoot);
    // --exit-code系の引数が来ても動くよう、出力があれば exit 1 を許容する
    if (d.code !== 0 && !(d.code === 1 && d.out)) die(`git diff ${userArgs.join(" ")} が失敗しました:\n${d.err}`);
    diffText = d.out;
    rangeLabel = `git diff ${userArgs.join(" ")}`;
  }

  const files = parseUnifiedDiff(diffText);

  // 既定モードでは未追跡ファイルも「新規追加」として合成する（AI開発では新規ファイルが主役になりがち）
  if (defaultMode) {
    const ls = runGit(["ls-files", "--others", "--exclude-standard"], repoRoot);
    for (const rel of ls.out.split("\n").filter(Boolean)) {
      let size = 0;
      try {
        size = statSync(join(repoRoot, rel)).size;
      } catch {
        continue;
      }
      if (size > MAX_UNTRACKED_BYTES) {
        files.push({
          path: rel,
          status: "added",
          hunks: [{ id: "", header: `(${(size / 1e6).toFixed(1)}MBのため本文省略)`, oldStart: 0, oldLines: 0, newStart: 0, newLines: 0, lines: [], meta: "omitted" }],
        });
        continue;
      }
      const arg = rel.startsWith("-") ? `./${rel}` : rel;
      const d = runGit(["diff", "--no-color", "--no-index", "/dev/null", arg], repoRoot);
      // --no-index は差分ありのとき exit 1 を返す（正常）
      for (const pf of parseUnifiedDiff(d.out)) {
        pf.status = "added";
        pf.path = rel;
        delete pf.oldPath;
        files.push(pf);
      }
    }
  }

  if (files.length === 0) die(`対象の差分がありません（${rangeLabel}）`);
  const paths = repoPaths({ select: true, prRef, repoRoot });
  const { outDir } = paths;

  // 折りたたみヒント・疑似hunk・ID付番・統計を機械的に確定する
  const totalHunks = files.reduce((a, f) => a + Math.max(1, f.hunks.length), 0);
  const width = Math.max(3, String(totalHunks).length);
  let n = 0;
  let additions = 0;
  let deletions = 0;
  for (const f of files) {
    if (LOCKFILE_RE.test(f.path)) f.collapsed = true;
    if (f.hunks.length === 0) {
      f.hunks.push({
        id: "",
        header: f.binary ? "(バイナリ変更のため本文なし)" : "(本文変更なし: リネーム・権限変更など)",
        oldStart: 0, oldLines: 0, newStart: 0, newLines: 0,
        lines: [],
        meta: f.binary ? "binary" : "meta",
      });
    }
    for (const hk of f.hunks) {
      hk.id = `h${String(++n).padStart(width, "0")}`;
      if (hk.lines.length > COLLAPSE_HUNK_LINES) hk.collapsed = true;
      for (const [t] of hk.lines) {
        if (t === "+") additions++;
        else if (t === "-") deletions++;
      }
    }
  }

  const doc: DiffDoc = {
    createdAt: new Date().toISOString(),
    repoRoot,
    rangeLabel,
    ...(prRef ? { prRef } : {}),
    stats: { files: files.length, hunks: n, additions, deletions },
    files,
  };

  // 差分が前回と同一なら annotations.json を保持する（再extractだけで注釈・承認が失われないように）。
  // 差分が変わった場合のみ、新しいIDと不整合になる古い注釈と画面を削除する。
  const diffPath = join(outDir, "diff.json");
  let sameAsPrev = false;
  if (existsSync(diffPath)) {
    try {
      const prev = JSON.parse(readFileSync(diffPath, "utf-8")) as DiffDoc;
      sameAsPrev = stableDiffJson(prev) === stableDiffJson(doc);
    } catch {
      // 壊れたdiff.jsonは作り直す
    }
  }
  if (!sameAsPrev) {
    for (const stale of ["annotations.json", "review.html", "comments.json"]) {
      const p = join(outDir, stale);
      if (existsSync(p)) rmSync(p);
    }
  }
  writeFileSync(diffPath, JSON.stringify(doc, null, 2));
  // diff.jsonを書けたextractだけをrender/serveの参照先として記録する。
  saveCurrentReview(paths);
  if (sameAsPrev) console.log(`[review-helper] 差分は前回と同一のため annotations.json を保持しました`);

  console.log(`[review-helper] 抽出完了`);
  console.log(`  対象     : ${rangeLabel}`);
  console.log(`  規模     : ${doc.stats.files} files / ${doc.stats.hunks} hunks (+${additions} -${deletions})`);
  console.log(`  hunk ID  : h${"1".padStart(width, "0")} 〜 h${String(n).padStart(width, "0")}`);
  if (prRef) console.log(`  PR       : ${prRef}`);
  console.log(`  diff.json: ${diffPath}`);
  console.log(``);
  console.log(`次の手順:`);
  console.log(`  1. diff.json を読み、変更を意図単位のグループに分ける`);
  if (prRef) console.log(`     背景収集は必ずこのPRを参照する: gh pr view ${prRef} --json title,body,comments`);
  console.log(`  2. ${join(outDir, "annotations.json")} を書く（スキーマは SKILL.md 参照）`);
  console.log(`  3. bun ${import.meta.path} render`);
}

// ---------- render ----------

function validateAnnotations(anno: Annotations, diff: DiffDoc): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!anno || typeof anno !== "object") return { errors: ["annotations.json がオブジェクトではありません"], warnings };
  if (typeof anno.title !== "string" || !anno.title.trim()) errors.push(`title（レビュータイトル）は必須です`);
  if (!Array.isArray(anno.groups) || anno.groups.length === 0) {
    errors.push(`groups は1件以上必要です`);
    return { errors, warnings };
  }

  const allIds = new Set<string>();
  for (const f of diff.files) for (const hk of f.hunks) allIds.add(hk.id);

  const seen = new Map<string, string>(); // hunk id -> グループ名
  anno.groups.forEach((g, i) => {
    const name = `groups[${i}]${g?.title ? `「${g.title}」` : ""}`;
    if (typeof g.title !== "string" || !g.title.trim()) errors.push(`${name}: title は必須です`);
    if (typeof g.intent !== "string" || !g.intent.trim()) errors.push(`${name}: intent（意図の説明）は必須です`);
    if (!RISKS.includes(g.risk)) errors.push(`${name}: risk は ${RISKS.join(" | ")} のいずれかにしてください（現在: ${JSON.stringify(g.risk)}）`);
    if (g.kind !== undefined && !KINDS.includes(g.kind)) errors.push(`${name}: kind は ${KINDS.join(" | ")} のいずれかにしてください（現在: ${JSON.stringify(g.kind)}）`);
    if (!Array.isArray(g.hunks) || g.hunks.length === 0) {
      errors.push(`${name}: hunks（hunk IDの配列）は1件以上必要です`);
      return;
    }
    for (const id of g.hunks) {
      if (!allIds.has(id)) {
        errors.push(`${name}: 存在しないhunk ID「${id}」を参照しています`);
        continue;
      }
      const prev = seen.get(id);
      if (prev) errors.push(`hunk「${id}」が複数グループに属しています: 「${prev}」と「${g.title}」`);
      else seen.set(id, g.title || name);
    }
    for (const fd of g.findings ?? []) {
      if (!fd || typeof fd.note !== "string" || !fd.note.trim()) errors.push(`${name}: findings の note は必須です`);
      else if (!allIds.has(fd.hunk)) errors.push(`${name}: findings が存在しないhunk ID「${fd.hunk}」を参照しています`);
      else if (!g.hunks.includes(fd.hunk)) warnings.push(`${name}: 指摘「${fd.note.slice(0, 30)}…」の対象 ${fd.hunk} はこのグループのhunksに含まれていません`);
    }
    // LLM出力は型が崩れがちなので、例外死させず検証エラーとして報告する
    const table: unknown = g.table;
    if (table !== undefined) {
      if (typeof table !== "object" || table === null || Array.isArray(table)) {
        errors.push(`${name}: table は {headers, rows} のオブジェクトにしてください`);
      } else {
        const t = table as { headers?: unknown; rows?: unknown };
        const headers = Array.isArray(t.headers) ? t.headers : undefined;
        const headersOk =
          !!headers && headers.length > 0 && headers.every((x) => typeof x === "string" && x.trim());
        if (!headersOk) errors.push(`${name}: table.headers は1件以上の空でない文字列の配列にしてください`);
        if (!Array.isArray(t.rows) || t.rows.length === 0) {
          errors.push(`${name}: table.rows は1行以上の配列にしてください`);
        } else {
          t.rows.forEach((row, ri) => {
            if (!Array.isArray(row) || !row.every((cell) => typeof cell === "string")) {
              errors.push(`${name}: table.rows[${ri}] は文字列の配列にしてください`);
            } else if (headersOk && row.length !== headers!.length) {
              warnings.push(`${name}: table.rows[${ri}] の列数（${row.length}）が headers の列数（${headers!.length}）と一致していません`);
            }
          });
        }
      }
    }
  });

  const ctx = anno.context;
  if (ctx !== undefined) {
    if (typeof ctx !== "object" || ctx === null || Array.isArray(ctx)) {
      errors.push("context はオブジェクトにしてください");
    } else {
      if (ctx.background !== undefined && typeof ctx.background !== "string") errors.push("context.background は文字列にしてください");
      if (ctx.requestedBy !== undefined && typeof ctx.requestedBy !== "string") errors.push("context.requestedBy は文字列にしてください");
      // LLM出力は型が崩れがちなので、配列であることを確認してから要素を検証する（非配列で例外死させない）
      const terms: unknown = ctx.terms;
      if (terms !== undefined) {
        if (!Array.isArray(terms)) {
          errors.push("context.terms は配列にしてください");
        } else {
          terms.forEach((t, i) => {
            if (!t || typeof t.term !== "string" || typeof t.desc !== "string") {
              errors.push(`context.terms[${i}] は {term, desc}（どちらも文字列）にしてください`);
            }
          });
        }
      }
      const links: unknown = ctx.links;
      if (links !== undefined) {
        if (!Array.isArray(links)) {
          errors.push("context.links は配列にしてください");
        } else {
          links.forEach((l, i) => {
            if (!l || typeof l.url !== "string" || !/^https?:\/\//i.test(l.url)) {
              errors.push(`context.links[${i}].url は http(s) のURLのみ許可です（javascript:等のスキームを防ぐ）`);
            }
          });
        }
      }
    }
  }

  const missing = [...allIds].filter((id) => !seen.has(id)).sort();
  if (missing.length > 0) {
    errors.push(`どのグループにも割り当てられていないhunkがあります: ${missing.join(", ")}（すべてのhunkをちょうど1つのグループに割り当ててください）`);
  }
  return { errors, warnings };
}

function render(args: string[]) {
  const { outDir } = repoPaths();
  const noOpen = args.includes("--no-open");

  const diffPath = join(outDir, "diff.json");
  const annoPath = join(outDir, "annotations.json");
  if (!existsSync(diffPath)) die(`diff.json がありません。先に extract を実行してください: ${diffPath}`);
  if (!existsSync(annoPath)) die(`annotations.json がありません。diff.json を読んで注釈を書いてください: ${annoPath}`);

  const diffRaw = readFileSync(diffPath, "utf-8");
  let diff: DiffDoc;
  let anno: Annotations;
  try {
    diff = JSON.parse(diffRaw);
  } catch (e) {
    die(`diff.json のJSONが壊れています: ${e}`);
  }
  try {
    anno = JSON.parse(readFileSync(annoPath, "utf-8"));
  } catch (e) {
    die(`annotations.json のJSONが壊れています: ${e}`);
  }

  const { errors, warnings } = validateAnnotations(anno, diff);
  for (const w of warnings) console.warn(`[review-helper] 警告: ${w}`);
  if (errors.length > 0) {
    console.error(`[review-helper] annotations.json の検証エラー（${errors.length}件）:`);
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }

  const templatePath = join(import.meta.dir, "template.html");
  if (!existsSync(templatePath)) die(`テンプレートがありません: ${templatePath}`);
  const template = readFileSync(templatePath, "utf-8");

  const htmlPath = join(outDir, "review.html");
  const combined = {
    generatedAt: new Date().toISOString(),
    stateKey: fnv1a(stableDiffJson(diff)), // 同じdiffなら承認状態を維持、diffが変われば自動リセット（createdAt等は含めない）
    diff,
    annotations: anno,
    commentsPath: join(outDir, "comments.json"), // 画面の「受信箱パスをコピー」用
    htmlPath, // 「質問/指摘を送信」後（serve終了後）もファイルを直接開けるよう、画面にパスを表示する
  };
  // 安全要件: `<` をすべて \u003c にエスケープし、</script> によるタグ脱出を防ぐ
  const payload = JSON.stringify(combined).replace(/</g, "\\u003c");
  if (!template.includes("__REVIEW_DATA__")) die("template.html に __REVIEW_DATA__ プレースホルダがありません");
  const html = template.replace("__REVIEW_DATA__", () => payload);

  writeFileSync(htmlPath, html);
  console.log(`[review-helper] 生成完了: ${htmlPath}`);
  console.log(`  グループ: ${anno.groups.length} / hunk: ${diff.stats.hunks}（全hunk割り当て済みを検証OK）`);

  if (!noOpen) openBrowser(htmlPath);
}

/** ブラウザで開く。REVIEW_HELPER_BROWSER にアプリ名を設定するとそのブラウザで開く（macOSのみ。例: Comet, Google Chrome） */
function openBrowser(target: string) {
  const app = process.env.REVIEW_HELPER_BROWSER;
  const cmd =
    process.platform === "darwin"
      ? app
        ? ["open", "-a", app, target]
        : ["open", target]
      : ["xdg-open", target];
  const p = Bun.spawnSync(cmd, { stdout: "ignore", stderr: "pipe" });
  if (p.exitCode === 0) console.log(`  ブラウザで開きました（${cmd.slice(0, -1).join(" ")}）`);
  else console.log(`  自動で開けませんでした。手動で開いてください: ${target}`);
}

// ---------- serve ----------

/**
 * review.html をローカル配信し、画面の「指摘を送信」（POST /api/comments）を受け付ける。
 * 受信した指摘は comments.json（受信箱）に保存し、標準出力にも出す。
 * --once: 最初の1件だけ受理して指摘を出力し終了する（エージェントが「人間の指摘待ち」をブロッキングで表現できる）。
 *         2件目以降のPOSTは409で拒否し、多重処理と受信箱の上書きを防ぐ。
 */
function serve(args: string[]) {
  const { outDir } = repoPaths();
  const noOpen = args.includes("--no-open");
  const once = args.includes("--once");
  const portIdx = args.indexOf("--port");
  const basePort = portIdx >= 0 ? Number(args[portIdx + 1]) : 4989;
  if (!Number.isInteger(basePort) || basePort <= 0 || basePort > 65535) die("--port には1〜65535の整数を指定してください");

  const htmlPath = join(outDir, "review.html");
  if (!existsSync(htmlPath)) die(`review.html がありません。先に render を実行してください: ${htmlPath}`);
  const commentsPath = join(outDir, "comments.json");
  const diffPath = join(outDir, "diff.json");

  let server: ReturnType<typeof Bun.serve> | null = null;
  let lastError: unknown = null;
  let accepted = false; // --once: 最初の受理後は409で拒否する
  for (let port = basePort; port < basePort + 10 && !server; port++) {
    try {
      server = Bun.serve({
        hostname: "127.0.0.1",
        port,
        fetch: async (req) => {
          const url = new URL(req.url);
          if (req.method === "GET" && url.pathname === "/") {
            // 再render後のリロードで最新を反映できるよう、毎回ディスクから読む
            return new Response(readFileSync(htmlPath, "utf-8"), {
              headers: { "content-type": "text/html; charset=utf-8" },
            });
          }
          if (req.method === "POST" && url.pathname === "/api/comments") {
            // CSRF対策: 他サイト由来のPOSTを拒否（同一オリジンのみ許可。Originなし＝curl等は許可）
            const origin = req.headers.get("origin");
            if (origin && origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) {
              return new Response("forbidden", { status: 403 });
            }
            let body: { prompt?: string; stateKey?: string };
            try {
              body = await req.json();
            } catch {
              return new Response("invalid json", { status: 400 });
            }
            if (typeof body.prompt !== "string" || !body.prompt.trim()) {
              return new Response("prompt required", { status: 400 });
            }
            // 古い画面からの誤送信ガード: 現行diff由来のstateKeyと一致しないPOSTは受理しない
            let expectedKey: string | null = null;
            try {
              expectedKey = fnv1a(stableDiffJson(JSON.parse(readFileSync(diffPath, "utf-8")) as DiffDoc));
            } catch {
              // diff.jsonが無い/壊れている場合も受理しない
            }
            if (!expectedKey || body.stateKey !== expectedKey) {
              console.log(`[review-helper] 古い画面からの送信を拒否しました（stateKey不一致）`);
              return Response.json({ error: "stale-state" }, { status: 409 });
            }
            // --once: 最初の1件のみ受理。チェックと確定の間にawaitを挟まないこと（並行POSTの二重受理防止）
            if (once && accepted) {
              return Response.json({ error: "already-accepted" }, { status: 409 });
            }
            if (once) accepted = true;
            writeFileSync(commentsPath, JSON.stringify(body, null, 2));
            console.log(`\n[review-helper] 指摘を受信しました → ${commentsPath}`);
            console.log(`---- 指摘プロンプト ここから ----`);
            console.log(body.prompt);
            console.log(`---- 指摘プロンプト ここまで ----`);
            if (once) {
              // レスポンスを返しきってから終了する
              setTimeout(() => process.exit(0), 50);
            }
            return Response.json({ ok: true });
          }
          return new Response("not found", { status: 404 });
        },
      });
    } catch (e) {
      lastError = e;
    }
  }
  if (!server) die(`ポート ${basePort}〜${basePort + 9} を確保できませんでした: ${lastError}`);

  const url = `http://127.0.0.1:${server.port}/`;
  console.log(`[review-helper] レビューサーバ起動: ${url}`);
  console.log(
    once
      ? `  画面の「指摘を送信」を待っています。最初の1件を受理して終了します（以後のPOSTは409で拒否）`
      : `  停止は Ctrl+C。受信した指摘は ${commentsPath} に保存されます`,
  );
  if (!noOpen) openBrowser(url);
}

// ---------- エントリポイント ----------

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === "extract") extract(rest);
else if (cmd === "render") render(rest);
else if (cmd === "serve") serve(rest);
else {
  console.log(`review-helper — 解説つき差分レビュー画面ジェネレータ

使い方:
  bun ${import.meta.path} extract [git diffの引数...]
      差分を抽出してhunk IDを付番し、$XDG_DATA_HOME/review-helper/<review-id>/diff.json を書き出す。
      引数なし: 未コミット差分（HEAD比較）＋未追跡ファイル
      引数あり: そのまま git diff に渡す（例: main...feature, HEAD~3）

  bun ${import.meta.path} render [--no-open]
      annotations.json を検証し、review.html を生成してブラウザで開く。

  bun ${import.meta.path} serve [--once] [--port N] [--no-open]
      review.html をローカル配信し、画面の「指摘を送信」を受け付ける（受信箱: comments.json）。
      --once: 最初の1件を受理して指摘を出力し終了。2件目以降は409で拒否。

詳細は skills/review-helper/SKILL.md（エージェント向け手順書）と README.md を参照。`);
  process.exit(cmd ? 1 : 0);
}
