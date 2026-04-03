import { useCallback, useMemo, useEffect, useRef } from "react";
import ForceGraph3D from "react-force-graph-3d";
import * as THREE from "three";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import SpriteText from "three-spritetext";

/* ── color constants ──────────────────────────────────── */
const NODE_COLORS = {
  author: "#58a6ff",
  repo: "#3fb950",
  topic: "#d29922",
};

const LINK_COLORS = {
  owns: "#58a6ff",
  contributes: "#8b949e",
  has_topic: "#d29922",
  coworker: "#da70d6",
  forked_from: "#8888cc",
};

/* ── LOD thresholds ───────────────────────────────────── */
const LOD_HIGH = 300;    // full sphere (16 segments)
const LOD_MED = 1500;    // low-poly sphere (8 segments)
const LOD_LOW = 8000;    // minimal sphere (4 segments)
const LOD_POINT = 50000; // beyond this: disable custom objects entirely

/* ── default style ────────────────────────────────────── */
const DEFAULT_STYLE = {
  nodeMinSize: 2,
  nodeMaxSize: 20,
  showLabels: true,
  labelScale: 1.0,
  edgeOpacity: 0.25,
  edgeWidthScale: 1.0,
  bloomStrength: 1.5,
  bloomRadius: 0.4,
  bloomThreshold: 0.1,
  particleSpeed: 0.004,
  particleCount: 1,
  showParticles: true,
  autoOrbit: false,
  starField: true,
  fogDensity: 0.0006,
};

/* ── helper: create star field ────────────────────────── */
function createStarField(count = 8000, radius = 6000) {
  const geo = new THREE.BufferGeometry();
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const sizes = new Float32Array(count);

  for (let i = 0; i < count; i++) {
    const r = radius * (0.4 + Math.random() * 0.6);
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
    positions[i * 3 + 2] = r * Math.cos(phi);

    const brightness = 0.5 + Math.random() * 0.5;
    // slight blue/white tint
    colors[i * 3] = brightness * (0.8 + Math.random() * 0.2);
    colors[i * 3 + 1] = brightness * (0.85 + Math.random() * 0.15);
    colors[i * 3 + 2] = brightness;
    sizes[i] = 0.5 + Math.random() * 2.0;
  }

  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geo.setAttribute("size", new THREE.BufferAttribute(sizes, 1));

  const mat = new THREE.PointsMaterial({
    size: 1.5,
    vertexColors: true,
    transparent: true,
    opacity: 0.7,
    sizeAttenuation: true,
    depthWrite: false,
  });

  return new THREE.Points(geo, mat);
}

/* ── helper: create nebula clouds ─────────────────────── */
function createNebula(count = 40, radius = 3000) {
  const group = new THREE.Group();
  const textureLoader = new THREE.TextureLoader();

  // procedural circle texture
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext("2d");
  const gradient = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  gradient.addColorStop(0, "rgba(255,255,255,0.3)");
  gradient.addColorStop(0.4, "rgba(255,255,255,0.05)");
  gradient.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 128, 128);
  const circleTexture = new THREE.CanvasTexture(canvas);

  const nebulaColors = [
    new THREE.Color(0x1a1a3e),
    new THREE.Color(0x1e3a5f),
    new THREE.Color(0x2d1b4e),
    new THREE.Color(0x0d2137),
    new THREE.Color(0x1b2a4a),
  ];

  for (let i = 0; i < count; i++) {
    const r = radius * (0.3 + Math.random() * 0.7);
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);

    const spriteMat = new THREE.SpriteMaterial({
      map: circleTexture,
      color: nebulaColors[Math.floor(Math.random() * nebulaColors.length)],
      transparent: true,
      opacity: 0.08 + Math.random() * 0.12,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const sprite = new THREE.Sprite(spriteMat);
    sprite.position.set(
      r * Math.sin(phi) * Math.cos(theta),
      r * Math.sin(phi) * Math.sin(theta),
      r * Math.cos(phi)
    );
    const scale = 400 + Math.random() * 1200;
    sprite.scale.set(scale, scale, 1);
    group.add(sprite);
  }

  return group;
}

