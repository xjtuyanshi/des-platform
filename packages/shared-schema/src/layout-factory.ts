import { LayoutDefinitionSchema, type LayoutDefinition } from './schemas.js';

export type LinearAssemblyLayoutOptions = {
  id: string;
  name?: string;
  stationCount: number;
  pitchM?: number;
  startX?: number;
  lineZ?: number;
  stationZ?: number;
  aisleZ?: number;
  dropZ?: number;
  binZ?: number;
  supermarketX?: number;
  supermarketZ?: number;
  emptyReturnZ?: number;
  amrHomeCount?: number;
};

const DEFAULT_PITCH_M = 5.1;

export function createLinearAssemblyLayout(options: LinearAssemblyLayoutOptions): LayoutDefinition {
  const stationCount = options.stationCount;
  if (!Number.isInteger(stationCount) || stationCount <= 0) {
    throw new Error(`stationCount must be a positive integer, received ${stationCount}`);
  }

  const pitchM = options.pitchM ?? DEFAULT_PITCH_M;
  const startX = options.startX ?? 18;
  const lineZ = options.lineZ ?? 0;
  const stationZ = options.stationZ ?? lineZ;
  const aisleZ = options.aisleZ ?? 11.3;
  const dropZ = options.dropZ ?? 7.8;
  const binZ = options.binZ ?? 5.2;
  const supermarketX = options.supermarketX ?? 9;
  const supermarketZ = options.supermarketZ ?? 11;
  const emptyReturnZ = options.emptyReturnZ ?? 16.5;
  const amrHomeCount = options.amrHomeCount ?? 3;
  const lineEndX = startX + stationCount * pitchM;
  const lineMidX = (startX + lineEndX) / 2;
  const floorWidth = Math.max(42, lineEndX + 23);

  const stations: LayoutDefinition['stations'] = Array.from({ length: stationCount }, (_, index) => {
    const stationIndex = index + 1;
    const stationId = `S${stationIndex}`;
    const lineX = startX + pitchM * (index + 0.5);

    return {
      id: stationId,
      index: stationIndex,
      lineX,
      stationZ,
      dropNodeId: `drop-s${stationIndex}`,
      binSlots: [
        { id: `${stationId}-A`, x: lineX - 0.95, z: binZ },
        { id: `${stationId}-B`, x: lineX + 0.95, z: binZ }
      ]
    };
  });

  const amrHomes: LayoutDefinition['facilities']['amrHomes'] = Array.from(
    { length: amrHomeCount },
    (_, index) => ({
      id: `home-${index + 1}`,
      x: supermarketX + 2 + index * 2,
      z: supermarketZ + 0.3
    })
  );

  const aisleNodes: LayoutDefinition['aisleGraph']['nodes'] = [
    { id: 'entry', x: startX, z: aisleZ },
    { id: 'supermarket', x: supermarketX, z: supermarketZ },
    { id: 'empty-return', x: supermarketX, z: emptyReturnZ },
    ...amrHomes,
    ...stations.map((station) => ({ id: `aisle-s${station.index}`, x: station.lineX, z: aisleZ })),
    ...stations.map((station) => ({ id: `drop-s${station.index}`, x: station.lineX, z: dropZ }))
  ];

  const aisleEdges: LayoutDefinition['aisleGraph']['edges'] = [
    ...amrHomes.map((home) => ['supermarket', home.id] as [string, string]),
    ['supermarket', 'empty-return'],
    ...amrHomes.map((home) => [home.id, 'entry'] as [string, string]),
    ['entry', 'aisle-s1'],
    ...Array.from({ length: stationCount - 1 }, (_, index) => [
      `aisle-s${index + 1}`,
      `aisle-s${index + 2}`
    ] as [string, string]),
    ...stations.map((station) => [`aisle-s${station.index}`, station.dropNodeId] as [string, string]),
    ['entry', 'empty-return']
  ];

  const layout: LayoutDefinition = {
    id: options.id,
    name: options.name ?? `Linear Assembly Layout - ${stationCount} Stations`,
    units: 'meter',
    floor: {
      width: floorWidth,
      depth: 30,
      height: 0.2
    },
    line: {
      start: { x: startX, z: lineZ },
      end: { x: lineEndX, z: lineZ },
      width: 2.6,
      elevation: 0.55,
      pitchM,
      skidLengthM: 5,
      skidGapM: 0.1,
      carLengthM: 4.6,
      carWidthM: 1.9,
      carHeightM: 1.6,
      speedMps: pitchM / 40
    },
    stations,
    facilities: {
      supermarket: { id: 'supermarket', x: supermarketX, z: supermarketZ, width: 4.5, depth: 3.4 },
      emptyReturn: { id: 'empty-return', x: supermarketX, z: emptyReturnZ, width: 4.5, depth: 3.4 },
      amrHomes
    },
    aisleGraph: {
      nodes: aisleNodes,
      edges: aisleEdges
    },
    obstacles: [
      {
        id: 'central-safety-island',
        x: lineMidX,
        z: aisleZ + 3.4,
        width: Math.min(12, Math.max(4.2, stationCount * pitchM * 0.12)),
        depth: 2.8,
        height: 1.2
      }
    ],
    walls: [
      { id: 'north-wall', x: lineMidX, z: 18.8, width: Math.max(24, stationCount * pitchM + 6), depth: 0.8, height: 2.4 },
      { id: 'south-wall', x: lineMidX, z: -5.8, width: Math.max(24, stationCount * pitchM + 6), depth: 0.8, height: 2.4 }
    ],
    cameras: [
      {
        id: 'overview',
        label: 'Main Line Overview',
        position: { x: lineMidX, y: Math.max(28, stationCount * 1.2), z: 24 },
        target: { x: lineMidX, y: 0, z: 4 }
      },
      {
        id: 'car-closeup',
        label: 'Car Close-up',
        position: { x: lineMidX, y: 9, z: -5 },
        target: { x: lineMidX, y: 1, z: lineZ }
      },
      {
        id: 'amr-aisle',
        label: 'AMR Aisle',
        position: { x: startX + pitchM, y: 14, z: 23 },
        target: { x: lineMidX, y: 0, z: aisleZ }
      }
    ],
    assets: {
      carBody: { kind: 'primitive', material: 'painted-metal', color: '#4cb0ff' },
      skid: { kind: 'primitive', material: 'steel', color: '#8a94a5' },
      amr: { kind: 'primitive', material: 'powder-coat', color: '#1ed0ff' },
      binFull: { kind: 'primitive', material: 'plastic', color: '#7ddc6f' },
      binEmpty: { kind: 'primitive', material: 'plastic', color: '#c4c9d4' }
    }
  };

  return LayoutDefinitionSchema.parse(layout);
}
