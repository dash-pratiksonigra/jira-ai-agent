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

function sanitizeUnifiedDiff(raw: string): string {
  const t = raw.trim();
  if (!t) return "";

  // If the model wrapped output in a code fence, extract the inside.
  const fence = t.match(/```(?:diff|patch|text)?\s*([\s\S]*?)\s*```/i);
  const inner = fence?.[1]?.trim();
  const candidate = inner && inner.includes("diff --git") ? inner : t;

  // Drop any leading non-diff chatter.
  const idx = candidate.indexOf("diff --git");
  return idx >= 0 ? candidate.slice(idx).trim() : "";
}

function validateUnifiedDiffOrThrow(patch: string) {
  const t = patch.trim();
  if (!t) throw new Error("Empty patch");

  if (t.includes("```")) throw new Error("Invalid patch: contains markdown code fences");
  if (!t.startsWith("diff --git ")) throw new Error("Invalid patch: must start with `diff --git`");
  if (!/\n--- (?:a\/|\/dev\/null)\S*/.test(t)) throw new Error("Invalid patch: missing `--- a/...` or `--- /dev/null`");
  if (!/\n\+\+\+ b\/\S+/.test(t)) throw new Error("Invalid patch: missing `+++ b/...`");
  if (!/\n@@ /.test(t)) throw new Error("Invalid patch: missing `@@` hunks");
  if (/(^|\n)\+\+ b\//.test(t)) throw new Error("Invalid patch: contains `++ b/...` (should be `+++ b/...`)");
  if (/(^|\n)-- a\//.test(t)) throw new Error("Invalid patch: contains `-- a/...` (should be `--- a/...`)");

  // Ensure sections are separated with `diff --git`, not only `---/+++` blocks.
  const lines = t.split(/\r?\n/);
  let sawDiff = false;
  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      sawDiff = true;
      continue;
    }
    if (!sawDiff) throw new Error("Invalid patch: content appears before first `diff --git`");
  }
}

