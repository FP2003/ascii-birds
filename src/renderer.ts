/**
 * Draws the World as a grid of ASCII cells:
 *   1. a pure black cell grid, the night sky
 *   2. a wake field that spreads where things fly (wingtip vortices, mostly),
 *      lighting the dots a pale sky blue
 *   3. small birds as one glyph per cell that flaps v - ^, glinting on hard turns
 *   4. raptors seen from below, rasterised cell-by-cell with supersampled
 *      edges: grey blocks shaded by the light, feather strokes that follow the
 *      heading, underwing markings, and shimmering accent colours
 */
import { clamp, hash3, smoothstep } from "./math";
import { SHOULDER, wingReach, type Raptor, type RaptorKind, type World } from "./world";
import { SPECIES } from "./species";

const ALPHA_LEVELS = 6;
const BIRD_ALPHAS = [0.28, 0.42, 0.58, 0.74, 0.9];
const BIRD_GLYPHS = ["v", "-", "^"];

// Dot colour classes: blue, green, red, pale; the last entry is the wake.
const DOT_RGB: [number, number, number][] = [
  [48, 52, 235],
  [52, 205, 60],
  [228, 50, 44],
  [190, 212, 255],
  [170, 200, 255],
];
const DOT_BASE_ALPHA = [1, 1, 1, 1, 1];
const WAKE = DOT_RGB.length - 1;

export type Theme = "dark" | "light";

/** Sky-side colours per theme. Raptors paint their own cells, so they stay as they are. */
const PALETTES: Record<Theme, { sky: string; grid: string; wake: [number, number, number]; bird: string; featherHot: string; featherCool: string }> = {
  dark: {
    sky: "#000",
    grid: "rgba(255,255,255,0.055)",
    wake: [170, 200, 255],
    bird: "230,238,255",
    featherHot: "255,236,205",
    featherCool: "200,180,160",
  },
  light: {
    sky: "#e9e6de",
    grid: "rgba(0,0,0,0.07)",
    wake: [52, 96, 210],
    bird: "18,22,34",
    featherHot: "120,72,30",
    featherCool: "150,110,80",
  },
};

const ACCENTS = ["#e0892c", "#e03a32", "#b44ae0", "#33c8cc", "#3cb54a", "#3150e8", "#d9c14a"];

// Sparse glyphs on bright plumage, dense glyphs in shadow, so the texture
// reinforces the shading instead of fighting it.
const SKIN_RAMP = ":;t%SX8#@";
const EDGE_HEAVY = ":;";
const EDGE_LIGHT = ".',`";
const MARK_GLYPHS = "#%@";
const PALE_GLYPHS = ":;'";
/** Flight-feather strokes for a heading of 0, 45, 90 and 135 degrees (y points down). */
const FEATHER_GLYPHS = ["-", "\\", "|", "/"];

const FLAG_BODY = 1;
const FLAG_EDGE = 2;
/** Wing coverts: the soft inner part of the wing. */
const FLAG_WING = 3;
/** Flight feathers: the outer and trailing part, drawn as strokes. */
const FLAG_FEATHER = 4;
const FLAG_EYE = 5;
const FLAG_MARK = 6;
const FLAG_PALE = 7;
const FLAG_RUFOUS = 8;
const FLAG_BEAK = 9;

const MARK_NONE = 0;
const MARK_DARK = 1;
const MARK_PALE = 2;
const MARK_RUFOUS = 3;

const RUFOUS_TINT: [number, number, number] = [1.3, 0.72, 0.42];
const PALE_TINT: [number, number, number] = [1, 0.98, 0.94];
const BEAK_TINT: [number, number, number] = [1.35, 1.12, 0.45];

// Sub-cell sample offsets for anti-aliased silhouettes.
const SUBSAMPLES = [0.25, 0.3, 0.75, 0.3, 0.25, 0.72, 0.75, 0.72];

/**
 * A raptor's outline seen from below. Lengths along the body are fractions of
 * beak-to-tail length (0 beak → 1 tail tip); wing positions are given against
 * p, the fraction of the way from the body out to the wingtip.
 */
interface RaptorShape {
  /** Head length, head half-width, and how pointed it is (low = blunt, owl-like). */
  head: [number, number, number];
  /** Half-width of the body at the shoulders. */
  bodyW: number;
  /** Where the tail starts, its half-width there and at the tip. */
  tail: [number, number, number];
  /** How deep the fork in the tail is (kites); 0 for a fan. */
  fork: number;
  wing: {
    /** Leading edge at the root. */
    lead: number;
    chord: number;
    tipChord: number;
    /** How far back the leading edge sweeps by the tip. */
    sweep: number;
    /** Forward bulge at the wrist, for the angled gull-wing of kites and ospreys. */
    crank: number;
    /** 0 pointed tip → 1 round tip. */
    round: number;
    /** Splayed primaries ("fingers") at the tip; 0 for a clean tip. */
    fingers: number;
  };
  eye: [number, number];
  /** Plumage colour multipliers (r, g, b) and overall brightness. */
  tint: [number, number, number];
  tone: number;
}

