import { useState, useEffect, useCallback } from "react";
import { Link } from "react-router-dom";

const API = "/api";

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
    max_depth: 3,
  });

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
      if (!r.ok) {
        setLoginError("Wrong password");
        return;
      }
      const data = await r.json();
      setToken(data.token);
      sessionStorage.setItem("admin_token", data.token);
      setPassword("");
    } catch (e) {
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
        fetch(`${API}/admin/sessions/${id}/tasks?limit=20`, { headers }),
      ]);
      if (sRes.ok) setSessionDetail(await sRes.json());
      if (tRes.ok) setTasks(await tRes.json());
    } catch (_) {}
  }, [token]);

  useEffect(() => {
    fetchSessions();
    fetchCrawlerStatus();
  }, [fetchSessions, fetchCrawlerStatus]);

  useEffect(() => {
    if (!token) return;
    const id = setInterval(() => {
      fetchSessions();
      fetchCrawlerStatus();
      if (selectedSessionId) fetchSessionDetail(selectedSessionId);
    }, 10_000);
    return () => clearInterval(id);
  }, [token, selectedSessionId, fetchSessions, fetchCrawlerStatus, fetchSessionDetail]);

  useEffect(() => {
    if (selectedSessionId) fetchSessionDetail(selectedSessionId);
  }, [selectedSessionId, fetchSessionDetail]);

  /* ── actions ────────────────────────────────────────── */
  const createSession = async (e) => {
    e.preventDefault();
    try {
      const r = await fetch(`${API}/admin/sessions`, {
        method: "POST",
        headers,
        body: JSON.stringify(newSession),
      });
      if (r.ok) {
        const s = await r.json();
        setShowNewForm(false);
        setNewSession({ name: "", seed_type: "search_query", seed_value: "", max_depth: 3 });
        await fetchSessions();
        setSelectedSessionId(s.id);
      }
    } catch (_) {}
  };

  const sessionAction = async (id, action) => {
    const method = action === "delete" ? "DELETE" : "POST";
    const url =
      action === "delete"
        ? `${API}/admin/sessions/${id}`
        : `${API}/admin/sessions/${id}/${action}`;
    await fetch(url, { method, headers });
    if (action === "delete") {
      setSelectedSessionId(null);
      setSessionDetail(null);
    }
    await fetchSessions();
    if (action !== "delete" && selectedSessionId === id) {
      await fetchSessionDetail(id);
    }
  };

  /* ── login screen ───────────────────────────────────── */
  if (!token) {
    return (
      <div className="admin-login-page">
        <form className="admin-login-form" onSubmit={handleLogin}>
          <h2>Admin Login</h2>
          <input
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="admin-input"
            autoFocus
          />
          {loginError && <div className="admin-error">{loginError}</div>}
          <button type="submit" className="btn btn-primary">
            Login
          </button>
          <Link to="/" className="btn" style={{ marginTop: 8, display: "block" }}>
            ← Back to Graph
          </Link>
        </form>
      </div>
    );
  }

  /* ── dashboard ──────────────────────────────────────── */
  return (
    <div className="admin-page">
      <header className="admin-header">
        <div className="header-left">
          <Link to="/" className="admin-back">← Graph</Link>
          <h1 className="app-title">Admin Dashboard</h1>
        </div>
        <div className="header-right">
          <span className="admin-status">
            Worker: {crawlerStatus.worker_running ? "● Running" : "○ Idle"}{" "}
            | API: {crawlerStatus.rate_limit_remaining ?? "–"}
          </span>
          <button className="btn" onClick={handleLogout}>
            Logout
          </button>
        </div>
      </header>

      <div className="admin-body">
        {/* ── session list ───────────────────────────── */}
        <aside className="admin-sidebar">
          <div className="admin-sidebar-header">
            <h3>Sessions</h3>
            <button
              className="btn btn-sm"
              onClick={() => setShowNewForm(!showNewForm)}
            >
              {showNewForm ? "Cancel" : "+ New"}
            </button>
          </div>

          {showNewForm && (
            <form className="new-session-form" onSubmit={createSession}>
              <input
                className="admin-input"
                placeholder="Session name"
                value={newSession.name}
                onChange={(e) =>
                  setNewSession({ ...newSession, name: e.target.value })
                }
                required
              />
              <select
                className="admin-input"
                value={newSession.seed_type}
                onChange={(e) =>
                  setNewSession({ ...newSession, seed_type: e.target.value })
                }
              >
                <option value="search_query">Search Query</option>
                <option value="repository">Repository</option>
                <option value="user">User</option>
              </select>
              <input
                className="admin-input"
                placeholder={
                  newSession.seed_type === "search_query"
                    ? 'e.g. topic:pytorch stars:>100'
                    : newSession.seed_type === "repository"
                    ? "e.g. pytorch/pytorch"
                    : "e.g. yunjey"
                }
                value={newSession.seed_value}
                onChange={(e) =>
                  setNewSession({ ...newSession, seed_value: e.target.value })
                }
                required
              />
              <label className="admin-label">
                Max Depth: {newSession.max_depth}
                <input
                  type="range"
                  min={1}
                  max={5}
                  value={newSession.max_depth}
                  onChange={(e) =>
                    setNewSession({ ...newSession, max_depth: +e.target.value })
                  }
                />
              </label>
              <button type="submit" className="btn btn-primary">
                Create & Start
              </button>
            </form>
          )}

          <div className="session-list">
            {sessions.map((s) => (
              <div
                key={s.id}
                className={`session-item ${
                  selectedSessionId === s.id ? "selected" : ""
                }`}
                onClick={() => setSelectedSessionId(s.id)}
              >
                <div className="session-item-name">{s.name}</div>
                <div className="session-item-meta">
                  <span
                    className={`session-status-dot status-${s.status}`}
                  />
                  {s.status} · {s.total_repos} repos
                </div>
              </div>
            ))}
            {sessions.length === 0 && (
              <div className="session-empty">No sessions yet</div>
            )}
          </div>
        </aside>

        {/* ── session detail ─────────────────────────── */}
        <main className="admin-main">
          {sessionDetail ? (
            <div className="session-detail">
              <h2>{sessionDetail.name}</h2>
              <div className="detail-grid">
                <div className="detail-item">
                  <span className="detail-label">Seed</span>
                  <span className="detail-value">
                    {sessionDetail.seed_type}: {sessionDetail.seed_value}
                  </span>
                </div>
                <div className="detail-item">
                  <span className="detail-label">Status</span>
                  <span
                    className={`detail-value session-status-dot status-${sessionDetail.status}`}
                  >
                    {" "}
                    {sessionDetail.status}
                  </span>
                </div>
                <div className="detail-item">
                  <span className="detail-label">Max Depth</span>
                  <span className="detail-value">
                    {sessionDetail.max_depth}
                  </span>
                </div>
                <div className="detail-item">
                  <span className="detail-label">Repos</span>
                  <span className="detail-value">
                    {sessionDetail.total_repos}
                  </span>
                </div>
                <div className="detail-item">
                  <span className="detail-label">Authors</span>
                  <span className="detail-value">
                    {sessionDetail.total_authors}
                  </span>
                </div>
                <div className="detail-item">
                  <span className="detail-label">Pending</span>
                  <span className="detail-value">
                    {sessionDetail.tasks_pending}
                  </span>
                </div>
                <div className="detail-item">
                  <span className="detail-label">Done</span>
                  <span className="detail-value">
                    {sessionDetail.tasks_done}
                  </span>
                </div>
                <div className="detail-item">
                  <span className="detail-label">Errors</span>
                  <span className="detail-value">
                    {sessionDetail.tasks_errors}
                  </span>
                </div>
              </div>

              <div className="session-actions">
                {sessionDetail.status === "running" ? (
                  <button
                    className="btn"
                    onClick={() =>
                      sessionAction(sessionDetail.id, "pause")
                    }
                  >
                    ⏸ Pause
                  </button>
                ) : (
                  <button
                    className="btn btn-primary"
                    onClick={() =>
                      sessionAction(sessionDetail.id, "start")
                    }
                  >
                    ▶ Start
                  </button>
                )}
                <button
                  className="btn btn-danger"
                  onClick={() => {
                    if (
                      window.confirm(
                        "Delete this session? Collected data will be kept."
                      )
                    )
                      sessionAction(sessionDetail.id, "delete");
                  }}
                >
                  🗑 Delete
                </button>
              </div>

              {/* ── recent tasks ──────────────────── */}
              <h3 style={{ marginTop: 24 }}>Recent Tasks</h3>
              <div className="tasks-table">
                {tasks.map((t) => (
                  <div key={t.id} className="task-row">
                    <span className={`task-status task-${t.status}`}>
                      {t.status === "done"
                        ? "✓"
                        : t.status === "error"
                        ? "✗"
                        : t.status === "processing"
                        ? "⟳"
                        : "○"}
                    </span>
                    <span className="task-type">{t.task_type}</span>
                    <span className="task-target" title={t.target}>
                      {t.target.length > 40
                        ? t.target.slice(0, 40) + "…"
                        : t.target}
                    </span>
                    <span className="task-depth">d{t.depth}</span>
                    {t.error_message && (
                      <span className="task-error" title={t.error_message}>
                        {t.error_message.slice(0, 50)}
                      </span>
                    )}
                  </div>
                ))}
                {tasks.length === 0 && (
                  <div className="session-empty">No tasks yet</div>
                )}
              </div>
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
