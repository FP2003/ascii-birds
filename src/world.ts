/**
 * Artificial-life sim for the hero: small-bird flocks and the raptors that hunt them.
 *
 * Birds: Reynolds boids (separation / alignment / cohesion) in Couzin-style
 * zones, with a blind spot behind each bird. Alarm spreads from bird to bird
 * through the flock (a "wave of agitation"), so a whole murmuration bolts
 * even when only its edge can see the hawk. Fleeing birds break sideways
 * around the raptor's path, splitting the flock like a flash expansion.
 *
 * Raptors: Reynolds steering (wander + pursuit + separation) on a rigid body
 * with spread, flapping or folded wings. Off the hunt they soar lazy circles
 * and glide, with the odd burst of wingbeats; on it they flap hard, and the
 * stoopers fold their wings and dive as they close. Hunger builds over time
 * and drops when they catch something. They prefer birds in sparse spots,
 * since dense flocks confuse predators, so stragglers get picked off. Caught
 * birds come back later as new flocks flying in from the edges, which keeps
 * the population steady.
 */
import { angleDiff, clamp, rand, randInt, smoothstep, TAU, wind } from "./math";
import { pickSpecies, SPECIES } from "./species";

export type RaptorKind = "hawk" | "falcon" | "eagle" | "kite" | "osprey" | "owl";

/** Which raptors to put in the sky; size is relative to the biggest. */
export type RaptorSpec = { kind: RaptorKind; size: number };

// The landing hero: a mixed sky, from a big low eagle down to a small high falcon.
const DEFAULT_RAPTORS: RaptorSpec[] = [
  { kind: "eagle", size: 1 },
  { kind: "kite", size: 0.84 },
  { kind: "hawk", size: 0.74 },
  { kind: "owl", size: 0.64 },
  { kind: "falcon", size: 0.56 },
];

/** How each raptor flies, as opposed to how it looks (that lives in the renderer). */
interface Flight {
  /** Full wingspan as a multiple of beak-to-tail length. */
  span: number;
  /** How far it folds its wings into a dive when closing on prey, 0..1. */
  stoop: number;
  /** Turn-rate multiplier while patrolling. */
  agility: number;
  /** Share of the patrol spent flapping rather than soaring. */
  flapping: number;
}

export const FLIGHT: Record<RaptorKind, Flight> = {
  hawk: { span: 2.0, stoop: 0.35, agility: 1, flapping: 0.35 },
  falcon: { span: 1.9, stoop: 1, agility: 1.2, flapping: 0.55 },
  eagle: { span: 2.2, stoop: 0.5, agility: 0.75, flapping: 0.22 },
  kite: { span: 2.1, stoop: 0.2, agility: 1.25, flapping: 0.3 },
  osprey: { span: 2.2, stoop: 0.6, agility: 0.9, flapping: 0.45 },
  owl: { span: 2.1, stoop: 0, agility: 1.1, flapping: 0.7 },
};

/** Where the wings join the body, as a fraction of beak-to-tail length. */
export const SHOULDER = 0.32;

export interface Bird {
  x: number;
  y: number;
  vx: number;
  vy: number;
  species: number;
  /** 0 calm → 1 panicking. Spreads to neighbours. */
  alarm: number;
  alive: boolean;
  respawnAt: number;
  /** Wingbeat phase. */
  phase: number;
  /** Smoothed angular velocity (rad/s); hard turns flash bright. */
  turn: number;
  /** 0.55 far → 1 near. */
  depth: number;
  /** Rotation sense shared by a flock when it swirls into a murmuration. */
  millDir: 1 | -1;
}

export interface Raptor {
  id: number;
  kind: RaptorKind;
  /** Beak to tail tip, in px. */
  length: number;
  /** Full wingspan, in px. */
  span: number;
  /** The shoulders: the point the wings hinge on. */
  x: number;
  y: number;
  heading: number;
  speed: number;
  /** Wingbeat phase; drives the flapping in the renderer. */
  phase: number;
  /** 0 gliding → 1 flapping hard. */
  flap: number;
  /** 0 wings spread → 1 folded into a stoop. */
  tuck: number;
  /** Smoothed angular velocity (rad/s); the raptor banks into turns. */
  turn: number;
  hunger: number;
  wander: number;
  orbitDir: 1 | -1;
  orbitRadius: number;
  target: Bird | null;
  retargetAt: number;
  /** 0 far / dim → 1 near / bright. */
  depth: number;
}

