/**
 * Dependency audit for CI: fails on any advisory of moderate severity or above, except the ones
 * listed below. Each exception names why it cannot be fixed yet and a date to look again; an
 * expired exception fails the audit, so none is forgotten.
 */
import { execFileSync } from 'node:child_process';

const EXCEPTIONS = [
  {
    // picomatch ReDoS with repeated extglobs. Reaches only build tools (Vite, Vitest, the
    // single-file plugin), which match glob patterns written in this repo, never user input.
    // No fixed picomatch exists yet (4.0.7 is the latest and affected); the shipped app
    // (`npm audit --omit=dev`) is clean.
    id: 'GHSA-fc5q-39xc-vjpf',
    until: '2026-12-31',
  },
];

const SEVERE = new Set(['moderate', 'high', 'critical']);

function auditReport() {
  try {
    return execFileSync('npm audit --json', { encoding: 'utf8', shell: true });
  } catch (error) {
    // npm audit exits non-zero when it finds anything; its JSON is still on stdout.
    if (typeof error.stdout === 'string' && error.stdout.trim()) return error.stdout;
    throw error;
  }
}

const report = JSON.parse(auditReport());
const today = new Date().toISOString().slice(0, 10);
const problems = [];

for (const exception of EXCEPTIONS) {
  if (exception.until < today)
    problems.push(`Exception ${exception.id} expired on ${exception.until}; check for a fix.`);
}

const allowed = new Set(EXCEPTIONS.map((e) => e.id));
for (const [name, vulnerability] of Object.entries(report.vulnerabilities ?? {})) {
  for (const via of vulnerability.via) {
    // A string means "vulnerable through that package"; the advisory itself is listed there.
    if (typeof via === 'string' || !SEVERE.has(via.severity)) continue;
    const id = String(via.url ?? '')
      .split('/')
      .pop();
    if (!allowed.has(id)) problems.push(`${name}: ${via.title} (${via.severity}) ${via.url}`);
  }
}

if (problems.length > 0) {
  console.error(`Dependency audit failed:\n${[...new Set(problems)].join('\n')}`);
  process.exit(1);
}
console.log(`Dependency audit passed (${EXCEPTIONS.length} listed exception(s)).`);
