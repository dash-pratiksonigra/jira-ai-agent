import type { AgentConfig } from "@ratifai/shared";
import type { JiraAdapter } from "../jira/JiraAdapter.js";

export async function tryClaimIssue(
  jira: JiraAdapter,
  agent: AgentConfig,
  issueKey: string
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const issue = await jira.getIssue(issueKey);

  const statusName = issue.fields.status?.name ?? "";
  if (statusName !== agent.workflowMapping.todoStatus) {
    return { ok: false, reason: `Issue status is '${statusName}', expected '${agent.workflowMapping.todoStatus}'` };
  }

  const labels = issue.fields.labels ?? [];
  if (agent.claimingPolicy.strategy === "label") {
    const claimLabel = `${agent.claimingPolicy.labelName}:${agent.claimingPolicy.labelValue}`;
    if (labels.includes(claimLabel)) return { ok: false, reason: "Already claimed" };
    const next = [...labels, claimLabel];
    await jira.editIssue(issueKey, { labels: next });
    return { ok: true };
  }

  if (agent.claimingPolicy.strategy === "customField") {
    if (!agent.claimingPolicy.customFieldId) return { ok: false, reason: "customFieldId not configured" };
    await jira.editIssue(issueKey, { [agent.claimingPolicy.customFieldId]: agent.name });
    return { ok: true };
  }

  return { ok: false, reason: "Unknown claiming strategy" };
}

