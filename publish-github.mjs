import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = dirname(fileURLToPath(import.meta.url));
const repository = 'CII-Joint-Lab-BIGC/dsh-collaborator';
const repositoryUrl = `https://github.com/${repository}`;
const version = '0.1.5';
const tag = `v${version}`;
const packageName = `dsh-collaborator-${version}.tgz`;
const expectedHash = '71140d10128bb2be96917f693656e19f28abd9657bf237f232377e46b8ef87fd';
const work = join(root, '.work', 'github-publish-20261117');
const packagePath = join(root, 'downloads', packageName);
const checksumPath = join(root, 'downloads', 'SHA256SUMS');
const notesPath = join(root, 'docs', 'RELEASE_0.1.5.md');
const args = process.argv.slice(2);
if (args.some(arg => arg !== '--check')) throw new Error('Only the optional --check flag is supported.');
const checkOnly = args.includes('--check');
const paths = [
  '.gitignore', 'README.md', 'README.en.md', 'CHANGELOG.md', 'package.json',
  'cordis.patch.yml', 'publish-github.mjs', 'screenshots.json', 'src/index.js', 'src/state.js',
  'src/interaction.js', 'prompts/collaborator.md', 'tests/integration.test.js',
  'tests/interaction.test.js', 'examples/acceptance.md',
  'docs/DEVELOPMENT.zh-CN.md', 'docs/RELEASE_0.1.5.md', 'downloads/SHA256SUMS',
  `downloads/${packageName}`, 'assets/poster-comic.png', 'assets/poster-features.png',
];

function run(command, commandArgs, { capture = false, allowFailure = false, input, env } = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: root, encoding: 'utf8', shell: false,
    stdio: capture || input !== undefined ? ['pipe', 'pipe', 'pipe'] : 'inherit',
    input, env: env ?? process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`${command} failed (${result.status}): ${(result.stderr ?? '').trim() || commandArgs.join(' ')}`);
  }
  return result;
}
const git = (commandArgs, options) => run('git', [
  '-c', 'http.sslBackend=openssl',
  '-c', 'credential.helper=',
  '-c', 'credential.helper=!gh auth git-credential',
  ...commandArgs,
], options);
const gh = (commandArgs, options) => run('gh', commandArgs, options);
const captureGit = commandArgs => git(commandArgs, { capture: true }).stdout.trim();
const captureGh = commandArgs => gh(commandArgs, { capture: true }).stdout.trim();
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const assert = (condition, message) => { if (!condition) throw new Error(message); };

