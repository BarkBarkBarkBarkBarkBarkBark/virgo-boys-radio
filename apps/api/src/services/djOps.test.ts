import { strict as assert } from 'node:assert';
import { test } from 'node:test';

process.env.SQLITE_DB_PATH = ':memory:';
process.env.APP_ENV = 'test';
process.env.ADMIN_USERS = 'operator:test-password';
process.env.SESSION_SECRET = 'a'.repeat(64);

const ops = await import('./djOps.js');
const { getDb } = await import('../db/client.js');

test('guest links and codes are hashed at rest, expire and can be revoked', () => {
  const invite = ops.createDjInvite('Demo DJ', 2);
  assert.match(invite.token, /^[a-f0-9]{64}$/);
  assert.match(invite.code, /^[A-HJ-NP-Z2-9]{12}$/);
  const record = getDb().prepare('SELECT token_sha256, code_sha256 FROM dj_invitations WHERE id = ?')
    .get(invite.id) as { token_sha256: string; code_sha256: string };
  assert.ok(record);
  assert.notEqual(record.token_sha256, invite.token);
  assert.notEqual(record.code_sha256, invite.code);

  assert.equal(ops.verifyDjCredential({ token: invite.token })?.label, 'Demo DJ');
  assert.equal(ops.verifyDjCredential({ code: invite.code.toLowerCase() })?.id, invite.id);
  assert.equal(ops.verifyDjCredential({ code: 'AAAAAAAAAAAA' }), null);
  assert.ok(ops.revokeDjInvite(invite.id));
  assert.equal(ops.verifyDjCredential({ token: invite.token }), null);
});

test('expired invitations never grant DJ access', () => {
  const invite = ops.createDjInvite('Expired', 1);
  getDb().prepare('UPDATE dj_invitations SET expires_at = ? WHERE id = ?')
    .run('2020-01-01T00:00:00Z', invite.id);
  assert.equal(ops.verifyDjCredential({ token: invite.token }), null);
});

test('audio and disconnect reasons persist in SQLite', () => {
  const id = ops.startDjMetrics('Test set', 123);
  ops.noteDjFrame(id, 4096, 120);
  ops.noteDjHeartbeat(id);
  const live = ops.getDjMetrics().live;
  assert.equal(live?.bytesReceived, 4096);
  assert.equal(live?.encoderPendingBytes, 120);
  ops.endDjMetrics(id, 'websocket_close_1006', 1006);
  const result = ops.getDjMetrics();
  assert.equal(result.live, null);
  assert.equal(result.recent[0]?.reason, 'websocket_close_1006');
  assert.equal(result.recent[0]?.bytesReceived, 4096);
  assert.equal(result.recent[0]?.closeCode, 1006);
});


test('browser backlog and dropped frames are recorded without trusting malformed counters', () => {
  const id = ops.startDjMetrics('Buffered set', 456);
  ops.noteDjClientDiagnostics(id, 5, 393216);
  assert.equal(ops.getDjMetrics().live?.browserDroppedFrames, 5);
  assert.equal(ops.getDjMetrics().live?.browserBufferedBytes, 393216);
  ops.noteDjClientDiagnostics(id, -500, -100);
  assert.equal(ops.getDjMetrics().live?.browserDroppedFrames, 5);
  assert.equal(ops.getDjMetrics().live?.browserBufferedBytes, 393216);
  ops.noteDjClientDiagnostics(id, 3, 65536);
  assert.equal(ops.getDjMetrics().live?.browserDroppedFrames, 5);
  assert.equal(ops.getDjMetrics().live?.browserBufferedBytes, 65536);
  ops.endDjMetrics(id, 'websocket_close_4008_uplink_queue_stalled', 4008);
  assert.equal(ops.getDjMetrics().recent.find((session) => session.id === id)?.closeCode, 4008);
});
