import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

test('AWS collection failure releases the test lease and records an incomplete report', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-failure-'));
  try {
    fs.mkdirSync(path.join(dir, 'scripts'));
    fs.writeFileSync(path.join(dir, 'scripts/mock-remote.py'), `import json, sys
from pathlib import Path
op = sys.argv[1]
output = Path(sys.argv[sys.argv.index('--output') + 1])
if op == 'collect':
    sys.exit(1)
output.write_text(json.dumps({'operation': op}))
`);
    const meta = path.join(dir, 'run.meta.json');
    fs.writeFileSync(meta, JSON.stringify({ runId: 'fixture-run', createdAt: '2026-01-01T00:00:00Z', finishedAt: '2026-01-01T00:01:00Z' }));
    const result = spawnSync(process.execPath, ['tools/aws-monitor.js', 'end', meta], {
      encoding: 'utf8', env: { ...process.env, MOCK_INFRA_DIR: dir }, timeout: 10000,
    });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'run.monitor-finish.json'))).operation, 'finish');
    const report = JSON.parse(fs.readFileSync(path.join(dir, 'run.aws.json')));
    assert.equal(report.runId, 'fixture-run');
    assert.equal(report.series.length, 0);
    assert.match(report.errors.join(' '), /collect failed/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