export interface WorldEvent {
  kind: "catch" | "scare";
  x: number;
  y: number;
}

/** Fraction of the wings' full reach showing right now: flapping and folding both shorten it. */
export function wingReach(r: Raptor) {
  return (1 - 0.62 * r.tuck) * (1 - 0.5 * r.flap * (0.5 + 0.5 * Math.sin(r.phase)));
}

export function beakOf(r: Raptor) {
  const d = r.length * SHOULDER;
  return { x: r.x + Math.cos(r.heading) * d, y: r.y + Math.sin(r.heading) * d };
}

const BIRD_SEPARATION_K = 420;
const BIRD_ALIGN_K = 1.4;
const BIRD_COHESION_K = 1;
const BIRD_FLEE_K = 1100;
const BLIND_COS = -0.6; // ~127° either side of the heading is visible
/** Threat points per raptor: beak, shoulders, and both wingtips. */
const THREAT_POINTS = 4;

export class World {
  width = 0;
  height = 0;
  time = 0;
  birds: Bird[] = [];
  raptors: Raptor[] = [];
  events: WorldEvent[] = [];
  pointer = { x: 0, y: 0, active: false };

  /** Bird neighbourhood radius; the spatial hash bucket size matches it. */
  private perception = 60;
  /** Per-species personal space in px (x, y). */
  private sepX: number[] = [];
  private sepY: number[] = [];
  private foreignSep = 40;
  private bucketCols = 0;
  private bucketRows = 0;
  private bucketHead = new Int32Array(0);
  private bucketCount = new Uint16Array(0);
  private bucketNext = new Int32Array(0);
  private lastSpawn = 0;
  private tmp = { x: 0, y: 0 };
  private threats = new Float32Array(0);

  /** birdCount overrides the area-based population (the sidebar wants a single small flock). */
  constructor(
    private raptorSpecs: RaptorSpec[] = DEFAULT_RAPTORS,
    private birdCount?: number,
  ) {}

  resize(width: number, height: number, cellW: number, cellH: number) {
    const first = this.width === 0;
    this.width = width;
    this.height = height;
    // Spacing is set in grid cells so every bird lands in its own cell.
    this.sepX = SPECIES.map((sp) => sp.spacing[0] * cellW);
    this.sepY = SPECIES.map((sp) => sp.spacing[1] * cellH);
    this.perception = Math.max(cellH * 3, cellW * 5.5);
    this.foreignSep = cellW * 3;

    if (first || this.birds.length === 0) {
      this.seed();
      return;
    }
    for (const b of this.birds) {
      b.x = clamp(b.x, 0, width);
      b.y = clamp(b.y, 0, height);
    }
  }

