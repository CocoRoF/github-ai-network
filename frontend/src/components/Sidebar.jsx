export default function Sidebar({
  stats,
  crawlerStatus,
  filters,
  onFiltersChange,
  onCrawlerToggle,
  selectedNode,
  onExpandNode,
  onRefresh,
}) {
  return (
    <aside className="sidebar">
      {/* ── Stats ─────────────────────────────────────── */}
      <div className="sidebar-section">
        <h3>Graph Stats</h3>
        <div className="stats-grid">
          <div className="stat">
            <span className="stat-value">{stats.repos || 0}</span>
            <span className="stat-label">Repos</span>
          </div>
          <div className="stat">
            <span className="stat-value">{stats.authors || 0}</span>
            <span className="stat-label">Authors</span>
          </div>
          <div className="stat">
            <span className="stat-value">{stats.topics || 0}</span>
            <span className="stat-label">Topics</span>
          </div>
        </div>
      </div>

      {/* ── Filters ───────────────────────────────────── */}
      <div className="sidebar-section">
        <h3>Filters</h3>

        <div className="filter-group">
          <label>Node Types</label>
          {["author", "repo", "topic"].map((t) => (
            <label key={t} className="checkbox-label">
              <input
                type="checkbox"
                checked={filters.types.includes(t)}
                onChange={(e) => {
                  const types = e.target.checked
                    ? [...filters.types, t]
                    : filters.types.filter((x) => x !== t);
                  onFiltersChange({ ...filters, types });
                }}
              />
              <span className={`type-dot type-${t}`} />
              {t.charAt(0).toUpperCase() + t.slice(1)}
            </label>
          ))}
        </div>

        <div className="filter-group">
          <label>Min Stars: {filters.minStars.toLocaleString()}</label>
          <input
            type="range"
            min={0}
            max={10000}
            step={100}
            value={filters.minStars}
            onChange={(e) =>
              onFiltersChange({ ...filters, minStars: +e.target.value })
            }
          />
        </div>

        <div className="filter-group">
          <label>Max Nodes: {filters.limit}</label>
          <input
            type="range"
            min={50}
            max={2000}
            step={50}
            value={filters.limit}
            onChange={(e) =>
              onFiltersChange({ ...filters, limit: +e.target.value })
            }
          />
        </div>

        <button className="btn btn-primary" onClick={onRefresh}>
          Apply Filters
        </button>
      </div>

      {/* ── Crawler ───────────────────────────────────── */}
      <div className="sidebar-section">
        <h3>Crawler</h3>
        <div className="crawler-info">
          <div
            className={`crawler-status ${
              crawlerStatus.running ? "status-running" : "status-stopped"
            }`}
          >
            {crawlerStatus.running ? "● Running" : "○ Stopped"}
          </div>
          <div className="crawler-stats">
            <span>Repos: {crawlerStatus.total_repos ?? "–"}</span>
            <span>Authors: {crawlerStatus.total_authors ?? "–"}</span>
            <span>Topics: {crawlerStatus.total_topics ?? "–"}</span>
            <span>Pending tasks: {crawlerStatus.tasks_pending ?? "–"}</span>
            <span>Done tasks: {crawlerStatus.tasks_done ?? "–"}</span>
            <span>Errors: {crawlerStatus.tasks_errors ?? "–"}</span>
            <span>
              API remaining: {crawlerStatus.rate_limit_remaining ?? "–"}
            </span>
          </div>
          {crawlerStatus.last_error && (
            <div className="crawler-error">{crawlerStatus.last_error}</div>
          )}
          <button className="btn btn-crawler" onClick={onCrawlerToggle}>
            {crawlerStatus.running ? "Stop Crawler" : "Start Crawler"}
          </button>
        </div>
      </div>

      {/* ── Selected Node ─────────────────────────────── */}
      {selectedNode && (
        <div className="sidebar-section">
          <h3>Node Detail</h3>
          <div className="node-detail">
            <div className={`node-type-badge type-${selectedNode.type}`}>
              {selectedNode.type}
            </div>
            <h4 className="node-name">{selectedNode.label}</h4>
            {selectedNode.description && (
              <p className="node-desc">{selectedNode.description}</p>
            )}
            <div className="node-meta">
              {selectedNode.stars != null && (
                <span>★ {selectedNode.stars.toLocaleString()}</span>
              )}
              {selectedNode.followers != null && (
                <span>👥 {selectedNode.followers.toLocaleString()}</span>
              )}
              {selectedNode.language && (
                <span>📝 {selectedNode.language}</span>
              )}
              {selectedNode.repo_count != null && (
                <span>📦 {selectedNode.repo_count} repos</span>
              )}
            </div>
            <div className="node-actions">
              <button
                className="btn btn-sm"
                onClick={() => onExpandNode(selectedNode.id)}
              >
                Expand Connections
              </button>
              {selectedNode.url && (
                <a
                  href={selectedNode.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="btn btn-sm btn-link"
                >
                  GitHub ↗
                </a>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Legend ─────────────────────────────────────── */}
      <div className="sidebar-section">
        <h3>Legend</h3>
        <div className="legend">
          <div className="legend-item">
            <span className="legend-dot" style={{ background: "#58a6ff" }} />
            Author
          </div>
          <div className="legend-item">
            <span className="legend-dot" style={{ background: "#3fb950" }} />
            Repository
          </div>
          <div className="legend-item">
            <span className="legend-dot" style={{ background: "#d29922" }} />
            Topic
          </div>
          <div className="legend-line">
            <span
              className="legend-line-sample"
              style={{ borderColor: "#58a6ff" }}
            />
            Owns
          </div>
          <div className="legend-line">
            <span
              className="legend-line-sample"
              style={{ borderColor: "#8b949e" }}
            />
            Contributes
          </div>
          <div className="legend-line">
            <span
              className="legend-line-sample"
              style={{ borderColor: "#d29922" }}
            />
            Has Topic
          </div>
        </div>
      </div>
    </aside>
  );
}
