import type {
  GenericDesExperimentResult,
  GenericDesRunResult,
  GenericDesSweepResult,
  GenericMetricStats
} from '@des-platform/model-compiler';

export type GenericDesReportInput = GenericDesRunResult | GenericDesExperimentResult | GenericDesSweepResult;

type GenericMaterialSnapshot = NonNullable<GenericDesRunResult['snapshot']['materialHandling']>;

function escapeHtml(value: unknown): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) {
    return 'n/a';
  }
  if (Math.abs(value) >= 1000) {
    return value.toFixed(0);
  }
  if (Math.abs(value) >= 100) {
    return value.toFixed(1);
  }
  if (Math.abs(value) >= 10) {
    return value.toFixed(2);
  }
  return value.toFixed(3);
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function formatParameters(parameters: Record<string, unknown>): string {
  const entries = Object.entries(parameters);
  if (entries.length === 0) {
    return '<tr><td colspan="2">No parameters defined.</td></tr>';
  }

  return entries
    .map(([key, value]) => `<tr><th>${escapeHtml(key)}</th><td>${escapeHtml(JSON.stringify(value))}</td></tr>`)
    .join('');
}

function metricRows(metricStats: Record<string, GenericMetricStats>): string {
  return Object.values(metricStats)
    .map(
      (metric) => `
        <tr>
          <td>${escapeHtml(metric.metric)}</td>
          <td>${metric.count}</td>
          <td>${formatNumber(metric.mean)}</td>
          <td>${formatNumber(metric.standardDeviation)}</td>
          <td>${formatNumber(metric.halfWidth95)}</td>
          <td>${formatNumber(metric.min)}</td>
          <td>${formatNumber(metric.max)}</td>
        </tr>
      `
    )
    .join('');
}

function renderMaterialSvg(snapshot: GenericMaterialSnapshot | null): string {
  if (!snapshot || snapshot.nodes.length === 0) {
    return '<p class="muted">No material handling layout captured.</p>';
  }

  const minX = Math.min(...snapshot.nodes.map((node) => node.x), 0);
  const maxX = Math.max(...snapshot.nodes.map((node) => node.x), 1);
  const minZ = Math.min(...snapshot.nodes.map((node) => node.z), 0);
  const maxZ = Math.max(...snapshot.nodes.map((node) => node.z), 1);
  const width = 920;
  const height = 360;
  const pad = 48;
  const spanX = Math.max(1, maxX - minX);
  const spanZ = Math.max(1, maxZ - minZ);
  const scale = Math.min((width - pad * 2) / spanX, (height - pad * 2) / spanZ);
  const x = (value: number) => pad + (value - minX) * scale;
  const y = (value: number) => height - pad - (value - minZ) * scale;
  const nodesById = new Map(snapshot.nodes.map((node) => [node.id, node]));
  const paths = (snapshot.paths ?? [])
    .map((path) => {
      const from = nodesById.get(path.from);
      const to = nodesById.get(path.to);
      if (!from || !to) {
        return '';
      }
      return `<line x1="${x(from.x)}" y1="${y(from.z)}" x2="${x(to.x)}" y2="${y(to.z)}" stroke="#57728f" stroke-width="3" stroke-linecap="round" />`;
    })
    .join('');
  const conveyors = (snapshot.conveyors ?? [])
    .map((conveyor) => {
      const from = nodesById.get(conveyor.entryNodeId);
      const to = nodesById.get(conveyor.exitNodeId);
      if (!from || !to) {
        return '';
      }
      return `<line x1="${x(from.x)}" y1="${y(from.z)}" x2="${x(to.x)}" y2="${y(to.z)}" stroke="#d28a2e" stroke-width="5" stroke-linecap="round" stroke-dasharray="9 7" />`;
    })
    .join('');
  const nodes = snapshot.nodes
    .map((node) => {
      const fill = node.type === 'storage' ? '#2f7d62' : node.type === 'dock' ? '#4976b8' : node.type === 'home' ? '#6c5bb8' : '#556274';
      return `
        <g>
          <circle cx="${x(node.x)}" cy="${y(node.z)}" r="10" fill="${fill}" stroke="#d9e5f2" stroke-width="1.4" />
          <text x="${x(node.x)}" y="${y(node.z) - 15}" text-anchor="middle">${escapeHtml(node.id)}</text>
        </g>
      `;
    })
    .join('');
  const transporters = (snapshot.transporterUnits ?? [])
    .map((unit) => {
      const node = nodesById.get(unit.currentNodeId);
      if (!node) {
        return '';
      }
      return `
        <g>
          <rect x="${x(node.x) - 7}" y="${y(node.z) + 11}" width="14" height="14" rx="3" fill="${unit.status === 'idle' ? '#55b67a' : '#d28a2e'}" />
          <text x="${x(node.x)}" y="${y(node.z) + 38}" text-anchor="middle">${escapeHtml(unit.id)}</text>
        </g>
      `;
    })
    .join('');

  return `
    <svg class="layout" viewBox="0 0 ${width} ${height}" role="img" aria-label="Material handling layout">
      <rect width="${width}" height="${height}" fill="#101820" />
      ${paths}
      ${conveyors}
      ${nodes}
      ${transporters}
    </svg>
  `;
}

