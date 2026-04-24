import type { LayoutDefinition, SimulationResult } from '@des-platform/shared-schema';

function formatSeconds(seconds: number): string {
  if (seconds >= 3600) {
    return `${(seconds / 3600).toFixed(2)} h`;
  }
  if (seconds >= 60) {
    return `${(seconds / 60).toFixed(1)} min`;
  }
  return `${seconds.toFixed(1)} s`;
}

function buildLayoutSvg(layout: LayoutDefinition): string {
  const width = 1180;
  const height = 420;
  const xScale = 12;
  const zScale = 14;
  const offsetX = 60;
  const offsetZ = 310;

  const toSvgX = (x: number) => offsetX + x * xScale;
  const toSvgY = (z: number) => offsetZ - z * zScale;

  const stationBlocks = layout.stations
    .map((station) => {
      const x = toSvgX(station.lineX);
      const y = toSvgY(0);
      const binA = station.binSlots[0]!;
      const binB = station.binSlots[1]!;
      return `
        <g>
          <rect x="${x - 20}" y="${y - 74}" width="40" height="24" rx="6" fill="#15263a" stroke="#3a5c86" />
          <text x="${x}" y="${y - 57}" text-anchor="middle" font-size="11" fill="#d6e7ff">${station.id}</text>
          <rect x="${toSvgX(binA.x) - 10}" y="${toSvgY(binA.z) - 10}" width="16" height="16" rx="3" fill="#63d36f" />
          <rect x="${toSvgX(binB.x) - 6}" y="${toSvgY(binB.z) - 10}" width="16" height="16" rx="3" fill="#bfc6d3" />
        </g>
      `;
    })
    .join('');

  const islands = layout.obstacles
    .map(
      (obstacle) => `
        <rect
          x="${toSvgX(obstacle.x) - (obstacle.width * xScale) / 2}"
          y="${toSvgY(obstacle.z) - (obstacle.depth * zScale) / 2}"
          width="${obstacle.width * xScale}"
          height="${obstacle.depth * zScale}"
          rx="8"
          fill="#f1b84c"
          opacity="0.85"
        />
      `
    )
    .join('');

  const walls = layout.walls
    .map(
      (wall) => `
        <rect
          x="${toSvgX(wall.x) - (wall.width * xScale) / 2}"
          y="${toSvgY(wall.z) - (wall.depth * zScale) / 2}"
          width="${wall.width * xScale}"
          height="${wall.depth * zScale}"
          fill="#34485e"
          opacity="0.5"
        />
      `
    )
    .join('');

  const graph = layout.aisleGraph.edges
    .map(([from, to]) => {
      const fromNode = layout.aisleGraph.nodes.find((node) => node.id === from)!;
      const toNode = layout.aisleGraph.nodes.find((node) => node.id === to)!;
      return `<line x1="${toSvgX(fromNode.x)}" y1="${toSvgY(fromNode.z)}" x2="${toSvgX(toNode.x)}" y2="${toSvgY(toNode.z)}" stroke="#4ecbff" stroke-width="2" stroke-dasharray="5 4" opacity="0.55" />`;
    })
    .join('');

  return `
    <svg viewBox="0 0 ${width} ${height}" width="100%" height="100%" xmlns="http://www.w3.org/2000/svg">
      <rect width="${width}" height="${height}" fill="#08111d" rx="18" />
      ${walls}
      <rect x="${toSvgX(layout.line.start.x)}" y="${toSvgY(0) - 14}" width="${(layout.line.end.x - layout.line.start.x) * xScale}" height="28" rx="14" fill="#2a3342" stroke="#5f6d80" />
      ${graph}
      ${islands}
      <rect x="${toSvgX(layout.facilities.supermarket.x) - 26}" y="${toSvgY(layout.facilities.supermarket.z) - 20}" width="52" height="34" rx="8" fill="#143d55" stroke="#4ecbff" />
      <text x="${toSvgX(layout.facilities.supermarket.x)}" y="${toSvgY(layout.facilities.supermarket.z) + 2}" text-anchor="middle" font-size="11" fill="#d6f5ff">Supermarket</text>
      <rect x="${toSvgX(layout.facilities.emptyReturn.x) - 26}" y="${toSvgY(layout.facilities.emptyReturn.z) - 20}" width="52" height="34" rx="8" fill="#3b283d" stroke="#ff8db3" />
      <text x="${toSvgX(layout.facilities.emptyReturn.x)}" y="${toSvgY(layout.facilities.emptyReturn.z) + 2}" text-anchor="middle" font-size="11" fill="#ffe3ec">Empty Return</text>
      ${stationBlocks}
    </svg>
  `;
}

