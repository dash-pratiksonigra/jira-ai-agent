import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  createAgentConfig,
  createJiraConnection,
  deleteJiraConnection,
  deleteAgentConfig,
  deleteAllAgentConfigs,
  listAgentConfigs,
  listJiraConnections,
  listRunAudit,
  listRuns,
  testJiraConnection,
  updateAgentConfig
} from "./api.js";

type Toast = { kind: "ok" | "fail"; message: string };

function defaultAgentForm() {
  return {
    name: "Agent-1",
    enabled: false,
    jiraConnectionId: "",
    jql: "project = YOURPROJ AND status = \"To Do\" ORDER BY created DESC",
    pollIntervalSeconds: 120,
    workflowMapping: {
      todoStatus: "To Do",
      inProgressStatus: "In Progress",
      readyForReviewStatus: "Ready for review",
      todoToInProgressTransitionId: "0",
      inProgressToReadyForReviewTransitionId: "0"
    },
    claimingPolicy: { strategy: "label", labelName: "agent_claimed", labelValue: "ratifai" },
    toolPolicy: { allowWebResearch: false, allowRepoActions: false, allowRunTests: false, allowedRepoUrls: [], allowedPathPrefixes: [] },
    llmPolicy: { provider: "other", model: "", temperature: 0.2, maxTokens: 4000, monthlyBudgetUsd: 0 },
    safetyPolicy: { dryRun: true, requireHumanApprovalForTransition: false, requireHumanApprovalForPr: false, maxIssuesPerRun: 1, concurrency: 1 }
  };
}

