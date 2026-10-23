// Installed Playwright 1.52's TS ESM loader stalls on this Windows Node 24 runtime.
// Compile the unchanged config/specs to disposable CJS; run the same browser tests.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const esbuild = require('esbuild');
const root = path.resolve(__dirname, '..');
const compat = path.join(root, '.e2e-compat');
const specs = path.join(root, 'e2e');
fs.mkdirSync(compat, { recursive: true });

function compile(from, to) {
  esbuild.buildSync({ entryPoints: [from], outfile: to, bundle: true, platform: 'node', format: 'cjs', target: 'node18', external: ['@playwright/test'], sourcemap: 'inline' });
}
function discover(folder) {
  return fs.readdirSync(folder, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(folder, entry.name);
    return entry.isDirectory() ? discover(file) : /\.(spec|test)\.[cm]?[jt]sx?$/.test(entry.name) ? [file] : [];
  });
}
const compiled = discover(specs).map(file => {
  const name = path.relative(specs, file).replace(/[\\/]/g, '_').replace(/\.[cm]?[jt]sx?$/, '.cjs');
  compile(file, path.join(compat, name));
  return name;
});
const configFile = path.join(compat, 'compiled-config.cjs');
compile(path.join(root, 'playwright.config.ts'), configFile);
const loaded = require(configFile);
const config = loaded.default ?? loaded;
config.testDir = compat;
config.testMatch = compiled.map(name => `**/${name}`);
config.outputDir = path.join(root, 'test-results');
function quoted(value) {
  if (/["\r\n]/.test(value)) throw new Error('실행 경로에 허용되지 않는 문자가 있습니다.');
  return `"${value}"`;
}
const vite = `${quoted(process.execPath)} ${quoted(path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'))} --host 127.0.0.1`;
if (Array.isArray(config.webServer)) config.webServer = config.webServer.map(server => ({ ...server, command: vite, cwd: root }));
else if (config.webServer) config.webServer = { ...config.webServer, command: vite, cwd: root };
const runConfig = path.join(compat, 'run-config.cjs');
fs.writeFileSync(runConfig, `module.exports = ${JSON.stringify(config, null, 2)};\n`);
const result = spawnSync(process.execPath, [path.join(root, 'node_modules', '@playwright', 'test', 'cli.js'), 'test', '--config', runConfig, ...process.argv.slice(2)], {
  cwd: root,
  env: { ...process.env, PW_DISABLE_TS_ESM: '1' },
  stdio: 'inherit',
});
if (result.error) { console.error(result.error.message); process.exitCode = 1; }
else process.exitCode = result.status ?? 1;
