# DES Platform

AI-native discrete-event simulation platform for logistics, manufacturing, warehousing, and material-flow systems. The automotive assembly replenishment model is the first reference scenario, not the product boundary.

The platform is being rebuilt around generic simulation primitives:

- deterministic DES core
- schema-first model DSL for AI-authored Process Flow and Material Handling models
- explicit material handling layout, transport, storage, conveyor, and AMR/AGV abstractions
- React + Three.js 3D viewer
- runtime-controlled WebSocket live viewer and replay API
- static HTML reporting
- JSON Schema output for future agent-authored scenarios

## Workspace Layout

- `packages/shared-schema`: zod schemas, typed interfaces, config loading, JSON Schema generation
- `packages/des-core`: generic deterministic DES runtime around the event queue
- `packages/event-queue`: deterministic priority queue ordered by `(time, priority, sequence)`
- `packages/process-flow`: AI-native Process Flow runtime blocks such as Source, Queue, Delay, Service, Seize, Release, SelectOutput, and Sink
- `packages/material-handling`: generic Material Handling runtime for layout networks, transporter fleets, storage, and conveyors
- `packages/model-compiler`: validates AI-native model DSL and creates executable Process Flow runtimes
- `packages/domain-model`: stations, bins, AMRs, cars, skids, transport tasks
- `packages/dispatching`: earliest-completion / nearest-idle dispatch policy
- `packages/motion-layer`: aisle graph routing + Rapier-backed motion world
- `packages/simulation-core`: automotive reference scenario engine and KPI generation
- `apps/sim-api`: HTTP + WebSocket API for replay/live viewer data
- `apps/viewer`: React + Three.js factory viewer
- `apps/reporting`: static report renderer and CLI
- `apps/model-runner`: headless CLI for validating and running generic AI-native DSL models
- `config/models`: generic process/material-handling model examples
- `config/layouts`: meter-based factory layouts
- `config/scenarios`: YAML scenario definitions
- `config/schemas`: generated JSON Schema artifacts
- `output`: generated baseline replay/report/validation artifacts

## Reference Scenario

The current reference scenario is a 10-station automotive assembly replenishment model:

- 10 serial stations on one paced main line
- pitch `5.1m`, skid `5.0m`, car `4.6m`, fixed takt `40s`
- station consumption timing is derived from `layout.lineX / conveyorSpeed`, not `stationIndex * takt`
- 2-bin line-side replenishment at every station
- per-station QPC profile: `180,200,220,190,240,210,175,230,205,250`
- 3 AMRs, `1.5m x 1.5m`, `1.5 m/s`
- no charging, no failures in baseline
- steady-state acceptance: `40s cycle`, `90 UPH`, `0 downtime`, `0 starvation`

Validation gates:

- geometry consistency between layout and scenario
- station arrival alignment from event logs
- station consumption accounting from `station-consumed` events
- single outstanding request per empty bin
- task lifecycle ordering
- car pitch spacing across retained runtime snapshots

## Commands

```bash
pnpm install
pnpm generate:schema
pnpm typecheck
pnpm test
pnpm run:model
pnpm run:experiment
pnpm validate:model
pnpm dev:api
pnpm dev:viewer
pnpm report:baseline
pnpm simulate:baseline
pnpm build
```

## AI-Native Modeling Foundation

The first generic modeling surface is a validated DSL under `@des-platform/shared-schema/model-dsl`.
It is intentionally code/data based instead of drag-and-drop based:

- AI or a user describes a process as blocks, resource pools, and connections.
- AI or a user describes a facility as nodes, paths, fleets, storage systems, conveyors, zones, and obstacles.
- Time fields can be deterministic numbers or seeded distributions such as `constant`, `uniform`, `triangular`, `normal`, and `exponential`.
- Model parameters give stable names, semantic paths, units, and min/max/step bounds for UI sliders and AI-authored experiment overrides.
- `@des-platform/model-compiler` validates the DSL before runtime.
- `@des-platform/process-flow` executes the model on `@des-platform/des-core`.
- `@des-platform/material-handling` provides the first generic material-flow runtime layer for `MoveByTransporter`, `Store`, `Retrieve`, and `Convey` blocks.
- Generated JSON Schemas include `process-flow.schema.json`, `material-handling.schema.json`, and `model-dsl.schema.json`.

Generic models can be run without the viewer:

```bash
pnpm validate:model
pnpm validate:model config/models/warehouse-material-flow.json
pnpm validate:model config/models/stochastic-single-machine.json
pnpm run:model
pnpm run:model config/models/warehouse-material-flow.json baseline
pnpm run:model config/models/stochastic-single-machine.json seed-20260424
pnpm run:experiment config/models/stochastic-single-machine.json seed-20260424
```

Validation writes `output/<model-file>-diagnostics.json` with schema, process graph, material route, and experiment diagnostics. This is the first guardrail for AI-authored models: an agent can generate a model, validate it, repair specific diagnostic codes, and only then run the simulation.

The runner writes serializable results to `output/<model-id>-<experiment-id>-run.json` with event logs, process snapshots, material-handling state, and summary KPIs.
Experiment runs write `output/<model-id>-<experiment-id>-experiment.json` with per-replication seeds, KPI summaries, standard deviations, and 95% confidence half-widths.
Parameterized runs apply `experiment.parameterOverrides` before compilation and include the effective `parameterValues` in run and experiment outputs.

Viewer defaults:

- API: `http://localhost:8787`
- Vite viewer: `http://localhost:5178`

Runtime endpoints:

- `GET /api/runtime/baseline`: current baseline session state
- `POST /api/runtime/baseline/start`: start a fresh live session, optionally with `startTimeSec`
- `POST /api/runtime/baseline/pause`: pause the active session
- `POST /api/runtime/baseline/resume`: resume the active session
- `POST /api/runtime/baseline/restart`: restart the active session, optionally with `startTimeSec`
- `POST /api/runtime/baseline/speed`: change runtime speed multiplier

Viewer behavior:

- the UI now defaults to `Live Runtime`, not replay
- live mode auto-starts the configured `liveWindowStartSec` so the first replenishment task is visible immediately
- `Restart Window`, `Restart From T0`, `Pause` / `Resume`, and speed presets are all backed by the runtime session API
- the default baseline viewer speed is `4x`; this keeps the eventful live window observable instead of burning through it in a few seconds
- replay remains available, but it is a secondary analysis path instead of the primary viewer flow

## Output Artifacts

After running the CLI commands, the important generated files are:

- [baseline-report.html](/Users/luke/codex%20projects/DES%20Sim/des-platform/output/baseline-report.html)
- [baseline-summary.json](/Users/luke/codex%20projects/DES%20Sim/des-platform/output/baseline-summary.json)
- [baseline-validation.txt](/Users/luke/codex%20projects/DES%20Sim/des-platform/output/baseline-validation.txt)
- [baseline-replay.json](/Users/luke/codex%20projects/DES%20Sim/des-platform/output/baseline-replay.json)

`baseline-summary.json` now includes both KPI summary and validation summary. `baseline-validation.txt` is the flattened acceptance record for quick inspection in a terminal.

## Notes

- The AnyLogic folders in the parent workspace remain reference-only.
- `@dimforge/rapier3d-compat` is used in the motion layer; its current package still emits a deprecated init warning during tests/CLI, but runtime behavior is correct.
- Replay payloads are downsampled for the API and CLI so the viewer stays responsive while KPI calculations still use the full simulation timeline.
