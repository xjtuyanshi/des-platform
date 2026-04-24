import type {
  KpiSummary,
  LayoutDefinition,
  RuntimeSessionState,
  ScenarioDefinition,
  SimulationResult,
  ValidationSummary,
  WorldSnapshot
} from '@des-platform/shared-schema';

export type SimulationSummary = {
  scenarioId: string;
  layoutId: string;
  kpis: KpiSummary;
  validation: ValidationSummary;
};

export type ScenarioCatalogItem = {
  id: string;
  name: string;
  description: string;
  layoutId: string;
  amrCount: number;
  amrSpeedMps: number;
  breakdownEnabled: boolean;
  breakdownMode: ScenarioDefinition['breakdown']['mode'];
  liveWindowStartSec: number;
  livePlaybackSpeed: number;
  isBaseline: boolean;
};

export type RuntimeEnvelope = {
  layout: LayoutDefinition;
  scenario: ScenarioDefinition;
  session: RuntimeSessionState | null;
};

export type RuntimeStartOptions = {
  speed?: number;
  startTimeSec?: number;
};

export type RuntimeSocketMessage =
  | {
      type: 'runtime-meta';
      scenarioId: string;
      layout: LayoutDefinition;
      scenario: ScenarioDefinition;
      session: RuntimeSessionState | null;
    }
  | { type: 'runtime-state'; scenarioId: string; session: RuntimeSessionState | null }
  | {
      type: 'runtime-snapshot';
      scenarioId: string;
      sessionId: string;
      snapshot: WorldSnapshot;
      status: RuntimeSessionState['status'];
      speed: number;
      progress: number;
      recentEvents: RuntimeSessionState['recentEvents'];
    };

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

function buildScenarioPath(prefix: string, scenarioId: string): string {
  return `${prefix}/${encodeURIComponent(scenarioId)}`;
}

function resolveWebSocketUrl(scenarioId: string): string {
  const explicitApiTarget = import.meta.env.VITE_API_TARGET as string | undefined;
  if (explicitApiTarget) {
    const url = new URL(explicitApiTarget);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.pathname = '/ws';
    url.search = `scenarioId=${encodeURIComponent(scenarioId)}`;
    return url.toString();
  }

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws?scenarioId=${encodeURIComponent(scenarioId)}`;
}

export async function fetchScenarioCatalog(): Promise<ScenarioCatalogItem[]> {
  return requestJson<ScenarioCatalogItem[]>('/api/scenarios');
}

export async function fetchReplay(scenarioId: string): Promise<SimulationResult> {
  return requestJson<SimulationResult>(buildScenarioPath('/api/replay', scenarioId));
}

export async function fetchScenarioSummary(scenarioId: string): Promise<SimulationSummary> {
  return requestJson<SimulationSummary>(`${buildScenarioPath('/api/replay', scenarioId)}/summary`);
}

export async function fetchRuntimeState(scenarioId: string): Promise<RuntimeEnvelope> {
  return requestJson<RuntimeEnvelope>(buildScenarioPath('/api/runtime', scenarioId));
}

export async function startRuntimeSession(scenarioId: string, options: RuntimeStartOptions = {}): Promise<RuntimeEnvelope> {
  return requestJson<RuntimeEnvelope>(`${buildScenarioPath('/api/runtime', scenarioId)}/start`, {
    method: 'POST',
    body: JSON.stringify(options)
  });
}

export async function pauseRuntimeSession(scenarioId: string): Promise<RuntimeEnvelope> {
  return requestJson<RuntimeEnvelope>(`${buildScenarioPath('/api/runtime', scenarioId)}/pause`, {
    method: 'POST',
    body: JSON.stringify({})
  });
}

export async function resumeRuntimeSession(scenarioId: string): Promise<RuntimeEnvelope> {
  return requestJson<RuntimeEnvelope>(`${buildScenarioPath('/api/runtime', scenarioId)}/resume`, {
    method: 'POST',
    body: JSON.stringify({})
  });
}

export async function restartRuntimeSession(
  scenarioId: string,
  options: RuntimeStartOptions = {}
): Promise<RuntimeEnvelope> {
  return requestJson<RuntimeEnvelope>(`${buildScenarioPath('/api/runtime', scenarioId)}/restart`, {
    method: 'POST',
    body: JSON.stringify(options)
  });
}

export async function updateRuntimeSpeed(scenarioId: string, speed: number): Promise<RuntimeEnvelope> {
  return requestJson<RuntimeEnvelope>(`${buildScenarioPath('/api/runtime', scenarioId)}/speed`, {
    method: 'POST',
    body: JSON.stringify({ speed })
  });
}

export type RuntimeHandlers = {
  onMeta: (payload: RuntimeEnvelope) => void;
  onState: (session: RuntimeSessionState | null) => void;
  onSnapshot: (message: Extract<RuntimeSocketMessage, { type: 'runtime-snapshot' }>) => void;
};

export function subscribeRuntime(scenarioId: string, handlers: RuntimeHandlers): () => void {
  const socket = new WebSocket(resolveWebSocketUrl(scenarioId));

  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data) as RuntimeSocketMessage;

    if (message.type === 'runtime-meta') {
      handlers.onMeta({
        layout: message.layout,
        scenario: message.scenario,
        session: message.session
      });
      return;
    }

    if (message.type === 'runtime-state') {
      handlers.onState(message.session);
      return;
    }

    handlers.onSnapshot(message);
  });

  return () => socket.close();
}
