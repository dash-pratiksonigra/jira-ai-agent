-- CreateTable
CREATE TABLE "JiraConnection" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "baseUrl" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "secretId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "JiraConnection_secretId_fkey" FOREIGN KEY ("secretId") REFERENCES "Secret" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AgentConfig" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "jiraConnectionId" TEXT NOT NULL,
    "jql" TEXT NOT NULL,
    "pollIntervalSeconds" INTEGER NOT NULL DEFAULT 120,
    "workflowMappingJson" TEXT NOT NULL,
    "claimingPolicyJson" TEXT NOT NULL,
    "toolPolicyJson" TEXT NOT NULL,
    "llmPolicyJson" TEXT NOT NULL,
    "safetyPolicyJson" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AgentConfig_jiraConnectionId_fkey" FOREIGN KEY ("jiraConnectionId") REFERENCES "JiraConnection" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Run" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "agentConfigId" TEXT NOT NULL,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME,
    "status" TEXT NOT NULL,
    "summary" TEXT,
    CONSTRAINT "Run_agentConfigId_fkey" FOREIGN KEY ("agentConfigId") REFERENCES "AgentConfig" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "IssueRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "issueKey" TEXT NOT NULL,
    "claimedAt" DATETIME,
    "finishedAt" DATETIME,
    "status" TEXT NOT NULL,
    "prUrl" TEXT,
    "lastError" TEXT,
    CONSTRAINT "IssueRun_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT,
    "issueRunId" TEXT,
    "at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor" TEXT NOT NULL,
    "actionType" TEXT NOT NULL,
    "payloadJson" TEXT NOT NULL,
    CONSTRAINT "AuditEvent_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "AuditEvent_issueRunId_fkey" FOREIGN KEY ("issueRunId") REFERENCES "IssueRun" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Secret" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "kind" TEXT NOT NULL,
    "ciphertext" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "JiraConnection_secretId_key" ON "JiraConnection"("secretId");
