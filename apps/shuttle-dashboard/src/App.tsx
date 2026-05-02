import { useEffect, useMemo, useRef, useState, useTransition } from 'react';

import type {
  EventLogEntry,
  KpiSnapshot,
  ShuttleScenario,
  ShuttleSimState,
  ShuttleStreamMessage,
  VehicleState
} from '@des-platform/shuttle-schemas';

type PrerequisiteReport = {
  checkedAt: string;
  host: {
    modelName: string | null;
    modelIdentifier: string | null;
    chip: string | null;
    memory: string | null;
    metalSupport: string | null;
    macos: string | null;
  };
  unreal: {
    installedCandidates: string[];
    preferredVersion: '5.7.4';
    status: 'ready' | 'blocked';
    notes: string[];
  };
  xcode: {
    developerDir: string | null;
    version: string | null;
    status: 'ready' | 'blocked';
    notes: string[];
  };
  pixelStreaming: {
    status: 'pending-unreal' | 'ready';
    notes: string[];
  };
};

type CommandStatus = {
  label: string;
  tone: 'idle' | 'ok' | 'warn' | 'error';
};

const CONTROLLED_PARAMS = [
  {
    label: 'Loaded speed',
    path: '/physicsParams/loadedSpeedMps',
    min: 0.4,
    max: 2.2,
    step: 0.05,
    unit: 'm/s'
  },
  {
    label: 'Empty speed',
    path: '/physicsParams/emptySpeedMps',
    min: 0.4,
    max: 2.6,
    step: 0.05,
    unit: 'm/s'
  },
  {
    label: 'Lift time',
    path: '/physicsParams/liftTimeSec',
    min: 0.5,
    max: 6,
    step: 0.1,
    unit: 's'
  },
  {
    label: 'Inbound rate',
    path: '/taskGeneration/inboundRatePerHour',
    min: 0,
    max: 720,
    step: 10,
    unit: 'PPH'
  },
  {
    label: 'Outbound rate',
    path: '/taskGeneration/outboundRatePerHour',
    min: 0,
    max: 720,
    step: 10,
    unit: 'PPH'
  }
] as const;

async function requestJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetch(input, {
    headers: {
      'Content-Type': 'application/json'
    },
    ...init
  });
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }
  return response.json() as Promise<T>;
}

function formatClock(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = Math.floor(totalSeconds % 60);
  return [hours, minutes, seconds].map((value) => String(value).padStart(2, '0')).join(':');
}

function formatNumber(value: number, digits = 1): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(digits);
}

