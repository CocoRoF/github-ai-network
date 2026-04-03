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

/* ── performance tier thresholds ──────────────────────── */
const TIER_SMALL   = 500;    // full custom objects + all labels + curved links + effects
const TIER_MED     = 2000;   // custom objects, selective labels, reduced effects
const TIER_LARGE   = 5000;   // InstancedMesh + ngraph, no custom objects
const TIER_HUGE    = 15000;  // no bloom, no fog, no particles, line-only links
const TIER_MASSIVE = 50000;  // minimal rendering
const LABEL_BUDGET = 80;     // max simultaneous sprite labels

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

/* ── helper: create star field (lightweight) ──────────── */
function createStarField(count, radius) {
  const geo = new THREE.BufferGeometry();
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);

  for (let i = 0; i < count; i++) {
    const r = radius * (0.4 + Math.random() * 0.6);
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
    positions[i * 3 + 2] = r * Math.cos(phi);

    const brightness = 0.5 + Math.random() * 0.5;
    colors[i * 3] = brightness * (0.8 + Math.random() * 0.2);
    colors[i * 3 + 1] = brightness * (0.85 + Math.random() * 0.15);
    colors[i * 3 + 2] = brightness;
  }

  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));

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
function createNebula(count, radius) {
  const group = new THREE.Group();
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext("2d");
  const gradient = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  gradient.addColorStop(0, "rgba(255,255,255,0.3)");
  gradient.addColorStop(0.4, "rgba(255,255,255,0.05)");
  gradient.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 64, 64);
  const circleTexture = new THREE.CanvasTexture(canvas);

  const nebulaColors = [0x1a1a3e, 0x1e3a5f, 0x2d1b4e, 0x0d2137, 0x1b2a4a];

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

/* ── helper: dispose Three.js object tree ─────────────── */
function disposeObject(obj) {
  if (!obj) return;
  if (obj.geometry) obj.geometry.dispose();
  if (obj.material) {
    if (Array.isArray(obj.material)) obj.material.forEach((m) => m.dispose());
    else obj.material.dispose();
  }
  if (obj.children) [...obj.children].forEach(disposeObject);
}

/* ── helper: update a single node's visuals in-place ──── */
function updateNodeVisuals(node, highlightSet, selectedNode) {
  const obj = node.__threeObj;
  if (!obj || !obj.children) return;

  const mesh = obj.children.find((c) => c.isMesh && !c.userData?.isSelectionRing);
  if (!mesh?.material) return;

  const color = NODE_COLORS[node.type] || "#8b949e";
  const isSelected = selectedNode?.id === node.id;
  const hopDist = highlightSet?.get(node.id);
  const isInHighlight = hopDist !== undefined;
  const dimmed = highlightSet && !isInHighlight;

  mesh.material.emissiveIntensity = dimmed
    ? 0.02 : isSelected ? 1.2 : isInHighlight ? 0.6 : 0.35;
  mesh.material.opacity = dimmed
    ? 0.06 : isInHighlight ? ([1, 0.9, 0.6, 0.35][hopDist] ?? 0.35) : 0.85;

  // selection ring
  const existingRing = obj.children.find((c) => c.userData?.isSelectionRing);
  if (isSelected && !existingRing) {
    const size = mesh.scale.x;
    const ringGeo = new THREE.RingGeometry(size * 1.3, size * 1.6, 24);
    const ringMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(color), transparent: true, opacity: 0.6,
      side: THREE.DoubleSide, depthWrite: false,
    });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.userData.isSelectionRing = true;
    obj.add(ring);
  } else if (!isSelected && existingRing) {
    obj.remove(existingRing);
    existingRing.geometry.dispose();
    existingRing.material.dispose();
  }

  // label visibility
  const sprite = obj.children.find((c) => c.isSprite);
  if (sprite) sprite.visible = !dimmed;
}

