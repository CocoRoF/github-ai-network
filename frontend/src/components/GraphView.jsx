import { useCallback } from "react";
import ForceGraph2D from "react-force-graph-2d";

const NODE_COLORS = {
  author: "#58a6ff",
  repo: "#3fb950",
  topic: "#d29922",
};

const LINK_COLORS = {
  owns: "rgba(88,166,255,0.35)",
  contributes: "rgba(139,148,158,0.25)",
  has_topic: "rgba(210,153,34,0.25)",
  coworker: "rgba(218,112,214,0.30)",
  forked_from: "rgba(136,136,204,0.30)",
};

export default function GraphView({
  graphData,
  onNodeClick,
  selectedNode,
  graphRef,
}) {
  const paintNode = useCallback(
    (node, ctx, globalScale) => {
      let r = Math.max(Math.sqrt(node.val || 1) * 2, 3);
      const color = NODE_COLORS[node.type] || "#8b949e";

      /* circle */
      ctx.beginPath();
      ctx.arc(node.x, node.y, r, 0, 2 * Math.PI);
      ctx.fillStyle = color;

      /* selected highlight */
      if (selectedNode && selectedNode.id === node.id) {
        ctx.shadowColor = color;
        ctx.shadowBlur = 15;
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 2;
        ctx.stroke();
      }

      ctx.fill();
      ctx.shadowBlur = 0;

      /* label */
      if (globalScale > 0.8 || r > 8) {
        const fontSize = Math.max(10 / globalScale, 1.5);
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
    [selectedNode]
  );

  const paintArea = useCallback((node, color, ctx) => {
    const r = Math.max(Math.sqrt(node.val || 1) * 2, 3) + 2;
    ctx.beginPath();
    ctx.arc(node.x, node.y, r, 0, 2 * Math.PI);
    ctx.fillStyle = color;
    ctx.fill();
  }, []);

  const linkColor = useCallback(
    (link) => LINK_COLORS[link.type] || "rgba(139,148,158,0.2)",
    []
  );

  const linkWidth = useCallback(
    (link) => link.weight || 0.5,
    []
  );

  const linkDash = useCallback(
    (link) => link.type === "forked_from" ? [4, 2] : null,
    []
  );

  return (
    <ForceGraph2D
      ref={graphRef}
      graphData={graphData}
      nodeCanvasObject={paintNode}
      nodePointerAreaPaint={paintArea}
      linkColor={linkColor}
      linkWidth={linkWidth}
      linkLineDash={linkDash}
      onNodeClick={onNodeClick}
      backgroundColor="#0d1117"
      cooldownTicks={100}
      d3AlphaDecay={0.02}
      d3VelocityDecay={0.3}
    />
  );
}
