import http from 'node:http';

import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import { WebSocketServer, type WebSocket } from 'ws';

import { ShuttleCommandSchema, type ShuttleStreamMessage } from '@des-platform/shuttle-schemas';
import { ShuttleSimCore, createDefaultShuttleScenario, hashEventLog } from '@des-platform/shuttle-sim-core';

import { collectPrerequisites } from './prerequisites.js';

const port = Number(process.env.SHUTTLE_PORT ?? process.env.PORT ?? 8791);
const tickMs = Number(process.env.SHUTTLE_TICK_MS ?? 250);
const realtimeSpeed = Number(process.env.SHUTTLE_SPEED ?? 1);

const app = express();
app.use(cors());
app.use(express.json({ limit: '4mb' }));

let sim = new ShuttleSimCore(createDefaultShuttleScenario());
const clients = new Set<WebSocket>();
let lastEventSequence = -1;

function send(socket: WebSocket, message: ShuttleStreamMessage): void {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function broadcast(message: ShuttleStreamMessage): void {
  for (const client of clients) {
    send(client, message);
  }
}

function broadcastState(): void {
  const state = sim.getState();
  broadcast({ type: 'simState', state });
  broadcast({ type: 'vehicleState', vehicles: state.vehicles, simTimeSec: state.simTimeSec });
  broadcast({ type: 'kpiUpdate', kpis: state.kpis, simTimeSec: state.simTimeSec });
  const newEvents = state.recentEvents.filter((event) => event.sequence > lastEventSequence);
  if (newEvents.length > 0) {
    lastEventSequence = Math.max(...newEvents.map((event) => event.sequence));
    broadcast({ type: 'taskEvent', events: newEvents, simTimeSec: state.simTimeSec });
  }
}

function commandResponse(response: Response): void {
  broadcastState();
  response.json({ ok: true, state: sim.getState() });
}

app.get('/api/shuttle/health', (_request: Request, response: Response) => {
  response.json({ ok: true, service: 'shuttle-api', protocol: 'shuttle.phase0.v0' });
});

app.get('/api/shuttle/prerequisites', async (_request: Request, response: Response, next: NextFunction) => {
  try {
    response.json(await collectPrerequisites());
  } catch (error) {
    next(error);
  }
});

app.get('/api/shuttle/scenario', (_request: Request, response: Response) => {
  response.json(sim.getScenario());
});

app.get('/api/shuttle/state', (_request: Request, response: Response) => {
  response.json(sim.getState());
});

app.get('/api/shuttle/exportLog', (_request: Request, response: Response) => {
  response.json({ eventLog: sim.getEventLog(), hash: hashEventLog(sim.getEventLog()) });
});

app.post('/api/shuttle/loadScenario', (request: Request, response: Response, next: NextFunction) => {
  try {
    const command = ShuttleCommandSchema.parse({ type: 'loadScenario', scenario: request.body });
    if (command.type !== 'loadScenario') throw new Error('Invalid loadScenario command');
    sim.loadScenario(command.scenario);
    lastEventSequence = -1;
    commandResponse(response);
  } catch (error) {
    next(error);
  }
});

app.post('/api/shuttle/reset', (request: Request, response: Response, next: NextFunction) => {
  try {
    const command = ShuttleCommandSchema.parse({ type: 'reset', seed: request.body?.seed });
    if (command.type !== 'reset') throw new Error('Invalid reset command');
    sim.reset(command.seed);
    lastEventSequence = -1;
    commandResponse(response);
  } catch (error) {
    next(error);
  }
});

app.post('/api/shuttle/pause', (_request: Request, response: Response, next: NextFunction) => {
  try {
    sim.pause();
    commandResponse(response);
  } catch (error) {
    next(error);
  }
});

app.post('/api/shuttle/resume', (_request: Request, response: Response, next: NextFunction) => {
  try {
    sim.resume();
    commandResponse(response);
  } catch (error) {
    next(error);
  }
});

app.post('/api/shuttle/setParam', (request: Request, response: Response, next: NextFunction) => {
  try {
    const command = ShuttleCommandSchema.parse({ type: 'setParam', ...request.body });
    if (command.type !== 'setParam') throw new Error('Invalid setParam command');
    const result = sim.setParam(command.path, command.value);
    if (!result.accepted) {
      response.status(422).json({ ok: false, result });
      return;
    }
    broadcastState();
    response.json({ ok: true, result, state: sim.getState() });
  } catch (error) {
    next(error);
  }
});

app.post('/api/shuttle/startRun', (request: Request, response: Response, next: NextFunction) => {
  try {
    const command = ShuttleCommandSchema.parse({ type: 'startRun', durationSec: request.body?.durationSec, seed: request.body?.seed });
    if (command.type !== 'startRun') throw new Error('Invalid startRun command');
    const scenario = sim.getScenario();
    const runSim = new ShuttleSimCore(command.seed === undefined ? scenario : { ...scenario, seed: command.seed });
    runSim.runToEnd(command.durationSec ?? scenario.durationSec);
    response.json({
      ok: true,
      state: runSim.getState(),
      eventLogHash: hashEventLog(runSim.getEventLog()),
      eventLog: runSim.getEventLog()
    });
  } catch (error) {
    next(error);
  }
});

app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
  const message = error instanceof Error ? error.message : String(error);
  broadcast({ type: 'error', message });
  response.status(500).json({ ok: false, error: message });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/shuttle-ws' });

wss.on('connection', (socket) => {
  clients.add(socket);
  send(socket, { type: 'connectionRecovered', state: sim.getState() });
  socket.on('close', () => {
    clients.delete(socket);
  });
});

setInterval(() => {
  if (sim.getState().status === 'running') {
    sim.step((tickMs / 1000) * realtimeSpeed);
    broadcastState();
  }
}, tickMs).unref();

server.listen(port, () => {
  console.log(`Shuttle Phase 0 API listening on http://localhost:${port}`);
});