  seed() {
    const { width: W, height: H } = this;
    const minSide = Math.min(W, H);
    // Sized by wingspan: the biggest spans a bit under half the short side.
    const baseLength = clamp(minSide * 0.25, 95, 240);
    const raptorCount = this.raptorSpecs.length;

    this.raptors = [];
    for (let i = 0; i < raptorCount; i++) {
      const { kind, size } = this.raptorSpecs[i];
      const length = baseLength * size;
      const orbitRadius = minSide * rand(0.28, 0.4);
      const a = (i / raptorCount) * TAU + rand(-0.4, 0.4);
      const orbitDir: 1 | -1 = i % 2 === 0 ? 1 : -1;
      this.raptors.push({
        id: i + 1,
        kind,
        length,
        span: length * FLIGHT[kind].span,
        x: W / 2 + Math.cos(a) * orbitRadius * (W / minSide) * 0.9,
        y: H / 2 + Math.sin(a) * orbitRadius,
        heading: a + (orbitDir * Math.PI) / 2,
        speed: 40,
        phase: rand(0, TAU),
        flap: 0,
        tuck: 0,
        turn: 0,
        hunger: rand(0.25, 0.75),
        wander: 0,
        orbitDir,
        orbitRadius,
        target: null,
        retargetAt: 0,
        depth: size,
      });
    }
    // Smaller (higher, farther) raptors draw first so the big one flies under them.
    this.raptors.sort((a, b) => a.length - b.length);
    this.threats = new Float32Array(raptorCount * THREAT_POINTS * 2);

    const total = this.birdCount ?? clamp(Math.round((W * H) / 4400), 85, 340);
    this.birds = [];
    while (this.birds.length < total) {
      const species = pickSpecies();
      const sp = SPECIES[species];
      const size = Math.min(randInt(sp.flockSize[0], sp.flockSize[1]), total - this.birds.length);
      const millDir: 1 | -1 = Math.random() < 0.5 ? 1 : -1;
      const cx = rand(W * 0.06, W * 0.94);
      const cy = rand(H * 0.08, H * 0.92);
      const dir = rand(0, TAU);
      for (let k = 0; k < size; k++) {
        this.birds.push({
          x: cx + rand(-1, 1) * this.sepX[species] * Math.sqrt(size),
          y: cy + rand(-1, 1) * this.sepY[species] * Math.sqrt(size),
          vx: Math.cos(dir) * sp.cruise,
          vy: Math.sin(dir) * sp.cruise,
          species,
          alarm: 0,
          alive: true,
          respawnAt: 0,
          phase: rand(0, TAU),
          turn: 0,
          depth: rand(0.55, 1),
          millDir,
        });
      }
    }
    this.bucketNext = new Int32Array(this.birds.length);
  }

  /** A clap: everything nearby scatters. */
  scare(x: number, y: number) {
    this.events.push({ kind: "scare", x, y });
    const r = 240;
    for (const b of this.birds) {
      if (!b.alive) continue;
      const dx = b.x - x;
      const dy = b.y - y;
      const d = Math.hypot(dx, dy);
      if (d > r || d < 1e-3) continue;
      // Flash expansion: everybody nearby bolts straight out.
      const k = (1 - d / r) * 260;
      b.vx += (dx / d) * k;
      b.vy += (dy / d) * k;
      b.alarm = 1;
    }
  }

  step(dt: number) {
    this.time += dt;
    this.rebuildHash();
    this.updateThreats();
    this.stepBirds(dt);
    this.stepRaptors(dt);
    this.respawn();
  }

  private rebuildHash() {
    const size = this.perception;
    const pad = 2;
    this.bucketCols = Math.ceil(this.width / size) + pad * 2;
    this.bucketRows = Math.ceil(this.height / size) + pad * 2;
    const n = this.bucketCols * this.bucketRows;
    if (this.bucketHead.length !== n) {
      this.bucketHead = new Int32Array(n);
      this.bucketCount = new Uint16Array(n);
    }
    this.bucketHead.fill(-1);
    this.bucketCount.fill(0);
    if (this.bucketNext.length !== this.birds.length) {
      this.bucketNext = new Int32Array(this.birds.length);
    }
    for (let i = 0; i < this.birds.length; i++) {
      const b = this.birds[i];
      if (!b.alive) continue;
      const k = this.bucketOf(b.x, b.y);
      this.bucketNext[i] = this.bucketHead[k];
      this.bucketHead[k] = i;
      this.bucketCount[k]++;
    }
  }

  private bucketOf(x: number, y: number) {
    const size = this.perception;
    const c = clamp(Math.floor(x / size) + 2, 0, this.bucketCols - 1);
    const r = clamp(Math.floor(y / size) + 2, 0, this.bucketRows - 1);
    return r * this.bucketCols + c;
  }

  /** The points birds keep away from: beak, shoulders, and the wingtips as they are right now. */
  private updateThreats() {
    const t = this.threats;
    for (let i = 0; i < this.raptors.length; i++) {
      const r = this.raptors[i];
      const o = i * THREAT_POINTS * 2;
      const beak = beakOf(r);
      const half = r.span * 0.5 * wingReach(r);
      const px = -Math.sin(r.heading) * half;
      const py = Math.cos(r.heading) * half;
      t[o] = beak.x;
      t[o + 1] = beak.y;
      t[o + 2] = r.x;
      t[o + 3] = r.y;
      t[o + 4] = r.x + px;
      t[o + 5] = r.y + py;
      t[o + 6] = r.x - px;
      t[o + 7] = r.y - py;
    }
  }