/* ── geometry cache (LOD) ─────────────────────────────── */
const geoCache = {
  _high: null, _med: null, _low: null,
  get(nodeCount) {
    if (!this._high) {
      this._high = new THREE.SphereGeometry(1, 16, 12);
      this._med = new THREE.SphereGeometry(1, 8, 6);
      this._low = new THREE.SphereGeometry(1, 4, 3);
    }
    if (nodeCount < TIER_SMALL) return this._high;
    if (nodeCount < TIER_MED) return this._med;
    return this._low;
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
  const orbitIntervalRef = useRef(null);
  const initDoneRef = useRef(false);
  const hasZoomedRef = useRef(false);
  const selectedNodeRef = useRef(null);
  const highlightSetRef = useRef(null);
  const prevHighlightRef = useRef(null);
  const styleRef = useRef(style);
  const nodeCountRef = useRef(0);
  const mountedRef = useRef(false);
  const sceneExtrasRef = useRef({
    stars: null, nebula: null, pointLight: null, ambientLight: null,
  });

  styleRef.current = style;

  const nodeCount = graphData.nodes.length;
  nodeCountRef.current = nodeCount;

  /* ── performance tier flags ─────────────────────────── */
  const useCustomObj    = nodeCount < TIER_LARGE;    // < 5K: custom 3D objects
  const enableParticles = nodeCount < TIER_MED;      // < 2K: link particles
  const useLinkWidth    = nodeCount < TIER_LARGE;    // < 5K: cylinder links
  const useCurvedLinks  = nodeCount < TIER_SMALL;    // < 500: curved links
  const enableDrag      = nodeCount < TIER_MASSIVE;  // < 50K: node drag
  const enablePointer   = nodeCount < TIER_MASSIVE;  // < 50K: raycasting
  const useNgraph       = nodeCount >= TIER_LARGE;   // >= 5K: ngraph engine

  /* ── reset scene on graphData change (runs FIRST) ───── */
  useEffect(() => {
    hasZoomedRef.current = false;
    initDoneRef.current = false;

    if (graphRef?.current) {
      try {
        const scene = graphRef.current.scene();
        const extras = sceneExtrasRef.current;
        if (extras.stars) { scene.remove(extras.stars); disposeObject(extras.stars); extras.stars = null; }
        if (extras.nebula) { scene.remove(extras.nebula); disposeObject(extras.nebula); extras.nebula = null; }
        if (extras.pointLight) { scene.remove(extras.pointLight); extras.pointLight = null; }
        if (extras.ambientLight) { scene.remove(extras.ambientLight); extras.ambientLight = null; }
        if (bloomPassRef.current) {
          const composer = graphRef.current.postProcessingComposer();
          const idx = composer.passes.indexOf(bloomPassRef.current);
          if (idx > -1) composer.passes.splice(idx, 1);
          bloomPassRef.current.dispose?.();
          bloomPassRef.current = null;
        }
        scene.fog = null;
      } catch (_) {}
    }
  }, [graphData, graphRef]);

  /* ── adjacency map (cached, rebuild only on links change) */
  const adjacencyMap = useMemo(() => {
    const adj = new Map();
    graphData.links.forEach((l) => {
      const s = l.source?.id ?? l.source;
      const t = l.target?.id ?? l.target;
      if (!adj.has(s)) adj.set(s, []);
      if (!adj.has(t)) adj.set(t, []);
      adj.get(s).push(t);
      adj.get(t).push(s);
    });
    return adj;
  }, [graphData.links]);

  /* ── highlight set (BFS only, uses cached adjacency) ── */
  const maxHops = useMemo(
    () => nodeCount > 3000 ? 1 : nodeCount > 500 ? 2 : 3,
    [nodeCount]
  );

  const highlightSet = useMemo(() => {
    if (!selectedNode) return null;
    const visited = new Map();
    visited.set(selectedNode.id, 0);
    const queue = [selectedNode.id];
    while (queue.length > 0) {
      const current = queue.shift();
      const dist = visited.get(current);
      if (dist >= maxHops) continue;
      for (const neighbor of adjacencyMap.get(current) || []) {
        if (!visited.has(neighbor)) {
          visited.set(neighbor, dist + 1);
          queue.push(neighbor);
        }
      }
    }
    return visited;
  }, [selectedNode, adjacencyMap, maxHops]);

  /* ── sync refs for stable callbacks ─────────────────── */
  useEffect(() => {
    selectedNodeRef.current = selectedNode;
    highlightSetRef.current = highlightSet;
  });

  /* ── Escape key to deselect ─────────────────────────── */
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === "Escape") onNodeClick(null);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onNodeClick]);

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

  /* ── label budget: pre-sort nodes by importance ─────── */
  const labelNodeIds = useMemo(() => {
    if (!useCustomObj || !style.showLabels) return new Set();
    if (nodeCount <= LABEL_BUDGET) {
      return new Set(graphData.nodes.map((n) => n.id));
    }
    const sorted = [...graphData.nodes]
      .sort((a, b) => (b.val || 1) - (a.val || 1))
      .slice(0, LABEL_BUDGET);
    return new Set(sorted.map((n) => n.id));
  }, [graphData.nodes, nodeCount, useCustomObj, style.showLabels]);

  /* ── scene setup (bloom, stars, fog) — adaptive ─────── */
  const handleEngineInit = useCallback(
    (fg) => {
      if (!fg || initDoneRef.current) return;
      initDoneRef.current = true;

      const scene = fg.scene();
      const renderer = fg.renderer();
      const nc = nodeCountRef.current;
      const s = styleRef.current;

      // background
      scene.background = new THREE.Color(0x030810);

      // fog (smaller graphs only)
      if (nc < TIER_HUGE && s.fogDensity > 0) {
        scene.fog = new THREE.FogExp2(0x030810, s.fogDensity);
      }

      // bloom (skip for huge graphs)
      if (nc < TIER_HUGE) {
        try {
          const bloomRes = nc > TIER_LARGE
            ? new THREE.Vector2(window.innerWidth / 2, window.innerHeight / 2)
            : new THREE.Vector2(window.innerWidth, window.innerHeight);
          const bloomPass = new UnrealBloomPass(
            bloomRes, s.bloomStrength, s.bloomRadius, s.bloomThreshold
          );
          const composer = fg.postProcessingComposer();
          composer.addPass(bloomPass);
          bloomPassRef.current = bloomPass;
        } catch (e) {
          console.warn("Bloom not available:", e);
        }
      }

      // star field
      if (nc < TIER_HUGE && s.starField) {
        const starCount = nc > TIER_MED ? 3000 : 8000;
        const stars = createStarField(starCount, 6000);
        scene.add(stars);
        sceneExtrasRef.current.stars = stars;
      }

      // nebula (small-medium only)
      if (nc < TIER_LARGE) {
        const nebula = createNebula(20, 4000);
        scene.add(nebula);
        sceneExtrasRef.current.nebula = nebula;
      }

      // lighting
      const ambient = new THREE.AmbientLight(0x404060, 1.2);
      scene.add(ambient);
      sceneExtrasRef.current.ambientLight = ambient;

      const pt = new THREE.PointLight(0x5588ff, 0.5, 10000);
      pt.position.set(0, 0, 0);
      scene.add(pt);
      sceneExtrasRef.current.pointLight = pt;

      // renderer tweaks
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.2;
    },
    [] // stable — reads from refs
  );

  /* ── scene init via useEffect (runs AFTER reset effect) */
  useEffect(() => {
    if (graphRef?.current && !initDoneRef.current && nodeCountRef.current > 0) {
      handleEngineInit(graphRef.current);
    }
  }, [graphData, handleEngineInit, graphRef]);

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

  /* ── direct visual update on selection (node materials + link opacity) */
  useEffect(() => {
    const prevHl = prevHighlightRef.current;
    const currHl = highlightSet;
    prevHighlightRef.current = currHl;

    /* — node material update (custom objects path) — */
    if (useCustomObj) {
      // Determine full vs delta update:
      // null↔Map transitions need ALL nodes (dim state flips for every node)
      // Map↔Map transitions only need the union of old + new highlight sets
      const needFullNodeUpdate = (prevHl === null) !== (currHl === null);

      if (needFullNodeUpdate) {
        graphData.nodes.forEach((n) => updateNodeVisuals(n, currHl, selectedNode));
      } else if (currHl) {
        // delta: only nodes whose highlight status changed
        const delta = new Set();
        if (prevHl) prevHl.forEach((_, id) => delta.add(id));
        currHl.forEach((_, id) => delta.add(id));
        for (const node of graphData.nodes) {
          if (delta.has(node.id)) updateNodeVisuals(node, currHl, selectedNode);
        }
      }
      // both null → no visual change needed
    }

    /* — link opacity update (all paths) — */
    const edgeOpacity = styleRef.current.edgeOpacity;
    graphData.links.forEach((link) => {
      const lineObj = link.__lineObj;
      if (!lineObj?.material) return;

      if (!currHl) {
        lineObj.material.opacity = edgeOpacity;
      } else {
        const s = link.source?.id ?? link.source;
        const t = link.target?.id ?? link.target;
        lineObj.material.opacity = (currHl.has(s) && currHl.has(t))
          ? edgeOpacity
          : 0.02;
      }
    });
  }, [selectedNode, highlightSet, graphData.nodes, graphData.links, useCustomObj]);

  /* ── InstancedMesh path: refresh on selection for color update */
  useEffect(() => {
    if (!mountedRef.current) { mountedRef.current = true; return; }
    if (nodeCountRef.current >= TIER_LARGE && graphRef?.current) {
      graphRef.current.refresh();
    }
  }, [selectedNode, graphRef]);

  /* ── node 3D object (< TIER_LARGE only) ─────────────── */
  const nodeThreeObject = useCallback(
    (node) => {
      const size = getNodeSize(node);
      const color = NODE_COLORS[node.type] || "#8b949e";
      const sel = selectedNodeRef.current;
      const hl = highlightSetRef.current;
      const isSelected = sel && sel.id === node.id;
      const hopDist = hl ? hl.get(node.id) : undefined;
      const isInHighlight = hopDist !== undefined;
      const dimmed = hl && !isInHighlight;

      const group = new THREE.Group();

      // sphere
      const geo = geoCache.get(nodeCount);
      const mat = new THREE.MeshStandardMaterial({
        color: new THREE.Color(color),
        emissive: new THREE.Color(color),
        emissiveIntensity: dimmed ? 0.02 : isSelected ? 1.2 : isInHighlight ? 0.6 : 0.35,
        roughness: 0.4,
        metalness: 0.3,
        transparent: true,
        opacity: dimmed ? 0.06 : isInHighlight ? ([1, 0.9, 0.6, 0.35][hopDist] ?? 0.35) : 0.85,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.scale.setScalar(size);
      group.add(mesh);

      // glow ring for selected
      if (isSelected) {
        const ringGeo = new THREE.RingGeometry(size * 1.3, size * 1.6, 24);
        const ringMat = new THREE.MeshBasicMaterial({
          color: new THREE.Color(color),
          transparent: true,
          opacity: 0.6,
          side: THREE.DoubleSide,
          depthWrite: false,
        });
        const ring = new THREE.Mesh(ringGeo, ringMat);
        ring.userData.isSelectionRing = true;
        group.add(ring);
      }

      // label (budget-limited)
      if (style.showLabels && !dimmed) {
        const inBudget = labelNodeIds.has(node.id);
        const showLabel = isSelected || (isInHighlight && hopDist <= 1) || inBudget;
        if (showLabel) {
          const label = node.type === "repo"
            ? (node.label || "").split("/").pop()
            : node.label || "";
          const sprite = new SpriteText(label);
          sprite.color = "rgba(201,209,217,0.9)";
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
    [getNodeSize, nodeCount, style.showLabels, style.labelScale, labelNodeIds]
    // ★ NO selectedNode, NO highlightSet — reads from refs
  );

  /* ── link styling — stable callbacks via refs ──────── */
  const linkColor = useCallback(
    (link) => {
      const base = LINK_COLORS[link.type] || "#8b949e";
      const hl = highlightSetRef.current;
      if (!hl) return base;
      const s = link.source?.id ?? link.source;
      const t = link.target?.id ?? link.target;
      if (!hl.has(s) || !hl.has(t)) return "rgba(60,60,80,0.04)";
      return base;
    },
    [] // stable — reads from ref
  );

  const linkOpacity = useMemo(
    () => {
      if (nodeCount > TIER_HUGE) return 0.06;
      if (nodeCount > TIER_LARGE) return 0.1;
      return style.edgeOpacity;
    },
    [style.edgeOpacity, nodeCount]
  );

  const linkWidthFn = useCallback(
    (link) => {
      const s = styleRef.current;
      return Math.max((link.weight || 0.5) * s.edgeWidthScale * 0.5, 0.15);
    },
    [] // stable — dim/highlight handled via material opacity in selection effect
  );

  /* ── node click: fly-to animation (division-by-zero safe) */
  const handleNodeClick = useCallback(
    (node) => {
      if (!node) {
        onNodeClick(null);
        return;
      }
      if (graphRef?.current) {
        const nx = node.x || 0, ny = node.y || 0, nz = node.z || 0;
        const dist = Math.hypot(nx, ny, nz);
        if (dist > 1) {
          const distRatio = 1 + 120 / dist;
          graphRef.current.cameraPosition(
            { x: nx * distRatio, y: ny * distRatio, z: nz * distRatio },
            { x: nx, y: ny, z: nz },
            1200
          );
        }
      }
      onNodeClick(node);
    },
    [onNodeClick, graphRef]
  );

  /* ── force engine configuration ─────────────────────── */
  const forceEngine = useNgraph ? "ngraph" : "d3";

  // d3: min 30 ticks so nodes displace from origin before first render
  const warmupTicks = useNgraph
    ? (nodeCount > TIER_MASSIVE ? 150 : 100)
    : Math.max(Math.min(Math.floor(nodeCount * 0.1), 100), 30);

  const cooldownTicks = useNgraph ? 0 : (nodeCount > TIER_MED ? 40 : 200);
  const cooldownTime = nodeCount > TIER_LARGE ? 3000 : 8000;

  /* ── stable callbacks for JSX props ─────────────────── */
  const handleBgClick = useCallback(() => onNodeClick(null), [onNodeClick]);

  const nodeLabelFn = useCallback((n) => n.label, []);

  const nodeColorFn = useCallback(
    (n) => {
      const hl = highlightSetRef.current;
      if (hl && !hl.has(n.id)) return "rgba(30,30,40,0.15)";
      return NODE_COLORS[n.type] || "#8b949e";
    },
    [] // stable — reads from ref
  );

  const handleEngineStop = useCallback(() => {
    if (graphRef?.current && nodeCountRef.current > 0 && !hasZoomedRef.current) {
      hasZoomedRef.current = true;
      graphRef.current.zoomToFit(800, 100);
    }
  }, [graphRef]); // stable — reads nodeCount from ref

  const handleNodeDragEnd = useCallback((node) => {
    node.fx = node.x;
    node.fy = node.y;
    node.fz = node.z;
  }, []);

  const fgRefCallback = useCallback((el) => {
    if (graphRef) graphRef.current = el;
  }, [graphRef]);

  /* ── cleanup on unmount ─────────────────────────────── */
  useEffect(() => {
    return () => {
      initDoneRef.current = false;
      if (bloomPassRef.current) {
        bloomPassRef.current.dispose?.();
        bloomPassRef.current = null;
      }
      if (orbitIntervalRef.current) {
        clearInterval(orbitIntervalRef.current);
        orbitIntervalRef.current = null;
      }
      const extras = sceneExtrasRef.current;
      Object.keys(extras).forEach((key) => {
        if (extras[key]) {
          disposeObject(extras[key]);
          extras[key] = null;
        }
      });
    };
  }, []);

  return (
    <ForceGraph3D
      graphData={graphData}
      /* ── node ─────────────── */
      {...(useCustomObj
        ? { nodeThreeObject, nodeThreeObjectExtend: false }
        : {
            nodeColor: nodeColorFn,
            nodeOpacity: 0.85,
            nodeResolution: nodeCount > TIER_MASSIVE ? 3 : 4,
          }
      )}
      nodeVal="val"
      nodeRelSize={nodeCount > TIER_MASSIVE ? 2 : 4}
      nodeLabel={enablePointer ? nodeLabelFn : null}
      /* ── link ─────────────── */
      linkColor={linkColor}
      linkOpacity={linkOpacity}
      linkWidth={useLinkWidth ? linkWidthFn : 0}
      linkDirectionalParticles={enableParticles && style.showParticles ? style.particleCount : 0}
      linkDirectionalParticleSpeed={style.particleSpeed}
      linkDirectionalParticleWidth={1.0}
      linkDirectionalParticleColor={linkColor}
      linkCurvature={useCurvedLinks ? 0.05 : 0}
      linkResolution={nodeCount > TIER_LARGE ? 3 : 6}
      /* ── interaction ──────── */
      onNodeClick={handleNodeClick}
      onBackgroundClick={handleBgClick}
      enablePointerInteraction={enablePointer}
      enableNodeDrag={enableDrag}
      /* ── engine ───────────── */
      forceEngine={forceEngine}
      warmupTicks={warmupTicks}
      cooldownTicks={cooldownTicks}
      cooldownTime={cooldownTime}
      d3AlphaDecay={nodeCount > TIER_HUGE ? 0.06 : 0.035}
      d3VelocityDecay={nodeCount > TIER_HUGE ? 0.5 : 0.4}
      /* ── render ───────────── */
      backgroundColor="rgba(0,0,0,0)"
      showNavInfo={false}
      onEngineStop={handleEngineStop}
      onNodeDragEnd={handleNodeDragEnd}
      ref={fgRefCallback}
    />
  );
}