function renderRunSections(result: GenericDesRunResult): string {
  const blockRows = Object.entries(result.snapshot.blockStats)
    .map(
      ([id, stats]) => `
        <tr>
          <td>${escapeHtml(id)}</td>
          <td>${stats.entered}</td>
          <td>${stats.completed}</td>
          <td>${stats.maxQueueLength}</td>
        </tr>
      `
    )
    .join('');
  const resourceRows = result.snapshot.resourcePools
    .map(
      (pool) => `
        <tr>
          <td>${escapeHtml(pool.id)}</td>
          <td>${pool.capacity}</td>
          <td>${pool.available}</td>
          <td>${formatPercent(pool.utilization)}</td>
          <td>${pool.waiting.length}</td>
          <td>${formatNumber(pool.averageWaitTimeSec)} s</td>
          <td>${pool.maxQueueLength}</td>
        </tr>
      `
    )
    .join('');
  const transporterRows = result.snapshot.transporterFleetStats
    .map(
      (fleet) => `
        <tr>
          <td>${escapeHtml(fleet.fleetId)}</td>
          <td>${fleet.moveRequests}</td>
          <td>${fleet.completedMoves}</td>
          <td>${formatPercent(fleet.utilization)}</td>
          <td>${formatNumber(fleet.averageWaitTimeSec)} s</td>
          <td>${formatNumber(fleet.totalDistanceM)} m</td>
          <td>${formatNumber(fleet.totalEmptyDistanceM)} m</td>
          <td>${formatNumber(fleet.totalLoadedDistanceM)} m</td>
        </tr>
      `
    )
    .join('');
  const material = result.snapshot.materialHandling;

  return `
    <section class="grid">
      <article>
        <h2>Run KPIs</h2>
        <div class="kpis">
          <div><span>Created</span><b>${result.summary.createdEntities}</b></div>
          <div><span>Completed</span><b>${result.summary.completedEntities}</b></div>
          <div><span>Completion</span><b>${formatPercent(result.summary.completionRatio)}</b></div>
          <div><span>Avg Cycle</span><b>${formatNumber(result.summary.averageCycleTimeSec)} s</b></div>
          <div><span>Max Cycle</span><b>${formatNumber(result.summary.maxCycleTimeSec)} s</b></div>
          <div><span>Stopped By</span><b>${escapeHtml(result.summary.stoppedBy)}</b></div>
        </div>
      </article>
      <article>
        <h2>Parameters</h2>
        <table><tbody>${formatParameters(result.parameterValues)}</tbody></table>
      </article>
    </section>
    <section class="grid">
      <article>
        <h2>Process Blocks</h2>
        <table>
          <thead><tr><th>Block</th><th>Entered</th><th>Completed</th><th>Max Queue</th></tr></thead>
          <tbody>${blockRows}</tbody>
        </table>
      </article>
      <article>
        <h2>Resources</h2>
        <table>
          <thead><tr><th>Pool</th><th>Capacity</th><th>Available</th><th>Utilization</th><th>Waiting</th><th>Avg Wait</th><th>Max Queue</th></tr></thead>
          <tbody>${resourceRows || '<tr><td colspan="7">No resource pools.</td></tr>'}</tbody>
        </table>
      </article>
    </section>
    <section>
      <article>
        <h2>Transporter Fleets</h2>
        <table>
          <thead><tr><th>Fleet</th><th>Requests</th><th>Completed</th><th>Utilization</th><th>Avg Wait</th><th>Total Distance</th><th>Empty</th><th>Loaded</th></tr></thead>
          <tbody>${transporterRows || '<tr><td colspan="8">No transporter fleet activity.</td></tr>'}</tbody>
        </table>
      </article>
    </section>
    <section>
      <article>
        <h2>Material Handling Layout</h2>
        ${renderMaterialSvg(material)}
      </article>
    </section>
  `;
}

