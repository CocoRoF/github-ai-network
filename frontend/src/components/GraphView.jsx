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

  /* set of neighbor node ids when a node is selected */
  const highlightSet = useMemo(() => {
    if (!selectedNode) return null;
    const ids = new Set();
    ids.add(selectedNode.id);
    graphData.links.forEach((l) => {
      const s = l.source?.id ?? l.source;
      const t = l.target?.id ?? l.target;
      if (s === selectedNode.id) ids.add(t);
      if (t === selectedNode.id) ids.add(s);
    });
    return ids;
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
      const isNeighbor = highlightSet && highlightSet.has(node.id);
      const dimmed = highlightSet && !isNeighbor;

      ctx.beginPath();
      ctx.arc(node.x, node.y, r, 0, 2 * Math.PI);

      if (dimmed) {
        ctx.fillStyle = baseColor;
        ctx.globalAlpha = 0.12;
        ctx.fill();
        ctx.globalAlpha = 1;
        return;
      }

      ctx.fillStyle = baseColor;

      if (isSelected) {
        ctx.shadowColor = baseColor;
        ctx.shadowBlur = 20;
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 2.5;
        ctx.stroke();
      } else if (isNeighbor) {
        ctx.shadowColor = baseColor;
        ctx.shadowBlur = 8;
        ctx.strokeStyle = "rgba(255,255,255,0.5)";
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }

      ctx.fill();
      ctx.shadowBlur = 0;

      /* labels */
      const showLabel =
        style.showLabels &&
        (isSelected || isNeighbor || globalScale > style.labelThreshold || r > 8);
      if (showLabel) {
        const fontSize = Math.max((10 * style.labelScale) / globalScale, 1.5);
        const label =
          node.type === "repo"
            ? (node.label || "").split("/").pop()
            : node.label || "";
        ctx.font = `${isSelected ? "bold " : ""}${fontSize}px Sans-Serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        ctx.fillStyle = dimmed ? "rgba(201,209,217,0.15)" : "#c9d1d9";
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
      const connected =
        highlightSet.has(s) && highlightSet.has(t);
      const alpha = connected
        ? Math.min(style.edgeOpacity * 3, 1).toFixed(2)
        : (style.edgeOpacity * 0.08).toFixed(2);
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
      const connected = highlightSet.has(s) && highlightSet.has(t);
      return connected ? base * 2 : base * 0.3;
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
