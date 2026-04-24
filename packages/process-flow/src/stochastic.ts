import type { TimeValueDefinition } from '@des-platform/shared-schema/model-dsl';

export type RandomSource = () => number;

export class SeededRandom {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let value = this.state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  }
}

export function createSeededRandom(seed = 1): RandomSource {
  const random = new SeededRandom(seed);
  return () => random.next();
}

export function sampleTimeSec(definition: TimeValueDefinition, random: RandomSource, context: string): number {
  const value = typeof definition === 'number' ? definition : sampleDistribution(definition, random);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${context} produced invalid nonnegative time ${value}`);
  }
  return value;
}

function sampleDistribution(definition: Exclude<TimeValueDefinition, number>, random: RandomSource): number {
  switch (definition.kind) {
    case 'constant':
      return definition.value;
    case 'uniform':
      return definition.min + random() * (definition.max - definition.min);
    case 'triangular':
      return sampleTriangular(definition.min, definition.mode, definition.max, random());
    case 'normal':
      return clamp(definition.mean + definition.sd * sampleStandardNormal(random), definition.min, definition.max);
    case 'exponential':
      return -definition.mean * Math.log(1 - random());
    default:
      definition satisfies never;
      return 0;
  }
}

function sampleTriangular(min: number, mode: number, max: number, draw: number): number {
  if (max === min) {
    return min;
  }

  const threshold = (mode - min) / (max - min);
  if (draw < threshold) {
    return min + Math.sqrt(draw * (max - min) * (mode - min));
  }
  return max - Math.sqrt((1 - draw) * (max - min) * (max - mode));
}

function sampleStandardNormal(random: RandomSource): number {
  let first = random();
  while (first <= Number.EPSILON) {
    first = random();
  }

  const second = random();
  return Math.sqrt(-2 * Math.log(first)) * Math.cos(2 * Math.PI * second);
}

function clamp(value: number, min: number, max?: number): number {
  const aboveMin = Math.max(min, value);
  return max === undefined ? aboveMin : Math.min(max, aboveMin);
}
