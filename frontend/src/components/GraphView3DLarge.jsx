/**
 * GraphView3DLarge — Custom Three.js renderer for all graph sizes.
 *
 * Architecture:
 *   - 1 InstancedMesh  (all nodes → 1 draw call)
 *   - 1 LineSegments   (all edges → 1 draw call)
 *   - Web Worker        (force layout off main thread)
 *
 * Total draw calls: 2  (vs N in react-force-graph-3d)
 */
import { useEffect, useRef, useMemo } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";

/* ── color constants ─────────────────────────────────── */
const NODE_COLORS = {
  author: "#58a6ff",
  repo: "#3fb950",
  topic: "#d29922",
};
// Brighter versions for highlight glow
const NODE_COLORS_BRIGHT = {
  author: "#9dcfff",
  repo: "#7ee89a",
  topic: "#f0c45a",
};
const LINK_COLORS = {
  owns: "#58a6ff",
  contributes: "#8b949e",
  has_topic: "#d29922",
  coworker: "#da70d6",
  forked_from: "#8888cc",
};
const DEFAULT_LINK_COLOR = "#8b949e";

const DEFAULT_STYLE = {
  nodeMinSize: 1,
  nodeMaxSize: 15,
  edgeOpacity: 0.15,
  bloomStrength: 0.6,
  bloomRadius: 0.1,
  bloomThreshold: 0.1,
  starField: true,
  fogDensity: 0.0006,
};

/* ── label constants ────────────────────────────────── */
const MAX_LABELS = 150;
const LABEL_UPDATE_MS = 250;

/* ── helpers ─────────────────────────────────────────── */
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
    const b = 0.5 + Math.random() * 0.5;
    colors[i * 3] = b * (0.8 + Math.random() * 0.2);
    colors[i * 3 + 1] = b * (0.85 + Math.random() * 0.15);
    colors[i * 3 + 2] = b;
  }
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  return new THREE.Points(
    geo,
    new THREE.PointsMaterial({
      size: 1.5,
      vertexColors: true,
      transparent: true,
      opacity: 0.7,
      sizeAttenuation: true,
      depthWrite: false,
    })
  );
}

function disposeObject(obj) {
  if (!obj) return;
  if (obj.geometry) obj.geometry.dispose();
  if (obj.material) {
    if (Array.isArray(obj.material)) obj.material.forEach((m) => m.dispose());
    else obj.material.dispose();
  }
  if (obj.children) [...obj.children].forEach(disposeObject);
}

