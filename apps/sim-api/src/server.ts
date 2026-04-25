import http from 'node:http';

import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import { WebSocketServer, type WebSocket } from 'ws';

import {
  DEFAULT_SCENARIO_ID,
  getScenarioCatalog,
  getScenarioReplay,
  getScenarioReport,
  getScenarioRuntimeState,
  getScenarioSummary,
  pauseScenarioRuntime,
  restartScenarioRuntime,
  resumeScenarioRuntime,
  startScenarioRuntime,
  subscribeScenarioRuntime,
  updateScenarioRuntimeSpeed
} from './runtime.js';
import {
  getGenericRuntimeState,
  getGenericStudyCatalog,
  pauseGenericRuntime,
  renderGenericRuntimeViewer,
  restartGenericRuntime,
  resumeGenericRuntime,
  startGenericRuntime,
  subscribeGenericRuntime,
  updateGenericRuntimeSpeed
} from './generic-runtime.js';

const port = Number(process.env.PORT ?? 8787);

const app = express();
app.use(cors());
app.use(express.json());

function getScenarioParam(request: Request): string {
  const value = request.params.scenarioId;
  return Array.isArray(value) ? value[0] ?? DEFAULT_SCENARIO_ID : value ?? DEFAULT_SCENARIO_ID;
}

function getStudyParam(request: Request): string {
  const value = request.params.studyId;
  return Array.isArray(value) ? value[0] ?? 'micro-fulfillment-inline' : value ?? 'micro-fulfillment-inline';
}

app.get('/api/health', (_request: Request, response: Response) => {
  response.json({ ok: true });
});

app.get('/api/scenarios', async (_request: Request, response: Response, next: NextFunction) => {
  try {
    response.json(await getScenarioCatalog());
  } catch (error) {
    next(error);
  }
});

app.get('/api/des-studies', async (_request: Request, response: Response, next: NextFunction) => {
  try {
    response.json(await getGenericStudyCatalog());
  } catch (error) {
    next(error);
  }
});

app.get('/api/replay/:scenarioId/summary', async (request: Request, response: Response, next: NextFunction) => {
  try {
    response.json(await getScenarioSummary(getScenarioParam(request)));
  } catch (error) {
    next(error);
  }
});

app.get('/api/replay/:scenarioId', async (request: Request, response: Response, next: NextFunction) => {
  try {
    response.json(await getScenarioReplay(getScenarioParam(request)));
  } catch (error) {
    next(error);
  }
});

app.get('/api/report/:scenarioId', async (request: Request, response: Response, next: NextFunction) => {
  try {
    response.type('html').send(await getScenarioReport(getScenarioParam(request)));
  } catch (error) {
    next(error);
  }
});

app.get('/api/runtime/:scenarioId', async (request: Request, response: Response, next: NextFunction) => {
  try {
    response.json(await getScenarioRuntimeState(getScenarioParam(request)));
  } catch (error) {
    next(error);
  }
});

app.post('/api/runtime/:scenarioId/start', async (request: Request, response: Response, next: NextFunction) => {
  try {
    response.json(await startScenarioRuntime(getScenarioParam(request), request.body?.speed, request.body?.startTimeSec));
  } catch (error) {
    next(error);
  }
});

app.post('/api/runtime/:scenarioId/pause', async (request: Request, response: Response, next: NextFunction) => {
  try {
    response.json(await pauseScenarioRuntime(getScenarioParam(request)));
  } catch (error) {
    next(error);
  }
});

app.post('/api/runtime/:scenarioId/resume', async (request: Request, response: Response, next: NextFunction) => {
  try {
    response.json(await resumeScenarioRuntime(getScenarioParam(request)));
  } catch (error) {
    next(error);
  }
});

app.post('/api/runtime/:scenarioId/restart', async (request: Request, response: Response, next: NextFunction) => {
  try {
    response.json(
      await restartScenarioRuntime(getScenarioParam(request), request.body?.speed, request.body?.startTimeSec)
    );
  } catch (error) {
    next(error);
  }
});

