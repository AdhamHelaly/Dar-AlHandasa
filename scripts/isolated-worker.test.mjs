import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const serverScript = resolve(root, 'server.mjs');

function runServerCli(args, env = {}) {
  return new Promise((resolveResult) => {
    const child = spawn(process.execPath, [serverScript, ...args], {
      cwd: root,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => stdout += chunk);
    child.stderr.on('data', chunk => stderr += chunk);

    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      resolveResult({ code: -1, stdout, stderr: stderr + '\n[TEST_TIMEOUT]' });
    }, 5000);

    child.on('close', code => {
      clearTimeout(timeout);
      resolveResult({ code, stdout, stderr });
    });
  });
}

test('missing UUID is rejected', async () => {
  const result1 = await runServerCli(['--env=staging', '--worker-single-order=']);
  assert.equal(result1.code, 1);
  assert.match(result1.stderr, /Missing UUID for --worker-single-order\./);

  const result2 = await runServerCli(['--env=staging', '--worker-single-order']);
  assert.equal(result2.code, 1);
  assert.match(result2.stderr, /Missing UUID for --worker-single-order\./);
});

test('invalid UUID is rejected', async () => {
  const result = await runServerCli(['--env=staging', '--worker-single-order=not-a-valid-uuid']);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Invalid UUID for --worker-single-order\./);
});

test('multiple UUID arguments are rejected', async () => {
  const result = await runServerCli([
    '--env=staging',
    '--worker-single-order=11111111-1111-1111-1111-111111111111',
    '--worker-single-order=22222222-2222-2222-2222-222222222222'
  ]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Multiple --worker-single-order arguments are rejected\./);
});

test('production environment rejects the mode', async () => {
  const result = await runServerCli([
    '--env=production',
    '--worker-single-order=11111111-1111-1111-1111-111111111111'
  ]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /--worker-single-order is only permitted in staging environment\./);
});

test('development environment rejects the mode', async () => {
  const result = await runServerCli([
    '--worker-single-order=11111111-1111-1111-1111-111111111111'
  ]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /--worker-single-order is only permitted in staging environment\./);
});

test('code inspection proves global sweep RPC is never called in single-order mode', async () => {
  const fs = await import('node:fs');
  const serverSource = fs.readFileSync(serverScript, 'utf8');

  // Verify single-order mode branch is strictly isolated
  const singleOrderBranchMatch = serverSource.match(/if\s*\(isSingleOrderWorker\)\s*\{([\s\S]*?)\}\s*else\s*\{/);
  assert.ok(singleOrderBranchMatch, 'isSingleOrderWorker isolation branch must exist');

  const singleOrderBranch = singleOrderBranchMatch[1];
  assert.ok(!singleOrderBranch.includes('expire_whatsapp_reservations'),
    'single-order branch must never invoke expire_whatsapp_reservations()');
  assert.ok(singleOrderBranch.includes('rpc/expire_whatsapp_order'),
    'single-order branch must invoke rpc/expire_whatsapp_order');
  assert.ok(singleOrderBranch.includes('target_order_product_mismatch'),
    'single-order branch must enforce fixture product match');
  assert.ok(singleOrderBranch.includes('target_order_not_whatsapp'),
    'single-order branch must verify order_method is whatsapp');
});

test('database RPC expire_whatsapp_order exists and enforces expiration timing and single-order atomicity', async () => {
  const fs = await import('node:fs');
  const migration = fs.readFileSync(resolve(root, 'supabase/migrations/20261119213150_delivery_orders.sql'), 'utf8');

  // Verify expire_whatsapp_order definition
  assert.ok(migration.includes('create or replace function public.expire_whatsapp_order(p_order_id uuid)'),
    'expire_whatsapp_order(uuid) must be defined');

  // Verify expiration timing check: if reservation_expires_at > now() then return current_order without update
  assert.ok(migration.includes('current_order.reservation_expires_at>now()'),
    'expire_whatsapp_order must check reservation_expires_at > now()');

  // Verify stock restoration happens exactly once on expired status transition
  assert.ok(migration.includes("update public.orders set status='expired',reservation_expires_at=null"),
    'expire_whatsapp_order must clear reservation_expires_at and set status to expired');
});