const SHAPES: Record<RaptorKind, RaptorShape> = {
  // Red-tailed hawk: broad rounded wings with fingered tips, a short fanned
  // tail, a dark bar along the leading edge and a rufous tail.
  hawk: {
    head: [0.12, 0.05, 0.8],
    bodyW: 0.085,
    tail: [0.62, 0.04, 0.095],
    fork: 0,
    wing: { lead: 0.18, chord: 0.4, tipChord: 0.28, sweep: 0.06, crank: 0.02, round: 0.45, fingers: 5 },
    eye: [0.05, 0.08],
    tint: [1.05, 0.95, 0.82],
    tone: 1,
  },
  // Peregrine: long pointed swept wings, a narrow tail, a dark hood and
  // finely barred slate underparts.
  falcon: {
    head: [0.1, 0.055, 0.7],
    bodyW: 0.08,
    tail: [0.6, 0.035, 0.055],
    fork: 0,
    wing: { lead: 0.2, chord: 0.34, tipChord: 0.05, sweep: 0.42, crank: 0.04, round: 0, fingers: 0 },
    eye: [0.05, 0.08],
    tint: [0.9, 0.95, 1.06],
    tone: 0.95,
  },
  // Bald eagle: long plank wings with deep fingers, a heavy head; dark brown
  // with a white head and tail.
  eagle: {
    head: [0.16, 0.055, 0.75],
    bodyW: 0.09,
    tail: [0.66, 0.045, 0.08],
    fork: 0,
    wing: { lead: 0.18, chord: 0.42, tipChord: 0.34, sweep: 0.03, crank: 0, round: 0.35, fingers: 7 },
    eye: [0.07, 0.1],
    tint: [0.98, 0.84, 0.68],
    tone: 0.72,
  },
  // Red kite: long angled wings with pale windows near the dark tips, and a
  // deeply forked rufous tail.
  kite: {
    head: [0.1, 0.045, 0.8],
    bodyW: 0.07,
    tail: [0.58, 0.04, 0.11],
    fork: 0.22,
    wing: { lead: 0.2, chord: 0.34, tipChord: 0.18, sweep: 0.16, crank: 0.08, round: 0.3, fingers: 5 },
    eye: [0.04, 0.07],
    tint: [1.12, 0.88, 0.7],
    tone: 0.95,
  },
  // Osprey: long gull-winged silhouette, white underneath with dark wrist
  // patches, dark tips, and a barred trailing edge.
  osprey: {
    head: [0.1, 0.05, 0.8],
    bodyW: 0.075,
    tail: [0.62, 0.04, 0.065],
    fork: 0,
    wing: { lead: 0.2, chord: 0.32, tipChord: 0.18, sweep: 0.16, crank: 0.12, round: 0.35, fingers: 4 },
    eye: [0.05, 0.08],
    tint: [0.96, 0.97, 1.02],
    tone: 1.05,
  },
  // Barn owl: a big round head with a pale heart-shaped face, broad rounded
  // wings, a stubby tail, and ghostly pale plumage.
  owl: {
    head: [0.22, 0.1, 0.3],
    bodyW: 0.1,
    tail: [0.72, 0.05, 0.07],
    fork: 0,
    wing: { lead: 0.16, chord: 0.46, tipChord: 0.38, sweep: 0.04, crank: 0, round: 0.7, fingers: 0 },
    eye: [0.08, 0.12],
    tint: [1.12, 1.03, 0.88],
    tone: 1.15,
  },
};

const KINDS = Object.keys(SHAPES) as RaptorKind[];

/** Body half-width at s ∈ [0, 1] (beak → tail tip), as a fraction of length. */
function bodyHalfWidth(shape: RaptorShape, s: number, tailFan: number) {
  const [head, headW, point] = shape.head;
  const [tailStart, tailRoot, tailTip] = shape.tail;
  if (s < head) return headW * Math.pow(Math.sin(((s / head) * Math.PI) / 2), point);
  if (s < SHOULDER) return headW + (shape.bodyW - headW) * smoothstep(head, SHOULDER, s);
  if (s < tailStart) return shape.bodyW + (tailRoot - shape.bodyW) * smoothstep(SHOULDER, tailStart, s);
  return tailRoot + (tailTip * tailFan - tailRoot) * ((s - tailStart) / (1 - tailStart));
}

/** Visible dark-grey cell grid, snapped to device pixels. Shared with the sidebar backdrop. */
export function paintGrid(
  g: CanvasRenderingContext2D,
  W: number,
  H: number,
  cw: number,
  ch: number,
  dpr: number,
  color = PALETTES.dark.grid,
) {
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.strokeStyle = color;
  g.lineWidth = 1;
  g.beginPath();
  for (let c = 0; c <= Math.ceil(W / cw); c++) {
    const x = Math.round(c * cw * dpr) + 0.5;
    g.moveTo(x, 0);
    g.lineTo(x, H * dpr);
  }
  for (let r = 0; r <= Math.ceil(H / ch); r++) {
    const y = Math.round(r * ch * dpr) + 0.5;
    g.moveTo(0, y);
    g.lineTo(W * dpr, y);
  }
  g.stroke();
}

