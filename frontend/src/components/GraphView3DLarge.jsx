/**
 * GraphView3DLarge — Custom Three.js renderer for 5K–100K+ node graphs.
 *
 * Architecture:
 *   - 1 InstancedMesh  (all nodes → 1 draw call)
 *   - 1 LineSegments   (all edges → 1 draw call)
 *   - Web Worker        (force layout off main thread)
 *   - GPU picking–free  (Three.js raycaster on InstancedMesh)
 *
 * Total draw calls: 2  (vs 100K+ in react-force-graph-3d)
 */
import { useEffect, useRef, useMemo, useCallback } from "react";
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
const LINK_COLORS = {
  owns: "#58a6ff",
  contributes: "#8b949e",
  has_topic: "#d29922",
  coworker: "#da70d6",
  forked_from: "#8888cc",
};
const DEFAULT_LINK_COLOR = "#8b949e";

const DEFAULT_STYLE = {
  nodeMinSize: 2,
  nodeMaxSize: 20,
  edgeOpacity: 0.25,
  bloomStrength: 1.5,
  bloomRadius: 0.4,
  bloomThreshold: 0.1,
  starField: true,
  fogDensity: 0.0006,
};

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
    const ease = t * (2 - t); // ease-out quad
    camera.position.lerpVectors(startPos, endPos, ease);
    controls.target.lerpVectors(startTarget, endTarget, ease);
    controls.update();
    if (t < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
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

  // Persistent Three.js objects (survive graphData changes)
  const threeRef = useRef(null); // { scene, camera, renderer, controls, composer, bloomPass, stars, lights }
  const graphObjRef = useRef(null); // { nodesMesh, edgesMesh, selectionRing, worker }
  const dataRef = useRef({
    nodes: [],
    links: [],
    nodeIdToIndex: new Map(),
    edgeNodeIndices: [],
    positions: null,
    scales: null,
    settled: false,
  });

  // Refs for stable callbacks
  const selectedNodeRef = useRef(null);
  const onNodeClickRef = useRef(onNodeClick);
  const styleRef = useRef(style);
  onNodeClickRef.current = onNodeClick;
  selectedNodeRef.current = selectedNode;
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

  const nodeCount = graphData.nodes.length;
  const maxHops = useMemo(
    () => (nodeCount > 3000 ? 1 : nodeCount > 500 ? 2 : 3),
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
      antialias: false, // skip AA for perf at 100K
      powerPreference: "high-performance",
    });
    renderer.setSize(w, h);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.2;
    container.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.12;
    controls.rotateSpeed = 0.5;
    controls.zoomSpeed = 1.2;
    controls.minDistance = 10;
    controls.maxDistance = 30000;

    // Lights
    const ambient = new THREE.AmbientLight(0x404060, 1.2);
    scene.add(ambient);
    const pointLight = new THREE.PointLight(0x5588ff, 0.5, 10000);
    pointLight.position.set(0, 200, 0);
    scene.add(pointLight);

    // Bloom (optional, only for < 15K nodes)
    let composer = null;
    let bloomPass = null;

    // Star field
    const stars = createStarField(4000, 8000);
    scene.add(stars);

    // Selection ring (reusable, single mesh)
    const ringGeo = new THREE.RingGeometry(1.3, 1.6, 32);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.7,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const selectionRing = new THREE.Mesh(ringGeo, ringMat);
    selectionRing.visible = false;
    scene.add(selectionRing);

    // Store refs
    threeRef.current = {
      scene,
      camera,
      renderer,
      controls,
      composer,
      bloomPass,
      stars,
      ambient,
      pointLight,
      selectionRing,
    };

    // Animation loop
    let animFrame;
    function animate() {
      animFrame = requestAnimationFrame(animate);
      controls.update();

      // Billboard selection ring toward camera
      if (selectionRing.visible) {
        selectionRing.quaternion.copy(camera.quaternion);
      }

      if (composer) {
        composer.render();
      } else {
        renderer.render(scene, camera);
      }
    }
    animate();

    // Resize
    const resizeObserver = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      if (width === 0 || height === 0) return;
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height);
      if (composer) composer.setSize(width, height);
    });
    resizeObserver.observe(container);

    // Cleanup
    return () => {
      cancelAnimationFrame(animFrame);
      resizeObserver.disconnect();
      controls.dispose();
      disposeObject(stars);
      disposeObject(selectionRing);
      if (bloomPass) bloomPass.dispose();
      if (composer) composer.dispose();
      renderer.dispose();
      if (container.contains(renderer.domElement)) {
        container.removeChild(renderer.domElement);
      }
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
      if (prev.worker) prev.worker.postMessage({ type: "stop" });
    }

    // Setup bloom for medium-large graphs (5K-15K)
    if (nc < 15000 && !t.composer) {
      try {
        const s = styleRef.current;
        const composer = new EffectComposer(renderer);
        composer.addPass(new RenderPass(scene, camera));
        const bloom = new UnrealBloomPass(
          new THREE.Vector2(
            renderer.domElement.width / 2,
            renderer.domElement.height / 2
          ),
          s.bloomStrength * 0.6,
          s.bloomRadius,
          s.bloomThreshold
        );
        composer.addPass(bloom);
        t.composer = composer;
        t.bloomPass = bloom;
      } catch (_) {
        /* bloom not critical */
      }
    } else if (nc >= 15000 && t.composer) {
      // Remove bloom for huge graphs
      t.composer = null;
      if (t.bloomPass) {
        t.bloomPass.dispose();
        t.bloomPass = null;
      }
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
    for (let i = 0; i < ec; i++) {
      const si = nodeIdToIndex.get(links[i].source?.id ?? links[i].source);
      const ti = nodeIdToIndex.get(links[i].target?.id ?? links[i].target);
      if (si !== undefined && ti !== undefined) {
        edgeNodeIndices.push([si, ti]);
      }
    }

    // Compute node sizes
    const { min: vMin, max: vMax } = valRange;
    const nodeScales = new Float32Array(nc);
    for (let i = 0; i < nc; i++) {
      const raw = nodes[i].val || 1;
      const t2 = vMax > vMin ? (raw - vMin) / (vMax - vMin) : 0;
      nodeScales[i] = s.nodeMinSize + t2 * (s.nodeMaxSize - s.nodeMinSize);
    }

    // Store in ref
    dataRef.current = {
      nodes,
      links,
      nodeIdToIndex,
      edgeNodeIndices,
      positions: null,
      scales: nodeScales,
      settled: false,
    };

    /* ── Create InstancedMesh for nodes ── */
    const sphereGeo = new THREE.SphereGeometry(
      1,
      nc > 50000 ? 4 : nc > 15000 ? 6 : 8,
      nc > 50000 ? 3 : nc > 15000 ? 4 : 6
    );
    const nodeMaterial = new THREE.MeshLambertMaterial({
      emissive: 0x222244,
      emissiveIntensity: 0.3,
    });

    const nodesMesh = new THREE.InstancedMesh(sphereGeo, nodeMaterial, nc);
    nodesMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

    // Initialize colors by node type
    const tmpColor = new THREE.Color();
    for (let i = 0; i < nc; i++) {
      tmpColor.set(NODE_COLORS[nodes[i].type] || "#8b949e");
      nodesMesh.setColorAt(i, tmpColor);
    }
    nodesMesh.instanceColor.needsUpdate = true;

    // Initialize transforms (random positions until worker sends real ones)
    const tmpMatrix = new THREE.Matrix4();
    const tmpQuat = new THREE.Quaternion();
    for (let i = 0; i < nc; i++) {
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      const r = 100 + Math.random() * 200;
      tmpMatrix.compose(
        new THREE.Vector3(
          r * Math.sin(phi) * Math.cos(theta),
          r * Math.sin(phi) * Math.sin(theta),
          r * Math.cos(phi)
        ),
        tmpQuat,
        new THREE.Vector3(nodeScales[i], nodeScales[i], nodeScales[i])
      );
      nodesMesh.setMatrixAt(i, tmpMatrix);
    }
    nodesMesh.instanceMatrix.needsUpdate = true;
    nodesMesh.computeBoundingSphere();
    scene.add(nodesMesh);

    /* ── Create LineSegments for edges ── */
    const validEdgeCount = edgeNodeIndices.length;
    const edgePositions = new Float32Array(validEdgeCount * 6);
    const edgeColors = new Float32Array(validEdgeCount * 6);

    // Initialize edge colors
    const tmpC = new THREE.Color();
    for (let i = 0; i < validEdgeCount; i++) {
      // Find original link for this valid edge
      const linkIdx = i; // edgeNodeIndices is built in order from links
      tmpC.set(LINK_COLORS[links[linkIdx]?.type] || DEFAULT_LINK_COLOR);
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
      opacity: nc > 15000 ? 0.08 : nc > 5000 ? 0.12 : s.edgeOpacity,
      depthWrite: false,
    });

    const edgesMesh = new THREE.LineSegments(edgeGeo, edgeMaterial);
    scene.add(edgesMesh);

    graphObjRef.current = { nodesMesh, edgesMesh, worker: null };

    /* ── Start Web Worker ── */
    const worker = new Worker(
      new URL("../workers/layout.worker.js", import.meta.url),
      { type: "module" }
    );
    graphObjRef.current.worker = worker;

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
          pos3.set(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
          const sc = nodeScales[i];
          scale3.set(sc, sc, sc);
          mat4.compose(pos3, quat4, scale3);
          nodesMesh.setMatrixAt(i, mat4);

          // Also mutate node objects for compatibility with GraphPage.focusNode
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
        // Zoom to fit once layout converges
        zoomToFitInternal(camera, controls, 800, 100);
      }
    };

    // Send graph to worker
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
      worker.postMessage({ type: "stop" });
      worker.terminate();
      scene.remove(nodesMesh);
      scene.remove(edgesMesh);
      disposeObject(nodesMesh);
      disposeObject(edgesMesh);
      graphObjRef.current = null;
    };
  }, [graphData, valRange]); // eslint-disable-line react-hooks/exhaustive-deps

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

  /* ── Effect 3: selection visual update ─────────────── */
  useEffect(() => {
    const gObj = graphObjRef.current;
    const t = threeRef.current;
    if (!gObj?.nodesMesh || !t) return;

    const { nodesMesh, edgesMesh } = gObj;
    const { selectionRing } = t;
    const { nodes, nodeIdToIndex, edgeNodeIndices, links, scales, positions } =
      dataRef.current;
    const nc = nodes.length;
    const hl = highlightSet;
    const tmpColor = new THREE.Color();

    // Update node colors
    for (let i = 0; i < nc; i++) {
      const node = nodes[i];
      const baseColor = NODE_COLORS[node.type] || "#8b949e";

      if (!hl) {
        // No selection — normal colors
        tmpColor.set(baseColor);
      } else if (node.id === selectedNode?.id) {
        // Selected node — bright
        tmpColor.set(baseColor).multiplyScalar(1.8);
        tmpColor.r = Math.min(tmpColor.r, 1);
        tmpColor.g = Math.min(tmpColor.g, 1);
        tmpColor.b = Math.min(tmpColor.b, 1);
      } else if (hl.has(node.id)) {
        // Neighbor — full brightness
        const hop = hl.get(node.id);
        const fade = hop === 1 ? 1.0 : hop === 2 ? 0.7 : 0.5;
        tmpColor.set(baseColor).multiplyScalar(fade);
      } else {
        // Dimmed — very dark
        tmpColor.setRGB(0.04, 0.04, 0.06);
      }

      nodesMesh.setColorAt(i, tmpColor);
    }
    nodesMesh.instanceColor.needsUpdate = true;

    // Update edge colors (dim non-highlighted edges)
    if (edgesMesh) {
      const edgeColorAttr = edgesMesh.geometry.attributes.color;
      const colorArr = edgeColorAttr.array;
      const validCount = edgeNodeIndices.length;

      for (let i = 0; i < validCount; i++) {
        const link = links[i];
        const s = link?.source?.id ?? link?.source;
        const t2 = link?.target?.id ?? link?.target;

        if (!hl || (hl.has(s) && hl.has(t2))) {
          tmpColor.set(LINK_COLORS[link?.type] || DEFAULT_LINK_COLOR);
        } else {
          tmpColor.setRGB(0.03, 0.03, 0.05);
        }
        colorArr[i * 6 + 0] = tmpColor.r;
        colorArr[i * 6 + 1] = tmpColor.g;
        colorArr[i * 6 + 2] = tmpColor.b;
        colorArr[i * 6 + 3] = tmpColor.r;
        colorArr[i * 6 + 4] = tmpColor.g;
        colorArr[i * 6 + 5] = tmpColor.b;
      }
      edgeColorAttr.needsUpdate = true;
    }

    // Position selection ring
    if (selectedNode && positions) {
      const idx = nodeIdToIndex.get(selectedNode.id);
      if (idx !== undefined && scales) {
        const sx = positions[idx * 3];
        const sy = positions[idx * 3 + 1];
        const sz = positions[idx * 3 + 2];
        const sc = scales[idx] * 1.6;
        selectionRing.position.set(sx, sy, sz);
        selectionRing.scale.set(sc, sc, sc);
        selectionRing.visible = true;
        const bc = NODE_COLORS[selectedNode.type] || "#ffffff";
        selectionRing.material.color.set(bc);
      }
    } else {
      selectionRing.visible = false;
    }
  }, [selectedNode, highlightSet, graphData]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ── Effect 4: bloom style updates ─────────────────── */
  useEffect(() => {
    const t = threeRef.current;
    if (!t?.bloomPass) return;
    t.bloomPass.strength = style.bloomStrength * 0.6;
    t.bloomPass.radius = style.bloomRadius;
    t.bloomPass.threshold = style.bloomThreshold;
  }, [style.bloomStrength, style.bloomRadius, style.bloomThreshold]);

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
      if (dx + dy > 5) return; // drag, not click

      const gObj = graphObjRef.current;
      if (!gObj?.nodesMesh) return;

      const rect = canvas.getBoundingClientRect();
      mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(mouse, camera);

      const hits = raycaster.intersectObject(gObj.nodesMesh);
      if (hits.length > 0) {
        const nodeIndex = hits[0].instanceId;
        const node = dataRef.current.nodes[nodeIndex];
        if (node) {
          // Fly-to animation
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

  /* ── Effect 7: Escape key to deselect ──────────────── */
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