/* ── smooth camera animation ─────────────────────────── */
function animateCamera(camera, controls, targetPos, targetLookAt, duration) {
  const startPos = camera.position.clone();
  const startTarget = controls.target.clone();
  const endPos = new THREE.Vector3(targetPos.x, targetPos.y, targetPos.z);
  const endTarget = new THREE.Vector3(
    targetLookAt.x,
    targetLookAt.y,
    targetLookAt.z
  );
  const start = performance.now();

  function step() {
    const t = Math.min((performance.now() - start) / duration, 1);
    const ease = t * (2 - t);
    camera.position.lerpVectors(startPos, endPos, ease);
    controls.target.lerpVectors(startTarget, endTarget, ease);
    controls.update();
    if (t < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

/* ── label helpers ──────────────────────────────────── */
function getLabelText(node) {
  const label = node.label || node.id || "";
  if (node.type === "repo" && label.includes("/")) {
    return label.split("/").pop();
  }
  return label.length > 30 ? label.substring(0, 27) + "…" : label;
}

function getOrCreateLabelTexture(cache, nodeId, text, color) {
  if (cache.has(nodeId)) return cache.get(nodeId);

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  const fontSize = 64;
  ctx.font = `bold ${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
  const metrics = ctx.measureText(text);
  const pw = Math.ceil(metrics.width) + 32;
  const ph = fontSize + 24;
  canvas.width = pw;
  canvas.height = ph;

  // Re-set font after canvas resize
  ctx.font = `bold ${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.shadowColor = "rgba(0,0,0,0.95)";
  ctx.shadowBlur = 8;
  ctx.shadowOffsetY = 2;
  ctx.fillStyle = color;
  ctx.fillText(text, pw / 2, ph / 2);

  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;
  const aspect = pw / ph;
  const entry = { texture, aspect };
  cache.set(nodeId, entry);

  // Evict old entries if cache grows too large
  if (cache.size > 500) {
    const iter = cache.keys();
    for (let i = 0; i < 100; i++) {
      const key = iter.next().value;
      const old = cache.get(key);
      if (old?.texture) old.texture.dispose();
      cache.delete(key);
    }
  }
  return entry;
}

function updateLabels(state, data, style) {
  const { labelSprites, labelTextureCache, camera } = state;
  if (
    !labelSprites ||
    !data.positions ||
    data.nodes.length === 0 ||
    style.showLabels === false
  ) {
    if (labelSprites) for (const sp of labelSprites) sp.visible = false;
    return;
  }

  const positions = data.positions;
  const nodes = data.nodes;
  const nc = nodes.length;
  const camPos = camera.position;

  // labelThreshold: 0..1 — maps to label visibility range
  const threshold = style.labelThreshold ?? 0.8;
  const maxDist = 150 + threshold * 3000;
  const maxDistSq = maxDist * maxDist;

  // Find candidate nodes within range
  const candidates = [];
  for (let i = 0; i < nc; i++) {
    const dx = positions[i * 3] - camPos.x;
    const dy = positions[i * 3 + 1] - camPos.y;
    const dz = positions[i * 3 + 2] - camPos.z;
    const distSq = dx * dx + dy * dy + dz * dz;
    if (distSq < maxDistSq) {
      candidates.push({ idx: i, distSq, val: nodes[i].val || 1 });
    }
  }

  // Sort by priority: higher val + closer distance first
  candidates.sort((a, b) => b.val / b.distSq - a.val / a.distSq);

  const count = Math.min(candidates.length, MAX_LABELS);
  const labelScale = style.labelScale ?? 1.0;

  for (let i = 0; i < count; i++) {
    const c = candidates[i];
    const node = nodes[c.idx];
    const sprite = labelSprites[i];

    const labelText = getLabelText(node);
    const color = NODE_COLORS_BRIGHT[node.type] || "#c0c8d0";
    const entry = getOrCreateLabelTexture(
      labelTextureCache,
      node.id,
      labelText,
      color
    );

    if (sprite.material.map !== entry.texture) {
      sprite.material.map = entry.texture;
      sprite.material.needsUpdate = true;
    }
    sprite.material.opacity = 0.9;

    // Position above the node
    const nodeScale = data.scales?.[c.idx] || 5;
    sprite.position.set(
      positions[c.idx * 3],
      positions[c.idx * 3 + 1] + nodeScale + 4,
      positions[c.idx * 3 + 2]
    );

    const baseH = 5 * labelScale;
    sprite.scale.set(baseH * entry.aspect, baseH, 1);
    sprite.visible = true;
  }

  // Hide unused sprites
  for (let i = count; i < labelSprites.length; i++) {
    labelSprites[i].visible = false;
  }
}

/* ── main component ──────────────────────────────────── */
export default function GraphView3DLarge({
  graphData,
  onNodeClick,
  selectedNode,
  graphRef,
  graphStyle = {},
}) {
  const containerRef = useRef(null);
  const style = useMemo(
    () => ({ ...DEFAULT_STYLE, ...graphStyle }),
    [graphStyle]
  );

  // Persistent Three.js objects
  const threeRef = useRef(null);
  const graphObjRef = useRef(null);
  const dataRef = useRef({
    nodes: [],
    links: [],
    nodeIdToIndex: new Map(),
    edgeNodeIndices: [], // [[srcIdx, tgtIdx], ...]
    edgeLinkIndices: [], // original link index for each valid edge
    positions: null,
    scales: null,
    settled: false,
  });

  // Refs for stable callbacks
  const onNodeClickRef = useRef(onNodeClick);
  const styleRef = useRef(style);
  onNodeClickRef.current = onNodeClick;
  styleRef.current = style;

  /* ── adjacency + highlight set ─────────────────────── */
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

  // Always 3 hops for strong visual context
  const maxHops = 3;

  const highlightSet = useMemo(() => {
    if (!selectedNode) return null;
    const visited = new Map();
    visited.set(selectedNode.id, 0);
    const queue = [selectedNode.id];
    while (queue.length > 0) {
      const current = queue.shift();
      const dist = visited.get(current);
      if (dist >= maxHops) continue;
      for (const nb of adjacencyMap.get(current) || []) {
        if (!visited.has(nb)) {
          visited.set(nb, dist + 1);
          queue.push(nb);
        }
      }
    }
    return visited;
  }, [selectedNode, adjacencyMap, maxHops]);

  /* ── val range for node sizing ─────────────────────── */
  const valRange = useMemo(() => {
    let min = Infinity,
      max = -Infinity;
    for (const n of graphData.nodes) {
      const v = n.val || 1;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    return { min: isFinite(min) ? min : 1, max: isFinite(max) ? max : 1 };
  }, [graphData.nodes]);

  /* ── zoomToFit helper ──────────────────────────────── */
  function zoomToFitInternal(camera, controls, duration, padding) {
    const positions = dataRef.current.positions;
    if (!positions) return;
    const count = positions.length / 3;
    if (count === 0) return;

    let cx = 0,
      cy = 0,
      cz = 0;
    for (let i = 0; i < count; i++) {
      cx += positions[i * 3];
      cy += positions[i * 3 + 1];
      cz += positions[i * 3 + 2];
    }
    cx /= count;
    cy /= count;
    cz /= count;

    let maxR = 0;
    for (let i = 0; i < count; i++) {
      const dx = positions[i * 3] - cx;
      const dy = positions[i * 3 + 1] - cy;
      const dz = positions[i * 3 + 2] - cz;
      const r = dx * dx + dy * dy + dz * dz;
      if (r > maxR) maxR = r;
    }
    maxR = Math.sqrt(maxR);

    const fov = (camera.fov * Math.PI) / 180;
    const dist = (maxR + padding) / Math.sin(fov / 2);

    animateCamera(
      camera,
      controls,
      { x: cx, y: cy, z: cz + dist },
      { x: cx, y: cy, z: cz },
      duration
    );
  }

  /* ── Effect 1: Three.js scene setup (once) ─────────── */
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x030810);

    const w = container.clientWidth || 800;
    const h = container.clientHeight || 600;
    const camera = new THREE.PerspectiveCamera(60, w / h, 1, 50000);
    camera.position.set(0, 0, 800);

    const renderer = new THREE.WebGLRenderer({
      antialias: false,
      powerPreference: "high-performance",
    });
    renderer.setSize(w, h);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.2;

    // Prevent CSS !important from .graph-container canvas from interfering
    const canvas = renderer.domElement;
    canvas.style.setProperty("display", "block", "important");
    container.appendChild(canvas);

    const controls = new OrbitControls(camera, canvas);
    controls.enableDamping = true;
    controls.dampingFactor = 0.12;
    controls.rotateSpeed = 0.5;
    controls.zoomSpeed = 1.2;
    controls.minDistance = 10;
    controls.maxDistance = 30000;

    // Minimal ambient for selection ring / other scene objects
    const ambient = new THREE.AmbientLight(0xffffff, 0.8);
    scene.add(ambient);

    // Star field
    const stars = createStarField(4000, 8000);
    scene.add(stars);

    // Selection ring — double ring for stronger visual
    const ringGroup = new THREE.Group();
    const ringGeo = new THREE.RingGeometry(1.2, 1.5, 48);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.9,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const ring1 = new THREE.Mesh(ringGeo, ringMat);
    ringGroup.add(ring1);
    // Outer glow ring
    const outerRingGeo = new THREE.RingGeometry(1.6, 2.2, 48);
    const outerRingMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.3,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const ring2 = new THREE.Mesh(outerRingGeo, outerRingMat);
    ringGroup.add(ring2);
    ringGroup.visible = false;
    scene.add(ringGroup);
    const selectionRing = ringGroup;

    // Label sprite pool
    const labelGroup = new THREE.Group();
    labelGroup.renderOrder = 999; // render on top
    const labelSprites = [];
    for (let i = 0; i < MAX_LABELS; i++) {
      const mat = new THREE.SpriteMaterial({
        transparent: true,
        depthWrite: false,
        depthTest: false,
        sizeAttenuation: true,
        opacity: 0,
      });
      const sprite = new THREE.Sprite(mat);
      sprite.visible = false;
      labelGroup.add(sprite);
      labelSprites.push(sprite);
    }
    scene.add(labelGroup);

    // Store ALL three.js state in ref
    const state = {
      scene,
      camera,
      renderer,
      controls,
      stars,
      selectionRing,
      labelGroup,
      labelSprites,
      labelTextureCache: new Map(),
      labelLastUpdate: 0,
      composer: null,
      bloomPass: null,
    };
    threeRef.current = state;

    // Animation loop — reads composer from ref, not closure
    let animFrame;
    function animate() {
      animFrame = requestAnimationFrame(animate);
      controls.update();

      if (selectionRing.visible) {
        selectionRing.quaternion.copy(camera.quaternion);
      }

      // Label update (throttled)
      const now = performance.now();
      const st = threeRef.current;
      if (st && now - st.labelLastUpdate > LABEL_UPDATE_MS) {
        st.labelLastUpdate = now;
        updateLabels(st, dataRef.current, styleRef.current);
      }

      const comp = threeRef.current?.composer;
      if (comp) {
        comp.render();
      } else {
        renderer.render(scene, camera);
      }
    }
    animate();

    // Resize observer
    const resizeObserver = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      if (width === 0 || height === 0) return;
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height);
      const comp = threeRef.current?.composer;
      if (comp) comp.setSize(width, height);
    });
    resizeObserver.observe(container);

    // Cleanup
    return () => {
      cancelAnimationFrame(animFrame);
      resizeObserver.disconnect();
      controls.dispose();
      disposeObject(stars);
      disposeObject(selectionRing);
      selectionRing.children.forEach((c) => disposeObject(c));
      // Label cleanup
      for (const sp of labelSprites) disposeObject(sp);
      disposeObject(labelGroup);
      for (const [, entry] of state.labelTextureCache) {
        if (entry.texture) entry.texture.dispose();
      }
      state.labelTextureCache.clear();
      if (state.bloomPass) state.bloomPass.dispose();
      if (state.composer) {
        state.composer.passes.forEach((p) => p.dispose?.());
      }
      renderer.dispose();
      if (container.contains(canvas)) container.removeChild(canvas);
      threeRef.current = null;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /* ── Effect 2: Graph meshes + worker (on graphData) ── */
  useEffect(() => {
    const t = threeRef.current;
    if (!t) return;
    const { scene, camera, controls, renderer } = t;
    const nc = graphData.nodes.length;
    const ec = graphData.links.length;
    if (nc === 0) return;

    // Cleanup previous graph objects
    const prev = graphObjRef.current;
    if (prev) {
      if (prev.nodesMesh) {
        scene.remove(prev.nodesMesh);
        disposeObject(prev.nodesMesh);
      }
      if (prev.edgesMesh) {
        scene.remove(prev.edgesMesh);
        disposeObject(prev.edgesMesh);
      }
      if (prev.worker) {
        prev.worker.postMessage({ type: "stop" });
        prev.worker.terminate();
      }
    }

    // Bloom — critical for the celestial glow effect
    if (!t.composer) {
      try {
        const s = styleRef.current;
        const composer = new EffectComposer(renderer);
        composer.addPass(new RenderPass(scene, camera));
        const bloomRes = nc > 30000 ? 3 : nc > 10000 ? 2 : 1.5;
        const bloom = new UnrealBloomPass(
          new THREE.Vector2(
            renderer.domElement.width / bloomRes,
            renderer.domElement.height / bloomRes
          ),
          s.bloomStrength,
          s.bloomRadius,
          s.bloomThreshold
        );
        composer.addPass(bloom);
        t.composer = composer;
        t.bloomPass = bloom;
      } catch (_) {}
    }

    // Fog
    const s = styleRef.current;
    if (nc < 15000 && s.fogDensity > 0) {
      scene.fog = new THREE.FogExp2(0x030810, s.fogDensity * 0.5);
    } else {
      scene.fog = null;
    }

    // Build data mappings
    const nodeIdToIndex = new Map();
    const nodes = graphData.nodes;
    const links = graphData.links;
    for (let i = 0; i < nc; i++) nodeIdToIndex.set(nodes[i].id, i);

    const edgeNodeIndices = [];
    const edgeLinkIndices = []; // track original link index
    for (let i = 0; i < ec; i++) {
      const si = nodeIdToIndex.get(links[i].source?.id ?? links[i].source);
      const ti = nodeIdToIndex.get(links[i].target?.id ?? links[i].target);
      if (si !== undefined && ti !== undefined) {
        edgeNodeIndices.push([si, ti]);
        edgeLinkIndices.push(i); // store which original link this edge corresponds to
      }
    }

    // Node sizes
    const { min: vMin, max: vMax } = valRange;
    const nodeScales = new Float32Array(nc);
    for (let i = 0; i < nc; i++) {
      const raw = nodes[i].val || 1;
      const tt = vMax > vMin ? (raw - vMin) / (vMax - vMin) : 0;
      nodeScales[i] = s.nodeMinSize + tt * (s.nodeMaxSize - s.nodeMinSize);
    }

    dataRef.current = {
      nodes,
      links,
      nodeIdToIndex,
      edgeNodeIndices,
      edgeLinkIndices,
      positions: null,
      scales: nodeScales,
      settled: false,
    };

    /* ── InstancedMesh for nodes — custom celestial body shader ── */
    const segments = nc > 50000 ? 8 : nc > 15000 ? 12 : 16;
    const rings = nc > 50000 ? 6 : nc > 15000 ? 8 : 12;
    const sphereGeo = new THREE.SphereGeometry(1, segments, rings);

    const nodeMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uGlowIntensity: { value: 1.0 },
      },
      vertexShader: /* glsl */ `
        varying vec3 vNormal;
        varying vec3 vViewDir;
        varying vec3 vColor;
        varying vec3 vWorldPos;

        void main() {
          // Instance color (Three.js auto-defines USE_INSTANCING_COLOR)
          vColor = vec3(1.0);
          #ifdef USE_INSTANCING_COLOR
            vColor = instanceColor;
          #endif

          // Position with instancing
          vec4 localPos = vec4(position, 1.0);
          #ifdef USE_INSTANCING
            localPos = instanceMatrix * localPos;
          #endif
          vec4 mvPosition = modelViewMatrix * localPos;

          // Normal with instancing
          vec3 n = normal;
          #ifdef USE_INSTANCING
            n = mat3(instanceMatrix) * n;
          #endif
          vNormal = normalize(normalMatrix * n);
          vViewDir = normalize(-mvPosition.xyz);
          vWorldPos = localPos.xyz;

          gl_Position = projectionMatrix * mvPosition;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uGlowIntensity;
        varying vec3 vNormal;
        varying vec3 vViewDir;
        varying vec3 vColor;
        varying vec3 vWorldPos;

        void main() {
          vec3 n = normalize(vNormal);
          vec3 v = normalize(vViewDir);
          float NdotV = max(dot(n, v), 0.0);

          // ── Fresnel rim glow — bright edges like atmosphere ──
          float fresnel = pow(1.0 - NdotV, 3.0);

          // ── Core gradient — brighter/whiter at center ──
          float core = smoothstep(0.0, 1.0, NdotV);

          // ── Soft directional light for depth ──
          vec3 lightDir = normalize(vec3(0.4, 0.8, 0.6));
          float diffuse = max(dot(n, lightDir), 0.0) * 0.25 + 0.75;

          // ── Color composition ──
          vec3 baseColor = vColor;
          vec3 centerColor = mix(baseColor, vec3(1.0), 0.35);  // whiter center
          vec3 edgeColor = baseColor * 1.3;                      // saturated edges
          vec3 bodyColor = mix(edgeColor, centerColor, core) * diffuse;

          // ── Rim glow (bloom picks this up for halo) ──
          vec3 rimColor = (baseColor + vec3(0.25)) * 1.6;

          // ── Subsurface scatter approximation ──
          float scatter = pow(NdotV, 0.4) * 0.15;

          // ── Final composition ──
          vec3 color = bodyColor * 0.85;
          color += rimColor * fresnel * 0.7;
          color += baseColor * scatter;
          color *= uGlowIntensity;

          gl_FragColor = vec4(color, 1.0);
        }
      `,
      transparent: false,
      depthWrite: true,
    });

    const nodesMesh = new THREE.InstancedMesh(sphereGeo, nodeMaterial, nc);
    nodesMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

    // Node colors
    const tmpColor = new THREE.Color();
    for (let i = 0; i < nc; i++) {
      tmpColor.set(NODE_COLORS[nodes[i].type] || "#8b949e");
      nodesMesh.setColorAt(i, tmpColor);
    }
    nodesMesh.instanceColor.needsUpdate = true;

    // Initial transforms (random sphere distribution)
    const tmpMatrix = new THREE.Matrix4();
    const tmpQuat = new THREE.Quaternion();
    const tmpPos = new THREE.Vector3();
    const tmpScale = new THREE.Vector3();
    for (let i = 0; i < nc; i++) {
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      const r = 100 + Math.random() * 300;
      tmpPos.set(
        r * Math.sin(phi) * Math.cos(theta),
        r * Math.sin(phi) * Math.sin(theta),
        r * Math.cos(phi)
      );
      const sc = nodeScales[i];
      tmpScale.set(sc, sc, sc);
      tmpMatrix.compose(tmpPos, tmpQuat, tmpScale);
      nodesMesh.setMatrixAt(i, tmpMatrix);
    }
    nodesMesh.instanceMatrix.needsUpdate = true;
    nodesMesh.computeBoundingSphere();
    scene.add(nodesMesh);

    /* ── LineSegments for edges ── */
    const validEdgeCount = edgeNodeIndices.length;
    const edgePositions = new Float32Array(validEdgeCount * 6);
    const edgeColors = new Float32Array(validEdgeCount * 6);

    const tmpC = new THREE.Color();
    for (let i = 0; i < validEdgeCount; i++) {
      const origIdx = edgeLinkIndices[i]; // ← FIX: use correct link index
      tmpC.set(LINK_COLORS[links[origIdx]?.type] || DEFAULT_LINK_COLOR);
      edgeColors[i * 6 + 0] = tmpC.r;
      edgeColors[i * 6 + 1] = tmpC.g;
      edgeColors[i * 6 + 2] = tmpC.b;
      edgeColors[i * 6 + 3] = tmpC.r;
      edgeColors[i * 6 + 4] = tmpC.g;
      edgeColors[i * 6 + 5] = tmpC.b;
    }

    const edgeGeo = new THREE.BufferGeometry();
    edgeGeo.setAttribute(
      "position",
      new THREE.BufferAttribute(edgePositions, 3).setUsage(
        THREE.DynamicDrawUsage
      )
    );
    edgeGeo.setAttribute(
      "color",
      new THREE.BufferAttribute(edgeColors, 3).setUsage(
        THREE.DynamicDrawUsage
      )
    );

    const edgeMaterial = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: nc > 15000 ? 0.1 : nc > 5000 ? 0.15 : s.edgeOpacity,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    const edgesMesh = new THREE.LineSegments(edgeGeo, edgeMaterial);
    scene.add(edgesMesh);

    graphObjRef.current = { nodesMesh, edgesMesh, worker: null };

    /* ── Web Worker ── */
    let worker;
    try {
      worker = new Worker(
        new URL("../workers/layout.worker.js", import.meta.url),
        { type: "module" }
      );
    } catch (err) {
      console.error("Failed to create layout worker:", err);
      // Fallback: zoomToFit on the random initial positions
      const initPos = new Float32Array(nc * 3);
      for (let i = 0; i < nc; i++) {
        const m = new THREE.Matrix4();
        nodesMesh.getMatrixAt(i, m);
        const p = new THREE.Vector3();
        p.setFromMatrixPosition(m);
        initPos[i * 3] = p.x;
        initPos[i * 3 + 1] = p.y;
        initPos[i * 3 + 2] = p.z;
        nodes[i].x = p.x;
        nodes[i].y = p.y;
        nodes[i].z = p.z;
      }
      dataRef.current.positions = initPos;
      setTimeout(() => zoomToFitInternal(camera, controls, 800, 100), 300);
      return;
    }
    graphObjRef.current.worker = worker;

    worker.onerror = (err) => {
      console.error("Layout worker error:", err);
    };

    // Reusable objects for position updates
    const pos3 = new THREE.Vector3();
    const scale3 = new THREE.Vector3();
    const mat4 = new THREE.Matrix4();
    const quat4 = new THREE.Quaternion();

    worker.onmessage = (e) => {
      const msg = e.data;

      if (msg.type === "positions") {
        const positions = new Float32Array(msg.positions);
        dataRef.current.positions = positions;

        // Update node instance matrices
        for (let i = 0; i < nc; i++) {
          pos3.set(
            positions[i * 3],
            positions[i * 3 + 1],
            positions[i * 3 + 2]
          );
          const sc = nodeScales[i];
          scale3.set(sc, sc, sc);
          mat4.compose(pos3, quat4, scale3);
          nodesMesh.setMatrixAt(i, mat4);

          // Mutate node objects for GraphPage.focusNode compatibility
          nodes[i].x = positions[i * 3];
          nodes[i].y = positions[i * 3 + 1];
          nodes[i].z = positions[i * 3 + 2];
        }
        nodesMesh.instanceMatrix.needsUpdate = true;
        nodesMesh.computeBoundingSphere();

        // Update edge positions
        for (let ei = 0; ei < validEdgeCount; ei++) {
          const [si, ti] = edgeNodeIndices[ei];
          edgePositions[ei * 6 + 0] = positions[si * 3];
          edgePositions[ei * 6 + 1] = positions[si * 3 + 1];
          edgePositions[ei * 6 + 2] = positions[si * 3 + 2];
          edgePositions[ei * 6 + 3] = positions[ti * 3];
          edgePositions[ei * 6 + 4] = positions[ti * 3 + 1];
          edgePositions[ei * 6 + 5] = positions[ti * 3 + 2];
        }
        edgeGeo.attributes.position.needsUpdate = true;
        edgeGeo.computeBoundingSphere();
      }

      if (msg.type === "settled") {
        dataRef.current.settled = true;
        zoomToFitInternal(camera, controls, 800, 100);
      }
    };

    // Send to worker
    worker.postMessage({
      type: "init",
      nodes: nodes.map((n) => ({ id: n.id })),
      links: links.map((l) => ({
        source: l.source?.id ?? l.source,
        target: l.target?.id ?? l.target,
      })),
    });

    // Cleanup
    return () => {
      if (worker) {
        worker.postMessage({ type: "stop" });
        worker.terminate();
      }
      scene.remove(nodesMesh);
      scene.remove(edgesMesh);
      disposeObject(nodesMesh);
      disposeObject(edgesMesh);
      graphObjRef.current = null;
      // Clear label texture cache when graph data changes
      const lt = threeRef.current?.labelTextureCache;
      if (lt) {
        for (const [, entry] of lt) {
          if (entry.texture) entry.texture.dispose();
        }
        lt.clear();
      }
    };
  }, [graphData, valRange]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ── Effect 3: selection visual update ─────────────── */
  useEffect(() => {
    const gObj = graphObjRef.current;
    const t = threeRef.current;
    if (!gObj?.nodesMesh || !t) return;

    const { nodesMesh, edgesMesh } = gObj;
    const { selectionRing } = t;
    const {
      nodes,
      links,
      nodeIdToIndex,
      edgeNodeIndices,
      edgeLinkIndices,
      scales,
      positions,
    } = dataRef.current;
    const nc = nodes.length;
    const hl = highlightSet;
    const tmpColor = new THREE.Color();

    // Update node colors with powerful 3-hop highlight gradient
    const brightTmp = new THREE.Color();
    for (let i = 0; i < nc; i++) {
      const node = nodes[i];
      const baseColor = NODE_COLORS[node.type] || "#8b949e";
      const brightColor = NODE_COLORS_BRIGHT[node.type] || "#c0c8d0";

      if (!hl) {
        // Normal state — vivid type colors
        tmpColor.set(baseColor);
      } else if (node.id === selectedNode?.id) {
        // Selected — near-white bright glow
        tmpColor.set(brightColor);
        brightTmp.setRGB(1, 1, 1);
        tmpColor.lerp(brightTmp, 0.5); // blend toward white
      } else if (hl.has(node.id)) {
        const hop = hl.get(node.id);
        if (hop === 1) {
          // Hop 1 — bright vivid color
          tmpColor.set(brightColor);
        } else if (hop === 2) {
          // Hop 2 — medium bright
          tmpColor.set(baseColor);
          brightTmp.set(brightColor);
          tmpColor.lerp(brightTmp, 0.4);
        } else {
          // Hop 3 — slightly brighter than normal
          tmpColor.set(baseColor).multiplyScalar(0.7);
        }
      } else {
        // Dimmed — visible but subdued (not invisible)
        tmpColor.set(baseColor).multiplyScalar(0.12);
      }

      nodesMesh.setColorAt(i, tmpColor);
    }
    if (nodesMesh.instanceColor) nodesMesh.instanceColor.needsUpdate = true;

    // Boost glow during selection for highlighted nodes
    if (nodesMesh.material.uniforms?.uGlowIntensity) {
      nodesMesh.material.uniforms.uGlowIntensity.value = hl ? 1.15 : 1.0;
    }

    // Update edge colors with 3-hop gradient
    if (edgesMesh) {
      const edgeColorAttr = edgesMesh.geometry.attributes.color;
      if (edgeColorAttr) {
        const colorArr = edgeColorAttr.array;
        const validCount = edgeNodeIndices.length;

        for (let i = 0; i < validCount; i++) {
          const origIdx = edgeLinkIndices[i];
          const link = links[origIdx];
          const sId = link?.source?.id ?? link?.source;
          const tId = link?.target?.id ?? link?.target;

          if (!hl) {
            // Normal — type-based edge color
            tmpColor.set(LINK_COLORS[link?.type] || DEFAULT_LINK_COLOR);
          } else if (hl.has(sId) && hl.has(tId)) {
            // Both endpoints in highlight set — bright edge
            const maxHopVal = Math.max(hl.get(sId), hl.get(tId));
            const edgeBase = LINK_COLORS[link?.type] || DEFAULT_LINK_COLOR;
            tmpColor.set(edgeBase);
            if (maxHopVal <= 1) {
              tmpColor.multiplyScalar(1.8); // very bright
              tmpColor.r = Math.min(tmpColor.r, 1);
              tmpColor.g = Math.min(tmpColor.g, 1);
              tmpColor.b = Math.min(tmpColor.b, 1);
            } else if (maxHopVal === 2) {
              tmpColor.multiplyScalar(1.2);
            }
            // hop 3: normal color
          } else {
            // Dimmed edge
            tmpColor.setRGB(0.03, 0.03, 0.06);
          }
          colorArr[i * 6 + 0] = tmpColor.r;
          colorArr[i * 6 + 1] = tmpColor.g;
          colorArr[i * 6 + 2] = tmpColor.b;
          colorArr[i * 6 + 3] = tmpColor.r;
          colorArr[i * 6 + 4] = tmpColor.g;
          colorArr[i * 6 + 5] = tmpColor.b;
        }
        edgeColorAttr.needsUpdate = true;

        // Boost edge opacity during selection for highlighted edges
        edgesMesh.material.opacity = hl
          ? Math.min(styleRef.current.edgeOpacity * 1.5, 0.6)
          : (nc > 15000 ? 0.08 : nc > 5000 ? 0.12 : styleRef.current.edgeOpacity);
      }
    }

    // Selection ring — position and color
    if (selectedNode && positions) {
      const idx = nodeIdToIndex.get(selectedNode.id);
      if (idx !== undefined && scales) {
        selectionRing.position.set(
          positions[idx * 3],
          positions[idx * 3 + 1],
          positions[idx * 3 + 2]
        );
        const sc = scales[idx] * 1.6;
        selectionRing.scale.set(sc, sc, sc);
        selectionRing.visible = true;
        const ringColor = NODE_COLORS_BRIGHT[selectedNode.type] || "#ffffff";
        selectionRing.children.forEach((child) => {
          child.material.color.set(ringColor);
        });
      }
    } else {
      selectionRing.visible = false;
    }
  }, [selectedNode, highlightSet, graphData]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ── Effect 4: bloom style updates ─────────────────── */
  useEffect(() => {
    const t = threeRef.current;
    if (!t?.bloomPass) return;
    t.bloomPass.strength = style.bloomStrength;
    t.bloomPass.radius = style.bloomRadius;
    t.bloomPass.threshold = style.bloomThreshold;
  }, [style.bloomStrength, style.bloomRadius, style.bloomThreshold]);

  /* ── Effect 4b: node size live update ──────────────── */
  useEffect(() => {
    const gObj = graphObjRef.current;
    if (!gObj?.nodesMesh) return;
    const { nodes, positions, scales } = dataRef.current;
    if (!positions || !scales) return;
    const nc = nodes.length;
    const { min: vMin, max: vMax } = valRange;

    // Recompute scales
    const newScales = new Float32Array(nc);
    for (let i = 0; i < nc; i++) {
      const raw = nodes[i].val || 1;
      const tt = vMax > vMin ? (raw - vMin) / (vMax - vMin) : 0;
      newScales[i] = style.nodeMinSize + tt * (style.nodeMaxSize - style.nodeMinSize);
    }
    dataRef.current.scales = newScales;

    // Update instance matrices with new scales
    const tmpPos = new THREE.Vector3();
    const tmpScale = new THREE.Vector3();
    const tmpQuat = new THREE.Quaternion();
    const tmpMat = new THREE.Matrix4();
    for (let i = 0; i < nc; i++) {
      tmpPos.set(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
      const sc = newScales[i];
      tmpScale.set(sc, sc, sc);
      tmpMat.compose(tmpPos, tmpQuat, tmpScale);
      gObj.nodesMesh.setMatrixAt(i, tmpMat);
    }
    gObj.nodesMesh.instanceMatrix.needsUpdate = true;
  }, [style.nodeMinSize, style.nodeMaxSize, valRange]);

  /* ── Effect 4c: edge opacity live update ───────────── */
  useEffect(() => {
    const gObj = graphObjRef.current;
    if (!gObj?.edgesMesh) return;
    gObj.edgesMesh.material.opacity = style.edgeOpacity;
  }, [style.edgeOpacity]);

  /* ── Effect 4d: fog live update ────────────────────── */
  useEffect(() => {
    const t = threeRef.current;
    if (!t) return;
    if (style.fogDensity > 0) {
      t.scene.fog = new THREE.FogExp2(0x030810, style.fogDensity * 0.5);
    } else {
      t.scene.fog = null;
    }
  }, [style.fogDensity]);

  /* ── Effect 4e: star field toggle ──────────────────── */
  useEffect(() => {
    const t = threeRef.current;
    if (!t?.stars) return;
    t.stars.visible = style.starField !== false;
  }, [style.starField]);

  /* ── Effect 4f: auto orbit ─────────────────────────── */
  useEffect(() => {
    const t = threeRef.current;
    if (!t) return;
    if (!style.autoOrbit) return;

    let angle = 0;
    const id = setInterval(() => {
      if (!threeRef.current) return;
      const cam = threeRef.current.camera;
      const ctrl = threeRef.current.controls;
      const dist = cam.position.length() || 800;
      angle += 0.003;
      cam.position.set(
        dist * Math.sin(angle),
        cam.position.y,
        dist * Math.cos(angle)
      );
      ctrl.update();
    }, 30);

    return () => clearInterval(id);
  }, [style.autoOrbit]);

  /* ── Effect 5: expose API via graphRef ─────────────── */
  useEffect(() => {
    if (!graphRef) return;
    graphRef.current = {
      cameraPosition: (pos, lookAt, duration) => {
        const t = threeRef.current;
        if (!t) return;
        animateCamera(t.camera, t.controls, pos, lookAt, duration || 1000);
      },
      zoomToFit: (duration, padding) => {
        const t = threeRef.current;
        if (!t) return;
        zoomToFitInternal(t.camera, t.controls, duration || 800, padding || 100);
      },
      scene: () => threeRef.current?.scene,
      renderer: () => threeRef.current?.renderer,
    };
    return () => {
      if (graphRef) graphRef.current = null;
    };
  }, [graphRef]);

  /* ── Effect 6: click/interaction handler ───────────── */
  useEffect(() => {
    const t = threeRef.current;
    if (!t) return;
    const { camera, renderer, controls } = t;
    const canvas = renderer.domElement;

    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2();
    let mouseDownPos = null;

    function onPointerDown(e) {
      mouseDownPos = { x: e.clientX, y: e.clientY };
    }

    function onPointerUp(e) {
      if (!mouseDownPos) return;
      const dx = Math.abs(e.clientX - mouseDownPos.x);
      const dy = Math.abs(e.clientY - mouseDownPos.y);
      mouseDownPos = null;
      if (dx + dy > 5) return; // drag

      const gObj = graphObjRef.current;
      if (!gObj?.nodesMesh) return;

      const rect = canvas.getBoundingClientRect();
      mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(mouse, camera);

      const hits = raycaster.intersectObject(gObj.nodesMesh);
      if (hits.length > 0 && hits[0].instanceId != null) {
        const node = dataRef.current.nodes[hits[0].instanceId];
        if (node) {
          const nx = node.x || 0,
            ny = node.y || 0,
            nz = node.z || 0;
          const dist = Math.hypot(nx, ny, nz);
          if (dist > 1) {
            const ratio = 1 + 120 / dist;
            animateCamera(
              camera,
              controls,
              { x: nx * ratio, y: ny * ratio, z: nz * ratio },
              { x: nx, y: ny, z: nz },
              1200
            );
          }
          onNodeClickRef.current(node);
        }
      } else {
        onNodeClickRef.current(null);
      }
    }

    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointerup", onPointerUp);

    return () => {
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointerup", onPointerUp);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /* ── Effect 7: Escape key ──────────────────────────── */
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === "Escape") onNodeClickRef.current(null);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  return (
    <div
      ref={containerRef}
      style={{ width: "100%", height: "100%", position: "relative" }}
    />
  );
}