export function App() {
  const [toast, setToast] = useState<Toast | null>(null);
  const [jiraConnections, setJiraConnections] = useState<any[]>([]);
  const [agentConfigs, setAgentConfigs] = useState<any[]>([]);
  const [runs, setRuns] = useState<any[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [auditEvents, setAuditEvents] = useState<any[]>([]);
  const [hiddenRunIds, setHiddenRunIds] = useState<Set<string>>(() => new Set());
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const selectedAgentIdRef = useRef<string | null>(null);
  const isNewConfigModeRef = useRef<boolean>(false);
  const isAgentDirtyRef = useRef<boolean>(false);

  const [connForm, setConnForm] = useState({ name: "Default", baseUrl: "", email: "", apiToken: "" });
  const [agentForm, setAgentForm] = useState<any>(defaultAgentForm());

  const selectedConnName = useMemo(() => jiraConnections.find((c) => c.id === agentForm.jiraConnectionId)?.name ?? "", [jiraConnections, agentForm.jiraConnectionId]);

  async function refresh() {
    const [conns, agents, r] = await Promise.all([listJiraConnections(), listAgentConfigs(), listRuns()]);
    setJiraConnections(conns as any);
    setAgentConfigs(agents as any);
    setRuns(r as any);
    if (!agentForm.jiraConnectionId && conns.length) {
      setAgentForm((x: any) => ({ ...x, jiraConnectionId: conns[0]!.id }));
    }

    const selectedId = selectedAgentIdRef.current;
    if (!selectedId && agents.length && !isNewConfigModeRef.current) {
      const firstId = (agents as any)[0]!.id as string;
      setSelectedAgentId(firstId);
      selectedAgentIdRef.current = firstId;
      setAgentForm((agents as any)[0]);
      return;
    }

    // Keep the editor in sync with the currently selected config,
    // but never overwrite user edits that haven't been saved yet.
    if (selectedId && !isAgentDirtyRef.current) {
      const updated = (agents as any[]).find((a) => a.id === selectedId);
      if (updated) setAgentForm(updated);
    }
  }

  useEffect(() => {
    selectedAgentIdRef.current = selectedAgentId;
  }, [selectedAgentId]);

  useEffect(() => {
    refresh().catch((e) => setToast({ kind: "fail", message: String(e) }));
    const t = setInterval(() => refresh().catch(() => {}), 3000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!selectedRunId) return;
    listRunAudit(selectedRunId)
      .then((ev) => setAuditEvents(ev as any))
      .catch((e) => setToast({ kind: "fail", message: String(e) }));
  }, [selectedRunId]);

  const visibleRuns = useMemo(() => runs.filter((r) => !hiddenRunIds.has(r.id)), [runs, hiddenRunIds]);

  return (
    <div>
      <div className="appTopbar">
        <div className="appTopbarInner">
          <div className="header" style={{ marginBottom: 0 }}>
            <div>
              <div className="title">RATIFAI Jira Agent</div>
              <div className="subtitle">Configure Jira connections, agent selection (JQL), workflow mapping, safety, and view run history.</div>
            </div>
            <div className="headerRight">
              {toast ? <span className={`pill ${toast.kind === "ok" ? "ok" : "fail"}`}>{toast.message}</span> : <span className="muted">API: `/api/*`</span>}
            </div>
          </div>
        </div>
      </div>

      <div className="container">

      <div className="grid">
        <div className="card">
          <div className="sectionTitle">
            <h2>Connections</h2>
            <span className="badge">{jiraConnections.length} saved</span>
          </div>
          <div className="row">
            <label>Name</label>
            <input value={connForm.name} onChange={(e) => setConnForm({ ...connForm, name: e.target.value })} />
          </div>
          <div className="row">
            <label>Base URL</label>
            <input placeholder="https://your-domain.atlassian.net" value={connForm.baseUrl} onChange={(e) => setConnForm({ ...connForm, baseUrl: e.target.value })} />
          </div>
          <div className="row">
            <label>Email</label>
            <input value={connForm.email} onChange={(e) => setConnForm({ ...connForm, email: e.target.value })} />
          </div>
          <div className="row">
            <label>API token</label>
            <input value={connForm.apiToken} onChange={(e) => setConnForm({ ...connForm, apiToken: e.target.value })} />
          </div>
          <div className="actions">
            <button
              className="primary"
              onClick={async () => {
                try {
                  await createJiraConnection(connForm);
                  setToast({ kind: "ok", message: "Connection saved" });
                  setConnForm({ ...connForm, apiToken: "" });
                  await refresh();
                } catch (e) {
                  setToast({ kind: "fail", message: String(e) });
                }
              }}
            >
              Save connection
            </button>
          </div>
          <div style={{ marginTop: 10 }}>
            <div className="tableWrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Base URL</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {jiraConnections.map((c) => (
                    <tr key={c.id}>
                      <td>{c.name}</td>
                      <td className="muted mono">{c.baseUrl}</td>
                      <td>
                        <button
                          onClick={async () => {
                            try {
                              const r = await testJiraConnection(c.id);
                              setToast({ kind: "ok", message: r.ok ? `OK: ${r.user?.displayName ?? "connected"}` : "Failed" });
                            } catch (e) {
                              setToast({ kind: "fail", message: String(e) });
                            }
                          }}
                        >
                          Test
                        </button>
                        <button
                          style={{ marginLeft: 8 }}
                          onClick={async () => {
                            try {
                              await deleteJiraConnection(c.id);
                              setToast({ kind: "ok", message: "Connection deleted" });
                              await refresh();
                            } catch (e) {
                              setToast({ kind: "fail", message: String(e) });
                            }
                          }}
                        >
                          Delete
                        </button>
                      </td>
                    </tr>
                  ))}
                  {!jiraConnections.length ? (
                    <tr>
                      <td colSpan={3} className="muted">
                        No connections yet.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="sectionTitle">
            <h2>Agent config</h2>
            <span className="badge">Editing: <span className="mono">{selectedAgentId ? selectedAgentId : "(new)"}</span></span>
          </div>
          <div className="row">
            <label>Selected config</label>
            <select
              value={selectedAgentId ?? ""}
              onChange={(e) => {
                const id = e.target.value;
                const nextId = id || null;
                setSelectedAgentId(nextId);
                selectedAgentIdRef.current = nextId;
                isNewConfigModeRef.current = nextId === null;
                isAgentDirtyRef.current = false;
                if (nextId === null) {
                  setAgentForm((prev: any) => {
                    const next = defaultAgentForm();
                    // preserve current jiraConnectionId if already set
                    next.jiraConnectionId = prev?.jiraConnectionId || (jiraConnections[0]?.id ?? "");
                    return next;
                  });
                  return;
                }
                const found = agentConfigs.find((a) => a.id === id);
                if (found) setAgentForm(found);
              }}
            >
              <option value="">(new)</option>
              {agentConfigs.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} ({a.enabled ? "enabled" : "disabled"})
                </option>
              ))}
            </select>
          </div>

          <div className="row">
            <label>Name</label>
            <input
              value={agentForm.name}
              onChange={(e) => {
                isAgentDirtyRef.current = true;
                setAgentForm({ ...agentForm, name: e.target.value });
              }}
            />
          </div>

          <div className="split">
            <div className="row tight" style={{ margin: 0 }}>
              <label>Enabled</label>
              <select value={String(agentForm.enabled)} onChange={(e) => setAgentForm({ ...agentForm, enabled: e.target.value === "true" })}>
                <option value="false">false</option>
                <option value="true">true</option>
              </select>
            </div>
            <div className="row tight" style={{ margin: 0 }}>
              <label>Jira connection</label>
              <select value={agentForm.jiraConnectionId} onChange={(e) => setAgentForm({ ...agentForm, jiraConnectionId: e.target.value })}>
                {jiraConnections.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="row">
            <label>JQL</label>
            <textarea
              value={agentForm.jql}
              onChange={(e) => {
                isAgentDirtyRef.current = true;
                setAgentForm({ ...agentForm, jql: e.target.value });
              }}
            />
          </div>
          <div className="split">
            <div className="row tight" style={{ margin: 0 }}>
              <label>Poll interval</label>
              <input
                type="number"
                value={agentForm.pollIntervalSeconds}
                onChange={(e) => setAgentForm({ ...agentForm, pollIntervalSeconds: Number(e.target.value) })}
              />
            </div>
            <div className="row tight" style={{ margin: 0 }}>
              <label>Dry-run</label>
              <select
                value={String(agentForm.safetyPolicy.dryRun)}
                onChange={(e) => setAgentForm({ ...agentForm, safetyPolicy: { ...agentForm.safetyPolicy, dryRun: e.target.value === "true" } })}
              >
                <option value="true">true</option>
                <option value="false">false</option>
              </select>
            </div>
          </div>

          <div className="divider" />

          <div className="split">
            <div className="row tight" style={{ margin: 0 }}>
              <label>Web research</label>
              <select
                value={String(agentForm.toolPolicy.allowWebResearch)}
                onChange={(e) => {
                  isAgentDirtyRef.current = true;
                  setAgentForm({ ...agentForm, toolPolicy: { ...agentForm.toolPolicy, allowWebResearch: e.target.value === "true" } });
                }}
              >
                <option value="false">false</option>
                <option value="true">true</option>
              </select>
            </div>
            <div className="row tight" style={{ margin: 0 }}>
              <label>Repo actions</label>
              <select
                value={String(agentForm.toolPolicy.allowRepoActions)}
                onChange={(e) => {
                  isAgentDirtyRef.current = true;
                  setAgentForm({ ...agentForm, toolPolicy: { ...agentForm.toolPolicy, allowRepoActions: e.target.value === "true" } });
                }}
              >
                <option value="false">false</option>
                <option value="true">true</option>
              </select>
            </div>
            <div className="row tight" style={{ margin: 0 }}>
              <label>LLM model</label>
              <input
                placeholder="(leave blank to auto-pick)"
                value={agentForm.llmPolicy.model}
                onChange={(e) => setAgentForm({ ...agentForm, llmPolicy: { ...agentForm.llmPolicy, model: e.target.value } })}
              />
            </div>
          </div>

          <div className="split">
            <div className="row tight" style={{ margin: 0 }}>
              <label>Run tests</label>
              <select
                value={String(agentForm.toolPolicy.allowRunTests)}
                onChange={(e) => {
                  isAgentDirtyRef.current = true;
                  setAgentForm({ ...agentForm, toolPolicy: { ...agentForm.toolPolicy, allowRunTests: e.target.value === "true" } });
                }}
              >
                <option value="false">false</option>
                <option value="true">true</option>
              </select>
            </div>
            <div className="row tight" style={{ margin: 0 }}>
              <label>Max tokens</label>
              <input
                type="number"
                value={agentForm.llmPolicy.maxTokens}
                onChange={(e) => setAgentForm({ ...agentForm, llmPolicy: { ...agentForm.llmPolicy, maxTokens: Number(e.target.value) } })}
              />
            </div>
            <div className="row tight" style={{ margin: 0 }}>
              <label>Temperature</label>
              <input
                type="number"
                step="0.1"
                value={agentForm.llmPolicy.temperature}
                onChange={(e) => setAgentForm({ ...agentForm, llmPolicy: { ...agentForm.llmPolicy, temperature: Number(e.target.value) } })}
              />
            </div>
          </div>

          <div className="row">
            <label>Claim label</label>
            <input
              value={`${agentForm.claimingPolicy.labelName}:${agentForm.claimingPolicy.labelValue}`}
              onChange={(e) => {
                const [labelName, labelValue] = e.target.value.split(":");
                setAgentForm({ ...agentForm, claimingPolicy: { ...agentForm.claimingPolicy, labelName: labelName || "agent_claimed", labelValue: labelValue || "ratifai" } });
              }}
            />
          </div>

          <div className="row">
            <label>Transitions</label>
            <div className="muted">
              Configure Jira transition IDs: To-do→In-Progress and In-Progress→Ready.
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 8 }}>
                <input
                  placeholder="todo→inProgress transitionId"
                  value={agentForm.workflowMapping.todoToInProgressTransitionId}
                  onChange={(e) => setAgentForm({ ...agentForm, workflowMapping: { ...agentForm.workflowMapping, todoToInProgressTransitionId: e.target.value } })}
                />
                <input
                  placeholder="inProgress→ready transitionId"
                  value={agentForm.workflowMapping.inProgressToReadyForReviewTransitionId}
                  onChange={(e) =>
                    setAgentForm({ ...agentForm, workflowMapping: { ...agentForm.workflowMapping, inProgressToReadyForReviewTransitionId: e.target.value } })
                  }
                />
              </div>
            </div>
          </div>

          <div className="actions">
            <button
              className="primary"
              onClick={async () => {
                try {
                  if (selectedAgentId) {
                    const updated = await updateAgentConfig(selectedAgentId, agentForm as any);
                    setAgentForm(updated as any);
                    isAgentDirtyRef.current = false;
                    setToast({ kind: "ok", message: `Agent updated (conn=${selectedConnName || "?"})` });
                  } else {
                    const created = await createAgentConfig(agentForm as any);
                    setSelectedAgentId(created.id);
                    selectedAgentIdRef.current = created.id;
                    isNewConfigModeRef.current = false;
                    setAgentForm(created as any);
                    isAgentDirtyRef.current = false;
                    setToast({ kind: "ok", message: `Agent created (conn=${selectedConnName || "?"})` });
                  }
                  await refresh();
                } catch (e) {
                  setToast({ kind: "fail", message: String(e) });
                }
              }}
              disabled={!jiraConnections.length}
            >
              {selectedAgentId ? "Update agent config" : "Create agent config"}
            </button>

            <button
              onClick={async () => {
                try {
                  if (selectedAgentId) {
                    await deleteAgentConfig(selectedAgentId);
                    setToast({ kind: "ok", message: "Agent config deleted" });
                    setSelectedAgentId(null);
                    selectedAgentIdRef.current = null;
                    isNewConfigModeRef.current = true;
                  } else {
                    await deleteAllAgentConfigs();
                    setToast({ kind: "ok", message: "All agent configs deleted" });
                    setSelectedAgentId(null);
                    selectedAgentIdRef.current = null;
                    isNewConfigModeRef.current = true;
                  }
                  await refresh();
                } catch (e) {
                  setToast({ kind: "fail", message: String(e) });
                }
              }}
            >
              {selectedAgentId ? "Delete selected" : "Delete all"}
            </button>
          </div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 14 }}>
        <div className="sectionTitle">
          <h2>Run history</h2>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span className="badge">Click a run to inspect audit events</span>
            <button
              onClick={() => {
                setHiddenRunIds((prev) => {
                  const next = new Set(prev);
                  for (const r of runs) next.add(r.id);
                  return next;
                });
                setSelectedRunId(null);
                setAuditEvents([]);
              }}
              disabled={!runs.length}
            >
              Hide all
            </button>
            <button
              onClick={() => {
                if (!selectedRunId) return;
                setHiddenRunIds((prev) => new Set(prev).add(selectedRunId));
                setSelectedRunId(null);
                setAuditEvents([]);
              }}
              disabled={!selectedRunId}
            >
              Hide selected
            </button>
            <button
              onClick={() => {
                setHiddenRunIds(new Set());
              }}
              disabled={!hiddenRunIds.size}
            >
              Reset hidden
            </button>
          </div>
        </div>
        <div className="tableWrap">
          <table className="table">
            <thead>
              <tr>
                <th>Run</th>
                <th>AgentConfig</th>
                <th>Status</th>
                <th>Started</th>
                <th>Finished</th>
                <th>Summary</th>
              </tr>
            </thead>
            <tbody>
              {visibleRuns.map((r) => (
                <tr key={r.id} style={{ cursor: "pointer" }} onClick={() => setSelectedRunId(r.id)}>
                  <td className="muted mono">{r.id}</td>
                  <td className="muted mono">{r.agentConfigId}</td>
                  <td>
                    <span className={`pill ${r.status === "succeeded" ? "ok" : r.status === "failed" ? "fail" : ""}`}>{r.status}</span>
                  </td>
                  <td className="muted">{new Date(r.startedAt).toLocaleString()}</td>
                  <td className="muted">{r.finishedAt ? new Date(r.finishedAt).toLocaleString() : "-"}</td>
                  <td className="muted">{r.summary ?? "-"}</td>
                </tr>
              ))}
              {!visibleRuns.length ? (
                <tr>
                  <td colSpan={6} className="muted">
                    {runs.length ? "All runs are hidden (Reset hidden to show)." : "No runs yet."}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>

      </div>

      <div className="card" style={{ marginTop: 14 }}>
        <div className="sectionTitle">
          <h2>Audit events</h2>
          {selectedRunId ? <span className="badge mono">{selectedRunId}</span> : <span className="badge">Select a run above</span>}
        </div>
        {!selectedRunId ? (
          <div className="muted">Select a run above.</div>
        ) : (
          <div className="tableWrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Action</th>
                  <th>IssueRun</th>
                  <th>Payload</th>
                </tr>
              </thead>
              <tbody>
                {auditEvents.map((e) => (
                  <tr key={e.id}>
                    <td className="muted">{new Date(e.at).toLocaleString()}</td>
                    <td>{e.actionType}</td>
                    <td className="muted mono">{e.issueRunId ?? "-"}</td>
                    <td className="muted">
                      <pre className="mono" style={{ margin: 0, whiteSpace: "pre-wrap" }}>{JSON.stringify(e.payloadJson, null, 2)}</pre>
                    </td>
                  </tr>
                ))}
                {!auditEvents.length ? (
                  <tr>
                    <td colSpan={4} className="muted">
                      No audit events for this run yet.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="muted" style={{ marginTop: 14, fontSize: 12 }}>
        Notes: Repo actions/PR creation are stubbed in this scaffold (planned next). Secrets are encrypted at rest in the API DB.
      </div>
      </div>
    </div>
  );
}

