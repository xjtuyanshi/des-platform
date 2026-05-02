# Shuttle Phase 0 Implementation

Phase 0 validates the architecture before high-fidelity warehouse production work:

- SimCore / WCS-lite is the authoritative state source.
- Dashboard commands use HTTP and state streaming uses WebSocket.
- Unreal is a visual twin that subscribes to state and interpolates actors.
- Pixel Streaming is only the browser video channel.

## Implemented Structure

- `packages/shuttle-schemas`: zod schemas for scenarios, vehicle state, reservations, event logs, commands, and stream messages.
- `packages/shuttle-sim-core`: deterministic SimCore with seed/reset/pause/resume, task generation, routing, reservations, event logs, and KPI snapshots.
- `apps/shuttle-api`: HTTP/WebSocket server for dashboard and Unreal bridge consumers.
- `apps/shuttle-dashboard`: React/Vite dashboard for command control, KPI display, vehicle state, event log, and Pixel Streaming readiness.
- `unreal-bridge`: source-only Unreal plugin scaffold for WebSocket subscription and placeholder actor interpolation.

## Commands

From `des-platform`:

```bash
pnpm install
pnpm test:shuttle
pnpm shuttle:prereq
pnpm dev:shuttle-api
pnpm dev:shuttle-dashboard
```

Default local URLs:

- API: `http://localhost:8791/api/shuttle/health`
- WebSocket: `ws://localhost:8791/shuttle-ws`
- Dashboard: `http://localhost:5179`

## Protocol

HTTP commands:

- `POST /api/shuttle/loadScenario`
- `POST /api/shuttle/reset`
- `POST /api/shuttle/pause`
- `POST /api/shuttle/resume`
- `POST /api/shuttle/setParam`
- `POST /api/shuttle/startRun`
- `GET /api/shuttle/exportLog`

WebSocket stream messages:

- `connectionRecovered`
- `simState`
- `vehicleState`
- `taskEvent`
- `kpiUpdate`
- `error`

## Traffic Baseline

The Phase 0 traffic model includes the data structure needed for the harder Phase 3 work:

- edge reservations
- node reservations
- zone/intersection reservations
- time windows
- priorities with aging hook
- conflict groups
- no-stop/no-parking flags
- wait reason codes
- deadlock/livelock counters and detector placeholders

This is still a smoke implementation. It validates deterministic blocking and wait reason logging; it is not the final multi-agent traffic controller.

## Current Prerequisite Status

Local inspection found:

- Host: Mac mini, Apple M4, 10-core CPU, 16 GB memory, Metal 4.
- Unreal/Epic application: not found under `/Applications` during implementation.
- Xcode: `xcodebuild` is blocked because the active developer directory is Command Line Tools only.

That means the API/dashboard/SimCore protocol can run now, but actual Pixel Streaming validation remains blocked until Unreal Engine 5.7.4 and full Xcode are installed.

## Phase 0 Acceptance Mapping

- Deterministic SimCore: implemented and covered by `test:shuttle`.
- Event log hash: implemented with SHA-256 over stable event fields.
- Reset without UE process restart: implemented at API/SimCore level.
- Dashboard control path: implemented for resume, pause, reset, and parameter updates.
- WebSocket reconnect: dashboard reconnects and consumes `connectionRecovered`.
- Unreal visual twin: source scaffold implemented, pending UE installation and compile.
- 30-minute Pixel Streaming validation: blocked by missing UE/full Xcode.

## Next Step After Prerequisites

1. Install Unreal Engine 5.7.4 and full Xcode.
2. Run `pnpm shuttle:prereq` until Unreal and Xcode are both `ready`.
3. Create a blank UE project and copy `unreal-bridge` into `Plugins/ShuttlePhase0Bridge`.
4. Enable Pixel Streaming and WebSockets.
5. Bind placeholder actors to `UShuttleStateSubscriberSubsystem`.
6. Run the 30-minute 1080p single-user Pixel Streaming test and record resource metrics.