export function renderReport(result: SimulationResult): string {
  const { kpis, scenario, layout, events, validation } = result;
  const taskCount = events.filter((event) => event.type === 'task-created').length;
  const starvationEvents = events.filter((event) => event.type === 'starvation-started').length;
  const finalSnapshot = result.snapshots.at(-1) ?? null;
  const taskFinishedByAmr = new Map<string, number>();
  const taskAssignedByAmr = new Map<string, number>();
  for (const event of events) {
    if (event.type !== 'task-finished' && event.type !== 'task-assigned') {
      continue;
    }

    const amrId = typeof event.payload.amrId === 'string' ? event.payload.amrId : null;
    if (!amrId) {
      continue;
    }

    const targetMap = event.type === 'task-finished' ? taskFinishedByAmr : taskAssignedByAmr;
    targetMap.set(amrId, (targetMap.get(amrId) ?? 0) + 1);
  }

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${scenario.name} Report</title>
    <style>
      :root {
        color-scheme: dark;
        --bg: #050a12;
        --panel: rgba(11, 18, 30, 0.88);
        --line: rgba(115, 152, 191, 0.22);
        --ink: #ecf4ff;
        --muted: #8fa4bd;
        --accent: #4ecbff;
        --warn: #f1b84c;
        --good: #63d36f;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: "IBM Plex Sans", "Avenir Next", "Segoe UI", sans-serif;
        background:
          radial-gradient(circle at top left, rgba(78, 203, 255, 0.12), transparent 30%),
          radial-gradient(circle at top right, rgba(241, 184, 76, 0.09), transparent 26%),
          var(--bg);
        color: var(--ink);
      }
      main {
        max-width: 1240px;
        margin: 0 auto;
        padding: 36px 28px 60px;
      }
      h1, h2, h3, p { margin: 0; }
      .hero {
        display: grid;
        grid-template-columns: 1.1fr 0.9fr;
        gap: 24px;
        margin-bottom: 28px;
      }
      .panel {
        border: 1px solid var(--line);
        background: var(--panel);
        border-radius: 24px;
        padding: 24px;
        backdrop-filter: blur(18px);
      }
      .eyebrow {
        color: var(--accent);
        font-size: 13px;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        margin-bottom: 12px;
      }
      .headline {
        font-size: clamp(34px, 4vw, 58px);
        line-height: 0.94;
        margin-bottom: 14px;
      }
      .lede {
        color: var(--muted);
        font-size: 15px;
        line-height: 1.6;
        max-width: 58ch;
      }
      .kpi-grid {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 14px;
        margin-top: 18px;
      }
      .kpi {
        border: 1px solid var(--line);
        border-radius: 18px;
        padding: 16px;
        background: rgba(255, 255, 255, 0.02);
      }
      .kpi b {
        display: block;
        font-size: 28px;
        margin-top: 6px;
      }
      .section-grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 24px;
        margin-top: 24px;
      }
      .table {
        width: 100%;
        border-collapse: collapse;
        font-size: 14px;
      }
      .table th,
      .table td {
        padding: 10px 0;
        border-bottom: 1px solid var(--line);
        text-align: left;
      }
      .table th { color: var(--muted); font-weight: 500; }
      .status-good { color: var(--good); }
      .status-warn { color: var(--warn); }
      .layout {
        min-height: 360px;
      }
      .list {
        display: grid;
        gap: 12px;
      }
      .list-row {
        display: flex;
        justify-content: space-between;
        border-bottom: 1px solid var(--line);
        padding-bottom: 10px;
      }
      .check-list {
        display: grid;
        gap: 12px;
      }
      .check {
        border: 1px solid var(--line);
        border-radius: 16px;
        padding: 14px 16px;
        background: rgba(255, 255, 255, 0.02);
      }
      .check header {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        margin-bottom: 8px;
      }
      .check p {
        color: var(--muted);
        font-size: 14px;
        line-height: 1.5;
      }
      @media (max-width: 900px) {
        .hero, .section-grid { grid-template-columns: 1fr; }
        .kpi-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      }
    </style>
  </head>
  <body>
    <main>
      <section class="hero">
        <div class="panel">
          <div class="eyebrow">DES Platform Baseline</div>
          <h1 class="headline">${scenario.name}</h1>
          <p class="lede">${scenario.description} The acceptance gate is steady-state 40 second cycle, 90 UPH, zero line downtime, and zero material starvation.</p>
          <div class="kpi-grid">
            <div class="kpi"><span>Steady cycle</span><b>${kpis.steadyStateCycleSec.toFixed(2)} s</b></div>
            <div class="kpi"><span>Steady UPH</span><b>${kpis.steadyStateUph.toFixed(2)}</b></div>
            <div class="kpi"><span>Actual avg UPH</span><b>${kpis.actualAverageUph.toFixed(2)}</b></div>
            <div class="kpi"><span>Downtime</span><b>${formatSeconds(kpis.lineDowntimeSec)}</b></div>
            <div class="kpi"><span>Starvation</span><b>${formatSeconds(kpis.starvationSec)}</b></div>
            <div class="kpi"><span>Baseline</span><b class="${kpis.baselinePass ? 'status-good' : 'status-warn'}">${kpis.baselinePass ? 'PASS' : 'FAIL'}</b></div>
          </div>
        </div>
        <div class="panel layout">
          ${buildLayoutSvg(layout)}
        </div>
      </section>
      <section class="section-grid">
        <div class="panel">
          <div class="eyebrow">Verification</div>
          <table class="table">
            <tbody>
              <tr><th>Completed cars</th><td>${kpis.completedCars}</td></tr>
              <tr><th>Released cars</th><td>${kpis.releasedCars}</td></tr>
              <tr><th>Total AMR distance</th><td>${kpis.totalAmrDistanceM.toFixed(1)} m</td></tr>
              <tr><th>Average task wait</th><td>${kpis.averageTaskWaitSec.toFixed(2)} s</td></tr>
              <tr><th>Average task cycle</th><td>${kpis.averageTaskCycleSec.toFixed(2)} s</td></tr>
              <tr><th>Max queue length</th><td>${kpis.maxQueueLength}</td></tr>
              <tr><th>Task count</th><td>${taskCount}</td></tr>
              <tr><th>Starvation events</th><td>${starvationEvents}</td></tr>
              <tr><th>Validation gate</th><td class="${validation.passed ? 'status-good' : 'status-warn'}">${validation.passed ? 'PASS' : 'FAIL'}</td></tr>
            </tbody>
          </table>
        </div>
        <div class="panel">
          <div class="eyebrow">Station Consumption</div>
          <div class="list">
            ${Object.entries(kpis.stationConsumption)
              .map(
                ([stationId, units]) => `
                  <div class="list-row">
                    <span>${stationId}</span>
                    <strong>${units} pcs</strong>
                  </div>
                `
              )
              .join('')}
          </div>
        </div>
      </section>
      <section class="section-grid">
        <div class="panel">
          <div class="eyebrow">AMR Utilization</div>
          <table class="table">
            <thead>
              <tr><th>AMR</th><th>Utilization</th><th>Assigned</th><th>Finished</th></tr>
            </thead>
            <tbody>
              ${Object.entries(kpis.amrUtilization)
                .map(
                  ([amrId, utilization]) => `
                    <tr>
                      <td>${amrId}</td>
                      <td>${(utilization * 100).toFixed(1)}%</td>
                      <td>${taskAssignedByAmr.get(amrId) ?? 0}</td>
                      <td>${taskFinishedByAmr.get(amrId) ?? 0}</td>
                    </tr>
                  `
                )
                .join('')}
            </tbody>
          </table>
        </div>
        <div class="panel">
          <div class="eyebrow">Scenario</div>
          <table class="table">
            <tbody>
              <tr><th>Duration</th><td>${formatSeconds(scenario.durationSec)}</td></tr>
              <tr><th>Takt</th><td>${scenario.taktTimeSec} s/car</td></tr>
              <tr><th>AMR count</th><td>${scenario.amr.count}</td></tr>
              <tr><th>AMR speed</th><td>${scenario.amr.speedMps} m/s</td></tr>
              <tr><th>Bin QPC</th><td>${scenario.stations.qpc.join(', ')}</td></tr>
              <tr><th>Breakdown enabled</th><td>${scenario.breakdown.enabled ? 'yes' : 'no'}</td></tr>
            </tbody>
          </table>
        </div>
      </section>
      <section class="section-grid">
        <div class="panel">
          <div class="eyebrow">Line-Side Material Capacity</div>
          <table class="table">
            <thead>
              <tr><th>Station</th><th>QPC</th><th>Bin A</th><th>Bin B</th><th>Total remaining</th></tr>
            </thead>
            <tbody>
              ${
                finalSnapshot
                  ? finalSnapshot.stations
                      .map((station) => {
                        const [binA, binB] = station.bins;
                        const totalQty = station.bins.reduce((sum, bin) => sum + bin.quantity, 0);
                        const totalCapacity = station.bins.reduce((sum, bin) => sum + bin.capacity, 0);
                        return `<tr><td>${station.id}</td><td>${station.qpc}</td><td>${binA?.quantity ?? 0}/${binA?.capacity ?? 0}</td><td>${binB?.quantity ?? 0}/${binB?.capacity ?? 0}</td><td>${totalQty}/${totalCapacity}</td></tr>`;
                      })
                      .join('')
                  : '<tr><td colspan="5">No final snapshot retained.</td></tr>'
              }
            </tbody>
          </table>
        </div>
        <div class="panel">
          <div class="eyebrow">Task Event Counts</div>
          <table class="table">
            <tbody>
              <tr><th>Bin emptied</th><td>${events.filter((event) => event.type === 'bin-emptied').length}</td></tr>
              <tr><th>Bin refilled</th><td>${events.filter((event) => event.type === 'bin-refilled').length}</td></tr>
              <tr><th>Tasks created</th><td>${taskCount}</td></tr>
              <tr><th>Tasks assigned</th><td>${events.filter((event) => event.type === 'task-assigned').length}</td></tr>
              <tr><th>Tasks finished</th><td>${events.filter((event) => event.type === 'task-finished').length}</td></tr>
              <tr><th>Station consumed</th><td>${events.filter((event) => event.type === 'station-consumed').length}</td></tr>
            </tbody>
          </table>
        </div>
      </section>
      <section class="section-grid">
        <div class="panel">
          <div class="eyebrow">Logic Validation</div>
          <div class="check-list">
            ${validation.checks
              .map(
                (check) => `
                  <article class="check">
                    <header>
                      <strong>${check.label}</strong>
                      <span class="${check.passed ? 'status-good' : 'status-warn'}">${check.passed ? 'PASS' : 'FAIL'}</span>
                    </header>
                    <p>${check.detail}</p>
                  </article>
                `
              )
              .join('')}
          </div>
        </div>
        <div class="panel">
          <div class="eyebrow">Acceptance Gate</div>
          <table class="table">
            <tbody>
              <tr><th>KPI gate</th><td class="${kpis.baselinePass ? 'status-good' : 'status-warn'}">${kpis.baselinePass ? 'PASS' : 'FAIL'}</td></tr>
              <tr><th>Validation gate</th><td class="${validation.passed ? 'status-good' : 'status-warn'}">${validation.passed ? 'PASS' : 'FAIL'}</td></tr>
              <tr><th>Warmup</th><td>${formatSeconds(scenario.report.warmupSec)}</td></tr>
              <tr><th>Consume events</th><td>${events.filter((event) => event.type === 'station-consumed').length}</td></tr>
              <tr><th>Task finished</th><td>${events.filter((event) => event.type === 'task-finished').length}</td></tr>
              <tr><th>Snapshots retained</th><td>${result.snapshots.length}</td></tr>
            </tbody>
          </table>
        </div>
      </section>
    </main>
  </body>
</html>`;
}
