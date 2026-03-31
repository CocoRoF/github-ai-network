import { useCallback, useMemo } from "react";
import ForceGraph2D from "react-force-graph-2d";

const NODE_COLORS = {
  author: "#58a6ff",
  repo: "#3fb950",
  topic: "#d29922",
};

const LINK_COLORS_SOLID = {
  owns: [88, 166, 255],
  contributes: [139, 148, 158],
  has_topic: [210, 153, 34],
  coworker: [218, 112, 214],
  forked_from: [136, 136, 204],
};

const DEFAULT_STYLE = {
  nodeMinSize: 2,
  nodeMaxSize: 20,
  labelScale: 1.0,
  labelThreshold: 0.8,
  showLabels: true,
  edgeOpacity: 0.35,
  edgeWidthScale: 1.0,
  chargeStrength: -30,
  linkDistance: 60,
};

export default function GraphView({
  graphData,
  onNodeClick,
  selectedNode,
  graphRef,
  graphStyle = {},
}) {
  const style = useMemo(
    () => ({ ...DEFAULT_STYLE, ...graphStyle }),
    [graphStyle]
  );

  /* set of neighbor node ids when a node is selected (3-hop BFS) */
  const highlightSet = useMemo(() => {
    if (!selectedNode) return null;
    // build adjacency list
    const adj = new Map();
    graphData.links.forEach((l) => {
      const s = l.source?.id ?? l.source;
      const t = l.target?.id ?? l.target;
      if (!adj.has(s)) adj.set(s, []);
      if (!adj.has(t)) adj.set(t, []);
      adj.get(s).push(t);
      adj.get(t).push(s);
    });
    // BFS up to 3 hops
    const visited = new Map(); // id → hop distance
    visited.set(selectedNode.id, 0);
    const queue = [selectedNode.id];
    while (queue.length > 0) {
      const current = queue.shift();
      const dist = visited.get(current);
      if (dist >= 3) continue;
      for (const neighbor of adj.get(current) || []) {
        if (!visited.has(neighbor)) {
          visited.set(neighbor, dist + 1);
          queue.push(neighbor);
        }
      }
    }
    return visited; // Map<id, hopDistance>
  }, [selectedNode, graphData.links]);

  /* map raw val → clamped pixel radius */
  const valRange = useMemo(() => {
    if (!graphData.nodes.length) return { min: 1, max: 1 };
    const vals = graphData.nodes.map((n) => n.val || 1);
    return { min: Math.min(...vals), max: Math.max(...vals) };
  }, [graphData.nodes]);

  const nodeRadius = useCallback(
    (node) => {
      const raw = node.val || 1;
      const { min, max } = valRange;
      const t = max > min ? (raw - min) / (max - min) : 0;
      return style.nodeMinSize + t * (style.nodeMaxSize - style.nodeMinSize);
    },
    [valRange, style.nodeMinSize, style.nodeMaxSize]
  );

  const paintNode = useCallback(
    (node, ctx, globalScale) => {
      const r = nodeRadius(node);
      const baseColor = NODE_COLORS[node.type] || "#8b949e";
      const isSelected = selectedNode && selectedNode.id === node.id;
      const hopDist = highlightSet ? highlightSet.get(node.id) : undefined;
      const isInHighlight = hopDist !== undefined;
      const dimmed = highlightSet && !isInHighlight;

      // graduated opacity: hop 0=full, 1=0.9, 2=0.55, 3=0.3
      const hopAlpha = isInHighlight ? [1, 0.9, 0.55, 0.3][hopDist] ?? 0.3 : 1;

      ctx.beginPath();
      ctx.arc(node.x, node.y, r, 0, 2 * Math.PI);

      if (dimmed) {
        ctx.fillStyle = baseColor;
        ctx.globalAlpha = 0.08;
        ctx.fill();
        ctx.globalAlpha = 1;
        return;
      }

      ctx.globalAlpha = hopAlpha;
      ctx.fillStyle = baseColor;

      if (isSelected) {
        ctx.shadowColor = baseColor;
        ctx.shadowBlur = 20;
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 2.5;
        ctx.stroke();
      } else if (hopDist === 1) {
        ctx.shadowColor = baseColor;
        ctx.shadowBlur = 10;
        ctx.strokeStyle = "rgba(255,255,255,0.6)";
        ctx.lineWidth = 1.5;
        ctx.stroke();
      } else if (hopDist === 2) {
        ctx.strokeStyle = "rgba(255,255,255,0.25)";
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.globalAlpha = 1;

      /* labels */
      const showLabel =
        style.showLabels &&
        (isSelected || isInHighlight || globalScale > style.labelThreshold || r > 8);
      if (showLabel) {
        const fontSize = Math.max((10 * style.labelScale) / globalScale, 1.5);
        const label =
          node.type === "repo"
            ? (node.label || "").split("/").pop()
            : node.label || "";
        ctx.font = `${isSelected ? "bold " : ""}${fontSize}px Sans-Serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        const labelAlpha = isInHighlight ? hopAlpha : 1;
        ctx.fillStyle = dimmed
          ? "rgba(201,209,217,0.08)"
          : `rgba(201,209,217,${labelAlpha.toFixed(2)})`;
        ctx.fillText(label, node.x, node.y + r + 2);
      }
    },
    [selectedNode, highlightSet, nodeRadius, style.showLabels, style.labelThreshold, style.labelScale]
  );

  const paintArea = useCallback(
    (node, color, ctx) => {
      const r = nodeRadius(node) + 2;
      ctx.beginPath();
      ctx.arc(node.x, node.y, r, 0, 2 * Math.PI);
      ctx.fillStyle = color;
      ctx.fill();
    },
    [nodeRadius]
  );

  const linkColorFn = useCallback(
    (link) => {
      const rgb = LINK_COLORS_SOLID[link.type] || [139, 148, 158];
      if (!highlightSet) {
        return `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${style.edgeOpacity.toFixed(2)})`;
      }
      const s = link.source?.id ?? link.source;
      const t = link.target?.id ?? link.target;
      const sHop = highlightSet.get(s);
      const tHop = highlightSet.get(t);
      const bothIn = sHop !== undefined && tHop !== undefined;
      if (!bothIn) {
        return `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${(style.edgeOpacity * 0.06).toFixed(2)})`;
      }
      // edge opacity based on the farther endpoint's hop distance
      const maxHop = Math.max(sHop, tHop);
      const hopMul = [3, 2.2, 1.2, 0.7][maxHop] ?? 0.7;
      const alpha = Math.min(style.edgeOpacity * hopMul, 1).toFixed(2);
      return `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alpha})`;
    },
    [style.edgeOpacity, highlightSet]
  );

  const linkWidth = useCallback(
    (link) => {
      const base = (link.weight || 0.5) * style.edgeWidthScale;
      if (!highlightSet) return base;
      const s = link.source?.id ?? link.source;
      const t = link.target?.id ?? link.target;
      const sHop = highlightSet.get(s);
      const tHop = highlightSet.get(t);
      const bothIn = sHop !== undefined && tHop !== undefined;
      if (!bothIn) return base * 0.2;
      const maxHop = Math.max(sHop, tHop);
      const mul = [2.5, 2, 1.2, 0.8][maxHop] ?? 0.8;
      return base * mul;
    },
    [style.edgeWidthScale, highlightSet]
  );

  const linkDash = useCallback(
    (link) => (link.type === "forked_from" ? [4, 2] : null),
    []
  );

  return (
    <ForceGraph2D
      ref={graphRef}
      graphData={graphData}
      nodeCanvasObject={paintNode}
      nodePointerAreaPaint={paintArea}
      linkColor={linkColorFn}
      linkWidth={linkWidth}
      linkLineDash={linkDash}
      onNodeClick={onNodeClick}
      onBackgroundClick={() => onNodeClick(null)}
      backgroundColor="#0d1117"
      cooldownTicks={100}
      d3AlphaDecay={0.02}
      d3VelocityDecay={0.3}
      d3Force="charge"
    />
  );
}