function issueHasLabel(issue: { fields: { labels?: string[] | null } }, label: string): boolean {
  const labels = issue.fields.labels ?? [];
  return labels.includes(label);
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
      // Only pick issues that are explicitly labeled for AI handling.
      const requiredLabel = "ai";
      const labeled = search.issues.filter((i) => issueHasLabel(i, requiredLabel));
      const candidates = labeled.map((i) => i.key);
      await this.deps.api.audit(runId, undefined, "jira_search", {
        jql: agent.jql,
        requiredLabel,
        totalFound: search.issues.length,
        candidates
      });

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
      try {
        await this.deps.jira.transitionIssue(issueKey, agent.workflowMapping.todoToInProgressTransitionId);
        await this.deps.api.audit(runId, issueRunId, "transition", {
          issueKey,
          to: agent.workflowMapping.inProgressStatus,
          transitionId: agent.workflowMapping.todoToInProgressTransitionId
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await this.deps.api.audit(runId, issueRunId, "transition_failed", {
          issueKey,
          transitionId: agent.workflowMapping.todoToInProgressTransitionId,
          error: msg
        });
        await this.deps.jira.addComment(
          issueKey,
          ["## Transition failed (agent)", "", `Could not transition to '${agent.workflowMapping.inProgressStatus}'.`, "", msg].join("\n")
        );
      }
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

        const desc = JSON.stringify(issue.fields.description ?? "");
        const patchPromptBase = [
          "You are a senior software engineer working in an existing monorepo. Based only on the Jira ticket text, output ONE unified-diff patch that can be applied with `git apply`.",
          "",
          "Repository context:",
          "- This is a monorepo. Top-level folders include `apps/api`, `apps/ui`, `apps/worker`, and `packages/shared`.",
          "- Do NOT create files under a top-level `src/` folder unless it already exists in THIS repo.",
          "- Prefer paths under `apps/ui/src/...`, `apps/api/src/...`, `apps/worker/src/...`, or `packages/shared/src/...`.",
          "- If you are unsure about the correct location, choose the most likely existing app/package (usually `apps/ui/src/...` for frontend UI changes).",
          "",
          "Output rules (STRICT):",
          "- Output ONLY the patch text. No explanations. No markdown fences. No headings.",
          "- The patch MUST be a valid unified diff produced by `git diff` style output.",
          "- Every file change MUST start with `diff --git a/<path> b/<path>`.",
          "- For new files, include: `new file mode 100644`, an `index ...` line, `--- /dev/null`, `+++ b/<path>`, and at least one `@@` hunk.",
          "- For modified files, include: an `index ...` line, `--- a/<path>`, `+++ b/<path>`, and at least one `@@` hunk.",
          "- Inside hunks, every line MUST begin with exactly one of: space, `+`, or `-`.",
          "- Do NOT include any lines like `++ b/path` (invalid) or `-- a/path` (invalid).",
          "- Use correct paths relative to repo root (e.g. `apps/ui/src/...`).",
          "- If you are unsure about paths or cannot implement safely, output an EMPTY string (no changes).",
          "",
          "Minimal example (format only; do not copy paths blindly):",
          "diff --git a/README.md b/README.md",
          "index 1111111..2222222 100644",
          "--- a/README.md",
          "+++ b/README.md",
          "@@ -1,1 +1,2 @@",
          " Hello",
          "+World",
          "",
          `Ticket_key: ${issueKey}`,
          `Ticket_title: ${issue.fields.summary ?? ""}`,
          `Ticket_description_json: ${desc}`
        ].join("\n");

        let patch = "";
        let branch: string | null = null;
        try {
          // Retry once if patch is malformed / cannot be applied.
          let lastApplyErr = "";
          for (let attempt = 0; attempt < 2; attempt++) {
            const prompt =
              attempt === 0
                ? patchPromptBase
                : [
                    patchPromptBase,
                    "",
                    "The previous patch failed `git apply`. Fix the patch so it is a valid unified diff and so it uses correct repo-relative paths for THIS monorepo.",
                    "",
                    "Hard requirements for the corrected patch:",
                    "- Every file block MUST begin with `diff --git a/... b/...`.",
                    "- New files MUST include `new file mode 100644`, `--- /dev/null`, `+++ b/...`, and at least one `@@` hunk.",
                    "- Output ONLY the patch text. No markdown fences.",
                    "",
                    "git apply error:",
                    lastApplyErr
                  ].join("\n");

            patch = sanitizeUnifiedDiff(await llm.generateText(prompt, { maxTokens: 3000, temperature: 0.2 }));
            if (!patch) break;

            // Only create a branch if we have a non-empty patch to try.
            if (!branch) branch = await runner.createBranch(issueKey);

            try {
              validateUnifiedDiffOrThrow(patch);
              await runner.applyPatch(patch);
              lastApplyErr = "";
              break;
            } catch (e) {
              lastApplyErr = e instanceof Error ? e.message : String(e);
              if (attempt === 1) throw e;
            }
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          await this.deps.jira.addComment(issueKey, ["## Code change (agent) failed", "", msg].join("\n"));
          await this.deps.api.audit(runId, issueRunId, "code_change_failed", { model, error: msg });
          patch = "";
        }

        if (patch.trim() && !/diff --git a\//.test(patch)) {
          // Extremely defensive: ensure patch looks like a unified diff before continuing.
          const msg = "Generated patch did not contain `diff --git` headers after sanitation.";
          await this.deps.api.audit(runId, issueRunId, "patch_apply_failed", { error: msg, branch });
          await this.deps.jira.addComment(issueKey, ["## Patch apply failed", "", msg].join("\n"));
          patch = "";
        }

        if (!patch.trim()) {
          await this.deps.api.audit(runId, issueRunId, "patch_skipped", { reason: "empty_or_unsalvageable_patch", branch });
          await this.deps.jira.addComment(
            issueKey,
            [
              "## No code changes generated (agent)",
              "",
              "I couldn’t produce a patch I can safely apply from the current ticket text, so I’m not opening a PR.",
              "",
              "Please add missing details (expected behavior, file locations, acceptance criteria) and I’ll retry."
            ].join("\n")
          );
          return;
        }

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
      try {
        await this.deps.jira.transitionIssue(issueKey, agent.workflowMapping.inProgressToReadyForReviewTransitionId);
        await this.deps.api.audit(runId, issueRunId, "transition", {
          issueKey,
          to: agent.workflowMapping.readyForReviewStatus,
          transitionId: agent.workflowMapping.inProgressToReadyForReviewTransitionId
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await this.deps.api.audit(runId, issueRunId, "transition_failed", {
          issueKey,
          transitionId: agent.workflowMapping.inProgressToReadyForReviewTransitionId,
          error: msg
        });
        await this.deps.jira.addComment(
          issueKey,
          ["## Transition failed (agent)", "", `Could not transition to '${agent.workflowMapping.readyForReviewStatus}'.`, "", msg].join("\n")
        );
      }
    } else {
      await this.deps.api.audit(runId, issueRunId, "dry_run_transition_skipped", {
        issueKey,
        transitionId: agent.workflowMapping.inProgressToReadyForReviewTransitionId
      });
    }
  }
}

