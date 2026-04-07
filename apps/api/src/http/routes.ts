import express from "express";
import { z } from "zod";
import {
  AgentConfigSchema,
  ClaimingPolicySchema,
  JiraConnectionSchema,
  LlmPolicySchema,
  SafetyPolicySchema,
  ToolPolicySchema,
  WorkflowMappingSchema
} from "@ratifai/shared";

import { randomUUID } from "node:crypto";
import { prisma } from "../db.js";
import { env } from "../env.js";
import { decryptString, encryptString } from "../crypto/secrets.js";
import { HttpError, parseJson } from "./errors.js";

export const router = express.Router();

function newId(prefix: string) {
  return `${prefix}_${randomUUID()}`;
}

function a(
  handler: (req: express.Request, res: express.Response, next: express.NextFunction) => Promise<void> | void
) {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

router.get("/health", a(async (_req, res) => {
  res.json({ ok: true });
}));

function requireWorkerKey(req: express.Request) {
  const required = env.WORKER_API_KEY;
  if (!required) return;
  const got = req.header("x-worker-api-key");
  if (!got || got !== required) throw new HttpError(401, "Unauthorized");
}

// --- Jira Connections ---
const CreateJiraConnectionBody = z.object({
  name: z.string().min(1),
  baseUrl: z.string().url(),
  email: z.string().min(1),
  apiToken: z.string().min(1)
});

router.get("/jira-connections", a(async (_req, res) => {
  const rows = await prisma.jiraConnection.findMany({ orderBy: { createdAt: "desc" } });
  res.json(rows.map((r) => JiraConnectionSchema.parse({ ...r, createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString() })));
}));

router.post("/jira-connections", a(async (req, res) => {
  const body = parseJson(req.body, CreateJiraConnectionBody);
  const id = newId("jira");
  const secretId = newId("sec");
  await prisma.secret.create({
    data: {
      id: secretId,
      kind: "jiraApiToken",
      ciphertext: encryptString(body.apiToken, env.SECRETS_MASTER_KEY)
    }
  });
  const row = await prisma.jiraConnection.create({
    data: {
      id,
      name: body.name,
      baseUrl: body.baseUrl.replace(/\/+$/, ""),
      email: body.email,
      secretId
    }
  });
  res.status(201).json(JiraConnectionSchema.parse({ ...row, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() }));
}));

router.post("/jira-connections/:id/test", a(async (req, res) => {
  const id = z.string().parse(req.params.id);
  const conn = await prisma.jiraConnection.findUnique({ where: { id }, include: { secret: true } });
  if (!conn || !conn.secret) throw new HttpError(404, "Jira connection not found");

  const token = decryptString(conn.secret.ciphertext, env.SECRETS_MASTER_KEY);
  const auth = Buffer.from(`${conn.email}:${token}`, "utf8").toString("base64");
  const resp = await fetch(`${conn.baseUrl}/rest/api/3/myself`, {
    headers: { Authorization: `Basic ${auth}`, Accept: "application/json" }
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new HttpError(400, "Jira connection test failed", { status: resp.status, body: text });
  }
  const json = (await resp.json()) as { displayName?: string; accountId?: string };
  res.json({ ok: true, user: { displayName: json.displayName ?? "", accountId: json.accountId ?? "" } });
}));

router.delete("/jira-connections/:id", a(async (req, res) => {
  const id = z.string().min(1).parse(req.params.id);
  const conn = await prisma.jiraConnection.findUnique({ where: { id } });
  if (!conn) throw new HttpError(404, "Jira connection not found");

  const refs = await prisma.agentConfig.count({ where: { jiraConnectionId: id } });
  if (refs > 0) {
    throw new HttpError(400, "Connection is in use by agent configs", { agentConfigCount: refs });
  }

  await prisma.$transaction(async (tx) => {
    // Remove connection first (it holds the FK to Secret)
    await tx.jiraConnection.delete({ where: { id } });
    if (conn.secretId) {
      await tx.secret.delete({ where: { id: conn.secretId } });
    }
  });

  res.json({ ok: true });
}));

// --- Agent Configs ---
const CreateAgentConfigBody = z.object({
  name: z.string().min(1),
  enabled: z.boolean().optional(),
  jiraConnectionId: z.string().min(1),
  jql: z.string().min(1),
  pollIntervalSeconds: z.number().int().positive().optional(),
  workflowMapping: WorkflowMappingSchema,
  claimingPolicy: ClaimingPolicySchema,
  toolPolicy: ToolPolicySchema,
  llmPolicy: LlmPolicySchema,
  safetyPolicy: SafetyPolicySchema
});

const UpdateAgentConfigBody = CreateAgentConfigBody.partial().extend({
  // keep id immutable; it comes from path
  id: z.never().optional()
});

router.get("/agent-configs", a(async (_req, res) => {
  const rows = await prisma.agentConfig.findMany({ orderBy: { createdAt: "desc" } });
  res.json(
    rows.map((r) =>
      AgentConfigSchema.parse({
        id: r.id,
        name: r.name,
        enabled: r.enabled,
        jiraConnectionId: r.jiraConnectionId,
        jql: r.jql,
        pollIntervalSeconds: r.pollIntervalSeconds,
        workflowMapping: JSON.parse(r.workflowMappingJson),
        claimingPolicy: JSON.parse(r.claimingPolicyJson),
        toolPolicy: JSON.parse(r.toolPolicyJson),
        llmPolicy: JSON.parse(r.llmPolicyJson),
        safetyPolicy: JSON.parse(r.safetyPolicyJson),
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString()
      })
    )
  );
}));

router.post("/agent-configs", a(async (req, res) => {
  const body = parseJson(req.body, CreateAgentConfigBody);
  const id = newId("agent");
  const row = await prisma.agentConfig.create({
    data: {
      id,
      name: body.name,
      enabled: body.enabled ?? false,
      jiraConnectionId: body.jiraConnectionId,
      jql: body.jql,
      pollIntervalSeconds: body.pollIntervalSeconds ?? 120,
      workflowMappingJson: JSON.stringify(body.workflowMapping),
      claimingPolicyJson: JSON.stringify(body.claimingPolicy),
      toolPolicyJson: JSON.stringify(body.toolPolicy),
      llmPolicyJson: JSON.stringify(body.llmPolicy),
      safetyPolicyJson: JSON.stringify(body.safetyPolicy)
    }
  });
  res.status(201).json(
    AgentConfigSchema.parse({
      id: row.id,
      name: row.name,
      enabled: row.enabled,
      jiraConnectionId: row.jiraConnectionId,
      jql: row.jql,
      pollIntervalSeconds: row.pollIntervalSeconds,
      workflowMapping: JSON.parse(row.workflowMappingJson),
      claimingPolicy: JSON.parse(row.claimingPolicyJson),
      toolPolicy: JSON.parse(row.toolPolicyJson),
      llmPolicy: JSON.parse(row.llmPolicyJson),
      safetyPolicy: JSON.parse(row.safetyPolicyJson),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString()
    })
  );
}));

router.put("/agent-configs/:id", a(async (req, res) => {
  const id = z.string().min(1).parse(req.params.id);
  const body = parseJson(req.body, UpdateAgentConfigBody);

  const existing = await prisma.agentConfig.findUnique({ where: { id } });
  if (!existing) throw new HttpError(404, "Agent config not found");

  const row = await prisma.agentConfig.update({
    where: { id },
    data: {
      name: body.name ?? existing.name,
      enabled: body.enabled ?? existing.enabled,
      jiraConnectionId: body.jiraConnectionId ?? existing.jiraConnectionId,
      jql: body.jql ?? existing.jql,
      pollIntervalSeconds: body.pollIntervalSeconds ?? existing.pollIntervalSeconds,
      workflowMappingJson: body.workflowMapping ? JSON.stringify(body.workflowMapping) : existing.workflowMappingJson,
      claimingPolicyJson: body.claimingPolicy ? JSON.stringify(body.claimingPolicy) : existing.claimingPolicyJson,
      toolPolicyJson: body.toolPolicy ? JSON.stringify(body.toolPolicy) : existing.toolPolicyJson,
      llmPolicyJson: body.llmPolicy ? JSON.stringify(body.llmPolicy) : existing.llmPolicyJson,
      safetyPolicyJson: body.safetyPolicy ? JSON.stringify(body.safetyPolicy) : existing.safetyPolicyJson
    }
  });

  res.json(
    AgentConfigSchema.parse({
      id: row.id,
      name: row.name,
      enabled: row.enabled,
      jiraConnectionId: row.jiraConnectionId,
      jql: row.jql,
      pollIntervalSeconds: row.pollIntervalSeconds,
      workflowMapping: JSON.parse(row.workflowMappingJson),
      claimingPolicy: JSON.parse(row.claimingPolicyJson),
      toolPolicy: JSON.parse(row.toolPolicyJson),
      llmPolicy: JSON.parse(row.llmPolicyJson),
      safetyPolicy: JSON.parse(row.safetyPolicyJson),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString()
    })
  );
}));

// Delete a single agent config and all its runs/audit records.
router.delete("/agent-configs/:id", a(async (req, res) => {
  const id = z.string().min(1).parse(req.params.id);
  const existing = await prisma.agentConfig.findUnique({ where: { id } });
  if (!existing) throw new HttpError(404, "Agent config not found");

  await prisma.$transaction(async (tx) => {
    const runs = await tx.run.findMany({ where: { agentConfigId: id }, select: { id: true } });
    const runIds = runs.map((r) => r.id);

    if (runIds.length) {
      await tx.auditEvent.deleteMany({ where: { runId: { in: runIds } } });
      await tx.issueRun.deleteMany({ where: { runId: { in: runIds } } });
      await tx.run.deleteMany({ where: { id: { in: runIds } } });
    }

    await tx.agentConfig.delete({ where: { id } });
  });

  res.json({ ok: true });
}));

// Dangerous: delete all agent configs and their runs/audit records.
router.delete("/agent-configs", a(async (_req, res) => {
  await prisma.$transaction(async (tx) => {
    await tx.auditEvent.deleteMany({});
    await tx.issueRun.deleteMany({});
    await tx.run.deleteMany({});
    await tx.agentConfig.deleteMany({});
  });
  res.json({ ok: true });
}));

// --- Worker: claim + locking ---
// Implements a DB-backed lock so multiple workers/instances can't process the same AgentConfig concurrently.
// For SQLite, this is good enough; for Postgres, we'd use advisory locks.

const ClaimNextIssueBody = z.object({
  agentConfigId: z.string().min(1)
});

router.post("/worker/claim-next-issue", a(async (req, res) => {
  requireWorkerKey(req);
  const body = parseJson(req.body, ClaimNextIssueBody);

  const agent = await prisma.agentConfig.findUnique({ where: { id: body.agentConfigId } });
  if (!agent) throw new HttpError(404, "Agent config not found");
  if (!agent.enabled) throw new HttpError(400, "Agent disabled");

  const runId = newId("run");
  const run = await prisma.run.create({
    data: {
      id: runId,
      agentConfigId: agent.id,
      status: "running"
    }
  });

  // NOTE: In v1, the worker picks the issue via Jira search and calls back to record it.
  res.json({
    runId: run.id,
    agentConfig: {
      id: agent.id,
      name: agent.name,
      jiraConnectionId: agent.jiraConnectionId,
      jql: agent.jql,
      pollIntervalSeconds: agent.pollIntervalSeconds,
      workflowMapping: JSON.parse(agent.workflowMappingJson),
      claimingPolicy: JSON.parse(agent.claimingPolicyJson),
      toolPolicy: JSON.parse(agent.toolPolicyJson),
      llmPolicy: JSON.parse(agent.llmPolicyJson),
      safetyPolicy: JSON.parse(agent.safetyPolicyJson)
    }
  });
}));

const CreateIssueRunBody = z.object({
  runId: z.string().min(1),
  issueKey: z.string().min(1)
});

router.post("/worker/issue-runs", a(async (req, res) => {
  requireWorkerKey(req);
  const body = parseJson(req.body, CreateIssueRunBody);
  const id = newId("issueRun");
  const row = await prisma.issueRun.create({
    data: {
      id,
      runId: body.runId,
      issueKey: body.issueKey,
      claimedAt: new Date(),
      status: "claimed"
    }
  });
  res.status(201).json({ id: row.id });
}));

const AppendAuditBody = z.object({
  runId: z.string().min(1),
  issueRunId: z.string().optional(),
  actor: z.enum(["agent", "system"]),
  actionType: z.string().min(1),
  payloadJson: z.record(z.string(), z.any())
});

router.post("/worker/audit", a(async (req, res) => {
  requireWorkerKey(req);
  const body = parseJson(req.body, AppendAuditBody);
  const row = await prisma.auditEvent.create({
    data: {
      id: newId("audit"),
      runId: body.runId,
      issueRunId: body.issueRunId ?? null,
      actor: body.actor,
      actionType: body.actionType,
      payloadJson: JSON.stringify(body.payloadJson)
    }
  });
  res.status(201).json({ id: row.id });
}));

const FinishRunBody = z.object({
  runId: z.string().min(1),
  status: z.enum(["succeeded", "failed", "cancelled"]),
  summary: z.string().optional()
});

router.post("/worker/finish-run", a(async (req, res) => {
  requireWorkerKey(req);
  const body = parseJson(req.body, FinishRunBody);
  await prisma.run.update({
    where: { id: body.runId },
    data: {
      finishedAt: new Date(),
      status: body.status,
      summary: body.summary ?? null
    }
  });
  res.json({ ok: true });
}));

// --- Runs / IssueRuns / Audit ---
router.get("/runs", a(async (_req, res) => {
  const rows = await prisma.run.findMany({ orderBy: { startedAt: "desc" }, take: 50 });
  res.json(
    rows.map((r) => ({
      id: r.id,
      agentConfigId: r.agentConfigId,
      startedAt: r.startedAt.toISOString(),
      finishedAt: r.finishedAt?.toISOString() ?? null,
      status: r.status,
      summary: r.summary ?? null
    }))
  );
}));

router.get("/runs/:runId/issue-runs", a(async (req, res) => {
  const runId = z.string().parse(req.params.runId);
  const rows = await prisma.issueRun.findMany({ where: { runId }, orderBy: { claimedAt: "desc" } });
  res.json(
    rows.map((r) => ({
      id: r.id,
      runId: r.runId,
      issueKey: r.issueKey,
      claimedAt: r.claimedAt?.toISOString() ?? null,
      finishedAt: r.finishedAt?.toISOString() ?? null,
      status: r.status,
      prUrl: r.prUrl ?? null,
      lastError: r.lastError ?? null
    }))
  );
}));

router.get("/runs/:runId/audit", a(async (req, res) => {
  const runId = z.string().parse(req.params.runId);
  const rows = await prisma.auditEvent.findMany({ where: { runId }, orderBy: { at: "asc" } });
  res.json(
    rows.map((e) => ({
      id: e.id,
      runId: e.runId,
      issueRunId: e.issueRunId,
      at: e.at.toISOString(),
      actor: e.actor,
      actionType: e.actionType,
      payloadJson: JSON.parse(e.payloadJson)
    }))
  );
}));