  private stepBirds(dt: number) {
    const { birds, raptors, pointer, threats, width: W, height: H, time } = this;
    const R = this.perception;
    const R2 = R * R;
    const foreignSep = this.foreignSep;
    const size = this.perception;
    const cols = this.bucketCols;
    const rows = this.bucketRows;
    const head = this.bucketHead;
    const next = this.bucketNext;
    const air = this.tmp;
    const calmDecay = Math.exp(-dt * 0.7);
    const contagion = Math.min(1, dt * 6);

    for (let i = 0; i < birds.length; i++) {
      const f = birds[i];
      if (!f.alive) continue;
      const sp = SPECIES[f.species];
      // Alarmed birds want more room: the flock flashes apart around a
      // raptor and closes back up once the threat passes.
      const spread = 1 + 1.8 * f.alarm;
      const sepX = this.sepX[f.species] * spread;
      const sepY = this.sepY[f.species] * spread;

      const speed = Math.hypot(f.vx, f.vy) || 1;
      const hx = f.vx / speed;
      const hy = f.vy / speed;

      let ax = 0;
      let ay = 0;
      let sx = 0;
      let sy = 0;
      let avx = 0;
      let avy = 0;
      let cx = 0;
      let cy = 0;
      let n = 0;
      let neighbourAlarm = 0;

      const bc = clamp(Math.floor(f.x / size) + 2, 0, cols - 1);
      const br = clamp(Math.floor(f.y / size) + 2, 0, rows - 1);
      for (let r = Math.max(0, br - 1); r <= Math.min(rows - 1, br + 1); r++) {
        for (let c = Math.max(0, bc - 1); c <= Math.min(cols - 1, bc + 1); c++) {
          let j = head[r * cols + c];
          while (j !== -1) {
            if (j !== i) {
              const o = birds[j];
              const dx = o.x - f.x;
              const dy = o.y - f.y;
              const d2 = dx * dx + dy * dy;
              if (d2 < R2 && d2 > 1e-6) {
                const d = Math.sqrt(d2);
                // Blind zone directly behind the bird.
                if ((dx * hx + dy * hy) / d > BLIND_COS) {
                  // Elliptical personal space, sized to the grid cells.
                  const qx = dx / sepX;
                  const qy = dy / sepY;
                  const q2 = qx * qx + qy * qy;
                  if (q2 < 1) {
                    const q = Math.sqrt(q2) || 1e-3;
                    const k = (1 - q) / q;
                    sx -= qx * k;
                    sy -= qy * k;
                  }
                  if (o.species === f.species) {
                    avx += o.vx;
                    avy += o.vy;
                    cx += dx;
                    cy += dy;
                    n++;
                  } else if (d < foreignSep) {
                    // Different species keep their own flocks.
                    const k = ((1 - d / foreignSep) / d) * 0.6;
                    sx -= dx * k;
                    sy -= dy * k;
                  }
                  if (o.alarm > neighbourAlarm) neighbourAlarm = o.alarm;
                }
              }
            }
            j = next[j];
          }
        }
      }

      ax += sx * BIRD_SEPARATION_K;
      ay += sy * BIRD_SEPARATION_K;
      if (n > 0) {
        const alignK = BIRD_ALIGN_K * sp.align;
        const cohesionK = BIRD_COHESION_K * sp.cohesion * (1 - 0.8 * f.alarm);
        ax += (avx / n - f.vx) * alignK + (cx / n) * cohesionK;
        ay += (avy / n - f.vy) * alignK + (cy / n) * cohesionK;
        if (sp.mill > 0) {
          // Circle the local centre: the flock rolls into a murmuration.
          const cl = Math.hypot(cx, cy) || 1;
          ax += (-cy / cl) * f.millDir * sp.mill * (1 - f.alarm);
          ay += (cx / cl) * f.millDir * sp.mill * (1 - f.alarm);
        }
      }

      // Predators. Distance is measured to the nearest of beak, body and
      // wingtips, so birds give the whole wingspan a wide berth.
      let fear = 0;
      for (let k = 0; k < raptors.length; k++) {
        const rp = raptors[k];
        const fearR = rp.span * 0.4 + 60;
        const o = k * THREAT_POINTS * 2;
        let best = Infinity;
        let bx = 0;
        let by = 0;
        for (let p = 0; p < THREAT_POINTS; p++) {
          const nx = threats[o + p * 2];
          const ny = threats[o + p * 2 + 1];
          const d2 = (f.x - nx) ** 2 + (f.y - ny) ** 2;
          if (d2 < best) {
            best = d2;
            bx = nx;
            by = ny;
          }
        }
        const d = Math.sqrt(best);
        if (d >= fearR || d < 1e-3) continue;
        let w = 1 - d / fearR;
        w *= w;
        const awayX = (f.x - bx) / d;
        const awayY = (f.y - by) / d;
        // Split the flock: break to whichever side of the raptor's path you're on.
        const shx = Math.cos(rp.heading);
        const shy = Math.sin(rp.heading);
        const side = shx * (f.y - threats[o + 1]) - shy * (f.x - threats[o]) >= 0 ? 1 : -1;
        ax += (awayX * 0.7 - shy * side * 0.9) * BIRD_FLEE_K * w;
        ay += (awayY * 0.7 + shx * side * 0.9) * BIRD_FLEE_K * w;
        fear = Math.max(fear, Math.sqrt(w));
      }

      if (pointer.active) {
        const pr = 130;
        const dx = f.x - pointer.x;
        const dy = f.y - pointer.y;
        const d = Math.hypot(dx, dy);
        if (d < pr && d > 1e-3) {
          const w = (1 - d / pr) ** 2;
          ax += (dx / d) * BIRD_FLEE_K * w;
          ay += (dy / d) * BIRD_FLEE_K * w;
          fear = Math.max(fear, Math.sqrt(w) * 0.8);
        }
      }

      // Alarm: direct threat sets it, neighbours pass it along (slightly
      // weaker each hop), and it fades on its own.
      let alarm = Math.max(f.alarm * calmDecay, fear);
      const relayed = neighbourAlarm * 0.86;
      if (relayed > alarm) alarm += (relayed - alarm) * contagion;
      f.alarm = alarm;

      // Soft walls.
      const m = 36;
      if (f.x < m) ax += (m - f.x) * 7;
      else if (f.x > W - m) ax -= (f.x - (W - m)) * 7;
      if (f.y < m) ay += (m - f.y) * 7;
      else if (f.y > H - m) ay -= (f.y - (H - m)) * 7;

      // Wind and a little individual restlessness.
      wind(f.x, f.y, time, air);
      ax += air.x * 0.5 + (Math.random() - 0.5) * sp.jitter;
      ay += air.y * 0.5 + (Math.random() - 0.5) * sp.jitter;

      // Relax toward a preferred speed that rises with panic.
      const preferred = sp.cruise * (1 + 1.3 * f.alarm);
      ax += (preferred - speed) * hx * 1.6;
      ay += (preferred - speed) * hy * 1.6;

      const before = Math.atan2(f.vy, f.vx);
      f.vx += ax * dt;
      f.vy += ay * dt;
      const maxSpeed = sp.maxSpeed * (1 + 1.8 * f.alarm);
      const s = Math.hypot(f.vx, f.vy);
      if (s > maxSpeed) {
        f.vx *= maxSpeed / s;
        f.vy *= maxSpeed / s;
      } else if (s < sp.minSpeed && s > 1e-3) {
        f.vx *= sp.minSpeed / s;
        f.vy *= sp.minSpeed / s;
      }
      f.turn += (angleDiff(before, Math.atan2(f.vy, f.vx)) / dt - f.turn) * Math.min(1, dt * 8);
      // Panicked birds beat their wings faster.
      f.phase += dt * (9 + Math.hypot(f.vx, f.vy) * 0.08 + f.alarm * 8);
      f.x = clamp(f.x + f.vx * dt, -60, W + 60);
      f.y = clamp(f.y + f.vy * dt, -60, H + 60);
    }
  }

