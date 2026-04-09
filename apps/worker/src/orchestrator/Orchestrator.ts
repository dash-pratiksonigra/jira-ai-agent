import type { AgentConfig } from "@ratifai/shared";
import type { JiraAdapter } from "../jira/JiraAdapter.js";
import { tryClaimIssue } from "../claim/claimIssue.js";
import { ApiClient } from "../api/ApiClient.js";
import { AnthropicClient } from "../llm/AnthropicClient.js";
import { env } from "../env.js";
import { CodeChangeRunner } from "../repo/CodeChangeRunner.js";

type ExecutionMode = "research" | "code_change";

function decideExecutionMode(agent: AgentConfig, issue: { fields: { summary?: string; description?: unknown } }): ExecutionMode {
  // v1 rules:
  // - If repo actions are allowed, prefer code changes unless ticket explicitly asks for research.
  // - Otherwise fall back to research (if allowed) or skip.
  const text = `${issue.fields.summary ?? ""}\n${JSON.stringify(issue.fields.description ?? "")}`.toLowerCase();
  const wantsResearch = /\bresearch\b|\binvestigate\b|\bspike\b|\brfc\b/.test(text);
  if (agent.toolPolicy.allowRepoActions && !wantsResearch) return "code_change";
  return "research";
}

export type OrchestratorDeps = {
  api: ApiClient;
  jira: JiraAdapter;
};

export class Orchestrator {
  constructor(private readonly deps: OrchestratorDeps) {}

  async runOnce(agent: AgentConfig): Promise<void> {
    const { runId } = await this.deps.api.claimNextIssue(agent.id);
    await this.deps.api.audit(runId, undefined, "run_started", { agentConfigId: agent.id, agentName: agent.name });

    try {
      const search = await this.deps.jira.search(agent.jql, agent.safetyPolicy.maxIssuesPerRun);
      const candidates = search.issues.map((i) => i.key);
      await this.deps.api.audit(runId, undefined, "jira_search", { jql: agent.jql, candidates });

      for (const issueKey of candidates) {
        const claimRes = await tryClaimIssue(this.deps.jira, agent, issueKey);
        await this.deps.api.audit(runId, undefined, "claim_attempt", { issueKey, ...claimRes });
        if (!claimRes.ok) continue;

        const { id: issueRunId } = await this.deps.api.createIssueRun(runId, issueKey);
        await this.processIssue(runId, agent, issueKey, issueRunId);
        await this.deps.api.finishRun(runId, "succeeded", `Processed ${issueKey}`);
        return;
      }

      await this.deps.api.finishRun(runId, "succeeded", "No claimable issues found");
    } catch (e) {
      const message = e instanceof Error ? e.message : "Unknown error";
      await this.deps.api.audit(runId, undefined, "run_failed", { error: message });
      await this.deps.api.finishRun(runId, "failed", message);
    }
  }