/* ── geometry cache (LOD) ─────────────────────────────── */
const geoCache = {
  highSphere: null,
  medSphere: null,
  lowSphere: null,
  get(nodeCount) {
    if (!this.highSphere) {
      this.highSphere = new THREE.SphereGeometry(1, 16, 12);
      this.medSphere = new THREE.SphereGeometry(1, 8, 6);
      this.lowSphere = new THREE.SphereGeometry(1, 4, 3);
    }
    if (nodeCount < LOD_HIGH) return this.highSphere;
    if (nodeCount < LOD_MED) return this.medSphere;
    return this.lowSphere;
  },
};

/* ── main component ───────────────────────────────────── */
export default function GraphView3D({
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

  const bloomPassRef = useRef(null);
  const starFieldRef = useRef(null);
  const nebulaRef = useRef(null);
  const orbitIntervalRef = useRef(null);
  const initDoneRef = useRef(false);

  const nodeCount = graphData.nodes.length;
  const isLargeGraph = nodeCount > LOD_LOW;
  const isMedGraph = nodeCount > LOD_MED;
  const isMassive = nodeCount > 50000;
  const isUltra = nodeCount > 200000;

  /* ── highlight set (BFS 2-hop for perf at scale) ────── */
  const highlightSet = useMemo(() => {
    if (!selectedNode) return null;
    const adj = new Map();
    graphData.links.forEach((l) => {
      const s = l.source?.id ?? l.source;
      const t = l.target?.id ?? l.target;
      if (!adj.has(s)) adj.set(s, []);
      if (!adj.has(t)) adj.set(t, []);
      adj.get(s).push(t);
      adj.get(t).push(s);
    });
    const maxHops = nodeCount > 10000 ? 1 : nodeCount > 3000 ? 2 : 3;
    const visited = new Map();
    visited.set(selectedNode.id, 0);
    const queue = [selectedNode.id];
    while (queue.length > 0) {
      const current = queue.shift();
      const dist = visited.get(current);
      if (dist >= maxHops) continue;
      for (const neighbor of adj.get(current) || []) {
        if (!visited.has(neighbor)) {
          visited.set(neighbor, dist + 1);
          queue.push(neighbor);
        }
      }
    }
    return visited;
  }, [selectedNode, graphData.links, nodeCount]);

  /* ── val range for node sizing ──────────────────────── */
  const valRange = useMemo(() => {
    if (!graphData.nodes.length) return { min: 1, max: 1 };
    let min = Infinity, max = -Infinity;
    for (const n of graphData.nodes) {
      const v = n.val || 1;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    return { min, max };
  }, [graphData.nodes]);

  const getNodeSize = useCallback(
    (node) => {
      const raw = node.val || 1;
      const { min, max } = valRange;
      const t = max > min ? (raw - min) / (max - min) : 0;
      return style.nodeMinSize + t * (style.nodeMaxSize - style.nodeMinSize);
    },
    [valRange, style.nodeMinSize, style.nodeMaxSize]
  );

  /* ── scene setup (bloom, stars, fog) ────────────────── */
  const handleEngineInit = useCallback(
    (fg) => {
      if (!fg || initDoneRef.current) return;
      initDoneRef.current = true;

      const scene = fg.scene();
      const renderer = fg.renderer();

      // background
      scene.background = new THREE.Color(0x030810);

      // fog for depth
      if (style.fogDensity > 0) {
        scene.fog = new THREE.FogExp2(0x030810, style.fogDensity);
      }

      // bloom post-processing
      try {
        const bloomPass = new UnrealBloomPass(
          new THREE.Vector2(window.innerWidth, window.innerHeight),
          style.bloomStrength,
          style.bloomRadius,
          style.bloomThreshold
        );
        const composer = fg.postProcessingComposer();
        composer.addPass(bloomPass);
        bloomPassRef.current = bloomPass;
      } catch (e) {
        console.warn("Bloom not available:", e);
      }

      // star field
      if (style.starField) {
        const stars = createStarField(10000, 8000);
        scene.add(stars);
        starFieldRef.current = stars;
      }

      // nebula
      const nebula = createNebula(30, 5000);
      scene.add(nebula);
      nebulaRef.current = nebula;

      // ambient light tweak
      const ambientLight = new THREE.AmbientLight(0x404060, 1.2);
      scene.add(ambientLight);

      const pointLight = new THREE.PointLight(0x5588ff, 0.5, 10000);
      pointLight.position.set(0, 0, 0);
      scene.add(pointLight);

      // renderer tweaks
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.2;
    },
    [style.bloomStrength, style.bloomRadius, style.bloomThreshold, style.starField, style.fogDensity]
  );

  /* ── update bloom params on style change ────────────── */
  useEffect(() => {
    if (bloomPassRef.current) {
      bloomPassRef.current.strength = style.bloomStrength;
      bloomPassRef.current.radius = style.bloomRadius;
      bloomPassRef.current.threshold = style.bloomThreshold;
    }
  }, [style.bloomStrength, style.bloomRadius, style.bloomThreshold]);

  /* ── auto orbit ─────────────────────────────────────── */
  useEffect(() => {
    if (orbitIntervalRef.current) {
      clearInterval(orbitIntervalRef.current);
      orbitIntervalRef.current = null;
    }
    if (style.autoOrbit && graphRef?.current) {
      let angle = 0;
      orbitIntervalRef.current = setInterval(() => {
        if (!graphRef.current) return;
        const dist = 800;
        angle += 0.003;
        graphRef.current.cameraPosition(
          { x: dist * Math.sin(angle), y: 100, z: dist * Math.cos(angle) },
          { x: 0, y: 0, z: 0 }
        );
      }, 30);
    }
    return () => {
      if (orbitIntervalRef.current) clearInterval(orbitIntervalRef.current);
    };
  }, [style.autoOrbit, graphRef]);

  /* ── node 3D object ─────────────────────────────────── */
  const nodeThreeObject = useCallback(
    (node) => {
      const size = getNodeSize(node);
      const color = NODE_COLORS[node.type] || "#8b949e";
      const isSelected = selectedNode && selectedNode.id === node.id;
      const hopDist = highlightSet ? highlightSet.get(node.id) : undefined;
      const isInHighlight = hopDist !== undefined;
      const dimmed = highlightSet && !isInHighlight;

      const group = new THREE.Group();

      // ── sphere (with LOD geometry) ─────
      const geo = geoCache.get(nodeCount);
      const mat = new THREE.MeshStandardMaterial({
        color: new THREE.Color(color),
        emissive: new THREE.Color(color),
        emissiveIntensity: dimmed ? 0.02 : isSelected ? 1.2 : isInHighlight ? 0.6 : 0.35,
        roughness: 0.4,
        metalness: 0.3,
        transparent: true,
        opacity: dimmed ? 0.06 : isInHighlight ? [1, 0.9, 0.6, 0.35][hopDist] ?? 0.35 : 0.85,
      });

      const mesh = new THREE.Mesh(geo, mat);
      mesh.scale.setScalar(size);
      group.add(mesh);

      // ── glow ring for selected ─────
      if (isSelected) {
        const ringGeo = new THREE.RingGeometry(size * 1.3, size * 1.6, 32);
        const ringMat = new THREE.MeshBasicMaterial({
          color: new THREE.Color(color),
          transparent: true,
          opacity: 0.6,
          side: THREE.DoubleSide,
          depthWrite: false,
        });
        const ring = new THREE.Mesh(ringGeo, ringMat);
        ring.lookAt(new THREE.Vector3(0, 0, 1)); // face camera approximately
        group.add(ring);
      }

      // ── label (only for important nodes or when zoomed) ─────
      if (style.showLabels && !dimmed && !isMassive) {
        const showLabel = isSelected || isInHighlight || size > 6 || nodeCount < 2000;
        if (showLabel) {
          const label = node.type === "repo"
            ? (node.label || "").split("/").pop()
            : node.label || "";
          const sprite = new SpriteText(label);
          sprite.color = dimmed ? "rgba(201,209,217,0.08)" : "rgba(201,209,217,0.9)";
          sprite.textHeight = Math.max(size * 0.6 * style.labelScale, 1.5);
          sprite.position.y = -(size + sprite.textHeight * 0.6);
          sprite.fontWeight = isSelected ? "bold" : "normal";
          sprite.backgroundColor = false;
          sprite.padding = 0;
          group.add(sprite);
        }
      }

      return group;
    },
    [getNodeSize, selectedNode, highlightSet, nodeCount, style.showLabels, style.labelScale, isMassive]
  );

  /* ── link styling ───────────────────────────────────── */
  const linkColor = useCallback(
    (link) => {
      const base = LINK_COLORS[link.type] || "#8b949e";
      if (!highlightSet) return base;
      const s = link.source?.id ?? link.source;
      const t = link.target?.id ?? link.target;
      const sIn = highlightSet.has(s);
      const tIn = highlightSet.has(t);
      if (!sIn || !tIn) return "rgba(60,60,80,0.04)";
      return base;
    },
    [highlightSet]
  );

  const linkOpacity = useMemo(
    () => (highlightSet ? style.edgeOpacity * 0.8 : style.edgeOpacity),
    [style.edgeOpacity, highlightSet]
  );

  const linkWidthFn = useCallback(
    (link) => {
      const base = Math.max((link.weight || 0.5) * style.edgeWidthScale * 0.5, 0);
      if (!highlightSet) return base;
      const s = link.source?.id ?? link.source;
      const t = link.target?.id ?? link.target;
      if (!highlightSet.has(s) || !highlightSet.has(t)) return 0;
      return base * 1.5;
    },
    [style.edgeWidthScale, highlightSet]
  );

  /* ── node click: fly-to animation ───────────────────── */
  const handleNodeClick = useCallback(
    (node) => {
      if (!node) {
        onNodeClick(null);
        return;
      }
      // fly camera to node
      if (graphRef?.current) {
        const distance = 120;
        const distRatio = 1 + distance / Math.hypot(node.x || 0, node.y || 0, node.z || 0);
        graphRef.current.cameraPosition(
          {
            x: (node.x || 0) * distRatio,
            y: (node.y || 0) * distRatio,
            z: (node.z || 0) * distRatio,
          },
          { x: node.x, y: node.y, z: node.z },
          1200
        );
      }
      onNodeClick(node);
    },
    [onNodeClick, graphRef]
  );

  /* ── performance: choose engine based on size ───────── */
  const forceEngine = isMassive ? "ngraph" : "d3";
  const warmupTicks = isUltra ? 200 : isMassive ? 100 : nodeCount > 10000 ? 50 : 0;
  const cooldownTicks = isUltra ? 100 : isMassive ? 200 : nodeCount > 10000 ? 150 : 300;
  const enablePointer = nodeCount < 200000;
  const useCustomNodeObj = nodeCount < LOD_POINT;

  return (
    <ForceGraph3D
      graphData={graphData}
      /* ── node ─────────────── */
      {...(useCustomNodeObj
        ? { nodeThreeObject: nodeThreeObject, nodeThreeObjectExtend: false }
        : {
            nodeColor: (n) => {
              if (highlightSet && !highlightSet.has(n.id)) return "rgba(30,30,40,0.15)";
              return NODE_COLORS[n.type] || "#8b949e";
            },
            nodeOpacity: 0.85,
            nodeResolution: isUltra ? 3 : 4,
          }
      )}
      nodeVal="val"
      nodeRelSize={isUltra ? 2 : 4}
      nodeLabel={isUltra ? null : (n) => n.label}
      /* ── link ─────────────── */
      linkColor={linkColor}
      linkOpacity={linkOpacity}
      linkWidth={isUltra ? 0 : linkWidthFn}
      linkDirectionalParticles={style.showParticles && !isMassive ? style.particleCount : 0}
      linkDirectionalParticleSpeed={style.particleSpeed}
      linkDirectionalParticleWidth={1.0}
      linkDirectionalParticleColor={linkColor}
      linkCurvature={isUltra ? 0 : 0.05}
      /* ── interaction ──────── */
      onNodeClick={handleNodeClick}
      onBackgroundClick={() => onNodeClick(null)}
      enablePointerInteraction={enablePointer}
      enableNodeDrag={nodeCount < 50000}
      /* ── engine ───────────── */
      forceEngine={forceEngine}
      warmupTicks={warmupTicks}
      cooldownTicks={cooldownTicks}
      d3AlphaDecay={isMassive ? 0.05 : 0.02}
      d3VelocityDecay={isMassive ? 0.5 : 0.3}
      /* ── render ───────────── */
      backgroundColor="rgba(0,0,0,0)"
      showNavInfo={false}
      onEngineStop={() => {
        if (graphRef?.current && nodeCount > 0) {
          graphRef.current.zoomToFit(800, 100);
        }
      }}
      /* ── init scene ────────── */
      onNodeDragEnd={(node) => {
        // pin node position after drag
        node.fx = node.x;
        node.fy = node.y;
        node.fz = node.z;
      }}
      ref={(el) => {
        // forward ref + init
        if (graphRef) graphRef.current = el;
        if (el && !initDoneRef.current) {
          setTimeout(() => handleEngineInit(el), 100);
        }
      }}
    />
  );
}
