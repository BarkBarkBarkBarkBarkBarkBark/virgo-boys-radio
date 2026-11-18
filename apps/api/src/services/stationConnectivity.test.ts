import assert from 'node:assert/strict';
import test from 'node:test';

process.env.SQLITE_DB_PATH = ':memory:';
process.env.APP_ENV = 'test';
process.env.ADMIN_USERS = 'operator:test-password';
process.env.SESSION_SECRET = 'a'.repeat(64);

const ops = await import('./stationConnectivity.js');
const clientId = 'localDiagnosticSession00001';

test('records listener lifecycle and correlates activity with observed IP', () => {
  assert.equal(ops.recordConnectivity({
    clientId, role: 'listener', event: 'play_requested', phase: 'connecting',
  }, '192.0.2.42'), true);
  assert.equal(ops.recordConnectivity({
    clientId, role: 'listener', event: 'playing', phase: 'playing',
    bufferedSeconds: 1.5, readyState: 4, networkState: 2,
  }, '192.0.2.42'), true);
  const events = ops.getConnectivityEvents(10, clientId) as Array<{ event: string; ip: string; bufferedSeconds: number }>;
  assert.equal(events.length, 2);
  assert.equal(events[0]?.event, 'playing');
  assert.equal(events[0]?.ip, '192.0.2.42');
  assert.equal(events[0]?.bufferedSeconds, 1.5);
  const clients = ops.getConnectivityClients() as Array<{ clientId: string; recentlyActive: number; ip: string }>;
  assert.equal(clients.find((client) => client.clientId === clientId)?.ip, '192.0.2.42');
  assert.equal(clients.find((client) => client.clientId === clientId)?.recentlyActive, 1);
});

test('cannot store credentials, arbitrary events or spoof IPs in payload', () => {
  assert.equal(ops.recordConnectivity({
    clientId, role: 'listener', event: 'arbitrary_command', phase: 'playing',
  }, '192.0.2.42'), false);
  assert.equal(ops.recordConnectivity({
    clientId, role: 'listener', event: 'error', phase: 'error',
    details: 'sample failure\nline2', bufferedSeconds: -10,
  }, 'injected-ip;DROP TABLE users'), true);
  const latest = (ops.getConnectivityEvents(1) as Array<{
    ip: string; details: string; bufferedSeconds: number | null;
  }>)[0]!;
  assert.equal(latest.ip, 'unknown');
  assert.equal(latest.details, 'sample failure line2');
  assert.equal(latest.bufferedSeconds, null);
});