export class AsciiRenderer {
  private ctx: CanvasRenderingContext2D;
  private bg: HTMLCanvasElement;
  private dpr = 1;
  private width = 0;
  private height = 0;
  private cw = 12;
  private ch = 18;
  private cols = 0;
  private rows = 0;
  private fontFamily = "ui-monospace, Menlo, monospace";

  private dotKind = new Uint8Array(0); // 0 none, 1 blue, 2 green, 3 red, 4 pale
  private dotPhase = new Float32Array(0);
  private dotFreq = new Float32Array(0);
  private energy = new Float32Array(0);
  private energyTmp = new Float32Array(0);
  private heat = new Float32Array(0);
  private bucketOf = new Uint8Array(0);
  private bucketOrder = new Int32Array(0);
  private bucketCounts = new Int32Array(DOT_RGB.length * ALPHA_LEVELS + 1);
  private dotStyles: string[] = [];

  private raptorFlag = new Uint8Array(0);
  private raptorShade = new Float32Array(0);
  private raptorKey = new Uint32Array(0);
  private raptorDepth = new Float32Array(0);
  private raptorKind = new Uint8Array(0);
  /** Feather stroke per cell (index into FEATHER_GLYPHS), from the raptor's heading. */
  private raptorStroke = new Uint8Array(0);

  // Per-raptor state for sampleRaptor(), set once per raptor per frame.
  private shape = SHAPES.hawk;
  private kind: RaptorKind = "hawk";
  private raptorId = 0;
  private ox = 0;
  private oy = 0;
  private cos = 1;
  private sin = 0;
  private len = 1;
  private halfSpanLeft = 0;
  private halfSpanRight = 0;
  private sweep = 0;
  private tailFan = 1;
  /** Raised wings catch less light. */
  private wingShadow = 0;
  // Scratch outputs of sampleRaptor(), to avoid allocating per sample.
  private hitFlag = 0;
  private hitShade = 0;
  private hitS = 0;
  private hitV = 0;

  /** Cells holding a bird this frame (frame stamp); dots skip them. */
  private birdStamp = new Uint32Array(0);
  private birdGlyph = new Uint8Array(0);
  private frameId = 0;
  /** Bird cells bucketed by brightness, so each bucket is one fillStyle. */
  private birdBuckets: number[][] = BIRD_ALPHAS.map(() => []);
  private birdStyles: string[] = [];
  private theme: Theme = "dark";
  private palette = PALETTES.dark;

  constructor(private canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("2D canvas unavailable");
    this.ctx = ctx;
    this.bg = document.createElement("canvas");
    this.buildStyles();
  }

  /** Switch palettes; takes effect on the next render. */
  setTheme(theme: Theme) {
    if (theme === this.theme || !PALETTES[theme]) return;
    this.theme = theme;
    this.palette = PALETTES[theme];
    this.buildStyles();
    if (this.cols > 0) this.paintBackground();
  }

  private buildStyles() {
    this.dotStyles = [];
    for (let c = 0; c < DOT_RGB.length; c++) {
      const [r, g, b] = c === WAKE ? this.palette.wake : DOT_RGB[c];
      for (let l = 0; l < ALPHA_LEVELS; l++) {
        const a = (DOT_BASE_ALPHA[c] * (l + 1)) / ALPHA_LEVELS;
        this.dotStyles.push(`rgba(${r},${g},${b},${a.toFixed(3)})`);
      }
    }
    this.birdStyles = BIRD_ALPHAS.map((a) => `rgba(${this.palette.bird},${a})`);
  }

  get cellWidth() {
    return this.cw;
  }

  get cellHeight() {
    return this.ch;
  }

  setFontFamily(family: string) {
    if (family) this.fontFamily = family;
  }

  resize(width: number, height: number, dpr: number) {
    this.width = width;
    this.height = height;
    this.dpr = dpr;
    this.cw = clamp(Math.round(width / 124), 8, 13);
    this.ch = Math.round(this.cw * 1.45);
    this.cols = Math.ceil(width / this.cw);
    this.rows = Math.ceil(height / this.ch);

    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    this.bg.width = this.canvas.width;
    this.bg.height = this.canvas.height;

    const n = this.cols * this.rows;
    this.dotKind = new Uint8Array(n);
    this.dotPhase = new Float32Array(n);
    this.dotFreq = new Float32Array(n);
    this.energy = new Float32Array(n);
    this.energyTmp = new Float32Array(n);
    this.heat = new Float32Array(n);
    this.bucketOf = new Uint8Array(n);
    this.bucketOrder = new Int32Array(n);
    this.raptorFlag = new Uint8Array(n);
    this.raptorShade = new Float32Array(n);
    this.raptorKey = new Uint32Array(n);
    this.raptorDepth = new Float32Array(n);
    this.raptorKind = new Uint8Array(n);
    this.raptorStroke = new Uint8Array(n);
    this.birdStamp = new Uint32Array(n);
    this.birdGlyph = new Uint8Array(n);

    for (let i = 0; i < n; i++) {
      const col = i % this.cols;
      const row = (i / this.cols) | 0;
      // No ambient dots: the grid stays black. Only the wake lights cells.
      this.dotKind[i] = 0;
      this.dotPhase[i] = hash3(col, row, 23) * Math.PI * 2;
      this.dotFreq[i] = 0.3 + hash3(col, row, 37) * 1.1;
    }
    this.paintBackground();
  }

