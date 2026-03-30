export default function Sidebar({
  stats,
  crawlerStatus,
  filters,
  onFiltersChange,
  selectedNode,
  onExpandNode,
  onRefresh,
  sessions,
  selectedSession,
  onSessionChange,
  graphStyle,
  onStyleChange,
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

      {/* ── Session Selector ──────────────────────────── */}
      <div className="sidebar-section">
        <h3>Session</h3>
        <select
          className="session-select"
          value={selectedSession || ""}
          onChange={(e) =>
            onSessionChange(e.target.value ? Number(e.target.value) : null)
          }
        >
          <option value="">All Sessions</option>
          {sessions.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} ({s.total_repos} repos)
            </option>
          ))}
        </select>
        {crawlerStatus.worker_running && (
          <div className="crawler-mini-status">
            <span className="status-running">● Crawler active</span>
            <span className="crawler-mini-detail">
              {crawlerStatus.tasks_pending ?? 0} pending
            </span>
          </div>
        )}
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
          <label>Language</label>
          <select
            className="session-select"
            value={filters.language}
            onChange={(e) =>
              onFiltersChange({ ...filters, language: e.target.value })
            }
          >
            <option value="">All Languages</option>
            {[
              "Python",
              "JavaScript",
              "TypeScript",
              "C++",
              "Java",
              "Rust",
              "Go",
              "Jupyter Notebook",
              "C",
              "Swift",
              "Kotlin",
              "Ruby",
              "Scala",
              "R",
              "Julia",
            ].map((lang) => (
              <option key={lang} value={lang}>
                {lang}
              </option>
            ))}
          </select>
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
              {selectedNode.company && (
                <span>🏢 {selectedNode.company}</span>
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

      {/* ── Appearance (Gephi-style) ────────────────────── */}
      <div className="sidebar-section">
        <h3>Appearance</h3>

        <div className="filter-group">
          <label>Node Size: {graphStyle.nodeMinSize}–{graphStyle.nodeMaxSize}px</label>
          <div className="range-pair">
            <input
              type="range"
              min={1}
              max={10}
              step={0.5}
              value={graphStyle.nodeMinSize}
              onChange={(e) =>
                onStyleChange({ ...graphStyle, nodeMinSize: +e.target.value })
              }
              title="Min size"
            />
            <input
              type="range"
              min={5}
              max={40}
              step={1}
              value={graphStyle.nodeMaxSize}
              onChange={(e) =>
                onStyleChange({ ...graphStyle, nodeMaxSize: +e.target.value })
              }
              title="Max size"
            />
          </div>
        </div>

        <div className="filter-group">
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={graphStyle.showLabels}
              onChange={(e) =>
                onStyleChange({ ...graphStyle, showLabels: e.target.checked })
              }
            />
            Show Labels
          </label>
        </div>

        {graphStyle.showLabels && (
          <>
            <div className="filter-group">
              <label>Label Size: {graphStyle.labelScale.toFixed(1)}x</label>
              <input
                type="range"
                min={0.3}
                max={3.0}
                step={0.1}
                value={graphStyle.labelScale}
                onChange={(e) =>
                  onStyleChange({ ...graphStyle, labelScale: +e.target.value })
                }
              />
            </div>
            <div className="filter-group">
              <label>Label Zoom Threshold: {graphStyle.labelThreshold.toFixed(1)}</label>
              <input
                type="range"
                min={0.1}
                max={3.0}
                step={0.1}
                value={graphStyle.labelThreshold}
                onChange={(e) =>
                  onStyleChange({ ...graphStyle, labelThreshold: +e.target.value })
                }
              />
            </div>
          </>
        )}

        <div className="filter-group">
          <label>Edge Opacity: {Math.round(graphStyle.edgeOpacity * 100)}%</label>
          <input
            type="range"
            min={0.05}
            max={1.0}
            step={0.05}
            value={graphStyle.edgeOpacity}
            onChange={(e) =>
              onStyleChange({ ...graphStyle, edgeOpacity: +e.target.value })
            }
          />
        </div>

        <div className="filter-group">
          <label>Edge Width: {graphStyle.edgeWidthScale.toFixed(1)}x</label>
          <input
            type="range"
            min={0.1}
            max={3.0}
            step={0.1}
            value={graphStyle.edgeWidthScale}
            onChange={(e) =>
              onStyleChange({ ...graphStyle, edgeWidthScale: +e.target.value })
            }
          />
        </div>
      </div>

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
          <div className="legend-line">
            <span
              className="legend-line-sample"
              style={{ borderColor: "#da70d6" }}
            />
            Co-worker
          </div>
          <div className="legend-line">
            <span
              className="legend-line-sample legend-dashed"
              style={{ borderColor: "#8888cc" }}
            />
            Forked From
          </div>
        </div>
      </div>
    </aside>
  );
}