  private async processIssue(runId: string, agent: AgentConfig, issueKey: string, issueRunId: string) {
    // Discover
    const issue = await this.deps.jira.getIssue(issueKey);
    await this.deps.api.audit(runId, issueRunId, "discover", {
      issueKey,
      summary: issue.fields.summary ?? null,
      status: issue.fields.status?.name ?? null
    });

    // Transition To-do -> In-Progress
    if (!agent.safetyPolicy.dryRun) {
      await this.deps.jira.transitionIssue(issueKey, agent.workflowMapping.todoToInProgressTransitionId);
      await this.deps.api.audit(runId, issueRunId, "transition", {
        issueKey,
        to: agent.workflowMapping.inProgressStatus,
        transitionId: agent.workflowMapping.todoToInProgressTransitionId
      });
    } else {
      await this.deps.api.audit(runId, issueRunId, "dry_run_transition_skipped", {
        issueKey,
        transitionId: agent.workflowMapping.todoToInProgressTransitionId
      });
    }

    // Clarify (very simple heuristic v1)
    const hasDescription = Boolean(issue.fields.description);
    if (!hasDescription) {
      await this.deps.jira.addComment(issueKey, "I’m missing a description/acceptance criteria. Please add details so I can proceed.");
      await this.deps.api.audit(runId, issueRunId, "clarification_requested", { issueKey });
      return;
    }

    // Plan (placeholder): post a short plan
    await this.deps.jira.addComment(
      issueKey,
      [
        "## Plan (agent)",
        "- Confirm requirements and edge cases from the ticket description",
        "- Implement changes in repo (when repo tools are enabled)",
        "- Run tests (when enabled) and report results",
        "- Create/update PR and link it here",
        "- Move ticket to Ready for review"
      ].join("\n")
    );
    await this.deps.api.audit(runId, issueRunId, "plan_posted", { issueKey });

    // Execute: decide research vs code changes
    const mode = decideExecutionMode(agent, issue);
    await this.deps.api.audit(runId, issueRunId, "execution_mode_selected", { issueKey, mode });

    if (mode === "research") {
      if (!agent.toolPolicy.allowWebResearch) {
        await this.deps.api.audit(runId, issueRunId, "execute_skipped", { reason: "allowWebResearch=false" });
      } else if (!env.ANTHROPIC_API_KEY) {
        await this.deps.jira.addComment(issueKey, "Research is enabled but `ANTHROPIC_API_KEY` is not set on the worker.");
        await this.deps.api.audit(runId, issueRunId, "research_failed", { reason: "missing_anthropic_api_key" });
      } else {
        const model = agent.llmPolicy.model || "claude-sonnet";
        const llm = new AnthropicClient(env.ANTHROPIC_API_KEY, model, env.ANTHROPIC_BASE_URL);

        const descriptionText = JSON.stringify(issue.fields.description ?? "");
        const prompt = [
          "You are a senior engineering research agent. Your job is to understand a Jira ticket and produce a research-backed, actionable response.",
          "",
          "Behavior:",
          "- If the ticket is ambiguous, state assumptions and list precise clarifying questions.",
          "- Do not invent internal details (repos, systems, policies). Use the ticket text only; when something is unknown, say so.",
          "- Prefer concrete, implementable recommendations (architecture, data flows, tradeoffs, risks, rollout steps).",
          "- When proposing APIs/schemas, keep them minimal and consistent.",
          "",
          "Output format (use these exact headings):",
          "Summary",
          "Interpreted_requirements",
          "Assumptions",
          "Research_plan",
          "Findings",
          "Recommendations",
          "Risks_and_mitigations",
          "Next_steps",
          "Clarifying_questions",
          "Sources",
          "",
          `Ticket_title: ${issue.fields.summary ?? issueKey}`,
          `Ticket_description_json: ${descriptionText}`
        ].join("\n");

        try {
          const research = await llm.generateText(prompt, {
            maxTokens: Math.min(agent.llmPolicy.maxTokens ?? 4000, 3000),
            temperature: agent.llmPolicy.temperature ?? 0.2
          });

          await this.deps.jira.addComment(issueKey, ["## Research (agent)", "", research].join("\n"));
          await this.deps.api.audit(runId, issueRunId, "research_posted", { model, chars: research.length });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          await this.deps.jira.addComment(issueKey, ["## Research (agent) failed", "", msg].join("\n"));
          await this.deps.api.audit(runId, issueRunId, "research_failed", { model, error: msg });
        }
      }
    }

    if (mode === "code_change") {
      if (!agent.toolPolicy.allowRepoActions) {
        await this.deps.api.audit(runId, issueRunId, "code_change_skipped", { reason: "allowRepoActions=false" });
      } else if (!env.ANTHROPIC_API_KEY) {
        await this.deps.jira.addComment(issueKey, "Code changes are enabled but `ANTHROPIC_API_KEY` is not set on the worker.");
        await this.deps.api.audit(runId, issueRunId, "code_change_failed", { reason: "missing_anthropic_api_key" });
      } else {
        const model = agent.llmPolicy.model || "claude-sonnet";
        const llm = new AnthropicClient(env.ANTHROPIC_API_KEY, model, env.ANTHROPIC_BASE_URL);

        const repoRoot = env.REPO_ROOT ?? process.cwd();
        const runner = new CodeChangeRunner({ repoRoot });
        await runner.ensureCleanOrThrow();
        const branch = await runner.createBranch(issueKey);

        const desc = JSON.stringify(issue.fields.description ?? "");
        const patchPrompt = [
          "You are a senior software engineer. Based only on the Jira ticket text, produce a single unified diff patch to implement the requested change in this repository.",
          "",
          "Constraints:",
          "- Output ONLY a unified diff patch (no markdown fences, no commentary).",
          "- The patch must apply with `git apply`.",
          "- If you cannot implement safely, output an empty patch (no changes).",
          "",
          `Ticket_key: ${issueKey}`,
          `Ticket_title: ${issue.fields.summary ?? ""}`,
          `Ticket_description_json: ${desc}`
        ].join("\n");

        let patch = "";
        try {
          patch = await llm.generateText(patchPrompt, { maxTokens: 2500, temperature: 0.2 });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          await this.deps.jira.addComment(issueKey, ["## Code change (agent) failed", "", msg].join("\n"));
          await this.deps.api.audit(runId, issueRunId, "code_change_failed", { model, error: msg });
          patch = "";
        }

        try {
          if (patch.trim()) {
            await runner.applyPatch(patch);
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          await this.deps.jira.addComment(issueKey, ["## Patch apply failed", "", msg].join("\n"));
          await this.deps.api.audit(runId, issueRunId, "patch_apply_failed", { error: msg, branch });
        }

        await runner.ensureNonEmptyCommit(
          issueKey,
          [
            "# Agent output",
            "",
            "This PR was created by the worker in code-change mode.",
            "",
            "If no patch was applied, this file exists so the PR is not empty.",
            "",
            `Issue: ${issueKey}`,
            `Branch: ${branch}`
          ].join("\n")
        );

        if (agent.toolPolicy.allowRunTests) {
          try {
            await runner.maybeRunTests(env.RUN_TESTS_COMMAND);
            await this.deps.api.audit(runId, issueRunId, "tests_ran", { command: env.RUN_TESTS_COMMAND ?? null });
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            await this.deps.jira.addComment(issueKey, ["## Tests failed (agent)", "", msg].join("\n"));
            await this.deps.api.audit(runId, issueRunId, "tests_failed", { error: msg });
          }
        }

        const sha = await runner.commitAll(issueKey);
        const pr = await runner.createPr({
          issueKey,
          title: `${issueKey}: ${issue.fields.summary ?? "Agent changes"}`,
          body: ["## Summary", "- Automated changes by RATIFAI worker.", "", "## Test plan", "- (if configured) ran worker test command.", ""].join(
            "\n"
          ),
          baseBranch: env.PR_BASE_BRANCH,
          remote: env.PR_REMOTE
        });

        await this.deps.jira.addComment(issueKey, ["## PR created (agent)", "", pr.prUrl].join("\n"));
        await this.deps.api.audit(runId, issueRunId, "pr_created", { prUrl: pr.prUrl, branch: pr.branch, sha, commitSha: pr.commitSha });
      }
    }

    // Report
    await this.deps.api.audit(runId, issueRunId, "report_posted", { issueKey });

    // Transition In-Progress -> Ready for review
    if (!agent.safetyPolicy.dryRun) {
      await this.deps.jira.transitionIssue(issueKey, agent.workflowMapping.inProgressToReadyForReviewTransitionId);
      await this.deps.api.audit(runId, issueRunId, "transition", {
        issueKey,
        to: agent.workflowMapping.readyForReviewStatus,
        transitionId: agent.workflowMapping.inProgressToReadyForReviewTransitionId
      });
    } else {
      await this.deps.api.audit(runId, issueRunId, "dry_run_transition_skipped", {
        issueKey,
        transitionId: agent.workflowMapping.inProgressToReadyForReviewTransitionId
      });
    }
  }
}

