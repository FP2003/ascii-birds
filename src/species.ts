export interface Species {
  name: string;
  cruise: number;
  maxSpeed: number;
  minSpeed: number;
  /** Relative odds of a new flock being this species. */
  weight: number;
  flockSize: [number, number];
  /** Personal space in grid cells (x, y), so every bird gets its own glyph. */
  spacing: [number, number];
  // Behaviour weights. Different mixes produce different collective shapes
  // (Couzin et al. 2002): strong alignment gives polarised flocks and
  // ribbons, low alignment gives swarms, and a tangential pull gives a swirl.
  align: number;
  cohesion: number;
  jitter: number;
  /** Tangential pull around the local centre: >0 makes a rolling murmuration. */
  mill: number;
  /** Share of the time spent flapping: 1 never stops, lower glides between bursts. */
  flapDuty: number;
}

export const SPECIES: Species[] = [
  {
    name: "starling",
    cruise: 44, maxSpeed: 76, minSpeed: 24, weight: 4,
    flockSize: [22, 36], spacing: [1.6, 1],
    align: 2.6, cohesion: 1.5, jitter: 30, mill: 60, flapDuty: 1,
  },
  {
    name: "swallow",
    cruise: 54, maxSpeed: 92, minSpeed: 30, weight: 2,
    flockSize: [6, 12], spacing: [2.4, 1.4],
    align: 0.6, cohesion: 0.7, jitter: 120, mill: 0, flapDuty: 0.5,
  },
  {
    name: "sparrow",
    cruise: 36, maxSpeed: 64, minSpeed: 18, weight: 3,
    flockSize: [10, 18], spacing: [1.8, 1.1],
    align: 1.4, cohesion: 1.6, jitter: 60, mill: 0, flapDuty: 1,
  },
  {
    name: "finch",
    cruise: 40, maxSpeed: 68, minSpeed: 20, weight: 2,
    flockSize: [8, 14], spacing: [2, 1.2],
    align: 2, cohesion: 1, jitter: 45, mill: 0, flapDuty: 0.6,
  },
  {
    name: "pigeon",
    cruise: 48, maxSpeed: 80, minSpeed: 24, weight: 1,
    flockSize: [6, 10], spacing: [2.6, 1.5],
    align: 3, cohesion: 0.9, jitter: 25, mill: 25, flapDuty: 0.8,
  },
];

const TOTAL_WEIGHT = SPECIES.reduce((sum, s) => sum + s.weight, 0);

export function pickSpecies() {
  let r = Math.random() * TOTAL_WEIGHT;
  for (let i = 0; i < SPECIES.length; i++) {
    r -= SPECIES[i].weight;
    if (r <= 0) return i;
  }
  return 0;
}
