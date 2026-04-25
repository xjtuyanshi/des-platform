export type LibraryParameterCatalogEntry = {
  id: string;
  type: string;
  required: boolean;
  description: string;
  unit?: string;
};

export type LibraryCatalogEntry = {
  id: string;
  name: string;
  category: 'process-flow' | 'material-handling' | 'experiment';
  purpose: string;
  aiUsage: string;
  parameters: LibraryParameterCatalogEntry[];
  constraints: string[];
  example: Record<string, unknown>;
};

export type AiNativeDesLibraryCatalogDefinition = {
  schemaVersion: 'des-platform.library-catalog.v1';
  dslSchemaVersion: 'des-platform.v1';
  purpose: string;
  entries: LibraryCatalogEntry[];
};

export const AiNativeDesLibraryCatalog: AiNativeDesLibraryCatalogDefinition = {
  schemaVersion: 'des-platform.library-catalog.v1',
  dslSchemaVersion: 'des-platform.v1',
  purpose: 'Machine-readable catalog of AI-native DES modeling primitives for Process Flow, Material Handling, and experiments.',
  entries: [
    {
      id: 'process.source',
      name: 'Source',
      category: 'process-flow',
      purpose: 'Create entities from an interval distribution or explicit schedule.',
      aiUsage: 'Use for orders, parts, pallets, vehicles, arrivals, demands, and any exogenous creation process.',
      parameters: [
        { id: 'entityType', type: 'string', required: false, description: 'Entity type name created by this source.' },
        { id: 'startAtSec', type: 'number', required: false, description: 'First creation time.', unit: 's' },
        { id: 'intervalSec', type: 'time-value', required: false, description: 'Interarrival time or seeded distribution.', unit: 's' },
        { id: 'scheduleAtSec', type: 'number[]', required: false, description: 'Explicit arrival times.', unit: 's' },
        { id: 'maxArrivals', type: 'integer', required: false, description: 'Maximum entities to create.' },
        { id: 'attributes', type: 'record<literal>', required: false, description: 'Initial entity attributes.' }
      ],
      constraints: ['Define intervalSec or scheduleAtSec.', 'intervalSec must be able to advance simulation time.'],
      example: { id: 'source', kind: 'source', entityType: 'order', intervalSec: { kind: 'exponential', mean: 45 }, maxArrivals: 20 }
    },
    {
      id: 'process.queue',
      name: 'Queue',
      category: 'process-flow',
      purpose: 'Represent bounded or unbounded waiting before downstream work.',
      aiUsage: 'Use when a named buffer is important for reporting or capacity constraints.',
      parameters: [
        { id: 'capacity', type: 'integer', required: false, description: 'Maximum transient queue length.' },
        { id: 'discipline', type: 'fifo|lifo', required: false, description: 'Queue discipline. Current runtime behavior is FIFO.' }
      ],
      constraints: ['Capacity, when provided, must be positive.'],
      example: { id: 'pack-queue', kind: 'queue', capacity: 20 }
    },
    {
      id: 'process.delay',
      name: 'Delay',
      category: 'process-flow',
      purpose: 'Hold an entity for deterministic or stochastic time without seizing a resource.',
      aiUsage: 'Use for curing, cooling, paperwork, dwell time, inspection dwell, and passive waits.',
      parameters: [
        { id: 'durationSec', type: 'time-value', required: true, description: 'Delay duration.', unit: 's' }
      ],
      constraints: ['durationSec must be nonnegative.'],
      example: { id: 'cooldown', kind: 'delay', durationSec: { kind: 'triangular', min: 20, mode: 30, max: 60 } }
    },
    {
      id: 'process.service',
      name: 'Service',
      category: 'process-flow',
      purpose: 'Queue for and seize resource capacity while work is performed, then release automatically.',
      aiUsage: 'Use for machines, operators, docks, inspection stations, packing benches, or any constrained server.',
      parameters: [
        { id: 'resourcePoolId', type: 'string', required: true, description: 'Resource pool to seize.' },
        { id: 'quantity', type: 'integer', required: false, description: 'Resource units needed.' },
        { id: 'durationSec', type: 'time-value', required: true, description: 'Processing time.', unit: 's' },
        { id: 'queueCapacity', type: 'integer', required: false, description: 'Maximum waiting requests for this block.' }
      ],
      constraints: ['resourcePoolId must reference a defined resource pool.', 'queueCapacity, when provided, must be positive.'],
      example: { id: 'pack', kind: 'service', resourcePoolId: 'packer', durationSec: { kind: 'triangular', min: 35, mode: 55, max: 95 } }
    },
    {
      id: 'process.seize',
      name: 'Seize',
      category: 'process-flow',
      purpose: 'Acquire resource capacity and keep it held across downstream blocks.',
      aiUsage: 'Use when an entity must keep an operator, fixture, dock, or tool across multiple steps.',
      parameters: [
        { id: 'resourcePoolId', type: 'string', required: true, description: 'Resource pool to seize.' },
        { id: 'quantity', type: 'integer', required: false, description: 'Resource units needed.' },
        { id: 'queueCapacity', type: 'integer', required: false, description: 'Maximum waiting requests.' }
      ],
      constraints: ['Must normally be paired with a downstream Release for the same resourcePoolId.'],
      example: { id: 'seize-operator', kind: 'seize', resourcePoolId: 'operator', quantity: 1 }
    },
    {
      id: 'process.release',
      name: 'Release',
      category: 'process-flow',
      purpose: 'Release resource capacity held by a prior Seize block.',
      aiUsage: 'Use after multi-step work that explicitly held resource capacity.',
      parameters: [
        { id: 'resourcePoolId', type: 'string', required: true, description: 'Resource pool to release.' },
        { id: 'quantity', type: 'integer', required: false, description: 'Resource units to release.' }
      ],
      constraints: ['The entity must hold at least quantity units before release.'],
      example: { id: 'release-operator', kind: 'release', resourcePoolId: 'operator', quantity: 1 }
    },
    {
      id: 'process.assign',
      name: 'Assign',
      category: 'process-flow',
      purpose: 'Set or overwrite entity attributes.',
      aiUsage: 'Use for order class, routing labels, promised lead time, product family, priority, or scenario tags.',
      parameters: [
        { id: 'assignments', type: 'record<literal>', required: false, description: 'Attribute values to merge onto the entity.' }
      ],
      constraints: ['Assignment values must be string, number, boolean, or null.'],
      example: { id: 'assign-express', kind: 'assign', assignments: { serviceClass: 'express', promisedLeadTimeSec: 600 } }
    },
    {
      id: 'process.selectOutput',
      name: 'SelectOutput',
      category: 'process-flow',
      purpose: 'Route entities across conditional, fallback, or seeded probability branches.',
      aiUsage: 'Use for business rules, product-family routing, priority branching, rejects, rework, and probabilistic mix.',
      parameters: [
        { id: 'connections[].condition', type: 'condition', required: false, description: 'Attribute comparison on an outgoing connection.' },
        { id: 'connections[].probability', type: 'number', required: false, description: 'Seeded probability for an outgoing connection, from 0 to 1.' }
      ],
      constraints: ['Probabilities are only allowed on outgoing SelectOutput connections.', 'Use one unconditional fallback connection when the branch should never dead-end.'],
      example: { id: 'select-priority', kind: 'selectOutput' }
    },
    {
      id: 'process.sink',
      name: 'Sink',
      category: 'process-flow',
      purpose: 'Complete entities and record cycle time.',
      aiUsage: 'Use for shipped orders, finished products, scrapped items, completed jobs, or any terminal state.',
      parameters: [],
      constraints: ['Sinks should usually have at least one incoming connection.'],
      example: { id: 'sink', kind: 'sink' }
    },
    {
      id: 'process.moveByTransporter',
      name: 'MoveByTransporter',
      category: 'material-handling',
      purpose: 'Move an entity using a transporter fleet over a material-handling route.',
      aiUsage: 'Use for AMR, AGV, forklift, worker, crane, or tow movement between layout nodes.',
      parameters: [
        { id: 'fleetId', type: 'string', required: true, description: 'Transporter fleet to use.' },
        { id: 'fromNodeId', type: 'string', required: true, description: 'Pickup node.' },
        { id: 'toNodeId', type: 'string', required: true, description: 'Dropoff node.' },
        { id: 'loadTimeSec', type: 'time-value', required: false, description: 'Load time.', unit: 's' },
        { id: 'unloadTimeSec', type: 'time-value', required: false, description: 'Unload time.', unit: 's' }
      ],
      constraints: ['Requires materialHandling.', 'A route must exist from current vehicle node to pickup and from pickup to dropoff.', 'Path-guided routes use path traffic-control reservations unless a path has trafficControl set to none.'],
      example: { id: 'move-to-pack', kind: 'moveByTransporter', fleetId: 'amr', fromNodeId: 'rack', toNodeId: 'pack', loadTimeSec: 3, unloadTimeSec: 3 }
    },
    {
      id: 'process.store',
      name: 'Store',
      category: 'material-handling',
      purpose: 'Put an entity item into a storage system slot.',
      aiUsage: 'Use for racks, ASRS buffers, supermarkets, staging lanes, and WIP storage.',
      parameters: [
        { id: 'storageId', type: 'string', required: true, description: 'Storage system id.' },
        { id: 'itemIdAttribute', type: 'string', required: false, description: 'Entity attribute containing item id; entity id is used when omitted.' }
      ],
      constraints: ['Storage system must have free capacity.', 'The item cannot already be stored in that system.'],
      example: { id: 'store-rack', kind: 'store', storageId: 'rack-a' }
    },
    {
      id: 'process.retrieve',
      name: 'Retrieve',
      category: 'material-handling',
      purpose: 'Remove an entity item from a storage system slot.',
      aiUsage: 'Use when modeling putaway followed by picking or staged retrieval.',
      parameters: [
        { id: 'storageId', type: 'string', required: true, description: 'Storage system id.' },
        { id: 'itemIdAttribute', type: 'string', required: false, description: 'Entity attribute containing item id; entity id is used when omitted.' }
      ],
      constraints: ['The item must already be present in the storage system.'],
      example: { id: 'retrieve-rack', kind: 'retrieve', storageId: 'rack-a' }
    },
    {
      id: 'process.convey',
      name: 'Convey',
      category: 'material-handling',
      purpose: 'Move an entity over a conveyor with travel time based on length and speed.',
      aiUsage: 'Use for belts, roller conveyors, sorters, takeaway conveyors, and fixed-route transfer.',
      parameters: [
        { id: 'conveyorId', type: 'string', required: true, description: 'Conveyor definition id.' }
      ],
      constraints: ['Conveyor must exist in materialHandling.conveyors.'],
      example: { id: 'convey-to-ship', kind: 'convey', conveyorId: 'pack-ship' }
    },
    {
      id: 'material.layout',
      name: 'Material Handling Layout',
      category: 'material-handling',
      purpose: 'Define nodes, paths, fleets, storage, conveyors, zones, and obstacles in meter units.',
      aiUsage: 'Use to convert a facility layout into simulation-ready material movement data.',
      parameters: [
        { id: 'nodes', type: 'MaterialNode[]', required: true, description: 'Named coordinates for docks, stations, storage, homes, chargers, and conveyor ports.' },
        { id: 'paths', type: 'MaterialPath[]', required: false, description: 'Directed or bidirectional travel links with optional speed limits, trafficControl, and capacity.' },
        { id: 'transporterFleets', type: 'TransporterFleet[]', required: false, description: 'AMR, AGV, forklift, worker, crane fleets.' },
        { id: 'storageSystems', type: 'StorageSystem[]', required: false, description: 'Capacity-constrained storage at nodes.' },
        { id: 'conveyors', type: 'Conveyor[]', required: false, description: 'Fixed conveyors with length and speed.' },
        { id: 'zones', type: 'MaterialZone[]', required: false, description: 'Free-space, restricted, storage, or traffic-control polygons.' },
        { id: 'obstacles', type: 'MaterialObstacle[]', required: false, description: 'Fixed rectangular obstacles for layout analysis and future motion planning.' }
      ],
      constraints: ['All references must point to defined node ids.', 'Storage slotIds length must match capacity when slotIds are provided.', 'Path trafficControl defaults to reservation and path capacity defaults to 1.'],
      example: { id: 'layout', nodes: [{ id: 'dock', type: 'dock', x: 0, z: 0 }], paths: [{ id: 'dock-rack', from: 'dock', to: 'rack', trafficControl: 'reservation', capacity: 1 }], transporterFleets: [{ id: 'amr', count: 2, homeNodeId: 'dock', speedMps: 1.5 }] }
    },
    {
      id: 'experiment.replication-sweep',
      name: 'Replications And Sweeps',
      category: 'experiment',
      purpose: 'Run seeded replications and parameter sweeps over a validated model.',
      aiUsage: 'Use to compare alternatives, perform sensitivity analysis, and generate confidence intervals.',
      parameters: [
        { id: 'seed', type: 'integer', required: false, description: 'Base random seed.' },
        { id: 'replications', type: 'integer', required: false, description: 'Number of independent replications.' },
        { id: 'seedStride', type: 'integer', required: false, description: 'Seed increment between replications.' },
        { id: 'parameterOverrides', type: 'record<literal>', required: false, description: 'Named parameter values for one experiment.' },
        { id: 'sweep', type: 'record<literal[]>', required: false, description: 'Cartesian product of parameter values.' },
        { id: 'stopTimeSec', type: 'number', required: true, description: 'Simulation horizon.', unit: 's' },
        { id: 'warmupSec', type: 'number', required: false, description: 'Warmup horizon retained in outputs for reporting.', unit: 's' }
      ],
      constraints: ['Overrides and sweep keys must reference declared model parameters.', 'Sweep values must match parameter type and range.'],
      example: { id: 'throughput-sweep', seed: 20260510, replications: 3, sweep: { 'amr-speed-mps': [1, 1.5, 2] }, stopTimeSec: 1800 }
    }
  ]
};