function renderExperimentSections(result: GenericDesExperimentResult): string {
  const replicationRows = result.replicationSummaries
    .map(
      (replication) => `
        <tr>
          <td>${replication.replicationIndex}</td>
          <td>${replication.seed}</td>
          <td>${replication.completedEntities}</td>
          <td>${formatNumber(replication.averageCycleTimeSec)}</td>
          <td>${escapeHtml(replication.stoppedBy)}</td>
        </tr>
      `
    )
    .join('');

  return `
    <section class="grid">
      <article>
        <h2>Experiment KPIs</h2>
        <div class="kpis">
          <div><span>Replications</span><b>${result.replications}</b></div>
          <div><span>Base Seed</span><b>${result.baseSeed}</b></div>
          <div><span>Completed Mean</span><b>${formatNumber(result.metricStats.completedEntities.mean)}</b></div>
          <div><span>Avg Cycle Mean</span><b>${formatNumber(result.metricStats.averageCycleTimeSec.mean)} s</b></div>
        </div>
      </article>
      <article>
        <h2>Parameters</h2>
        <table><tbody>${formatParameters(result.parameterValues)}</tbody></table>
      </article>
    </section>
    <section>
      <article>
        <h2>Metric Statistics</h2>
        <table>
          <thead><tr><th>Metric</th><th>N</th><th>Mean</th><th>Std Dev</th><th>95% Half Width</th><th>Min</th><th>Max</th></tr></thead>
          <tbody>${metricRows(result.metricStats)}</tbody>
        </table>
      </article>
    </section>
    <section>
      <article>
        <h2>Replications</h2>
        <table>
          <thead><tr><th>#</th><th>Seed</th><th>Completed</th><th>Avg Cycle</th><th>Stopped By</th></tr></thead>
          <tbody>${replicationRows}</tbody>
        </table>
      </article>
    </section>
  `;
}