function getPointerValue(source: unknown, pointer: string): unknown {
  const parts = pointer.split('/').slice(1);
  let cursor = source;
  for (const part of parts) {
    if (!cursor || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}

function websocketUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/shuttle-ws`;
}

function mergeEvents(previous: EventLogEntry[], next: EventLogEntry[]): EventLogEntry[] {
  const bySequence = new Map<number, EventLogEntry>();
  for (const event of [...previous, ...next]) {
    bySequence.set(event.sequence, event);
  }
  return [...bySequence.values()].sort((left, right) => left.sequence - right.sequence).slice(-80);
}

function KpiStrip({ kpis }: { kpis: KpiSnapshot | null }) {
  const items = [
    ['Total PPH', kpis ? formatNumber(kpis.totalPph, 1) : '--'],
    ['Inbound PPH', kpis ? formatNumber(kpis.inboundPph, 1) : '--'],
    ['Outbound PPH', kpis ? formatNumber(kpis.outboundPph, 1) : '--'],
    ['P95 cycle', kpis ? `${formatNumber(kpis.p95TaskCycleSec, 1)}s` : '--'],
    ['Conflicts', kpis ? String(kpis.reservationConflictCount) : '--'],
    ['Deadlocks', kpis ? String(kpis.deadlockCount) : '--']
  ];

  return (
    <section className="kpi-strip" aria-label="KPI summary">
      {items.map(([label, value]) => (
        <div className="metric" key={label}>
          <span>{label}</span>
          <strong>{value}</strong>
        </div>
      ))}
    </section>
  );
}

function VehicleTable({ vehicles }: { vehicles: VehicleState[] }) {
  return (
    <section className="panel vehicle-panel">
      <div className="panel-head">
        <h2>Vehicle State</h2>
        <span>{vehicles.length} units</span>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>State</th>
              <th>Node</th>
              <th>Target</th>
              <th>Speed</th>
              <th>Wait</th>
            </tr>
          </thead>
          <tbody>
            {vehicles.map((vehicle) => (
              <tr key={vehicle.id}>
                <td>{vehicle.id}</td>
                <td><span className={`state-pill ${vehicle.state}`}>{vehicle.state}</span></td>
                <td>{vehicle.currentNodeId}</td>
                <td>{vehicle.targetNodeId ?? '--'}</td>
                <td>{vehicle.speedMps.toFixed(2)}</td>
                <td>{vehicle.waitReason ?? '--'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function EventLog({ events }: { events: EventLogEntry[] }) {
  return (
    <section className="panel event-panel">
      <div className="panel-head">
        <h2>Event Log</h2>
        <span>latest {events.length}</span>
      </div>
      <div className="event-list">
        {[...events].slice(-18).reverse().map((event) => (
          <div className="event-row" key={event.sequence}>
            <time>{event.timeSec.toFixed(1)}s</time>
            <strong>{event.eventType}</strong>
            <span>{event.vehicleId ?? event.taskId ?? 'system'}</span>
            <small>{event.reason ?? ''}</small>
          </div>
        ))}
      </div>
    </section>
  );
}

function StreamingPane({ prerequisites }: { prerequisites: PrerequisiteReport | null }) {
  const unrealReady = prerequisites?.unreal.status === 'ready';
  const xcodeReady = prerequisites?.xcode.status === 'ready';
  const ready = unrealReady && xcodeReady;

  return (
    <section className="stream-pane">
      <div className="stream-header">
        <div>
          <h2>Pixel Streaming View</h2>
          <p>Browser video channel for the Unreal visual twin. Core state still comes from SimCore.</p>
        </div>
        <span className={`readiness ${ready ? 'ready' : 'blocked'}`}>{ready ? 'ready for UE hookup' : 'blocked prerequisite'}</span>
      </div>
      <div className="stream-placeholder">
        <div className="warehouse-grid" aria-hidden="true">
          <span className="shuttle-dot dot-a" />
          <span className="shuttle-dot dot-b" />
          <span className="load-block block-a" />
          <span className="load-block block-b" />
        </div>
        <div className="stream-copy">
          <strong>Unreal stream is not attached yet</strong>
          <span>Install UE 5.7.4 and full Xcode, enable Pixel Streaming, then point this pane at the signalling server page.</span>
        </div>
      </div>
    </section>
  );
}

function PrerequisitePanel({ report }: { report: PrerequisiteReport | null }) {
  return (
    <section className="panel prereq-panel">
      <div className="panel-head">
        <h2>Mac / UE Gate</h2>
        <span>{report ? new Date(report.checkedAt).toLocaleTimeString() : 'checking'}</span>
      </div>
      {report ? (
        <div className="prereq-grid">
          <div>
            <span>Host</span>
            <strong>{[report.host.modelName, report.host.chip, report.host.memory].filter(Boolean).join(' / ')}</strong>
          </div>
          <div>
            <span>Unreal 5.7.4</span>
            <strong className={report.unreal.status}>{report.unreal.status}</strong>
          </div>
          <div>
            <span>Xcode</span>
            <strong className={report.xcode.status}>{report.xcode.status}</strong>
          </div>
          <div>
            <span>Pixel Streaming</span>
            <strong>{report.pixelStreaming.status}</strong>
          </div>
        </div>
      ) : (
        <p className="muted">Waiting for prerequisite report...</p>
      )}
    </section>
  );
}

export function App() {
  const [scenario, setScenario] = useState<ShuttleScenario | null>(null);
  const [state, setState] = useState<ShuttleSimState | null>(null);
  const [events, setEvents] = useState<EventLogEntry[]>([]);
  const [prerequisites, setPrerequisites] = useState<PrerequisiteReport | null>(null);
  const [commandStatus, setCommandStatus] = useState<CommandStatus>({ label: 'ready', tone: 'idle' });
  const [isPending, startTransition] = useTransition();
  const reconnectAttemptRef = useRef(0);

  const kpis = state?.kpis ?? null;
  const vehicles = state?.vehicles ?? [];
  const statusTone = state?.status === 'running' ? 'ok' : state?.status === 'paused' ? 'warn' : 'idle';

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      requestJson<ShuttleScenario>('/api/shuttle/scenario'),
      requestJson<ShuttleSimState>('/api/shuttle/state'),
      requestJson<PrerequisiteReport>('/api/shuttle/prerequisites')
    ])
      .then(([nextScenario, nextState, report]) => {
        if (cancelled) return;
        setScenario(nextScenario);
        setState(nextState);
        setEvents(nextState.recentEvents);
        setPrerequisites(report);
      })
      .catch((error) => setCommandStatus({ label: error instanceof Error ? error.message : String(error), tone: 'error' }));
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let socket: WebSocket | null = null;
    let reconnectTimer: number | null = null;
    let closed = false;

    const connect = () => {
      socket = new WebSocket(websocketUrl());
      socket.addEventListener('open', () => {
        reconnectAttemptRef.current = 0;
      });
      socket.addEventListener('message', (event) => {
        const message = JSON.parse(event.data as string) as ShuttleStreamMessage;
        if (message.type === 'connectionRecovered' || message.type === 'simState') {
          startTransition(() => {
            setState(message.state);
            setEvents(message.state.recentEvents);
          });
        }
        if (message.type === 'taskEvent') {
          setEvents((previous) => mergeEvents(previous, message.events));
        }
        if (message.type === 'error') {
          setCommandStatus({ label: message.message, tone: 'error' });
        }
      });
      socket.addEventListener('close', () => {
        if (closed) return;
        reconnectAttemptRef.current += 1;
        const delay = Math.min(4000, 400 * reconnectAttemptRef.current);
        reconnectTimer = window.setTimeout(connect, delay);
      });
    };

    connect();
    return () => {
      closed = true;
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, []);

  const paramValues = useMemo(() => {
    if (!scenario) return new Map<string, number>();
    return new Map(CONTROLLED_PARAMS.map((param) => [param.path, Number(getPointerValue(scenario, param.path) ?? 0)]));
  }, [scenario]);

  async function postCommand(path: string, body: unknown = {}): Promise<void> {
    const startedAt = performance.now();
    setCommandStatus({ label: 'sending command...', tone: 'idle' });
    try {
      const response = await requestJson<{ state?: ShuttleSimState; result?: unknown }>(path, {
        method: 'POST',
        body: JSON.stringify(body)
      });
      if (response.state) {
        setState(response.state);
      }
      const elapsedMs = Math.round(performance.now() - startedAt);
      setCommandStatus({ label: `ack ${elapsedMs} ms`, tone: 'ok' });
    } catch (error) {
      setCommandStatus({ label: error instanceof Error ? error.message : String(error), tone: 'error' });
    }
  }

  async function updateParam(path: string, value: number): Promise<void> {
    setScenario((previous) => {
      if (!previous) return previous;
      return structuredClone(previous);
    });
    await postCommand('/api/shuttle/setParam', { path, value });
    const nextScenario = await requestJson<ShuttleScenario>('/api/shuttle/scenario');
    setScenario(nextScenario);
  }

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand-block">
          <div className="mark" aria-hidden="true">S0</div>
          <div>
            <h1>Shuttle Phase 0</h1>
            <p>Authoritative SimCore protocol with Unreal visual twin hook points.</p>
          </div>
        </div>

        <section className="control-block">
          <div className="run-row">
            <button type="button" onClick={() => postCommand('/api/shuttle/resume')}>Resume</button>
            <button type="button" onClick={() => postCommand('/api/shuttle/pause')}>Pause</button>
            <button type="button" onClick={() => postCommand('/api/shuttle/reset', { seed: state?.seed })}>Reset</button>
          </div>
          <div className={`status-line ${commandStatus.tone}`}>
            <span>{state?.status ?? 'loading'}</span>
            <strong>{commandStatus.label}{isPending ? ' / rendering' : ''}</strong>
          </div>
        </section>

        <section className="control-block param-block">
          <h2>Scenario Parameters</h2>
          {CONTROLLED_PARAMS.map((param) => {
            const value = paramValues.get(param.path) ?? 0;
            return (
              <label key={param.path}>
                <span>
                  {param.label}
                  <strong>{formatNumber(value, 2)} {param.unit}</strong>
                </span>
                <input
                  type="range"
                  min={param.min}
                  max={param.max}
                  step={param.step}
                  value={value}
                  onChange={(event) => updateParam(param.path, Number(event.currentTarget.value))}
                />
              </label>
            );
          })}
        </section>

        <PrerequisitePanel report={prerequisites} />
      </aside>

      <section className="workspace">
        <header className="workspace-header">
          <div>
            <p className="caption">SimCore / WCS-lite is source of truth</p>
            <h2>{scenario?.name ?? 'Phase 0 Scenario'}</h2>
          </div>
          <div className={`runtime-badge ${statusTone}`}>
            <span>{formatClock(state?.simTimeSec ?? 0)}</span>
            <strong>{state ? `${Math.round((state.simTimeSec / state.durationSec) * 100)}%` : '--'}</strong>
          </div>
        </header>

        <KpiStrip kpis={kpis} />
        <div className="main-grid">
          <StreamingPane prerequisites={prerequisites} />
          <VehicleTable vehicles={vehicles} />
          <EventLog events={events} />
        </div>
      </section>
    </main>
  );
}
