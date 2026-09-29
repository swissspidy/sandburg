/** Renders a CompareReport as Markdown. */
import type { CompareReport, Rates } from './compare.ts';

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const sec = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

function ratesRow(name: string, r: Rates): string {
  return `| ${name} | ${r.n} | **${pct(r.agreement)}** | ${r.bothPass} | ${r.bothFail} | ${r.browserStricter} | ${r.browserLenient} |`;
}

export function renderReport(report: CompareReport, title = 'Sandburg fidelity report'): string {
  const t = report.timing;
  const lines = [
    `# ${title}`,
    '',
    `Generated ${report.createdAt}. Browser runtime: ${report.runtime}. Reference: ${report.reference}.`,
    '',
    '## Agreement (pass/fail per app)',
    '',
    '| Framework | Apps | Agreement | Both pass | Both fail | Browser stricter | Browser lenient |',
    '|---|---|---|---|---|---|---|',
    ...Object.entries(report.byFramework).map(([fw, r]) => ratesRow(fw, r)),
    ratesRow('**All**', report.overall),
    '',
    '"Browser stricter": the browser run failed and the reference passed (a false alarm if the browser is used as a pre-filter). ' +
      '"Browser lenient": the browser run passed and the reference failed (a missed failure).',
    '',
  ];
  if (report.groundTruth) {
    const g = report.groundTruth;
    lines.push(
      '## Against ground truth',
      '',
      `For ${g.n} apps with a known expected outcome (seeded faults), the browser run was right in **${pct(g.browserAccuracy)}** of apps and the Docker reference in **${pct(g.referenceAccuracy)}**.`,
      '',
    );
  }
  lines.push('## Disagreements by cause', '', '| Cause | Apps |', '|---|---|', ...Object.entries(report.causes).map(([c, n]) => `| \`${c}\` | ${n} |`), '');
  const dis = report.pairs.filter((p) => p.disagreement);
  if (dis.length) {
    lines.push('| App | Direction | Cause | Browser failure | Reference failure |', '|---|---|---|---|---|');
    for (const p of dis) {
      const b = p.browser.failedChecks.length ? `checks: ${p.browser.failedChecks.join(', ')}` : (p.browser.message ?? '');
      const r = p.reference.failedChecks.length ? `checks: ${p.reference.failedChecks.join(', ')}` : (p.reference.message ?? '');
      lines.push(`| ${p.label} | ${p.disagreement} | \`${p.cause}\` | ${escape(b)} | ${escape(r)} |`);
    }
    lines.push('');
  }
  if (report.excluded.length) {
    lines.push('## Excluded', '', 'The reference could not judge these apps (infrastructure errors):', '', ...report.excluded.map((e) => `- ${e.label}: ${escape(e.reason)}`), '');
  }
  lines.push(
    '## Time and cost per run',
    '',
    `Measured on one ${report.vcpus}-vCPU machine. Cost assumes $${report.vcpuHourUsd}/vCPU-hour and charges the whole machine for the batch's wall time.`,
    '',
    '| | Parallel | Median run | p90 run | Batch wall time | Machine time per app | Cost per app |',
    '|---|---|---|---|---|---|---|',
    `| Browser (${report.runtime}) | ${t.browser.parallel} | ${sec(t.browser.medianMs)} | ${sec(t.browser.p90Ms)} | ${sec(t.browser.wallMs)} | ${sec(t.browser.machineMsPerRun)} | $${t.browser.costUsdPerRun.toFixed(6)} |`,
    `| Reference (${report.reference}) | ${t.reference.parallel} | ${sec(t.reference.medianMs)} | ${sec(t.reference.p90Ms)} | ${sec(t.reference.wallMs)} | ${sec(t.reference.machineMsPerRun)} | $${t.reference.costUsdPerRun.toFixed(6)} |`,
    '',
  );
  return lines.join('\n');
}

function escape(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 200);
}
