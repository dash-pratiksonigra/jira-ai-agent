import fs from "node:fs/promises";
import path from "node:path";
import { RepoClient } from "./RepoClient.js";

function safeBranchName(s: string) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9/_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 60);
}

export type CreatePrResult = { prUrl: string; branch: string; commitSha: string };

export class CodeChangeRunner {
  private readonly repo: RepoClient;
  constructor(private readonly opts: { repoRoot: string }) {
    this.repo = new RepoClient({ cwd: opts.repoRoot });
  }

  private async currentBranch(): Promise<string> {
    const { stdout } = await this.repo.git(["rev-parse", "--abbrev-ref", "HEAD"]);
    return stdout.trim();
  }

  async ensureCleanOrThrow() {
    const { stdout } = await this.repo.git(["status", "--porcelain"]);
    if (stdout.trim()) throw new Error("Working tree not clean. Commit/stash changes before running the worker.");
  }

  async createBranch(issueKey: string) {
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const branch = `ratifai/${safeBranchName(issueKey)}-${ts}`;
    await this.repo.git(["checkout", "-b", branch]);
    return branch;
  }

  async applyPatch(patchText: string) {
    const trimmed = patchText.trim();
    if (!trimmed) throw new Error("Empty patch");
    if (!/^diff --git a\//m.test(trimmed)) {
      throw new Error("Invalid patch: missing `diff --git a/... b/...` headers");
    }
    if (!/^--- /m.test(trimmed) || !/^\+\+\+ /m.test(trimmed)) {
      throw new Error("Invalid patch: missing `---` / `+++` file markers");
    }
    if (!/^@@/m.test(trimmed)) {
      throw new Error("Invalid patch: missing `@@` hunks");
    }
    const dir = path.join(this.opts.repoRoot, ".ratifai");
    await fs.mkdir(dir, { recursive: true });
    const patchPath = path.join(dir, `patch-${Date.now()}.patch`);
    await fs.writeFile(patchPath, patchText, "utf8");
    // --whitespace=fix is a pragmatic default for LLM-generated diffs.
    await this.repo.git(["apply", "--whitespace=fix", patchPath], { timeoutMs: 60_000 });
    return patchPath;
  }

  async cleanScratch() {
    // Ensure scratch artifacts never get committed.
    const dir = path.join(this.opts.repoRoot, ".ratifai");
    try {
      await fs.rm(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }

  async hasWorkingTreeChanges(): Promise<boolean> {
    const { stdout } = await this.repo.git(["status", "--porcelain"]);
    return Boolean(stdout.trim());
  }

  async maybeRunTests(commandLine?: string) {
    if (!commandLine) return;
    const parts = commandLine.trim().split(/\s+/);
    const cmd = parts[0];
    const args = parts.slice(1);
    if (!cmd) return;
    await this.repo.run(cmd, args, { timeoutMs: 20 * 60_000 });
  }

  async commitAll(issueKey: string) {
    await this.cleanScratch();
    await this.repo.git(["add", "-A"]);
    await this.repo.git(["commit", "-m", `feat: ${issueKey} (agent)`]);
    const { stdout } = await this.repo.git(["rev-parse", "HEAD"]);
    return stdout.trim();
  }

  async createPr(params: {
    issueKey: string;
    title: string;
    body: string;
    baseBranch?: string;
    remote?: string;
  }): Promise<CreatePrResult> {
    const remote = params.remote ?? "origin";
    const baseBranch = params.baseBranch ?? "develop";

    await this.repo.gh(["--version"], { timeoutMs: 20_000 });
    await this.repo.git(["push", "-u", remote, "HEAD"]);

    const headBranch = await this.currentBranch();
    // Ensure we never try to PR from the base branch itself.
    if (headBranch === baseBranch) {
      throw new Error(`Refusing to create PR from base branch '${baseBranch}'.`);
    }

    const { stdout: prUrl } = await this.repo.gh([
      "pr",
      "create",
      "--base",
      baseBranch,
      "--head",
      headBranch,
      "--title",
      params.title,
      "--body",
      params.body
    ]);

    const { stdout: shaStdout } = await this.repo.git(["rev-parse", "HEAD"]);
    return { prUrl: prUrl.trim(), branch: headBranch, commitSha: shaStdout.trim() };
  }
}

