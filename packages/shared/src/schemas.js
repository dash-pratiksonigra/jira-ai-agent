import { z } from "zod";
export const JiraConnectionSchema = z.object({
    id: z.string(),
    name: z.string().min(1),
    baseUrl: z.string().url(),
    email: z.string().min(1),
    createdAt: z.string(),
    updatedAt: z.string()
});
export const WorkflowMappingSchema = z.object({
    todoStatus: z.string().min(1),
    inProgressStatus: z.string().min(1),
    readyForReviewStatus: z.string().min(1),
    todoToInProgressTransitionId: z.string().min(1),
    inProgressToReadyForReviewTransitionId: z.string().min(1)
});
export const ClaimingPolicySchema = z.object({
    strategy: z.enum(["label", "customField"]),
    labelName: z.string().min(1).default("agent_claimed"),
    labelValue: z.string().min(1).default("ratifai"),
    customFieldId: z.string().optional()
});
export const ToolPolicySchema = z.object({
    allowWebResearch: z.boolean().default(false),
    allowRepoActions: z.boolean().default(false),
    allowRunTests: z.boolean().default(false),
    allowedRepoUrls: z.array(z.string().url()).default([]),
    allowedPathPrefixes: z.array(z.string()).default([])
});
export const LlmPolicySchema = z.object({
    provider: z.enum(["openai", "azureOpenAI", "anthropic", "other"]).default("other"),
    model: z.string().min(1).default(""),
    temperature: z.number().min(0).max(2).default(0.2),
    maxTokens: z.number().int().positive().default(4000),
    monthlyBudgetUsd: z.number().nonnegative().default(0)
});
export const SafetyPolicySchema = z.object({
    dryRun: z.boolean().default(true),
    requireHumanApprovalForTransition: z.boolean().default(false),
    requireHumanApprovalForPr: z.boolean().default(false),
    maxIssuesPerRun: z.number().int().positive().default(1),
    concurrency: z.number().int().positive().default(1)
});
export const AgentConfigSchema = z.object({
    id: z.string(),
    name: z.string().min(1),
    enabled: z.boolean().default(false),
    jiraConnectionId: z.string(),
    jql: z.string().min(1),
    pollIntervalSeconds: z.number().int().positive().default(120),
    workflowMapping: WorkflowMappingSchema,
    claimingPolicy: ClaimingPolicySchema,
    toolPolicy: ToolPolicySchema,
    llmPolicy: LlmPolicySchema,
    safetyPolicy: SafetyPolicySchema,
    createdAt: z.string(),
    updatedAt: z.string()
});
export const RunSchema = z.object({
    id: z.string(),
    agentConfigId: z.string(),
    startedAt: z.string(),
    finishedAt: z.string().nullable(),
    status: z.enum(["running", "succeeded", "failed", "cancelled"]),
    summary: z.string().nullable()
});
export const IssueRunSchema = z.object({
    id: z.string(),
    runId: z.string(),
    issueKey: z.string(),
    claimedAt: z.string().nullable(),
    finishedAt: z.string().nullable(),
    status: z.enum(["claimed", "clarifying", "executing", "readyForReview", "failed"]),
    prUrl: z.string().url().nullable(),
    lastError: z.string().nullable()
});
export const AuditEventSchema = z.object({
    id: z.string(),
    issueRunId: z.string().nullable(),
    runId: z.string().nullable(),
    at: z.string(),
    actor: z.enum(["agent", "system"]),
    actionType: z.string().min(1),
    payloadJson: z.record(z.string(), z.any())
});
//# sourceMappingURL=schemas.js.map