#!/usr/bin/env node
/**
 * Push current HEAD to github.com/uberwinder/footprint-navigator main branch.
 * Uses GITHUB_PAT environment variable (stored in Replit Secrets).
 *
 * Usage: node scripts/push-github.mjs [commit message]
 */
import { execSync } from 'child_process';

const PAT = process.env.GITHUB_PAT;
if (!PAT) { console.error('GITHUB_PAT secret not set'); process.exit(1); }

const OWNER = 'uberwinder';
const REPO  = 'footprint-navigator';
const BASE  = 'https://api.github.com';
const headers = {
  'Authorization': `token ${PAT}`,
  'Accept': 'application/vnd.github.v3+json',
  'Content-Type': 'application/json',
  'User-Agent': 'footprint-push-script',
};

const message = process.argv[2] || `Sync from Replit — ${new Date().toISOString()}`;

async function api(path, method = 'GET', body) {
  const res = await fetch(`${BASE}${path}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`GitHub API ${method} ${path} → ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

console.log('Fetching current main branch state...');
const ref    = await api(`/repos/${OWNER}/${REPO}/git/refs/heads/main`);
const parentSha   = ref.object.sha;
const parentCommit = await api(`/repos/${OWNER}/${REPO}/git/commits/${parentSha}`);
const baseTreeSha = parentCommit.tree.sha;
console.log('Parent commit:', parentSha.slice(0, 8));

const files = execSync('git ls-files').toString().trim().split('\n').filter(Boolean);
console.log(`Uploading ${files.length} files as blobs...`);

const treeItems = [];
const skipped = [];
let done = 0;
for (const file of files) {
  let content;
  try { content = execSync(`git show HEAD:"${file}"`, { maxBuffer: 20 * 1024 * 1024 }).toString('base64'); }
  catch { skipped.push(`${file} (read error)`); continue; }

  const res = await fetch(`${BASE}/repos/${OWNER}/${REPO}/git/blobs`, {
    method: 'POST', headers, body: JSON.stringify({ content, encoding: 'base64' }),
  });
  const blob = await res.json();
  if (!res.ok) {
    // Secret scanning or other rejection — skip gracefully
    const reason = res.status === 422 ? 'secret scan' : `HTTP ${res.status}`;
    skipped.push(`${file} (${reason})`);
    continue;
  }
  treeItems.push({ path: file, mode: '100644', type: 'blob', sha: blob.sha });
  done++;
  if (done % 30 === 0) console.log(`  ${done}/${files.length}`);
}
console.log(`  ${done} uploaded, ${skipped.length} skipped`);
if (skipped.length) console.log('  Skipped:', skipped.join(', '));

const newTree   = await api(`/repos/${OWNER}/${REPO}/git/trees`,   'POST', { base_tree: baseTreeSha, tree: treeItems });
const newCommit = await api(`/repos/${OWNER}/${REPO}/git/commits`, 'POST', { message, tree: newTree.sha, parents: [parentSha] });
const updated   = await api(`/repos/${OWNER}/${REPO}/git/refs/heads/main`, 'PATCH', { sha: newCommit.sha, force: true });

console.log(`\n✓ Pushed to ${updated.ref}`);
console.log(`  Commit: ${newCommit.sha.slice(0, 8)} — ${message}`);
console.log(`  https://github.com/${OWNER}/${REPO}/commit/${newCommit.sha}`);