  private stepRaptors(dt: number) {
    const { raptors, width: W, height: H, time } = this;
    const minSide = Math.min(W, H);
    const cxW = W / 2;
    const cyW = H / 2;

    for (const rp of raptors) {
      const L = rp.length;
      const flight = FLIGHT[rp.kind];
      const beak = beakOf(rp);

      rp.hunger = Math.min(1, rp.hunger + dt * 0.03);

      // Momentum.
      let dx = Math.cos(rp.heading);
      let dy = Math.sin(rp.heading);

      // Wander: a slowly drifting offset on a circle ahead of the beak.
      rp.wander = clamp(rp.wander + (Math.random() - 0.5) * dt * 3.2, -1.1, 1.1);
      dx += Math.cos(rp.heading + rp.wander) * 0.45;
      dy += Math.sin(rp.heading + rp.wander) * 0.45;

      // Hunt.
      if (time >= rp.retargetAt) {
        rp.target = this.findPrey(rp);
        rp.retargetAt = time + 0.45;
      }
      const t = rp.target;
      let hunting = false;
      let closing = 0;
      if (t && t.alive && rp.hunger > 0.3) {
        // Pursuit: aim at where the bird is about to be.
        const tx = t.x + t.vx * 0.35 - beak.x;
        const ty = t.y + t.vy * 0.35 - beak.y;
        const d = Math.hypot(tx, ty) || 1;
        const w = 1.4 + 2.6 * rp.hunger;
        dx += (tx / d) * w;
        dy += (ty / d) * w;
        hunting = true;
        closing = clamp(1 - d / (rp.span * 0.9), 0, 1);
      } else {
        // Patrol: soaring a lazy circuit around the headline.
        const rx = (rp.x - cxW) / (W / minSide);
        const ry = rp.y - cyW;
        const r = Math.hypot(rx, ry) || 1;
        const radius = rp.orbitRadius * (1 + 0.15 * Math.sin(time * 0.05 + rp.id));
        const radial = clamp((radius - r) / radius, -1, 1);
        dx += ((-ry / r) * rp.orbitDir + (rx / r) * radial * 0.9) * 0.55;
        dy += ((rx / r) * rp.orbitDir + (ry / r) * radial * 0.9) * 0.55;
      }

      // Give other raptors room.
      for (const other of raptors) {
        if (other === rp) continue;
        const ox = rp.x - other.x;
        const oy = rp.y - other.y;
        const d = Math.hypot(ox, oy);
        const range = (rp.span + other.span) * 0.5;
        if (d < range && d > 1e-3) {
          const w = (1 - d / range) * 3;
          dx += (ox / d) * w;
          dy += (oy / d) * w;
        }
      }

      // Keep the headline mostly clear: a soft elliptical no-fly zone,
      // padded by the wings so they don't sweep across it either.
      const pad = rp.span * 0.25;
      const ex = (rp.x - cxW) / (W * 0.3 + pad);
      const ey = (rp.y - cyW) / (H * 0.16 + pad);
      const e2 = ex * ex + ey * ey;
      if (e2 < 1) {
        const e = Math.sqrt(e2) || 1e-3;
        const w = (1 - e) * (hunting ? 1 : 2.5);
        dx += (ex / e) * w;
        dy += (ey / e) * w;
      }

      // Turn back once the body leaves the frame, so wings dip off-screen
      // now and then but the raptors never wander away for good.
      const over = Math.max(-rp.x, rp.x - W, -rp.y, rp.y - H);
      if (over > -rp.span * 0.1) {
        const w = clamp((over + rp.span * 0.1) / (rp.span * 0.4), 0, 1) * 3.5;
        const toX = cxW - rp.x;
        const toY = cyW - rp.y;
        const d = Math.hypot(toX, toY) || 1;
        dx += (toX / d) * w;
        dy += (toY / d) * w;
      }

      const desired = Math.atan2(dy, dx);
      // The turning circle grows with speed; a folded stoop barely steers.
      const agility =
        Math.min(hunting ? 1.7 + closing : 0.8 * flight.agility, rp.speed / (L * 0.5)) * (1 - 0.4 * rp.tuck);
      const maxTurn = agility * dt;
      const turned = clamp(angleDiff(rp.heading, desired), -maxTurn, maxTurn);
      rp.heading += turned;
      rp.turn += (turned / dt - rp.turn) * Math.min(1, dt * 3);

      // Wings: soar with the odd burst of beats, flap hard on the hunt,
      // and fold into a stoop on the final approach.
      const burst = Math.sin(time * 0.45 + rp.id * 2.1) > 1 - 2 * flight.flapping;
      const flapTarget = hunting ? 1 - rp.tuck : burst ? 0.9 : 0;
      rp.flap += (flapTarget - rp.flap) * Math.min(1, dt * 2.5);
      const tuckTarget = hunting ? smoothstep(0.35, 0.85, closing) * flight.stoop : 0;
      rp.tuck += (tuckTarget - rp.tuck) * Math.min(1, dt * (tuckTarget > rp.tuck ? 3 : 1.5));
      // Bigger birds beat slower.
      rp.phase += dt * (3 + 900 / (L + 60)) * (0.25 + rp.flap);

      const cruise = 36 + L * 0.1;
      const targetSpeed = hunting ? cruise * (1.45 + closing * 1.5) * (1 + 0.7 * rp.tuck) : cruise;
      rp.speed += (targetSpeed - rp.speed) * Math.min(1, dt * 1.1);

      rp.x += Math.cos(rp.heading) * rp.speed * dt;
      rp.y += Math.sin(rp.heading) * rp.speed * dt;

      // Strike.
      if (rp.hunger > 0.15) {
        const reach = L * 0.12 + 8;
        const b = beakOf(rp);
        for (const f of this.birds) {
          if (!f.alive) continue;
          if ((f.x - b.x) ** 2 + (f.y - b.y) ** 2 < reach * reach) {
            f.alive = false;
            f.respawnAt = time + rand(3, 8);
            rp.hunger = Math.max(0, rp.hunger - 0.16);
            this.events.push({ kind: "catch", x: f.x, y: f.y });
          }
        }
      }
    }
  }

