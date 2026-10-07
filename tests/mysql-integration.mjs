// Launches only a new, isolated mysqld; never connects to an existing service.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdir, mkdtemp, readFile, writeFile, rm, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../', import.meta.url));
const bin = process.env.RELAGRID_MYSQL_BIN;
const expected = process.env.RELAGRID_MYSQL_VERSION;
if (!bin || !expected || !/^\d+\.\d+\.\d+$/.test(expected)) {
  throw new Error(
    'Set RELAGRID_MYSQL_BIN and RELAGRID_MYSQL_VERSION (exact installed version). See docs/mysql-integration.md.',
  );
}
const executable = (name) => path.join(bin, name + (process.platform === 'win32' ? '.exe' : ''));
const active = new Set();
let interrupted = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    interrupted = true;
    for (const child of active) child.kill();
  });
}

async function command(exe, args, { input, env, timeout = 60_000 } = {}) {
  if (interrupted) throw new Error('Interrupted');
  const child = spawn(exe, args, {
    cwd: repo,
    env: env ?? process.env,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  active.add(child);
  let output = '';
  let errors = '';
  child.stdout.setEncoding('utf8').on('data', (s) => {
    output += s;
  });
  child.stderr.setEncoding('utf8').on('data', (s) => {
    errors += s;
  });
  child.stdin.on('error', () => {});
  child.stdin.end(input);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, timeout);
  try {
    const [code] = await once(child, 'close');
    if (code !== 0 || timedOut || interrupted) {
      // Do not include SQL input, arguments or environment: they can contain credentials.
      throw new Error(
        `${path.basename(exe)} failed (exit=${code}, timeout=${timedOut})\n${output}\n${errors}`,
      );
    }
    return output;
  } finally {
    clearTimeout(timer);
    active.delete(child);
  }
}

async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

const version = await command(executable('mysqld'), ['--no-defaults', '--version']);
if (!version.includes(`Ver ${expected} `))
  throw new Error(`Expected MySQL ${expected}, got ${version.trim()}`);
const root = await mkdtemp(path.join(tmpdir(), 'relagrid-mysql-'));
const reportDir = path.join(repo, 'test-results', `mysql-${path.basename(root)}`);
await mkdir(reportDir, { recursive: true });
const results = [];
let server;
let serverLog;
let logFile;
let serverDone;
let port;
const data = path.join(root, 'data');
const database = `relagrid_fixture_${randomBytes(8).toString('hex')}`;
const password = randomBytes(24).toString('hex');
const clientArgs = () => [
  '--no-defaults',
  '--no-login-paths',
  '--password=',
  '--protocol=TCP',
  '--host=127.0.0.1',
  `--port=${port}`,
  '--user=root',
  '--ssl-mode=DISABLED',
  '--default-character-set=utf8mb4',
  '--batch',
  '--raw',
  '--skip-column-names',
];
const sql = (input) => command(executable('mysql'), clientArgs(), { input, timeout: 10_000 });

async function stop() {
  if (server) {
    if (server.exitCode === null && server.signalCode === null) server.kill();
    await serverDone;
    active.delete(server);
    server = undefined;
  }
  if (serverLog) {
    await serverLog.close();
    serverLog = undefined;
  }
}

async function start(certificate) {
  await stop();
  port = await freePort();
  logFile = path.join(reportDir, `server-${certificate}.log`);
  serverLog = await open(logFile, 'w');
  server = spawn(
    executable('mysqld'),
    [
      '--no-defaults',
      ...(process.platform === 'win32'
        ? ['--no-monitor']
        : [`--socket=${path.join(root, 'mysql.sock')}`]),
      `--datadir=${data}`,
      `--port=${port}`,
      '--bind-address=127.0.0.1',
      '--mysqlx=OFF',
      '--skip-log-bin',
      '--default-time-zone=+00:00',
      '--console',
      `--ssl-ca=${path.join(root, 'ca.pem')}`,
      `--ssl-cert=${path.join(root, `${certificate}.pem`)}`,
      `--ssl-key=${path.join(root, 'key.pem')}`,
    ],
    { windowsHide: true, stdio: ['ignore', serverLog.fd, serverLog.fd] },
  );
  active.add(server);
  let spawnError;
  serverDone = new Promise((resolve) => {
    server.once('error', (error) => {
      spawnError = error;
      resolve();
    });
    server.once('close', resolve);
  });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (interrupted || spawnError || server.exitCode !== null || server.signalCode !== null) break;
    // Wait for this process to report readiness before sending any SQL to its port.
    const log = await readFile(logFile, 'utf8');
    if (log.includes('ready for connections')) {
      const actualData = (await sql('SELECT @@datadir;'))
        .trim()
        .replaceAll('\\', '/')
        .replace(/\/$/, '');
      if (actualData.toLowerCase() !== data.replaceAll('\\', '/').toLowerCase()) {
        throw new Error(
          'Port is not owned by the isolated data directory; refusing initialization',
        );
      }
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Isolated MySQL failed to start. See ${logFile}`);
}

try {
  const fixtures = path.join(repo, 'src-tauri', 'test-fixtures', 'tls');
  for (const cert of ['server', 'wrong-host', 'expired']) {
    const der = await readFile(path.join(fixtures, `${cert}.der`));
    await writeFile(
      path.join(root, `${cert}.pem`),
      `-----BEGIN CERTIFICATE-----\n${der
        .toString('base64')
        .match(/.{1,64}/g)
        .join('\n')}\n-----END CERTIFICATE-----\n`,
    );
  }
  const key = await readFile(path.join(fixtures, 'server-key.der'));
  await writeFile(
    path.join(root, 'key.pem'),
    `-----BEGIN PRIVATE KEY-----\n${key
      .toString('base64')
      .match(/.{1,64}/g)
      .join('\n')}\n-----END PRIVATE KEY-----\n`,
    { mode: 0o600 },
  );
  const ca = await readFile(path.join(fixtures, 'ca.pem'), 'utf8');
  await writeFile(path.join(root, 'ca.pem'), ca);
  console.log(`Initializing isolated MySQL ${expected}`);
  await command(
    executable('mysqld'),
    ['--no-defaults', '--initialize-insecure', `--datadir=${data}`, '--console'],
    { timeout: 120_000 },
  );
  await start('server');
  const actualVersion = (await sql('SELECT VERSION();')).trim();
  if (actualVersion !== expected) throw new Error(`Unexpected server version: ${actualVersion}`);
  const fixture = (
    await readFile(path.join(repo, 'tests', 'fixtures', 'schema.sql'), 'utf8')
  ).replaceAll('relagrid_fixture', database);
  await sql(
    fixture +
      `\nCREATE USER 'fixture_writer'@'127.0.0.1' IDENTIFIED BY '${password}';\nGRANT ALL ON ${database}.* TO 'fixture_writer'@'127.0.0.1';\nCREATE USER 'fixture_reader'@'127.0.0.1' IDENTIFIED BY '${password}';\nGRANT SELECT ON ${database}.* TO 'fixture_reader'@'127.0.0.1';\n`,
  );
  const env = {
    ...process.env,
    RELAGRID_TEST_ISOLATED: 'true',
    RELAGRID_TEST_HOST: '127.0.0.1',
    RELAGRID_TEST_DATABASE: database,
    RELAGRID_TEST_USERNAME: 'fixture_writer',
    RELAGRID_TEST_PASSWORD: password,
    RELAGRID_TEST_CA_PEM: ca,
    RELAGRID_TEST_SERVER_VERSION: actualVersion,
  };
  // Compile once; launching the test binary directly lets the timeout/signal own the actual process.
  const build = await command(
    'cargo',
    [
      'test',
      '--manifest-path',
      'src-tauri/Cargo.toml',
      '--lib',
      '--no-run',
      '--message-format=json',
    ],
    { timeout: 600_000 },
  );
  const testBinary = build
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .find(
      (item) =>
        item.reason === 'compiler-artifact' &&
        item.profile.test &&
        item.target.name === 'relagrid_lib' &&
        item.executable,
    )?.executable;
  if (!testBinary) throw new Error('Integration test binary not found');
  for (const scenario of ['plain', 'tls', 'wrong-host', 'expired']) {
    if (scenario === 'wrong-host' || scenario === 'expired') await start(scenario);
    const negative = scenario === 'wrong-host' || scenario === 'expired';
    const args = negative
      ? ['mysql_fixture_reject_invalid_tls', '--ignored', '--test-threads=1', '--nocapture']
      : [
          'mysql_fixture',
          '--ignored',
          '--skip',
          'mysql_fixture_reject_invalid_tls',
          '--test-threads=1',
          '--nocapture',
        ];
    console.log(`Testing MySQL ${actualVersion}: ${scenario}`);
    const output = await command(testBinary, args, {
      env: {
        ...env,
        RELAGRID_TEST_PORT: String(port),
        RELAGRID_TEST_TLS: String(scenario !== 'plain'),
      },
      timeout: 180_000,
    });
    await writeFile(path.join(reportDir, `${scenario}.log`), output);
    const match = output.match(/test result: ok\. (\d+) passed; 0 failed; 0 ignored;/);
    const minimum = negative ? 1 : 7;
    if (!match || Number(match[1]) < minimum)
      throw new Error(`Expected at least ${minimum} real DB tests in ${scenario}`);
    results.push({ scenario, version: actualVersion, passed: Number(match[1]) });
    console.log(`${scenario}: ${match[1]} passed`);
  }
} catch (error) {
  // Redact generated credentials even if a dependency echoed them in an error.
  const message = String(error.stack ?? error).replaceAll(password, '[redacted]');
  await writeFile(path.join(reportDir, 'failure.log'), message);
  console.error(message);
  process.exitCode = 1;
} finally {
  await stop();
  // root is the exact directory created by mkdtemp above; never accept an external cleanup path.
  if (
    path.dirname(root) !== path.resolve(tmpdir()) ||
    !path.basename(root).startsWith('relagrid-mysql-')
  ) {
    throw new Error('Refusing cleanup outside the generated temporary directory');
  }
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  await writeFile(
    path.join(reportDir, 'summary.json'),
    JSON.stringify({ results, success: !process.exitCode, cleanup: true }, null, 2),
  );
  console.log(`Isolated database removed. Results: ${reportDir}`);
}