function renderSweepSections(result: GenericDesSweepResult): string {
  const bestCase = [...result.cases].sort(
    (left, right) => left.metricStats.averageCycleTimeSec.mean - right.metricStats.averageCycleTimeSec.mean
  )[0];
  const rows = result.cases
    .map(
      (candidate) => `
        <tr>
          <td>${candidate.caseIndex}</td>
          <td><code>${escapeHtml(JSON.stringify(candidate.parameterValues))}</code></td>
          <td>${formatNumber(candidate.metricStats.completedEntities.mean)}</td>
          <td>${formatNumber(candidate.metricStats.averageCycleTimeSec.mean)}</td>
          <td>${formatNumber(candidate.metricStats.averageCycleTimeSec.halfWidth95)}</td>
        </tr>
      `
    )
    .join('');

  return `
    <section class="grid">
      <article>
        <h2>Sweep KPIs</h2>
        <div class="kpis">
          <div><span>Cases</span><b>${result.caseCount}</b></div>
          <div><span>Replications</span><b>${result.replications}</b></div>
          <div><span>Base Seed</span><b>${result.baseSeed}</b></div>
          <div><span>Best Case</span><b>${bestCase?.caseIndex ?? 'n/a'}</b></div>
        </div>
      </article>
      <article>
        <h2>Best Parameters</h2>
        <table><tbody>${bestCase ? formatParameters(bestCase.parameterValues) : '<tr><td>No cases.</td></tr>'}</tbody></table>
      </article>
    </section>
    <section>
      <article>
        <h2>Sweep Cases</h2>
        <table>
          <thead><tr><th>Case</th><th>Parameters</th><th>Completed Mean</th><th>Avg Cycle Mean</th><th>Avg Cycle 95% Half Width</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </article>
    </section>
  `;
}

function renderBody(result: GenericDesReportInput): string {
  switch (result.schemaVersion) {
    case 'des-platform.run.v1':
      return renderRunSections(result);
    case 'des-platform.experiment.v1':
      return renderExperimentSections(result);
    case 'des-platform.sweep.v1':
      return renderSweepSections(result);
    default:
      result satisfies never;
      return '';
  }
}

export function renderGenericDesReport(result: GenericDesReportInput): string {
  const title = `${result.modelName} / ${result.experimentName ?? result.experimentId}`;
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)} Report</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f5f7fa;
        --panel: #ffffff;
        --line: #d8e0ea;
        --ink: #18212c;
        --muted: #607084;
        --accent: #2d6cdf;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: Inter, "Avenir Next", "Segoe UI", sans-serif;
        background: var(--bg);
        color: var(--ink);
      }
      main {
        max-width: 1180px;
        margin: 0 auto;
        padding: 28px;
      }
      header {
        margin-bottom: 20px;
      }
      h1, h2, p { margin: 0; }
      h1 {
        font-size: 32px;
        line-height: 1.15;
      }
      h2 {
        font-size: 16px;
        margin-bottom: 14px;
      }
      .meta {
        color: var(--muted);
        margin-top: 8px;
      }
      section {
        margin-top: 18px;
      }
      .grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 18px;
      }
      article {
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: 8px;
        padding: 18px;
        overflow-x: auto;
      }
      .kpis {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 10px;
      }
      .kpis div {
        border: 1px solid var(--line);
        border-radius: 6px;
        padding: 12px;
        min-height: 74px;
      }
      .kpis span {
        display: block;
        color: var(--muted);
        font-size: 12px;
        margin-bottom: 6px;
      }
      .kpis b {
        font-size: 22px;
      }
      table {
        width: 100%;
        border-collapse: collapse;
        font-size: 14px;
      }
      th, td {
        padding: 9px 8px 9px 0;
        border-bottom: 1px solid var(--line);
        text-align: left;
        vertical-align: top;
      }
      th {
        color: var(--muted);
        font-weight: 600;
      }
      code {
        white-space: nowrap;
      }
      .layout {
        width: 100%;
        height: auto;
        border-radius: 6px;
        overflow: hidden;
      }
      .layout text {
        fill: #dce8f5;
        font-size: 12px;
      }
      .muted {
        color: var(--muted);
      }
      @media (max-width: 860px) {
        main { padding: 18px; }
        .grid { grid-template-columns: 1fr; }
        .kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      }
    </style>
  </head>
  <body>
    <main>
      <header>
        <h1>${escapeHtml(title)}</h1>
        <p class="meta">model=${escapeHtml(result.modelId)} experiment=${escapeHtml(result.experimentId)} schema=${escapeHtml(result.schemaVersion)}</p>
      </header>
      ${renderBody(result)}
    </main>
  </body>
</html>`;
}
