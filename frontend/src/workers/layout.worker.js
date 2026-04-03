/**
 * Web Worker: Force-directed layout using d3-force-3d.
 * Runs simulation off main thread, posts Float32Array positions via transferable objects (zero-copy).
 *
 * Messages:
 *   Main → Worker:  { type: 'init', nodes: [{id},...], links: [{source,target},...] }
 *                   { type: 'stop' }
 *   Worker → Main:  { type: 'positions', positions: ArrayBuffer, alpha: number }
 *                   { type: 'settled' }
 */
import {
  forceSimulation,
  forceManyBody,
  forceLink,
  forceCenter,
} from "d3-force-3d";

let sim = null;
let simNodes = [];
let tickCount = 0;
let settled = false;

self.onmessage = (e) => {
  const msg = e.data;

  if (msg.type === "init") {
    if (sim) sim.stop();
    settled = false;
    tickCount = 0;

    const n = msg.nodes.length;

    // Create node copies with random initial positions (large sphere for spread)
    simNodes = msg.nodes.map((nd, i) => {
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      const r = 500 + Math.random() * 1000;
      return {
        id: nd.id,
        index: i,
        x: r * Math.sin(phi) * Math.cos(theta),
        y: r * Math.sin(phi) * Math.sin(theta),
        z: r * Math.cos(phi),
      };
    });

    const simLinks = msg.links.map((l) => ({
      source: l.source,
      target: l.target,
    }));

    // 5x spread: much stronger repulsion, larger link distances
    const charge = n > 50000 ? -80 : n > 10000 ? -120 : -200;
    const distMax = n > 50000 ? 1500 : n > 10000 ? 2000 : 3000;
    const theta = n > 20000 ? 1.5 : n > 5000 ? 1.2 : 0.9;
    const linkDist = n > 50000 ? 120 : n > 10000 ? 180 : 250;
    const alphaDecay = n > 50000 ? 0.04 : n > 10000 ? 0.03 : 0.02;

    sim = forceSimulation(simNodes, 3)
      .force(
        "charge",
        forceManyBody().strength(charge).distanceMax(distMax).theta(theta)
      )
      .force(
        "link",
        forceLink(simLinks).id((d) => d.id).distance(linkDist).strength(0.2)
      )
      .force("center", forceCenter())
      .alphaDecay(alphaDecay)
      .velocityDecay(0.4);

    sim.on("tick", () => {
      tickCount++;

      // Throttle position posts
      const postEvery = n > 50000 ? 5 : n > 10000 ? 3 : 2;
      const alpha = sim.alpha();

      if (tickCount % postEvery !== 0 && alpha > 0.005) return;

      const positions = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        positions[i * 3] = simNodes[i].x || 0;
        positions[i * 3 + 1] = simNodes[i].y || 0;
        positions[i * 3 + 2] = simNodes[i].z || 0;
      }

      self.postMessage(
        { type: "positions", positions: positions.buffer, alpha },
        [positions.buffer]
      );

      if (!settled && alpha < 0.005) {
        settled = true;
        self.postMessage({ type: "settled" });
      }
    });
  }

  if (msg.type === "stop") {
    if (sim) {
      sim.stop();
      sim = null;
    }
  }
};
