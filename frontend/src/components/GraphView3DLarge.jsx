/**
 * GraphView3DLarge — Thin wrapper around @cocorof/graphier's NetworkGraph3D.
 *
 * Translates the app-specific props (graphData, graphStyle, selectedNode, graphRef)
 * into graphier's prop interface while keeping the same external API that
 * GraphPage.jsx and NodeDetailModal.jsx expect.
 */
import { useRef, useMemo, useImperativeHandle, useState, useCallback } from "react";
import { NetworkGraph3D, celestial } from "@cocorof/graphier";

/* ── Context menu (app-specific UI) ───────────────── */
function ContextMenu({ x, y, node, onClose }) {
  if (!node) return null;
  const ghUrl =
    node.type === "topic"
      ? `https://github.com/topics/${node.label || node.id}`
      : `https://github.com/${node.label || node.id}`;

  return (
    <div
      className="node-context-menu"
      style={{ left: x, top: y }}
      onMouseLeave={onClose}
    >
      <a href={ghUrl} target="_blank" rel="noopener noreferrer" onClick={onClose}>
        Open on GitHub
      </a>
      <button
        onClick={() => {
          navigator.clipboard.writeText(
            `${node.type}: ${node.label || node.id}`
          );
          onClose();
        }}
      >
        Copy info
      </button>
    </div>
  );
}

/* ── Style → graphier props translator ────────────── */
function useGraphierStyle(graphStyle) {
  return useMemo(
    () => ({
      nodeMinSize: graphStyle.nodeMinSize ?? 1,
      nodeMaxSize: graphStyle.nodeMaxSize ?? 15,
      labelScale: graphStyle.labelScale ?? 1.0,
      labelThreshold: graphStyle.labelThreshold ?? 0.8,
      showLabels: graphStyle.showLabels ?? true,
      edgeOpacity: graphStyle.edgeOpacity ?? 0.15,
      edgeWidthScale: graphStyle.edgeWidthScale ?? 1.0,
      bloomStrength: graphStyle.bloomStrength ?? 0.6,
      bloomRadius: graphStyle.bloomRadius ?? 0.1,
      bloomThreshold: graphStyle.bloomThreshold ?? 0.1,
      autoOrbit: graphStyle.autoOrbit ?? false,
      starField: graphStyle.starField ?? true,
      fogDensity: graphStyle.fogDensity ?? 0.0006,
      flySpeed: graphStyle.flySpeed ?? 1.0,
      maxLabels: 150,
    }),
    [graphStyle]
  );
}

function useGraphierLayout(graphStyle) {
  return useMemo(
    () => ({
      ...(graphStyle.alphaDecay ? { alphaDecay: graphStyle.alphaDecay } : {}),
      spreadFactor: graphStyle.spreadFactor ?? "auto",
    }),
    [graphStyle.alphaDecay, graphStyle.spreadFactor]
  );
}

export default function GraphView3DLarge({
  graphData,
  onNodeClick,
  onNodeDoubleClick,
  selectedNode,
  graphRef: externalRef,
  graphStyle = {},
}) {
  const internalRef = useRef(null);
  const [ctxMenu, setCtxMenu] = useState(null);

  const style = useGraphierStyle(graphStyle);
  const layout = useGraphierLayout(graphStyle);

  /* ── Expose the same ref API that GraphPage/NodeDetailModal expect ── */
  useImperativeHandle(externalRef, () => ({
    cameraPosition(pos, lookAt, duration) {
      internalRef.current?.cameraPosition(pos, lookAt, duration);
    },
    zoomToFit(duration, padding) {
      internalRef.current?.zoomToFit(duration, padding);
    },
    zoomIn() {
      internalRef.current?.zoomIn();
    },
    zoomOut() {
      internalRef.current?.zoomOut();
    },
    focusNode(nodeId, duration) {
      internalRef.current?.focusNode(nodeId, duration);
    },
    captureScreenshot() {
      return internalRef.current?.captureScreenshot() ?? null;
    },
    reheatLayout() {
      internalRef.current?.reheatLayout();
    },
    scene() {
      return internalRef.current?.getScene();
    },
    renderer() {
      return internalRef.current?.getRenderer();
    },
  }));

  /* ── Context menu handler ── */
  const handleContextMenu = useCallback((node, pos) => {
    setCtxMenu({ x: pos.x, y: pos.y, node });
  }, []);

  const closeCtxMenu = useCallback(() => setCtxMenu(null), []);

  return (
    <div style={{ width: "100%", height: "100%", position: "relative" }}>
      <NetworkGraph3D
        ref={internalRef}
        data={graphData}
        theme={celestial}
        style={style}
        layout={layout}
        selectedNodeId={selectedNode?.id ?? null}
        highlightHops={3}
        onNodeClick={onNodeClick}
        onNodeDoubleClick={onNodeDoubleClick}
        onContextMenu={handleContextMenu}
      />
      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          node={ctxMenu.node}
          onClose={closeCtxMenu}
        />
      )}
    </div>
  );
}
