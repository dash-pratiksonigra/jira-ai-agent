import { z } from "zod";
import type { AgentConfig } from "@ratifai/shared";

export class ApiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly workerApiKey?: string
  ) {}

  private headers() {
    return {
      "Content-Type": "application/json",
      ...(this.workerApiKey ? { "x-worker-api-key": this.workerApiKey } : {})
    };
  }

  async claimNextIssue(agentConfigId: string): Promise<{ runId: string; agentConfig: AgentConfig }> {
    const resp = await fetch(`${this.baseUrl}/api/worker/claim-next-issue`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ agentConfigId })
    });
    if (!resp.ok) throw new Error(`API claim-next-issue failed: ${resp.status} ${await resp.text()}`);
    const json = await resp.json();
    return z
      .object({
        runId: z.string(),
        agentConfig: z.any()
      })
      .parse(json) as { runId: string; agentConfig: AgentConfig };
  }

  async createIssueRun(runId: string, issueKey: string): Promise<{ id: string }> {
    const resp = await fetch(`${this.baseUrl}/api/worker/issue-runs`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ runId, issueKey })
    });
    if (!resp.ok) throw new Error(`API issue-runs failed: ${resp.status} ${await resp.text()}`);
    const json = await resp.json();
    return z.object({ id: z.string() }).parse(json);
  }

  async audit(runId: string, issueRunId: string | undefined, actionType: string, payloadJson: Record<string, unknown>) {
    const resp = await fetch(`${this.baseUrl}/api/worker/audit`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        runId,
        issueRunId,
        actor: "agent",
        actionType,
        payloadJson
      })
    });
    if (!resp.ok) throw new Error(`API audit failed: ${resp.status} ${await resp.text()}`);
  }

  async finishRun(runId: string, status: "succeeded" | "failed" | "cancelled", summary?: string) {
    const resp = await fetch(`${this.baseUrl}/api/worker/finish-run`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ runId, status, summary })
    });
    if (!resp.ok) throw new Error(`API finish-run failed: ${resp.status} ${await resp.text()}`);
  }
}