  /**
   * Pick prey in the raptor's forward cone, preferring close birds in sparse
   * buckets (stragglers) over birds buried in a dense flock.
   */
  private findPrey(rp: Raptor): Bird | null {
    const range = rp.span * 0.8 + 160;
    const { x: hx, y: hy } = beakOf(rp);
    const fx = Math.cos(rp.heading);
    const fy = Math.sin(rp.heading);
    let best: Bird | null = null;
    let bestScore = Infinity;
    let currentScore = Infinity;

    for (const f of this.birds) {
      if (!f.alive) continue;
      const dx = f.x - hx;
      const dy = f.y - hy;
      const d = Math.hypot(dx, dy);
      if (d > range || d < 1e-3) continue;
      const cos = (dx * fx + dy * fy) / d;
      if (cos < 0.2) continue;
      const crowd = this.bucketCount[this.bucketOf(f.x, f.y)];
      const score = d * (1 + (1 - cos) * 0.8) * (1 + crowd * 0.07);
      if (score < bestScore) {
        bestScore = score;
        best = f;
      }
      if (f === rp.target) currentScore = score;
    }
    // Stick with the current target unless something is clearly better.
    if (rp.target && currentScore < bestScore * 1.3) return rp.target;
    return best;
  }

  private respawn() {
    const { time, width: W, height: H } = this;
    const due: Bird[] = [];
    for (const b of this.birds) if (!b.alive && b.respawnAt <= time) due.push(b);
    if (due.length === 0) return;
    if (due.length < 6 && time - this.lastSpawn < 9) return;
    this.lastSpawn = time;

    // A new flock flies in from a random edge.
    const side = randInt(0, 3);
    const along = rand(0.15, 0.85);
    const x = side === 0 ? -20 : side === 1 ? W + 20 : along * W;
    const y = side === 2 ? -20 : side === 3 ? H + 20 : along * H;
    const inward = Math.atan2(H / 2 - y, W / 2 - x) + rand(-0.5, 0.5);
    const species = pickSpecies();
    const sp = SPECIES[species];
    const millDir: 1 | -1 = Math.random() < 0.5 ? 1 : -1;
    for (const b of due.slice(0, sp.flockSize[1])) {
      b.alive = true;
      b.species = species;
      b.alarm = 0;
      b.turn = 0;
      b.millDir = millDir;
      b.x = x + rand(-1, 1) * this.perception;
      b.y = y + rand(-1, 1) * this.perception;
      b.vx = Math.cos(inward) * sp.cruise * 1.4;
      b.vy = Math.sin(inward) * sp.cruise * 1.4;
    }
  }
}

