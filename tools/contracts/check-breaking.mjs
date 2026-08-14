import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { relative, resolve, sep } from 'node:path';

const require = createRequire(import.meta.url);
const bufCli = require.resolve('@bufbuild/buf/bin/buf');
const projectRoot = process.cwd();
const workspaceRoot = resolve(projectRoot, '../..');
const contractPath = relative(workspaceRoot, projectRoot).split(sep).join('/');
const baseRef = process.env.NX_BASE?.trim() || 'main';

function runGit(args) {
  const result = spawnSync('git', args, {
    cwd: workspaceRoot,
    encoding: 'utf8',
    shell: false,
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout);
    process.exit(result.status ?? 1);
  }

  return result.stdout.trim();
}

const baseCommit = runGit(['rev-parse', '--verify', `${baseRef}^{commit}`]);
const baselineFiles = runGit([
  'ls-tree',
  '-r',
  '--name-only',
  baseCommit,
  '--',
  `${contractPath}/proto`,
]);
const hasBaseline = baselineFiles
  .split(/\r?\n/)
  .some((file) => file.endsWith('.proto'));

if (!hasBaseline) {
  console.log(
    `Skipping breaking check: ${baseRef} has no ${contractPath} baseline.`,
  );
  process.exit(0);
}

const against = `../../.git#ref=${baseCommit},subdir=${contractPath}`;
const result = spawnSync(
  process.execPath,
  [bufCli, 'breaking', '--against', against],
  {
    cwd: projectRoot,
    stdio: 'inherit',
    shell: false,
  },
);

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