app.post('/api/runtime/:scenarioId/speed', async (request: Request, response: Response, next: NextFunction) => {
  try {
    response.json(await updateScenarioRuntimeSpeed(getScenarioParam(request), Number(request.body?.speed)));
  } catch (error) {
    next(error);
  }
});

app.get('/api/des-runtime/:studyId', async (request: Request, response: Response, next: NextFunction) => {
  try {
    response.json(await getGenericRuntimeState(getStudyParam(request)));
  } catch (error) {
    next(error);
  }
});

app.get('/api/des-runtime/:studyId/viewer', async (request: Request, response: Response, next: NextFunction) => {
  try {
    response.type('html').send(renderGenericRuntimeViewer(getStudyParam(request)));
  } catch (error) {
    next(error);
  }
});

app.post('/api/des-runtime/:studyId/start', async (request: Request, response: Response, next: NextFunction) => {
  try {
    response.json(
      await startGenericRuntime(
        getStudyParam(request),
        request.body?.speed,
        request.body?.startTimeSec,
        request.body?.experimentId
      )
    );
  } catch (error) {
    next(error);
  }
});

app.post('/api/des-runtime/:studyId/pause', async (request: Request, response: Response, next: NextFunction) => {
  try {
    response.json(await pauseGenericRuntime(getStudyParam(request)));
  } catch (error) {
    next(error);
  }
});

app.post('/api/des-runtime/:studyId/resume', async (request: Request, response: Response, next: NextFunction) => {
  try {
    response.json(await resumeGenericRuntime(getStudyParam(request)));
  } catch (error) {
    next(error);
  }
});

app.post('/api/des-runtime/:studyId/restart', async (request: Request, response: Response, next: NextFunction) => {
  try {
    response.json(
      await restartGenericRuntime(
        getStudyParam(request),
        request.body?.speed,
        request.body?.startTimeSec,
        request.body?.experimentId
      )
    );
  } catch (error) {
    next(error);
  }
});

app.post('/api/des-runtime/:studyId/speed', async (request: Request, response: Response, next: NextFunction) => {
  try {
    response.json(await updateGenericRuntimeSpeed(getStudyParam(request), Number(request.body?.speed)));
  } catch (error) {
    next(error);
  }
});

app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
  const message = error instanceof Error ? error.message : 'Unknown server error';
  response.status(500).json({ error: message });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

wss.on('connection', (socket: WebSocket, _request: http.IncomingMessage, scenarioId: string) => {
  const unsubscribe = subscribeScenarioRuntime(scenarioId, (event) => {
    if (socket.readyState === 1) {
      socket.send(JSON.stringify(event));
    }
  });

  socket.on('close', () => {
    unsubscribe();
  });
});

server.on('upgrade', (request, socket, head) => {
  const requestUrl = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  if (requestUrl.pathname === '/ws/des') {
    const studyId = requestUrl.searchParams.get('studyId') ?? 'micro-fulfillment-inline';
    wss.handleUpgrade(request, socket, head, (websocket: WebSocket) => {
      wss.emit('generic-connection', websocket, request, studyId);
    });
    return;
  }

  if (requestUrl.pathname !== '/ws') {
    socket.destroy();
    return;
  }

  const scenarioId = requestUrl.searchParams.get('scenarioId') ?? DEFAULT_SCENARIO_ID;

  wss.handleUpgrade(request, socket, head, (websocket: WebSocket) => {
    wss.emit('connection', websocket, request, scenarioId);
  });
});

wss.on('generic-connection', (socket: WebSocket, _request: http.IncomingMessage, studyId: string) => {
  const unsubscribe = subscribeGenericRuntime(studyId, (event) => {
    if (socket.readyState === 1) {
      socket.send(JSON.stringify(event));
    }
  });

  socket.on('close', () => {
    unsubscribe();
  });
});

server.listen(port, () => {
  console.log(`DES sim API listening on http://localhost:${port}`);
});
