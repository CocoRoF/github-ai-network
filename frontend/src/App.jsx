import { useState, useEffect, useCallback, useRef } from "react";
import GraphView from "./components/GraphView";
import Sidebar from "./components/Sidebar";

const API = "/api";

export default function App() {
  const [graphData, setGraphData] = useState({ nodes: [], links: [] });
  const [selectedNode, setSelectedNode] = useState(null);
  const [searchResults, setSearchResults] = useState([]);
  const [filters, setFilters] = useState({
    types: ["author", "repo", "topic"],
    minStars: 0,
    limit: 300,
  });
  const [crawlerStatus, setCrawlerStatus] = useState({});
  const [loading, setLoading] = useState(false);
  const [stats, setStats] = useState({});
  const graphRef = useRef();
  const searchTimeout = useRef(null);

  /* ── fetch graph ──────────────────────────────────── */
  const fetchGraph = useCallback(async () => {
    setLoading(true);
    try {
      const p = new URLSearchParams({
        limit: filters.limit,
        min_stars: filters.minStars,
        types: filters.types.join(","),
      });
      const res = await fetch(`${API}/graph?${p}`);
      const data = await res.json();
      setGraphData(data);
      setStats(data.stats || {});
    } catch (e) {
      console.error("fetch graph:", e);
    }
    setLoading(false);
  }, [filters]);

  /* ── crawler status polling ───────────────────────── */
  const fetchCrawler = useCallback(async () => {
    try {
      const r = await fetch(`${API}/crawler/status`);
      setCrawlerStatus(await r.json());
    } catch (_) {}
  }, []);

  useEffect(() => {
    fetchGraph();
  }, [fetchGraph]);

  useEffect(() => {
    fetchCrawler();
    const id = setInterval(fetchCrawler, 10_000);
    return () => clearInterval(id);
  }, [fetchCrawler]);

  /* ── node interaction ─────────────────────────────── */
  const handleNodeClick = (node) => setSelectedNode(node);

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

  /* ── crawler toggle ───────────────────────────────── */
  const toggleCrawler = async () => {
    const ep = crawlerStatus.running ? "stop" : "start";
    await fetch(`${API}/crawler/${ep}`, { method: "POST" });
    await fetchCrawler();
  };

  /* ── render ───────────────────────────────────────── */
  return (
    <div className="app">
      <header className="app-header">
        <div className="header-left">
          <h1 className="app-title">
            <span className="title-icon">◈</span> GitHub AI Network
          </h1>
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
        </div>
      </header>

      <main className="app-main">
        <Sidebar
          stats={stats}
          crawlerStatus={crawlerStatus}
          filters={filters}
          onFiltersChange={setFilters}
          onCrawlerToggle={toggleCrawler}
          selectedNode={selectedNode}
          onExpandNode={handleExpand}
          onRefresh={fetchGraph}
        />
        <div className="graph-container">
          {graphData.nodes.length === 0 && !loading ? (
            <div className="empty-state">
              <div className="empty-icon">◈</div>
              <h2>No Data Yet</h2>
              <p>
                Start the crawler to begin exploring the GitHub AI ecosystem.
              </p>
              <ol>
                <li>
                  Set <code>GITHUB_TOKEN</code> in the backend{" "}
                  <code>.env</code> file
                </li>
                <li>Click <strong>Start Crawler</strong> in the sidebar</li>
                <li>Wait for data to be collected</li>
                <li>Click <strong>⟳ Refresh</strong> to see the network</li>
              </ol>
            </div>
          ) : (
            <GraphView
              graphData={graphData}
              onNodeClick={handleNodeClick}
              selectedNode={selectedNode}
              graphRef={graphRef}
            />
          )}
        </div>
      </main>
    </div>
  );
}
