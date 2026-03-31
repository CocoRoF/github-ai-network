import { useState, useEffect, useCallback, useRef } from "react";
import { Link } from "react-router-dom";
import GraphView from "../components/GraphView";
import TableView from "../components/TableView";
import Sidebar from "../components/Sidebar";
import StatsModal from "../components/StatsModal";

const API = "/api";

export default function GraphPage() {
  const [graphData, setGraphData] = useState({ nodes: [], links: [] });
  const [selectedNode, setSelectedNode] = useState(null);
  const [searchResults, setSearchResults] = useState([]);
  const [sessions, setSessions] = useState([]);
  const [selectedSession, setSelectedSession] = useState(null); // null = all
  const [filters, setFilters] = useState({
    types: ["author", "repo", "topic"],
    minStars: 0,
    limit: 300,
    language: "",
  });
  const [crawlerStatus, setCrawlerStatus] = useState({});
  const [loading, setLoading] = useState(false);
  const [stats, setStats] = useState({});
  const [graphStyle, setGraphStyle] = useState({
    nodeMinSize: 2,
    nodeMaxSize: 20,
    labelScale: 1.0,
    labelThreshold: 0.8,
    showLabels: true,
    edgeOpacity: 0.35,
    edgeWidthScale: 1.0,
  });
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [showStatsModal, setShowStatsModal] = useState(false);
  const [viewMode, setViewMode] = useState("graph");
  const graphRef = useRef();
  const searchTimeout = useRef(null);

  /* ── fetch sessions ───────────────────────────────── */
  const fetchSessions = useCallback(async () => {
    try {
      const r = await fetch(`${API}/sessions`);
      setSessions(await r.json());
    } catch (_) {}
  }, []);

  /* ── fetch graph ──────────────────────────────────── */
  const fetchGraph = useCallback(async () => {
    setLoading(true);
    try {
      const p = new URLSearchParams({
        limit: filters.limit,
        min_stars: filters.minStars,
        types: filters.types.join(","),
        compact: "true",
      });
      if (selectedSession) p.set("session_id", selectedSession);
      if (filters.language) p.set("language", filters.language);
      const res = await fetch(`${API}/graph?${p}`);
      const data = await res.json();
      setGraphData(data);
      setStats(data.stats || {});
    } catch (e) {
      console.error("fetch graph:", e);
    }
    setLoading(false);
  }, [filters, selectedSession]);

  /* ── crawler status polling ───────────────────────── */
  const fetchCrawler = useCallback(async () => {
    try {
      const r = await fetch(`${API}/crawler/status`);
      setCrawlerStatus(await r.json());
    } catch (_) {}
  }, []);

  useEffect(() => {
    fetchSessions();
    fetchGraph();
  }, [fetchGraph, fetchSessions]);

  useEffect(() => {
    fetchCrawler();
    const interval = crawlerStatus.worker_running ? 15_000 : 60_000;
    const id = setInterval(fetchCrawler, interval);
    return () => clearInterval(id);
  }, [fetchCrawler, crawlerStatus.worker_running]);

  /* ── node interaction ─────────────────────────────── */
  const focusNode = useCallback(
    (node) => {
      if (node && graphRef.current && node.x != null) {
        graphRef.current.centerAt(node.x, node.y, 600);
        graphRef.current.zoom(3, 600);
      }
    },
    [graphRef]
  );

  const handleNodeClick = async (node) => {
    if (!node) {
      setSelectedNode(null);
      return;
    }
    focusNode(node);
    try {
      const r = await fetch(`${API}/graph/node/${encodeURIComponent(node.id)}`);
      const detail = await r.json();
      setSelectedNode({ ...node, ...detail });
    } catch (_) {
      setSelectedNode(node);
    }
  };

  const handleExpand = async (nodeId) => {
    try {
      const r = await fetch(
        `${API}/graph/neighbors?node_id=${encodeURIComponent(nodeId)}`
      );
      const data = await r.json();
      setGraphData((prev) => {
        const ids = new Set(prev.nodes.map((n) => n.id));
        const linkKeys = new Set(
          prev.links.map(
            (l) =>
              `${l.source?.id ?? l.source}-${l.target?.id ?? l.target}`
          )
        );
        return {
          nodes: [
            ...prev.nodes,
            ...data.nodes.filter((n) => !ids.has(n.id)),
          ],
          links: [
            ...prev.links,
            ...data.links.filter(
              (l) => !linkKeys.has(`${l.source}-${l.target}`)
            ),
          ],
        };
      });
    } catch (e) {
      console.error("expand:", e);
    }
  };

  /* ── search ───────────────────────────────────────── */
  const handleSearchInput = (e) => {
    const q = e.target.value;
    clearTimeout(searchTimeout.current);
    if (!q.trim()) {
      setSearchResults([]);
      return;
    }
    searchTimeout.current = setTimeout(async () => {
      try {
        const r = await fetch(
          `${API}/search?q=${encodeURIComponent(q)}`
        );
        const data = await r.json();
        setSearchResults(data.results || []);
      } catch (_) {}
    }, 300);
  };

  const handleResultClick = (result) => {
    setSearchResults([]);
    handleExpand(result.id);
    const node = graphData.nodes.find((n) => n.id === result.id);
    if (node && graphRef.current) {
      graphRef.current.centerAt(node.x, node.y, 1000);
      graphRef.current.zoom(3, 1000);
      setSelectedNode(node);
    }
  };

  /* ── render ───────────────────────────────────────── */
  return (
    <div className="app">
      <header className="app-header">
        <div className="header-left">
          <h1 className="app-title">
            <span className="title-icon">◈</span> GitHub AI Network
          </h1>
          <div className="view-tabs">
            <button
              className={`view-tab${viewMode === "graph" ? " active" : ""}`}
              onClick={() => setViewMode("graph")}
            >
              Graph
            </button>
            <button
              className={`view-tab${viewMode === "table" ? " active" : ""}`}
              onClick={() => setViewMode("table")}
            >
              Table
            </button>
          </div>
        </div>

        <div className="header-center">
          <div className="search-container">
            <input
              type="text"
              placeholder="Search repos, authors, topics…"
              className="search-input"
              onChange={handleSearchInput}
            />
            {searchResults.length > 0 && (
              <div className="search-dropdown">
                {searchResults.map((r) => (
                  <div
                    key={r.id}
                    className="search-result"
                    onClick={() => handleResultClick(r)}
                  >
                    <span className={`type-badge type-${r.type}`}>
                      {r.type}
                    </span>
                    <span className="result-label">{r.label}</span>
                    {r.stars != null && (
                      <span className="result-stars">
                        ★ {r.stars.toLocaleString()}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="header-right">
          <button
            className="refresh-btn"
            onClick={fetchGraph}
            disabled={loading}
          >
            {loading ? "⟳ Loading…" : "⟳ Refresh"}
          </button>
          <Link to="/admin" className="btn btn-admin-link">
            Admin
          </Link>
        </div>
      </header>

      <main className="app-main">
        <div className={`sidebar-wrapper${sidebarOpen ? "" : " collapsed"}`}>
          <Sidebar
            stats={stats}
            crawlerStatus={crawlerStatus}
            filters={filters}
            onFiltersChange={setFilters}
            selectedNode={selectedNode}
            onExpandNode={handleExpand}
            onRefresh={fetchGraph}
            sessions={sessions}
            selectedSession={selectedSession}
            onSessionChange={setSelectedSession}
            graphStyle={graphStyle}
            onStyleChange={setGraphStyle}
            onStatsClick={() => setShowStatsModal(true)}
            sidebarOpen={sidebarOpen}
            onToggleSidebar={() => setSidebarOpen((v) => !v)}
          />
        </div>
        <div className="graph-container">
          {graphData.nodes.length === 0 && !loading ? (
            <div className="empty-state">
              <div className="empty-icon">◈</div>
              <h2>No Data Yet</h2>
              <p>
                Go to the{" "}
                <Link to="/admin" style={{ color: "var(--blue)" }}>
                  Admin page
                </Link>{" "}
                to create a crawler session.
              </p>
            </div>
          ) : viewMode === "graph" ? (
            <GraphView
              graphData={graphData}
              onNodeClick={handleNodeClick}
              selectedNode={selectedNode}
              graphRef={graphRef}
              graphStyle={graphStyle}
            />
          ) : (
            <TableView
              graphData={graphData}
              onNodeClick={handleNodeClick}
            />
          )}
        </div>
      </main>

      {showStatsModal && (
        <StatsModal
          graphData={graphData}
          onClose={() => setShowStatsModal(false)}
          onNodeClick={(node) => {
            setShowStatsModal(false);
            const graphNode = graphData.nodes.find((n) => n.id === node.id);
            handleNodeClick(graphNode || node);
          }}
        />
      )}
    </div>
  );
}
