import { timingSafeEqual } from 'node:crypto';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { createDjInvite, getDjMetrics, listDjInvites, revokeDjInvite } from '../../services/djOps.js';

const Login = z.object({ password: z.string().min(1).max(150) });
const Invite = z.object({ label: z.string().max(70).default('Guest DJ'), hours: z.number().int().min(1).max(168).default(24) });

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

async function requireOps(request: FastifyRequest, reply: FastifyReply) {
  const expected = process.env.OPS_SHARED_SECRET ?? '';
  const submitted = request.headers['x-station-ops-key'];
  if (!/^[0-9a-f]{64}$/i.test(expected) || typeof submitted !== 'string' || !safeEqual(expected, submitted)) {
    reply.code(403).send({ error: 'Forbidden' });
  }
}

async function readIcecastStatus() {
  try {
    const response = await fetch('http://127.0.0.1:8000/status-json.xsl', {
      signal: AbortSignal.timeout(2500),
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) return { reachable: false, sourceConnected: false, listeners: 0, bitrateKbps: null };
    const data = await response.json() as {
      icestats?: { source?: { listenurl?: string; listeners?: number; bitrate?: number; audio_info?: string } | Array<{ listenurl?: string; listeners?: number; bitrate?: number; audio_info?: string }> };
    };
    const source = data.icestats?.source;
    const sources = source ? (Array.isArray(source) ? source : [source]) : [];
    const live = sources.find((s) => s.listenurl?.includes('/radio.mp3')) ?? sources[0];
    return {
      reachable: true, sourceConnected: Boolean(live), listeners: Number(live?.listeners ?? 0),
      bitrateKbps: live?.bitrate ?? null, audioInfo: live?.audio_info ?? null,
    };
  } catch {
    return { reachable: false, sourceConnected: false, listeners: 0, bitrateKbps: null };
  }
}

const opsRoute: FastifyPluginAsync = async (fastify) => {
  fastify.post('/ops/login', {
    config: { rateLimit: { max: 5, timeWindow: '5 minutes' } },
  }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const parsed = Login.safeParse(request.body);
    const expected = process.env.OPS_ADMIN_PASSWORD ?? '';
    if (!parsed.success || !expected || !safeEqual(parsed.data.password, expected)) {
      return reply.code(401).send({ error: 'Invalid admin password' });
    }
    return reply.send({ ok: true });
  });

  fastify.get('/ops/metrics', { preHandler: requireOps }, async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return reply.send({ ...getDjMetrics(), icecast: await readIcecastStatus() });
  });
  fastify.get('/ops/invites', { preHandler: requireOps }, async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return reply.send({ invites: listDjInvites() });
  });
  fastify.post('/ops/invites', {
    preHandler: requireOps,
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const parsed = Invite.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid invitation request' });
    reply.header('Cache-Control', 'no-store');
    return reply.send({ invite: createDjInvite(parsed.data.label, parsed.data.hours) });
  });
  fastify.post('/ops/invites/:id/revoke', { preHandler: requireOps }, async (request, reply) => {
    const id = (request.params as { id?: string }).id ?? '';
    reply.header('Cache-Control', 'no-store');
    if (!revokeDjInvite(id)) return reply.code(404).send({ error: 'Invitation not found or already revoked' });
    return reply.send({ ok: true });
  });
};

export default opsRoute;
