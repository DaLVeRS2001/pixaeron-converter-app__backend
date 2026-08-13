import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const bufCli = require.resolve('@bufbuild/buf/bin/buf');
const projectRoot = resolve(import.meta.dirname, '..');
const temporaryRoot = mkdtempSync(join(tmpdir(), 'pixaeron-contracts-'));

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    encoding: 'utf8',
    shell: false,
  });

  if (result.error) throw result.error;

  return result;
}

function runBuf(args) {
  return run(process.execPath, [bufCli, ...args]);
}

function commandOutput(result) {
  return result.stderr || result.stdout || '';
}

function checkContract() {
  const lint = runBuf(['lint']);
  if (lint.status !== 0) {
    process.stderr.write(commandOutput(lint));
    return lint.status ?? 1;
  }

  const generated = runBuf([
    'generate',
    '--template',
    'buf.gen.yaml',
    '--output',
    temporaryRoot,
  ]);
  if (generated.status !== 0) {
    process.stderr.write(commandOutput(generated));
    return generated.status ?? 1;
  }

  const expected = resolve(projectRoot, 'src/generated');
  const actual = resolve(temporaryRoot, 'src/generated');
  const diff = run('git', [
    'diff',
    '--no-index',
    '--exit-code',
    '--',
    expected,
    actual,
  ]);

  if (diff.status === 1) {
    process.stderr.write(
      'Generated notification contract is stale. Run: npm run contracts:generate\n',
    );
    process.stderr.write(diff.stdout);
    return 1;
  }
  if (diff.status !== 0) {
    process.stderr.write(commandOutput(diff));
    return diff.status ?? 1;
  }

  return 0;
}

try {
  process.exitCode = checkContract();
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
