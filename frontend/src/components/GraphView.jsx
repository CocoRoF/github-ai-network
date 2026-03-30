import { useCallback, useMemo } from "react";
import ForceGraph2D from "react-force-graph-2d";

const NODE_COLORS = {
  author: "#58a6ff",
  repo: "#3fb950",
  topic: "#d29922",
};

const LINK_COLORS = {
  owns: "rgba(88,166,255,{a})",
  contributes: "rgba(139,148,158,{a})",
  has_topic: "rgba(210,153,34,{a})",
  coworker: "rgba(218,112,214,{a})",
  forked_from: "rgba(136,136,204,{a})",
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
      const color = NODE_COLORS[node.type] || "#8b949e";

      ctx.beginPath();
      ctx.arc(node.x, node.y, r, 0, 2 * Math.PI);
      ctx.fillStyle = color;

      if (selectedNode && selectedNode.id === node.id) {
        ctx.shadowColor = color;
        ctx.shadowBlur = 15;
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 2;
        ctx.stroke();
      }

      ctx.fill();
      ctx.shadowBlur = 0;

      if (style.showLabels && (globalScale > style.labelThreshold || r > 8)) {
        const fontSize = Math.max((10 * style.labelScale) / globalScale, 1.5);
        const label =
          node.type === "repo"
            ? (node.label || "").split("/").pop()
            : node.label || "";
        ctx.font = `${fontSize}px Sans-Serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        ctx.fillStyle = "#c9d1d9";
        ctx.fillText(label, node.x, node.y + r + 2);
      }
    },
    [selectedNode, nodeRadius, style.showLabels, style.labelThreshold, style.labelScale]
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
      const template = LINK_COLORS[link.type] || "rgba(139,148,158,{a})";
      return template.replace("{a}", style.edgeOpacity.toFixed(2));
    },
    [style.edgeOpacity]
  );

  const linkWidth = useCallback(
    (link) => (link.weight || 0.5) * style.edgeWidthScale,
    [style.edgeWidthScale]
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
      backgroundColor="#0d1117"
      cooldownTicks={100}
      d3AlphaDecay={0.02}
      d3VelocityDecay={0.3}
      d3Force="charge"
    />
  );
}