  private paintBackground() {
    const g = this.bg.getContext("2d");
    if (!g) return;
    const { width: W, height: H, dpr, cw, ch } = this;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = this.palette.sky;
    g.fillRect(0, 0, W, H);
    paintGrid(g, W, H, cw, ch, dpr, this.palette.grid);
  }

  render(world: World, dt: number) {
    const { ctx, dpr, cols, ch } = this;
    if (cols === 0) return;
    const t = world.time;

    this.consumeEvents(world);
    this.rasterizeRaptors(world.raptors, t);
    this.depositWake(world);
    this.diffuse(dt);

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(this.bg, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    this.markBirds(world);
    this.drawDots(t);

    ctx.font = `600 ${Math.round(ch * 0.74)}px ${this.fontFamily}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    this.drawFeathers();
    this.drawBirds();
    this.drawRaptors(t);
  }

  // ── simulation → field ──────────────────────────────────────────────

  private cellIndex(x: number, y: number) {
    const c = Math.floor(x / this.cw);
    const r = Math.floor(y / this.ch);
    if (c < 0 || r < 0 || c >= this.cols || r >= this.rows) return -1;
    return r * this.cols + c;
  }

  private stamp(field: Float32Array, x: number, y: number, radius: number, amount: number) {
    const c0 = Math.floor(x / this.cw);
    const r0 = Math.floor(y / this.ch);
    for (let r = r0 - radius; r <= r0 + radius; r++) {
      for (let c = c0 - radius; c <= c0 + radius; c++) {
        if (c < 0 || r < 0 || c >= this.cols || r >= this.rows) continue;
        const d = Math.hypot(c - c0, (r - r0) * 1.4);
        if (d > radius + 0.5) continue;
        const i = r * this.cols + c;
        field[i] = Math.min(1.6, field[i] + amount * (1 - d / (radius + 1)));
      }
    }
  }

  private consumeEvents(world: World) {
    for (const e of world.events) {
      if (e.kind === "catch") {
        this.stamp(this.heat, e.x, e.y, 2, 1);
        this.stamp(this.energy, e.x, e.y, 3, 0.9);
      } else {
        this.stamp(this.energy, e.x, e.y, 6, 1.4);
      }
    }
    world.events.length = 0;
  }

  private depositWake(world: World) {
    const { energy } = this;
    for (const b of world.birds) {
      if (!b.alive) continue;
      const i = this.cellIndex(b.x, b.y);
      if (i >= 0) energy[i] = Math.min(1.6, energy[i] + 0.012 + b.alarm * 0.03);
    }
    for (const rp of world.raptors) {
      // Wingtip vortices: each tip trails a stream of disturbed air, more so on the downstroke.
      const half = rp.span * 0.5 * wingReach(rp) * 0.94;
      const back = rp.length * 0.12;
      const hx = Math.cos(rp.heading);
      const hy = Math.sin(rp.heading);
      const amount = 0.07 + rp.speed * 0.0012 + rp.flap * 0.05;
      for (const side of [-1, 1]) {
        const i = this.cellIndex(rp.x - hy * half * side - hx * back, rp.y + hx * half * side - hy * back);
        if (i >= 0) energy[i] = Math.min(1.6, energy[i] + amount);
      }
    }
    if (world.pointer.active) {
      this.stamp(energy, world.pointer.x, world.pointer.y, 1, 0.08);
    }
  }

  /** Blur + decay so wakes spread out like ripples and fade. */
  private diffuse(dt: number) {
    const { cols, rows, energy, energyTmp: tmp, heat } = this;
    const decay = Math.exp(-dt * 1.5);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        const l = c > 0 ? energy[i - 1] : energy[i];
        const rt = c < cols - 1 ? energy[i + 1] : energy[i];
        const u = r > 0 ? energy[i - cols] : energy[i];
        const d = r < rows - 1 ? energy[i + cols] : energy[i];
        tmp[i] = (energy[i] * 4 + l + rt + u + d) * 0.125 * decay;
      }
    }
    this.energy = tmp;
    this.energyTmp = energy;
    const heatDecay = Math.exp(-dt * 2.2);
    for (let i = 0; i < heat.length; i++) heat[i] *= heatDecay;
  }

  // ── raptors ─────────────────────────────────────────────────────────

  /**
   * Classify one screen point against the current raptor (frame already set).
   * Body coordinates: s along the body (0 beak → 1 tail tip), v across it.
   * Writes hit* fields and returns whether the point is on the raptor.
   */
  private sampleRaptor(px: number, py: number) {
    const L = this.len;
    const dx = px - this.ox;
    const dy = py - this.oy;
    const s = SHOULDER - (dx * this.cos + dy * this.sin) / L;
    const v = -dx * this.sin + dy * this.cos;
    const av = Math.abs(v);
    const shape = this.shape;
    this.hitS = s;
    this.hitV = v;
    if (s < 0 || s > 1) return false;

    // Body, head and tail.
    const w = bodyHalfWidth(shape, s, this.tailFan) * L;
    let inBody = av <= w;
    if (inBody && s > shape.tail[0]) {
      const k = av / (w || 1);
      // A forked tail has a notch cut out of the middle; a fan tail ends in a gentle curve.
      const end = shape.fork > 0 ? 1 - shape.fork * Math.max(0, 1 - k * 1.15) : 1 - 0.035 * k * k;
      inBody = s <= end;
    }
    if (inBody) {
      const across = av / (w || 1);
      // Rounded underside lit from the top-left; the flanks fall off into shadow.
      const facing = (v > 0 ? 1 : -1) * (this.sin * 0.6 - this.cos * 0.8) * across;
      let shade = 0.6 - across * across * 0.38 + facing * 0.2;
      let flag = FLAG_BODY;
      if (s < 0.035) {
        flag = FLAG_BEAK;
        shade = 0.8;
      } else if (s > shape.eye[0] && s < shape.eye[1] && across > 0.42 && across < 0.85) {
        flag = FLAG_EYE;
        shade = 0;
      } else {
        const mark = this.marking(s, v / L, across, -1, 0);
        if (mark) flag = mark === MARK_DARK ? FLAG_MARK : mark === MARK_PALE ? FLAG_PALE : FLAG_RUFOUS;
      }
      this.hitFlag = flag;
      this.hitShade = shade;
      return true;
    }

    // Wings.
    const half = v > 0 ? this.halfSpanRight : this.halfSpanLeft;
    const p = av / (half || 1);
    if (p > 1) return false;
    const wing = shape.wing;
    const lead = wing.lead + this.sweep * Math.pow(p, 1.6) - wing.crank * Math.sin(Math.PI * Math.min(1, p / 0.9));
    let chord = wing.chord + (wing.tipChord - wing.chord) * p;
    const roundZone = 0.12 + wing.round * 0.3;
    if (p > 1 - roundZone) {
      const k = (p - (1 - roundZone)) / roundZone;
      // Round tips close on a quarter circle, pointed ones on a straight taper.
      chord *= wing.round * Math.sqrt(Math.max(0, 1 - k * k)) + (1 - wing.round) * (1 - k);
    }
    const c = (s - lead) / (chord || 1e-3);
    if (c < 0 || c > 1) return false;
    if (wing.fingers > 0 && p > 0.78) {
      // Splayed primaries: slots between the fingers widen toward the tip.
      const slot = (c * wing.fingers) % 1;
      if (slot > 1 - 0.5 * ((p - 0.78) / 0.22)) return false;
    }

    // Leading edge and the inner wing catch the light; raised wings dim.
    const shade = clamp(0.58 + 0.16 * (1 - c) - 0.14 * p - this.wingShadow, 0.05, 1);
    const mark = this.marking(s, v / L, 0, p, c);
    let flag = c < 0.45 && p < 0.8 ? FLAG_WING : FLAG_FEATHER;
    if (mark) flag = mark === MARK_DARK ? FLAG_MARK : mark === MARK_PALE ? FLAG_PALE : FLAG_RUFOUS;
    this.hitFlag = flag;
    this.hitShade = shade;
    return true;
  }

  /**
   * Plumage pattern at a point. On the body p is -1 and `across` is set; on
   * a wing p is the span fraction and c the position along the chord.
   */
  private marking(s: number, v: number, across: number, p: number, c: number) {
    const onWing = p >= 0;
    const speck = hash3(Math.round(s * 60), Math.round(v * 40), this.raptorId);
    switch (this.kind) {
      case "hawk":
        if (onWing) {
          if (p > 0.9) return MARK_DARK; // dark fingertips
          if (c < 0.14 && p > 0.1 && p < 0.5) return MARK_DARK; // patagial bar
          if (c > 0.88 && p > 0.3) return MARK_DARK; // dusky trailing edge
          return p < 0.6 && c < 0.5 ? MARK_PALE : MARK_NONE;
        }
        if (s > this.shape.tail[0] + 0.03) return MARK_RUFOUS;
        if (s > 0.36 && s < 0.5 && speck < 0.45) return MARK_DARK; // belly band
        return s > 0.15 && s < 0.36 ? MARK_PALE : MARK_NONE;
      case "falcon":
        if (onWing) return Math.sin(s * 140 + p * 6) > 0.55 ? MARK_DARK : MARK_NONE;
        if (s < 0.13 && across > 0.25) return MARK_DARK; // hood and moustache
        if (s < 0.22) return MARK_PALE; // pale throat
        return Math.sin(s * 120) > 0.5 && speck < 0.7 ? MARK_DARK : MARK_NONE;
      case "eagle":
        if (onWing) return MARK_NONE;
        return s < this.shape.head[0] + 0.03 || s > this.shape.tail[0] + 0.02 ? MARK_PALE : MARK_NONE;
      case "kite":
        if (onWing) {
          if (p > 0.86) return MARK_DARK;
          if (p > 0.6 && c < 0.7) return MARK_PALE; // the pale windows
          return c < 0.4 ? MARK_RUFOUS : MARK_NONE;
        }
        if (s < 0.12) return MARK_PALE; // pale head
        return speck < 0.25 ? MARK_DARK : MARK_RUFOUS;
      case "osprey":
        if (onWing) {
          if (p > 0.82) return MARK_DARK;
          if (p > 0.4 && p < 0.58 && c < 0.4) return MARK_DARK; // wrist patch
          if (c > 0.6 && Math.sin(p * 40) > 0.3) return MARK_DARK; // barred trailing edge
          return c < 0.55 ? MARK_PALE : MARK_NONE;
        }
        if (s < 0.1 && across > 0.5) return MARK_DARK; // eye stripe
        return s > this.shape.tail[0] && Math.sin(s * 90) > 0.4 ? MARK_DARK : MARK_PALE;
      case "owl":
        if (onWing) return c < 0.7 && speck < 0.06 ? MARK_DARK : MARK_PALE;
        if (s < this.shape.head[0]) return across < 0.92 ? MARK_PALE : MARK_RUFOUS; // heart-shaped face
        return speck < 0.08 ? MARK_DARK : MARK_PALE;
    }
  }

  /**
   * Set up each raptor's frame and wing pose, then supersample every cell in
   * its bounding box against the shape. Fully covered cells become solid
   * plumage; partial cells become edge glyphs.
   */
  private rasterizeRaptors(raptors: Raptor[], t: number) {
    const { raptorFlag, raptorShade, raptorKey, raptorDepth, raptorKind, raptorStroke, cw, ch, cols, rows } = this;
    raptorFlag.fill(0);

    for (const rp of raptors) {
      const L = rp.length;
      this.shape = SHAPES[rp.kind];
      this.kind = rp.kind;
      this.raptorId = rp.id;
      this.ox = rp.x;
      this.oy = rp.y;
      this.cos = Math.cos(rp.heading);
      this.sin = Math.sin(rp.heading);
      this.len = L;
      const kindIndex = KINDS.indexOf(rp.kind);

      // Bank into turns: the inside wing foreshortens, the outside one spreads.
      const bank = clamp(rp.turn * 0.35, -0.3, 0.3);
      const reach = wingReach(rp);
      const half = (rp.span * 0.5 - this.shape.bodyW * L) * reach + this.shape.bodyW * L;
      this.halfSpanRight = half * (1 - bank);
      this.halfSpanLeft = half * (1 + bank);
      // Folding sweeps the hands back along the body, and so does each upstroke.
      const upstroke = rp.flap * (0.5 + 0.5 * Math.sin(rp.phase));
      this.sweep = this.shape.wing.sweep + 0.3 * rp.tuck + 0.12 * upstroke;
      // Tails fan out to steer, and close up into a stoop.
      this.tailFan = (1 + 0.8 * Math.abs(bank)) * (1 - 0.4 * rp.tuck);
      this.wingShadow = 0.3 * rp.flap * Math.sin(rp.phase);

      // Feather strokes run along the body axis.
      const angle = ((rp.heading % Math.PI) + Math.PI) % Math.PI;
      const stroke = Math.round(angle / (Math.PI / 4)) % 4;

      const extent = Math.max(Math.max(this.halfSpanLeft, this.halfSpanRight), L) + Math.hypot(cw, ch);
      const c0 = Math.max(0, Math.floor((rp.x - extent) / cw));
      const c1 = Math.min(cols - 1, Math.floor((rp.x + extent) / cw));
      const r0 = Math.max(0, Math.floor((rp.y - extent) / ch));
      const r1 = Math.min(rows - 1, Math.floor((rp.y + extent) / ch));
      if (c0 > c1 || r0 > r1) continue;

      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
          const x = c * cw;
          const y = r * ch;
          const centerHit = this.sampleRaptor(x + cw / 2, y + ch / 2);
          const flag = this.hitFlag;
          const shade = this.hitShade;
          const s = this.hitS;
          const v = this.hitV;

          let hits = centerHit ? 1 : 0;
          for (let k = 0; k < SUBSAMPLES.length; k += 2) {
            if (this.sampleRaptor(x + SUBSAMPLES[k] * cw, y + SUBSAMPLES[k + 1] * ch)) hits++;
          }
          if (hits === 0) continue;
          const coverage = hits / 5;

          const i = r * cols + c;
          // Body-anchored key so each glyph rides along with the plumage.
          const key = (hash3(Math.round(s * 52), Math.round(v / (cw * 0.9)), rp.id) * 4294967295) >>> 0;
          raptorKey[i] = key;
          raptorDepth[i] = rp.depth;
          raptorKind[i] = kindIndex;
          raptorStroke[i] = stroke;

          if (centerHit && coverage >= 0.6) {
            raptorFlag[i] = flag;
            const flicker = (hash3(c, r, Math.floor(t * 6)) - 0.5) * 0.06;
            raptorShade[i] = clamp(shade + flicker, 0, 1);
          } else {
            raptorFlag[i] = FLAG_EDGE;
            raptorShade[i] = coverage;
          }
        }
      }
    }
  }

  private drawRaptors(t: number) {
    const { ctx, cols, rows, cw, ch, raptorFlag, raptorShade, raptorKey, raptorDepth, raptorKind, raptorStroke } = this;
    const n = cols * rows;
    for (let i = 0; i < n; i++) {
      const flag = raptorFlag[i];
      if (!flag) continue;
      const col = i % cols;
      const row = (i / cols) | 0;
      const x = col * cw;
      const y = row * ch;
      const key = raptorKey[i];
      const shade = raptorShade[i];
      const shape = SHAPES[KINDS[raptorKind[i]]];
      const dim = (0.7 + 0.3 * raptorDepth[i]) * shape.tone;
      let [tr, tg, tb] = shape.tint;

      // Colours re-roll on a staggered clock so the plumage shimmers.
      const tick = Math.floor(t * 2.4 + (key % 997) / 97);
      const roll = hash3(key, tick, 7);

      if (flag === FLAG_EDGE) {
        // Soft, anti-aliased silhouette: no block, just a light glyph.
        const set = shade >= 0.5 ? EDGE_HEAVY : EDGE_LIGHT;
        const g = (70 + shade * 80) * dim;
        ctx.fillStyle =
          roll < 0.07
            ? ACCENTS[key % ACCENTS.length]
            : `rgb(${Math.round(g * tr)},${Math.round(g * tg)},${Math.min(255, Math.round(g * tb + 6))})`;
        ctx.fillText(set[(key >>> 8) % set.length], x + cw / 2, y + ch / 2 + 1);
        continue;
      }

      let level: number;
      let glyph: string;
      if (flag === FLAG_EYE) {
        level = 12;
        glyph = "o";
      } else if (flag === FLAG_BEAK) {
        level = 150;
        glyph = "'";
        [tr, tg, tb] = BEAK_TINT;
      } else if (flag === FLAG_MARK) {
        level = 24 + shade * 22;
        glyph = MARK_GLYPHS[(key >>> 8) % MARK_GLYPHS.length];
      } else if (flag === FLAG_PALE) {
        level = (175 + shade * 70) / Math.max(shape.tone, 0.8);
        glyph = PALE_GLYPHS[(key >>> 8) % PALE_GLYPHS.length];
        [tr, tg, tb] = PALE_TINT;
      } else if (flag === FLAG_FEATHER) {
        level = 40 + shade * 120;
        glyph = FEATHER_GLYPHS[raptorStroke[i]];
      } else {
        level = 46 + shade * 160;
        const jitter = ((key >>> 4) % 3) - 1;
        glyph = SKIN_RAMP[clamp(Math.floor((1 - shade) * 8.99) + jitter, 0, SKIN_RAMP.length - 1)];
        if (flag === FLAG_RUFOUS) [tr, tg, tb] = RUFOUS_TINT;
      }
      level *= dim;
      ctx.fillStyle = `rgb(${Math.min(255, Math.round(level * tr))},${Math.min(255, Math.round(level * tg))},${Math.min(255, Math.round(level * tb + 4))})`;
      ctx.fillRect(x + 1, y + 1, cw - 1, ch - 1);

      let color: string;
      if (flag === FLAG_EYE) color = "#d9b84a";
      else if (flag === FLAG_MARK) color = `rgb(${Math.round(70 * tr)},${Math.round(70 * tg)},${Math.round(70 * tb)})`;
      else if (roll < 0.09) color = ACCENTS[key % ACCENTS.length];
      else if (roll < 0.13) color = "#ffffff";
      else color = level > 110 ? "#0e0f13" : "#1b1d24";
      ctx.fillStyle = color;
      ctx.fillText(glyph, x + cw / 2, y + ch / 2 + 1);
    }
  }

  // ── birds, dots, feathers ───────────────────────────────────────────

  /**
   * Snap each bird to a cell and bucket it by brightness: far birds are dim,
   * near birds brighter, and turning or panicking birds glint. Nearer birds
   * claim a cell first when two land in the same one. The glyph follows the
   * wingbeat (v - ^), and gliders hold "-" between bursts.
   */
  private markBirds(world: World) {
    const { birdStamp, birdGlyph, birdBuckets, raptorFlag } = this;
    const frame = ++this.frameId;
    for (const bucket of birdBuckets) bucket.length = 0;
    for (let pass = 0; pass < 2; pass++) {
      for (const b of world.birds) {
        if (!b.alive || (b.depth > 0.78 ? 0 : 1) !== pass) continue;
        const i = this.cellIndex(b.x, b.y);
        if (i < 0 || birdStamp[i] === frame || raptorFlag[i]) continue;
        birdStamp[i] = frame;
        const duty = Math.max(SPECIES[b.species].flapDuty, b.alarm);
        const flapping = (b.phase * 0.08) % 1 < duty;
        const beat = Math.sin(b.phase);
        birdGlyph[i] = !flapping ? 1 : beat > 0.35 ? 0 : beat < -0.35 ? 2 : 1;
        const glint = clamp(Math.abs(b.turn) / 3.5, 0, 1);
        const v = 0.3 + (0.4 * (b.depth - 0.55)) / 0.45 + 0.3 * Math.max(glint, b.alarm);
        birdBuckets[clamp(Math.floor(v * BIRD_ALPHAS.length), 0, BIRD_ALPHAS.length - 1)].push(i);
      }
    }
  }

  private drawBirds() {
    const { ctx, cw, ch, cols, birdBuckets, birdGlyph } = this;
    for (let b = 0; b < birdBuckets.length; b++) {
      const bucket = birdBuckets[b];
      if (!bucket.length) continue;
      ctx.fillStyle = this.birdStyles[b];
      for (const i of bucket) {
        ctx.fillText(BIRD_GLYPHS[birdGlyph[i]], (i % cols) * cw + cw / 2, ((i / cols) | 0) * ch + ch / 2 + 1);
      }
    }
  }

  /** A puff of loose feathers where a raptor struck. */
  private drawFeathers() {
    const { ctx, heat, cols, cw, ch } = this;
    const { featherHot, featherCool } = this.palette;
    for (let i = 0; i < heat.length; i++) {
      const h = heat[i];
      if (h < 0.08) continue;
      const col = i % cols;
      const row = (i / cols) | 0;
      ctx.fillStyle = h > 0.5 ? `rgba(${featherHot},${h.toFixed(2)})` : `rgba(${featherCool},${(h * 1.6).toFixed(2)})`;
      ctx.fillText(h > 0.6 ? "*" : "'", col * cw + cw / 2, row * ch + ch / 2 + 1);
    }
  }

  /**
   * Every cell's dot twinkles on its own clock, is modulated by slow light
   * bands, and flares pale blue where the wake field is strong.
   * Dots are bucketed by colour/alpha so each bucket is one fillStyle.
   */
  private drawDots(t: number) {
    const { ctx, cols, rows, cw, ch, dotKind, dotPhase, dotFreq, energy, raptorFlag, birdStamp, frameId } = this;
    const { bucketOf, bucketOrder, bucketCounts } = this;
    const n = cols * rows;
    const SKIP = bucketCounts.length - 1;
    bucketCounts.fill(0);

    for (let i = 0; i < n; i++) {
      const e = energy[i];
      const kind = dotKind[i];
      if (raptorFlag[i] || birdStamp[i] === frameId || (kind === 0 && e < 0.45)) {
        bucketOf[i] = SKIP;
        continue;
      }
      let bucket: number;
      if (e > 0.45) {
        const level = clamp(Math.floor((e - 0.45) * 5), 0, ALPHA_LEVELS - 1);
        bucket = WAKE * ALPHA_LEVELS + level;
      } else {
        const col = i % cols;
        const row = (i / cols) | 0;
        // Dots stay bright and crisp; the twinkle is a gentle breathe, not a fade.
        const twinkle = 0.5 + 0.5 * Math.sin(t * dotFreq[i] + dotPhase[i]);
        const bands = 0.85 + 0.15 * Math.sin(col * 0.11 + t * 0.35) * Math.sin(row * 0.17 - t * 0.27);
        const v = clamp((0.55 + 0.45 * twinkle) * bands + e * 2, 0, 1);
        bucket = (kind - 1) * ALPHA_LEVELS + clamp(Math.floor(v * ALPHA_LEVELS), 0, ALPHA_LEVELS - 1);
      }
      bucketOf[i] = bucket;
      bucketCounts[bucket]++;
    }

    // Counting sort cells by bucket.
    const starts = new Int32Array(bucketCounts.length);
    for (let b = 1; b < bucketCounts.length; b++) starts[b] = starts[b - 1] + bucketCounts[b - 1];
    const cursor = starts.slice();
    for (let i = 0; i < n; i++) {
      const b = bucketOf[i];
      if (b !== SKIP) bucketOrder[cursor[b]++] = i;
    }

    const small = Math.max(2, Math.round(cw * 0.19));
    const large = small + 1;
    for (let b = 0; b < SKIP; b++) {
      const count = bucketCounts[b];
      if (!count) continue;
      ctx.fillStyle = this.dotStyles[b];
      const size = b >= WAKE * ALPHA_LEVELS ? large : small;
      const start = starts[b];
      for (let k = start; k < start + count; k++) {
        const i = bucketOrder[k];
        const col = i % cols;
        const row = (i / cols) | 0;
        // Sit the dot low-right in its cell, as in the reference.
        ctx.fillRect(Math.round(col * cw + cw * 0.66 - size / 2), Math.round(row * ch + ch * 0.64 - size / 2), size, size);
      }
    }
  }
}
