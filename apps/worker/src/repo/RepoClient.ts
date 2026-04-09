import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export class RepoClient {
  constructor(private readonly opts: { cwd: string }) {}

  async run(cmd: string, args: string[], opts?: { timeoutMs?: number }): Promise<{ stdout: string; stderr: string }> {
    const timeoutMs = opts?.timeoutMs ?? 10 * 60_000;
    const res = await execFileAsync(cmd, args, { cwd: this.opts.cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: 10 * 1024 * 1024 });
    return { stdout: (res.stdout ?? "").toString(), stderr: (res.stderr ?? "").toString() };
  }

  async git(args: string[], opts?: { timeoutMs?: number }) {
    return await this.run("git", args, opts);
  }

  async gh(args: string[], opts?: { timeoutMs?: number }) {
    return await this.run("gh", args, opts);
  }
}

