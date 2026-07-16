import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const npmExecPath = process.env.npm_execpath;
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const temp = mkdtempSync(join(tmpdir(), 'folderforge pack ünicode-'));
let tarballPath;
let oauthChild;
let oauthAuthorizationServer;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHealth(url, child, getLogs) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Packed OAuth CLI exited early:
${getLogs()}`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // retry
    }
    await sleep(100);
  }
  throw new Error(`Packed OAuth CLI did not become healthy:
${getLogs()}`);
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  const exited = await Promise.race([
    new Promise((resolve) => child.once('exit', () => resolve(true))),
    sleep(3000).then(() => false),
  ]);
  if (!exited && child.exitCode === null) child.kill('SIGKILL');
}

function parseRpcResponse(text, contentType) {
  if (contentType.includes('text/event-stream')) {
    const data = text.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).filter(Boolean);
    if (!data.length) throw new Error(`Empty packed OAuth MCP response: ${text}`);
    return JSON.parse(data.at(-1));
  }
  return JSON.parse(text);
}

function run(command, args, options = {}) {
  const env = { ...process.env, ...options.env };
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) delete env[name];
  }
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    env,
    encoding: 'utf8',
    stdio: options.capture === false ? 'inherit' : 'pipe',
  });
  if (result.status !== 0 || result.error !== undefined) {
    throw new Error(
      `${command} ${args.join(' ')} failed with code ${result.status ?? 'unknown'}\n` +
        `${result.stdout ?? ''}\n${result.stderr ?? result.error?.message ?? ''}`
    );
  }
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function runNpm(args, options = {}) {
  const sanitizedOptions = {
    ...options,
    env: {
      ...options.env,
      npm_config_dry_run: undefined,
      NPM_CONFIG_DRY_RUN: undefined,
    },
  };
  if (npmExecPath && existsSync(npmExecPath)) {
    return run(process.execPath, [npmExecPath, ...args], sanitizedOptions);
  }
  if (process.platform === 'win32') {
    throw new Error('npm_execpath is required for Windows package smoke. Run via npm run smoke:package.');
  }
  return run(npm, args, sanitizedOptions);
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Could not allocate a temporary TCP port.'));
        return;
      }
      server.close((error) => (error ? reject(error) : resolvePort(address.port)));
    });
  });
}

try {
  const packed = runNpm(['pack', '--json', '--ignore-scripts']);
  const jsonStart = packed.stdout.indexOf('[');
  const jsonEnd = packed.stdout.lastIndexOf(']');
  if (jsonStart < 0 || jsonEnd < jsonStart) {
    throw new Error(`npm pack did not return JSON:\n${packed.stdout}`);
  }
  const packReport = JSON.parse(packed.stdout.slice(jsonStart, jsonEnd + 1));
  const entry = packReport[0];
  if (!entry?.filename || !Array.isArray(entry.files)) {
    throw new Error('npm pack report is missing filename/files metadata.');
  }

  tarballPath = join(root, entry.filename);
  const packagedFiles = new Set(entry.files.map((file) => file.path));
  for (const required of [
    'package.json',
    'README.md',
    'LICENSE',
    'dist/main.js',
    'dist/server/auth/oauth.js',
    'dist/chatgpt/cli.js',
    'docs/oauth.md',
    'docs/chatgpt-connect.md',
    'docs/adr-0004-oauth-resource-server.md',
  ]) {
    if (!packagedFiles.has(required)) {
      throw new Error(`Packed tarball is missing required file: ${required}`);
    }
  }

  writeFileSync(
    join(temp, 'package.json'),
    JSON.stringify({ name: 'folderforge-package-smoke', version: '0.0.0', private: true }, null, 2)
  );
  runNpm(
    ['install', '--ignore-scripts', '--no-audit', '--no-fund', tarballPath],
    { cwd: temp }
  );

  const installedRoot = join(temp, 'node_modules', '@musashishao', 'folderforge');
  const installedPackageJson = JSON.parse(
    readFileSync(join(installedRoot, 'package.json'), 'utf8')
  );
  if (installedPackageJson.scripts?.postinstall !== undefined) {
    throw new Error('Packed package still declares a postinstall lifecycle script.');
  }

  const binShim = join(
    temp,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'folderforge.cmd' : 'folderforge'
  );
  if (!existsSync(binShim)) {
    throw new Error(`npm did not create the expected FolderForge bin shim: ${binShim}`);
  }
  const installedCli = join(installedRoot, 'dist', 'main.js');
  if (!existsSync(installedCli)) {
    throw new Error(`Packed package is missing its installed CLI: ${installedCli}`);
  }
  const runCli = (args) => run(process.execPath, [installedCli, ...args], { cwd: temp });

  const version = runCli(['--version']).stdout.trim();
  const expected = `folderforge ${packageJson.version}`;
  if (version !== expected) {
    throw new Error(`CLI version mismatch: expected "${expected}", got "${version}".`);
  }

  const help = runCli(['--help']).stdout;
  for (const flag of [
    'doctor',
    'setup browser',
    'connect chatgpt',
    'chatgpt <command>',
    '--http',
    '--tools-preset',
    '--policy',
    '--auth <mode>',
    '--oauth-resource',
    '--oauth-issuer',
    '--oauth-resource-documentation',
    '--unsafe-oauth-http',
  ]) {
    if (!help.includes(flag)) throw new Error(`CLI help is missing ${flag}.`);
  }
  const chatgptHelp = runCli(['connect', 'chatgpt', '--help']).stdout;
  for (const text of ['--quick', '--secure', '--public-url', 'status|doctor|repair|start|stop|disconnect', 'never stores']) {
    if (!chatgptHelp.includes(text)) throw new Error(`Packed ChatGPT help is missing ${text}.`);
  }

  const setupOutput = runCli(['setup', 'browser', '--dry-run', '--json']).stdout;
  const setup = JSON.parse(setupOutput);
  if (
    setup.schemaVersion !== 1 ||
    setup.exitCode !== 0 ||
    setup.browser !== 'chromium' ||
    setup.dryRun !== true ||
    !Array.isArray(setup.args)
  ) {
    throw new Error(`Browser setup dry-run returned an invalid report: ${setupOutput}`);
  }
  if (setup.command !== process.execPath || setup.args.slice(1).join(' ') !== 'install chromium') {
    throw new Error(`Browser setup resolved an unexpected command: ${setupOutput}`);
  }
  const resolvedPlaywrightCli = setup.args[0];
  if (
    typeof resolvedPlaywrightCli !== 'string' ||
    !resolvedPlaywrightCli.includes(`${join('node_modules', 'playwright')}`) ||
    setupOutput.includes('npx')
  ) {
    throw new Error(`Browser setup did not use the installed package-local Playwright CLI: ${setupOutput}`);
  }

  const [httpPort, dashboardPort] = await Promise.all([freePort(), freePort()]);
  writeFileSync(
    join(temp, 'folderforge.yaml'),
    `server:\n  http:\n    host: 127.0.0.1\n    port: ${httpPort}\n  dashboard:\n    host: 127.0.0.1\n    port: ${dashboardPort}\n`
  );
  const doctorOutput = runCli(['doctor', '--json', '--project', temp]).stdout;
  const doctor = JSON.parse(doctorOutput);
  if (doctor.schemaVersion !== 1 || doctor.exitCode !== 0 || !Array.isArray(doctor.findings)) {
    throw new Error(`Doctor smoke returned an invalid report: ${doctorOutput}`);
  }
  for (const id of ['runtime.node', 'config.discovery', 'playwright.chromium', 'version.consistency']) {
    if (!doctor.findings.some((finding) => finding.id === id)) {
      throw new Error(`Doctor report is missing required finding: ${id}`);
    }
  }
  if (existsSync(join(temp, '.folderforge'))) {
    throw new Error('Doctor created .folderforge state during a read-only package smoke.');
  }

  if (!temp.includes(' ') || !temp.includes('ü')) {
    throw new Error(`Package smoke path did not preserve spaces and Unicode: ${temp}`);
  }

  // Start the CLI from the installed tarball in OAuth mode against a deterministic local AS.
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
  const publicJwk = { ...(await exportJWK(publicKey)), kid: 'packed-key-1', alg: 'RS256', use: 'sig' };
  const [issuerPort, oauthMcpPort] = await Promise.all([freePort(), freePort()]);
  const issuer = `http://127.0.0.1:${issuerPort}`;
  const oauthBase = `http://127.0.0.1:${oauthMcpPort}`;
  const resource = `${oauthBase}/mcp`;
  oauthAuthorizationServer = createHttpServer((req, res) => {
    const path = new URL(req.url ?? '/', issuer).pathname;
    if (path === '/.well-known/oauth-authorization-server') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code'],
        code_challenge_methods_supported: ['S256'],
        client_id_metadata_document_supported: true,
        token_endpoint_auth_methods_supported: ['none'],
      }));
      return;
    }
    if (path === '/jwks') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ keys: [publicJwk] }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => oauthAuthorizationServer.listen(issuerPort, '127.0.0.1', resolve));

  let oauthLogs = '';
  oauthChild = spawn(process.execPath, [
    installedCli,
    '--project', temp,
    '--http',
    '--host', '127.0.0.1',
    '--port', String(oauthMcpPort),
    '--no-dashboard',
    '--tools-preset', 'readonly',
    '--auth', 'oauth',
    '--oauth-resource', resource,
    '--oauth-issuer', issuer,
    '--oauth-scopes', 'folderforge:read,folderforge:write',
    '--oauth-client-registration', 'cimd',
    '--oauth-algorithms', 'RS256',
    '--oauth-resource-documentation', `${oauthBase}/oauth-docs`,
    '--unsafe-oauth-http',
  ], { cwd: temp, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const collectOauthLog = (chunk) => { oauthLogs = `${oauthLogs}${chunk.toString()}`.slice(-65536); };
  oauthChild.stdout.on('data', collectOauthLog);
  oauthChild.stderr.on('data', collectOauthLog);
  await waitForHealth(`${oauthBase}/healthz`, oauthChild, () => oauthLogs);

  const challenge = await fetch(`${resource}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  if (challenge.status !== 401 || !challenge.headers.get('www-authenticate')?.includes('resource_metadata=')) {
    throw new Error(`Packed OAuth CLI did not return the RFC 9728 challenge: ${challenge.status}`);
  }
  const metadata = await fetch(`${oauthBase}/.well-known/oauth-protected-resource/mcp`);
  const metadataBody = await metadata.json();
  if (
    metadata.status !== 200 ||
    metadataBody.resource !== resource ||
    metadataBody.resource_documentation !== `${oauthBase}/oauth-docs`
  ) {
    throw new Error(`Packed OAuth metadata mismatch: ${JSON.stringify(metadataBody)}`);
  }
  const now = Math.floor(Date.now() / 1000);
  const accessToken = await new SignJWT({ scope: 'folderforge:read', client_id: 'packed-chatgpt' })
    .setProtectedHeader({ alg: 'RS256', kid: 'packed-key-1', typ: 'at+jwt' })
    .setIssuer(issuer)
    .setAudience(resource)
    .setSubject('packed-user')
    .setIssuedAt(now)
    .setExpirationTime(now + 300)
    .sign(privateKey);
  const listResponse = await fetch(resource, {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
  });
  const listText = await listResponse.text();
  const listMessage = parseRpcResponse(listText, listResponse.headers.get('content-type') ?? '');
  if (!listResponse.ok || !Array.isArray(listMessage.result?.tools) || listMessage.result.tools.length === 0) {
    throw new Error(`Packed OAuth tools/list failed: ${listResponse.status} ${listText}`);
  }
  if (oauthLogs.includes(accessToken)) throw new Error('Packed OAuth CLI leaked the access token into logs.');
  await stopChild(oauthChild);
  oauthChild = undefined;
  await new Promise((resolve) => oauthAuthorizationServer.close(resolve));
  oauthAuthorizationServer = undefined;

  console.log(
    JSON.stringify(
      {
        ok: true,
        package: basename(tarballPath),
        version: packageJson.version,
        files: entry.files.length,
        installedTo: temp,
        pathHasSpaces: temp.includes(' '),
        pathHasUnicode: temp.includes('ü'),
        oauth: 'packed-cli-startup / metadata / 401-challenge / signed-token-tools-list',
      },
      null,
      2
    )
  );
} finally {
  await stopChild(oauthChild);
  if (oauthAuthorizationServer) {
    await new Promise((resolve) => oauthAuthorizationServer.close(resolve));
  }
  if (tarballPath) rmSync(tarballPath, { force: true });
  rmSync(temp, { recursive: true, force: true });
}