function verifyFiles(requirePosters) {
  for (const path of paths) {
    if (!requirePosters && path.startsWith('assets/')) continue;
    assert(existsSync(join(root, path)), `Missing publication file: ${path}`);
  }
  assert(hash(packagePath) === expectedHash, 'The original plugin package checksum does not match.');
  assert(readFileSync(checksumPath, 'utf8').trim() === `${expectedHash}  ${packageName}`, 'Invalid SHA256SUMS.');
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert(manifest.name === 'dsh-collaborator' && manifest.version === version, 'Unexpected package identity.');
  const chinese = readFileSync(join(root, 'README.md'), 'utf8');
  const english = readFileSync(join(root, 'README.en.md'), 'utf8');
  assert(chinese.includes('href="./README.en.md"') && english.includes('href="./README.md"'), 'Missing language switches.');
  for (const text of [chinese, english]) {
    for (const poster of ['poster-comic.png', 'poster-features.png']) {
      assert(text.includes(`./assets/${poster}`), `Missing poster reference: ${poster}`);
    }
  }
  if (requirePosters) {
    for (const poster of ['poster-comic.png', 'poster-features.png']) {
      const bytes = readFileSync(join(root, 'assets', poster));
      assert(bytes.length > 24 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')), `Invalid PNG: ${poster}`);
      assert(bytes.readUInt32BE(16) === 1944 && bytes.readUInt32BE(20) === 809, `Unexpected poster dimensions: ${poster}`);
    }
  }
}

function verifyIndex() {
  const staged = captureGit(['diff', '--cached', '--name-only']).split(/\r?\n/).filter(Boolean);
  assert(staged.every(path => paths.includes(path)), 'Unrelated staged files found. No upload was attempted.');
  return staged;
}

function main() {
  verifyFiles(false);
  for (const source of ['src/index.js', 'src/state.js', 'src/interaction.js']) run(process.execPath, ['--check', source]);
  if (checkOnly) {
    console.log('Offline checks passed: source syntax, original package SHA-256, file list, poster references, and language switches.');
    console.log('No network request, commit, push, release, or settings change was made.');
    return;
  }
  assert(process.env.CODEX_SANDBOX_NETWORK_DISABLED !== '1', 'This execution environment disables networking. Run this command from your own PowerShell window.');
  assert(captureGit(['remote', 'get-url', 'origin']).replace(/\/$/, '') === `${repositoryUrl}.git`, 'Unexpected origin remote.');
  assert(resolve(captureGit(['rev-parse', '--show-toplevel'])).toLowerCase() === resolve(root).toLowerCase(), 'The project root is not the Git root.');
  verifyIndex();
  console.log('Checking the existing GitHub sign-in and fetching main...');
  gh(['auth', 'status', '--hostname', 'github.com']);
  git(['fetch', 'origin', 'main']);
  const hasHead = git(['rev-parse', '--verify', '--quiet', 'HEAD'], { capture: true, allowFailure: true }).status === 0;
  if (!hasHead) {
    // Set the remote initial commit as the local parent, preserving working files.
    git(['reset', '--mixed', 'refs/remotes/origin/main']);
  } else {
    const ancestor = git(['merge-base', '--is-ancestor', 'refs/remotes/origin/main', 'HEAD'], { capture: true, allowFailure: true });
    assert(ancestor.status === 0, 'Remote main has changes not present locally. Stopping without rewriting history.');
  }

  console.log('Preparing the two original posters...');
  mkdirSync(join(root, 'assets'), { recursive: true });
  for (const [index, name] of ['poster-comic.png', 'poster-features.png'].entries()) {
    const target = join(root, 'assets', name);
    if (existsSync(target)) continue;
    const transferFile = join(work, `transfer-${index}.json`);
    const helper = join(work, 'library-helper', 'library_file_transfer.py');
    assert(existsSync(transferFile) && existsSync(helper), `Restore the original poster at assets/${name} before retrying.`);
    const result = run('python', [helper, 'materialize', target], {
      capture: true, allowFailure: true, input: readFileSync(transferFile, 'utf8'),
      env: { ...process.env, PYTHONUTF8: '1' },
    });
    assert(result.status === 0, 'Poster download failed. Ask to refresh its temporary link; no content has been pushed.');
    console.log(`Ready: assets/${name}`);
  }
  verifyFiles(true);
  console.log('Committing only the reviewed publication files...');
  git(['add', '--', ...paths]);
  if (verifyIndex().length) {
    git(['-c', 'user.name=Roman', '-c', 'user.email=147357103+X-Roman-666@users.noreply.github.com',
      'commit', '-m', 'Publish DSH Collaborator with bilingual documentation, posters, and installable package']);
  }
  console.log('Pushing main without force...');
  git(['push', '-u', 'origin', 'HEAD:main']);
  const revision = captureGit(['rev-parse', 'HEAD']);
  const remoteRevision = captureGit(['ls-remote', 'origin', 'refs/heads/main']).split(/\s+/)[0];
  assert(revision === remoteRevision, 'Remote main does not match the local publication commit.');

  console.log('Publishing the original plugin package as a GitHub release...');
  const existing = gh(['release', 'view', tag, '--repo', repository, '--json', 'tagName,assets,url'], { capture: true, allowFailure: true });
  if (existing.status === 0) {
    const release = JSON.parse(existing.stdout);
    const names = new Set(release.assets.map(asset => asset.name));
    for (const [name, path] of [[packageName, packagePath], ['SHA256SUMS', checksumPath]]) {
      if (!names.has(name)) gh(['release', 'upload', tag, path, '--repo', repository]);
    }
  } else {
    gh(['release', 'create', tag, packagePath, checksumPath, '--repo', repository, '--target', 'main',
      '--title', `DSH Collaborator ${version}`, '--notes-file', notesPath, '--latest']);
  }
  const verification = join(work, 'release-verification');
  mkdirSync(verification, { recursive: true });
  gh(['release', 'download', tag, '--repo', repository, '--pattern', packageName, '--dir', verification, '--clobber']);
  assert(hash(join(verification, packageName)) === expectedHash, 'The release package checksum does not match. Existing assets were not overwritten.');
  console.log(`\nPublished and verified: ${repositoryUrl}`);
  console.log(`English: ${repositoryUrl}/blob/main/README.en.md`);
  console.log(`Download: ${repositoryUrl}/releases/download/${tag}/${packageName}`);
  console.log(`Commit: ${revision}`);
}

try { main(); }
catch (error) { console.error(`Publication stopped: ${error.message}`); process.exitCode = 1; }
