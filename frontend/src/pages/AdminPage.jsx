import { useState, useEffect, useCallback, useRef } from "react";
import { Link } from "react-router-dom";

const API = "/api";

/* ── tiny helpers ───────────────────────────────────────── */
function fmtDuration(secs) {
  if (secs == null) return "–";
  if (secs < 60) return `${Math.round(secs)}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ${Math.round(secs % 60)}s`;
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return `${h}h ${m}m`;
}

function timeAgo(isoStr) {
  if (!isoStr) return "–";
  const diff = (Date.now() - new Date(isoStr).getTime()) / 1000;
  if (diff < 60) return `${Math.round(diff)}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function HealthDot({ status }) {
  const color = status === "healthy" ? "#4ade80" : status === "warning" ? "#facc15" : "#ef4444";
  return <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: "50%", background: color, marginRight: 6 }} />;
}

function LogBadge({ level }) {
  const colors = { info: "#3b82f6", warning: "#f59e0b", error: "#ef4444" };
  return (
    <span className="log-badge" style={{ background: colors[level] || "#6b7280" }}>
      {level}
    </span>
  );
}

export default function AdminPage() {
  const [token, setToken] = useState(() => sessionStorage.getItem("admin_token") || "");
  const [password, setPassword] = useState("");
  const [loginError, setLoginError] = useState("");
  const [sessions, setSessions] = useState([]);
  const [selectedSessionId, setSelectedSessionId] = useState(null);
  const [sessionDetail, setSessionDetail] = useState(null);
  const [tasks, setTasks] = useState([]);
  const [crawlerStatus, setCrawlerStatus] = useState({});
  const [showNewForm, setShowNewForm] = useState(false);
  const [newSession, setNewSession] = useState({
    name: "",
    seed_type: "search_query",
    seed_value: "",
  });
  const [sessionLogs, setSessionLogs] = useState([]);
  const [globalLogs, setGlobalLogs] = useState([]);
  const [detailTab, setDetailTab] = useState("overview");
  const [logFilter, setLogFilter] = useState("");
  const logEndRef = useRef(null);

  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  /* ── login ──────────────────────────────────────────── */
  const handleLogin = async (e) => {
    e.preventDefault();
    setLoginError("");
    try {
      const r = await fetch(`${API}/admin/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (!r.ok) { setLoginError("Wrong password"); return; }
      const data = await r.json();
      setToken(data.token);
      sessionStorage.setItem("admin_token", data.token);
      setPassword("");
    } catch (_) {
      setLoginError("Connection error");
    }
  };

  const handleLogout = () => {
    setToken("");
    sessionStorage.removeItem("admin_token");
  };

  /* ── fetch data ─────────────────────────────────────── */
  const fetchSessions = useCallback(async () => {
    if (!token) return;
    try {
      const r = await fetch(`${API}/admin/sessions`, { headers });
      if (r.status === 401) { handleLogout(); return; }
      setSessions(await r.json());
    } catch (_) {}
  }, [token]);

  const fetchCrawlerStatus = useCallback(async () => {
    if (!token) return;
    try {
      const r = await fetch(`${API}/admin/crawler/status`, { headers });
      if (r.ok) setCrawlerStatus(await r.json());
    } catch (_) {}
  }, [token]);

  const fetchSessionDetail = useCallback(async (id) => {
    if (!token || !id) return;
    try {
      const [sRes, tRes] = await Promise.all([
        fetch(`${API}/admin/sessions/${id}`, { headers }),
        fetch(`${API}/admin/sessions/${id}/tasks?limit=30`, { headers }),
      ]);
      if (sRes.ok) setSessionDetail(await sRes.json());
      if (tRes.ok) setTasks(await tRes.json());
    } catch (_) {}
  }, [token]);

  const fetchSessionLogs = useCallback(async (id) => {
    if (!token || !id) return;
    try {
      const url = `${API}/admin/sessions/${id}/logs?limit=100${logFilter ? `&level=${logFilter}` : ""}`;
      const r = await fetch(url, { headers });
      if (r.ok) setSessionLogs(await r.json());
    } catch (_) {}
  }, [token, logFilter]);

  const fetchGlobalLogs = useCallback(async () => {
    if (!token) return;
    try {
      const r = await fetch(`${API}/admin/crawler/logs/recent?limit=80`, { headers });
      if (r.ok) setGlobalLogs(await r.json());
    } catch (_) {}
  }, [token]);

  useEffect(() => {
    fetchSessions();
    fetchCrawlerStatus();
    fetchGlobalLogs();
  }, [fetchSessions, fetchCrawlerStatus, fetchGlobalLogs]);

  useEffect(() => {
    if (!token) return;
    const id = setInterval(() => {
      fetchSessions();
      fetchCrawlerStatus();
      fetchGlobalLogs();
      if (selectedSessionId) {
        fetchSessionDetail(selectedSessionId);
        if (detailTab === "logs") fetchSessionLogs(selectedSessionId);
      }
    }, 5_000);
    return () => clearInterval(id);
  }, [token, selectedSessionId, detailTab, fetchSessions, fetchCrawlerStatus, fetchSessionDetail, fetchSessionLogs, fetchGlobalLogs]);

  useEffect(() => {
    if (selectedSessionId) {
      fetchSessionDetail(selectedSessionId);
      fetchSessionLogs(selectedSessionId);
    }
  }, [selectedSessionId, fetchSessionDetail, fetchSessionLogs]);

  /* ── actions ────────────────────────────────────────── */
  const createSession = async (e) => {
    e.preventDefault();
    try {
      const r = await fetch(`${API}/admin/sessions`, {
        method: "POST", headers,
        body: JSON.stringify(newSession),
      });
      if (r.ok) {
        const s = await r.json();
        setShowNewForm(false);
        setNewSession({ name: "", seed_type: "search_query", seed_value: "" });
        await fetchSessions();
        setSelectedSessionId(s.id);
      }
    } catch (_) {}
  };

  const sessionAction = async (id, action) => {
    const method = action === "delete" ? "DELETE" : "POST";
    const url = action === "delete"
      ? `${API}/admin/sessions/${id}`
      : `${API}/admin/sessions/${id}/${action}`;
    await fetch(url, { method, headers });
    if (action === "delete") { setSelectedSessionId(null); setSessionDetail(null); }
    await fetchSessions();
    if (action !== "delete" && selectedSessionId === id) await fetchSessionDetail(id);
  };

  /* ── computed health ────────────────────────────────── */
  const workerHealth = (() => {
    if (!crawlerStatus.worker_running) return "dead";
    if (crawlerStatus.rate_limit_waiting) return "warning";
    if (crawlerStatus.heartbeat_seconds_ago != null && crawlerStatus.heartbeat_seconds_ago > 60) return "warning";
    return "healthy";
  })();

  const sessionHealth = (s) => {
    if (s.status !== "running") return s.status;
    if (!crawlerStatus.worker_running) return "stale";
    return "running";
  };

  /* ── login screen ───────────────────────────────────── */
  if (!token) {
    return (
      <div className="admin-login-page">
        <form className="admin-login-form" onSubmit={handleLogin}>
          <h2>Admin Login</h2>
          <input type="password" placeholder="Password" value={password}
            onChange={(e) => setPassword(e.target.value)} className="admin-input" autoFocus />
          {loginError && <div className="admin-error">{loginError}</div>}
          <button type="submit" className="btn btn-primary">Login</button>
          <Link to="/" className="btn" style={{ marginTop: 8, display: "block" }}>← Back to Graph</Link>
        </form>
      </div>
    );
  }

  const rlPct = crawlerStatus.rate_limit_limit
    ? Math.round((crawlerStatus.rate_limit_remaining / crawlerStatus.rate_limit_limit) * 100) : null;
  const rlResetIn = crawlerStatus.rate_limit_reset
    ? Math.max(0, Math.round((new Date(crawlerStatus.rate_limit_reset).getTime() - Date.now()) / 1000)) : null;

  /* ── dashboard ──────────────────────────────────────── */
  return (
    <div className="admin-page">
      <header className="admin-header">
        <div className="header-left">
          <Link to="/" className="admin-back">← Graph</Link>
          <h1 className="app-title">Admin Dashboard</h1>
        </div>
        <div className="header-right">
          <button className="btn" onClick={handleLogout}>Logout</button>
        </div>
      </header>

      {/* ── status bar ──────────────────────────────── */}
      <div className="admin-status-bar">
        <div className="status-card">
          <div className="status-card-label">Worker</div>
          <div className="status-card-value">
            <HealthDot status={workerHealth} />
            {workerHealth === "healthy" ? "Running" : workerHealth === "warning" ? "Degraded" : "Stopped"}
          </div>
          {crawlerStatus.worker_uptime_seconds != null && (
            <div className="status-card-sub">Uptime: {fmtDuration(crawlerStatus.worker_uptime_seconds)}</div>
          )}
          {crawlerStatus.heartbeat_seconds_ago != null && (
            <div className="status-card-sub">Heartbeat: {Math.round(crawlerStatus.heartbeat_seconds_ago)}s ago</div>
          )}
        </div>

        <div className="status-card">
          <div className="status-card-label">Current Task</div>
          <div className="status-card-value" style={{ fontSize: 12 }}>
            {crawlerStatus.current_task
              ? <>
                  <span className="task-type-badge">{crawlerStatus.current_task.type}</span>
                  {" "}{crawlerStatus.current_task.target?.length > 30
                    ? crawlerStatus.current_task.target.slice(0, 30) + "…"
                    : crawlerStatus.current_task.target}
                </>
              : <span style={{ opacity: 0.5 }}>Idle</span>
            }
          </div>
          {crawlerStatus.current_task?.started_at && (
            <div className="status-card-sub">Started: {timeAgo(crawlerStatus.current_task.started_at)}</div>
          )}
        </div>

        <div className="status-card">
          <div className="status-card-label">Rate Limit</div>
          <div className="status-card-value">
            {crawlerStatus.rate_limit_waiting
              ? <span className="rate-limit-waiting">⏳ WAITING</span>
              : <>{crawlerStatus.rate_limit_remaining ?? "–"} / {crawlerStatus.rate_limit_limit ?? "–"}</>
            }
          </div>
          <div className="status-card-sub">
            {rlPct != null && (
              <div className="rate-bar">
                <div className="rate-bar-fill"
                  style={{ width: `${rlPct}%`, background: rlPct > 20 ? "#4ade80" : rlPct > 5 ? "#facc15" : "#ef4444" }} />
              </div>
            )}
            {rlResetIn != null && rlResetIn > 0 && <span>Resets in {fmtDuration(rlResetIn)}</span>}
          </div>
        </div>

        <div className="status-card">
          <div className="status-card-label">Throughput</div>
          <div className="status-card-value">
            {crawlerStatus.tasks_per_minute ? `${crawlerStatus.tasks_per_minute} tasks/min` : "–"}
          </div>
          <div className="status-card-sub">API calls: {crawlerStatus.total_api_calls ?? 0}</div>
        </div>

        <div className="status-card">
          <div className="status-card-label">Totals</div>
          <div className="status-card-value" style={{ fontSize: 12 }}>
            {crawlerStatus.total_repos ?? 0} repos · {crawlerStatus.total_authors ?? 0} authors
          </div>
          <div className="status-card-sub">
            Pending: {crawlerStatus.tasks_pending ?? 0} · Done: {crawlerStatus.tasks_done ?? 0} · Err: {crawlerStatus.tasks_errors ?? 0}
          </div>
        </div>
      </div>

      {crawlerStatus.last_error && (
        <div className="admin-error-banner">
          <strong>Last Error:</strong> {crawlerStatus.last_error}
        </div>
      )}

      <div className="admin-body">
        {/* ── session list ───────────────────────────── */}
        <aside className="admin-sidebar">
          <div className="admin-sidebar-header">
            <h3>Sessions</h3>
            <button className="btn btn-sm" onClick={() => setShowNewForm(!showNewForm)}>
              {showNewForm ? "Cancel" : "+ New"}
            </button>
          </div>

          {showNewForm && (
            <form className="new-session-form" onSubmit={createSession}>
              <input className="admin-input" placeholder="Session name"
                value={newSession.name} onChange={(e) => setNewSession({ ...newSession, name: e.target.value })} required />
              <select className="admin-input" value={newSession.seed_type}
                onChange={(e) => setNewSession({ ...newSession, seed_type: e.target.value })}>
                <option value="search_query">Search Query</option>
                <option value="repository">Repository</option>
                <option value="user">User</option>
              </select>
              <input className="admin-input"
                placeholder={
                  newSession.seed_type === "search_query" ? "e.g. topic:pytorch stars:>100"
                    : newSession.seed_type === "repository" ? "e.g. pytorch/pytorch" : "e.g. yunjey"
                }
                value={newSession.seed_value} onChange={(e) => setNewSession({ ...newSession, seed_value: e.target.value })} required />
              <button type="submit" className="btn btn-primary">Create & Start</button>
            </form>
          )}

          <div className="session-list">
            {sessions.map((s) => {
              const health = sessionHealth(s);
              return (
                <div key={s.id}
                  className={`session-item ${selectedSessionId === s.id ? "selected" : ""}`}
                  onClick={() => { setSelectedSessionId(s.id); setDetailTab("overview"); }}>
                  <div className="session-item-name">{s.name}</div>
                  <div className="session-item-meta">
                    <span className={`session-status-dot status-${health === "stale" ? "stale" : s.status}`} />
                    {health === "stale" ? <span className="stale-label">stale</span> : s.status}
                    {" · "}{s.total_repos} repos
                  </div>
                  {health === "stale" && (
                    <div className="session-stale-warning">⚠ Worker not running</div>
                  )}
                </div>
              );
            })}
            {sessions.length === 0 && <div className="session-empty">No sessions yet</div>}
          </div>

          <div className="global-log-section">
            <h4>Recent Activity</h4>
            <div className="global-log-list">
              {globalLogs.slice(0, 20).map((log, i) => (
                <div key={i} className={`global-log-entry log-${log.level}`}>
                  <span className="global-log-type">{log.event_type}</span>
                  <span className="global-log-msg">{log.message?.length > 60 ? log.message.slice(0, 60) + "…" : log.message}</span>
                </div>
              ))}
              {globalLogs.length === 0 && <div className="session-empty">No activity yet</div>}
            </div>
          </div>
        </aside>

        {/* ── session detail ─────────────────────────── */}
        <main className="admin-main">
          {sessionDetail ? (
            <div className="session-detail">
              <div className="session-detail-header">
                <h2>{sessionDetail.name}</h2>
                <div className="session-actions">
                  {sessionDetail.status === "running" ? (
                    <button className="btn" onClick={() => sessionAction(sessionDetail.id, "pause")}>⏸ Pause</button>
                  ) : (
                    <button className="btn btn-primary" onClick={() => sessionAction(sessionDetail.id, "start")}>▶ Start</button>
                  )}
                  <button className="btn btn-danger" onClick={() => {
                    if (window.confirm("Delete this session? Collected data will be kept."))
                      sessionAction(sessionDetail.id, "delete");
                  }}>🗑 Delete</button>
                </div>
              </div>

              <div className="detail-tabs">
                {["overview", "tasks", "logs"].map((tab) => (
                  <button key={tab}
                    className={`detail-tab ${detailTab === tab ? "active" : ""}`}
                    onClick={() => {
                      setDetailTab(tab);
                      if (tab === "logs") fetchSessionLogs(selectedSessionId);
                    }}>
                    {tab.charAt(0).toUpperCase() + tab.slice(1)}
                  </button>
                ))}
              </div>

              {detailTab === "overview" && (
                <div className="detail-overview">
                  <div className="detail-grid">
                    <div className="detail-item">
                      <span className="detail-label">Seed</span>
                      <span className="detail-value">{sessionDetail.seed_type}: {sessionDetail.seed_value}</span>
                    </div>
                    <div className="detail-item">
                      <span className="detail-label">Status</span>
                      <span className="detail-value">
                        <span className={`session-status-dot status-${sessionDetail.status}`} />
                        {sessionDetail.status}
                        {sessionDetail.status === "running" && !crawlerStatus.worker_running && (
                          <span className="stale-label" style={{ marginLeft: 8 }}>⚠ Worker not running</span>
                        )}
                      </span>
                    </div>
                    <div className="detail-item">
                      <span className="detail-label">Repos</span>
                      <span className="detail-value">{sessionDetail.total_repos}</span>
                    </div>
                    <div className="detail-item">
                      <span className="detail-label">Authors</span>
                      <span className="detail-value">{sessionDetail.total_authors}</span>
                    </div>
                    <div className="detail-item">
                      <span className="detail-label">Tasks Pending</span>
                      <span className="detail-value">{sessionDetail.tasks_pending}</span>
                    </div>
                    <div className="detail-item">
                      <span className="detail-label">Tasks Done</span>
                      <span className="detail-value">{sessionDetail.tasks_done}</span>
                    </div>
                    <div className="detail-item">
                      <span className="detail-label">Errors</span>
                      <span className="detail-value">{sessionDetail.tasks_errors}</span>
                    </div>
                    <div className="detail-item">
                      <span className="detail-label">Created</span>
                      <span className="detail-value">{timeAgo(sessionDetail.created_at)}</span>
                    </div>
                    <div className="detail-item">
                      <span className="detail-label">Last Updated</span>
                      <span className="detail-value">{timeAgo(sessionDetail.updated_at)}</span>
                    </div>
                  </div>

                  {(sessionDetail.tasks_done + sessionDetail.tasks_errors + sessionDetail.tasks_pending) > 0 && (
                    <div className="session-progress">
                      <div className="progress-label">
                        Task Progress: {sessionDetail.tasks_done} / {sessionDetail.tasks_done + sessionDetail.tasks_errors + sessionDetail.tasks_pending}
                      </div>
                      <div className="progress-bar">
                        <div className="progress-fill progress-done"
                          style={{ width: `${(sessionDetail.tasks_done / (sessionDetail.tasks_done + sessionDetail.tasks_errors + sessionDetail.tasks_pending)) * 100}%` }} />
                        <div className="progress-fill progress-error"
                          style={{ width: `${(sessionDetail.tasks_errors / (sessionDetail.tasks_done + sessionDetail.tasks_errors + sessionDetail.tasks_pending)) * 100}%` }} />
                      </div>
                    </div>
                  )}
                </div>
              )}

              {detailTab === "tasks" && (
                <div className="tasks-section">
                  <div className="tasks-table">
                    <div className="task-row task-header-row">
                      <span className="task-status">St</span>
                      <span className="task-type">Type</span>
                      <span className="task-target">Target</span>
                      <span className="task-depth">Depth</span>
                      <span className="task-result">Result</span>
                      <span className="task-time">Processed</span>
                    </div>
                    {tasks.map((t) => (
                      <div key={t.id} className={`task-row task-row-${t.status}`}>
                        <span className={`task-status task-${t.status}`}>
                          {t.status === "done" ? "✓" : t.status === "error" ? "✗" : t.status === "processing" ? "⟳" : "○"}
                        </span>
                        <span className="task-type">{t.task_type}</span>
                        <span className="task-target" title={t.target}>
                          {t.target.length > 35 ? t.target.slice(0, 35) + "…" : t.target}
                        </span>
                        <span className="task-depth">d{t.depth}</span>
                        <span className="task-result">{t.result_count ?? "–"}</span>
                        <span className="task-time">{t.processed_at ? timeAgo(t.processed_at) : "–"}</span>
                        {t.error_message && (
                          <div className="task-error-detail" title={t.error_message}>
                            ↳ {t.error_message.slice(0, 80)}
                          </div>
                        )}
                      </div>
                    ))}
                    {tasks.length === 0 && <div className="session-empty">No tasks yet</div>}
                  </div>
                </div>
              )}

              {detailTab === "logs" && (
                <div className="logs-section">
                  <div className="logs-toolbar">
                    <select className="admin-input log-filter-select" value={logFilter}
                      onChange={(e) => setLogFilter(e.target.value)}>
                      <option value="">All levels</option>
                      <option value="info">Info</option>
                      <option value="warning">Warning</option>
                      <option value="error">Error</option>
                    </select>
                    <button className="btn btn-sm" onClick={() => fetchSessionLogs(selectedSessionId)}>↻ Refresh</button>
                  </div>
                  <div className="logs-list">
                    {sessionLogs.map((log) => (
                      <div key={log.id} className={`log-entry log-${log.level}`}>
                        <span className="log-time">{log.created_at ? new Date(log.created_at).toLocaleTimeString() : ""}</span>
                        <LogBadge level={log.level} />
                        <span className="log-event-type">{log.event_type}</span>
                        <span className="log-message">{log.message}</span>
                        {log.metadata && (
                          <span className="log-meta" title={JSON.stringify(log.metadata)}>
                            {Object.entries(log.metadata).map(([k, v]) => `${k}=${v}`).join(" ")}
                          </span>
                        )}
                      </div>
                    ))}
                    {sessionLogs.length === 0 && <div className="session-empty">No logs yet</div>}
                    <div ref={logEndRef} />
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="admin-placeholder">
              Select a session or create a new one
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
