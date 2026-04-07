import { z } from "zod";
import { AgentConfigSchema, JiraConnectionSchema } from "@ratifai/shared";

export async function listJiraConnections() {
  const resp = await fetch("/api/jira-connections");
  if (!resp.ok) throw new Error(await resp.text());
  const json = await resp.json();
  return z.array(JiraConnectionSchema).parse(json);
}

export async function createJiraConnection(input: { name: string; baseUrl: string; email: string; apiToken: string }) {
  const resp = await fetch("/api/jira-connections", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });
  if (!resp.ok) throw new Error(await resp.text());
  const json = await resp.json();
  return JiraConnectionSchema.parse(json);
}

export async function testJiraConnection(id: string) {
  const resp = await fetch(`/api/jira-connections/${encodeURIComponent(id)}/test`, { method: "POST" });
  if (!resp.ok) throw new Error(await resp.text());
  return (await resp.json()) as { ok: boolean; user?: { displayName: string; accountId: string } };
}

export async function deleteJiraConnection(id: string) {
  const resp = await fetch(`/api/jira-connections/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!resp.ok) throw new Error(await resp.text());
  return (await resp.json()) as { ok: boolean };
}

export async function listAgentConfigs() {
  const resp = await fetch("/api/agent-configs");
  if (!resp.ok) throw new Error(await resp.text());
  const json = await resp.json();
  return z.array(AgentConfigSchema).parse(json);
}

export async function createAgentConfig(input: unknown) {
  const resp = await fetch("/api/agent-configs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });
  if (!resp.ok) throw new Error(await resp.text());
  const json = await resp.json();
  return AgentConfigSchema.parse(json);
}

export async function updateAgentConfig(id: string, input: unknown) {
  // API treats `id` as immutable (comes from URL), so omit it from body if present.
  const body =
    input && typeof input === "object" && input !== null
      ? (() => {
          const { id: _ignored, ...rest } = input as Record<string, unknown>;
          return rest;
        })()
      : input;

  const resp = await fetch(`/api/agent-configs/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!resp.ok) throw new Error(await resp.text());
  const json = await resp.json();
  return AgentConfigSchema.parse(json);
}

export async function deleteAgentConfig(id: string) {
  const resp = await fetch(`/api/agent-configs/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!resp.ok) throw new Error(await resp.text());
  return (await resp.json()) as { ok: boolean };
}

export async function deleteAllAgentConfigs() {
  const resp = await fetch(`/api/agent-configs`, { method: "DELETE" });
  if (!resp.ok) throw new Error(await resp.text());
  return (await resp.json()) as { ok: boolean };
}

export async function listRuns() {
  const resp = await fetch("/api/runs");
  if (!resp.ok) throw new Error(await resp.text());
  return (await resp.json()) as Array<{
    id: string;
    agentConfigId: string;
    startedAt: string;
    finishedAt: string | null;
    status: string;
    summary: string | null;
  }>;
}

export async function listRunAudit(runId: string) {
  const resp = await fetch(`/api/runs/${encodeURIComponent(runId)}/audit`);
  if (!resp.ok) throw new Error(await resp.text());
  return (await resp.json()) as Array<{
    id: string;
    runId: string | null;
    issueRunId: string | null;
    at: string;
    actor: string;
    actionType: string;
    payloadJson: any;
  }>;
}

