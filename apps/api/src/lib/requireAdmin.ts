import type { FastifyReply, FastifyRequest } from 'fastify';

declare module 'fastify' {
  interface Session {
    admin?: { username: string };
  }
}

/** All admin endpoints require a verified session, including DJ invitations. */
export async function requireAdmin(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const admin = request.session?.admin;
  if (!admin?.username) {
    reply.status(401).send({ error: 'Admin sign-in required' });
    return;
  }
  request.adminUsername = admin.username;
}

declare module 'fastify' {
  interface FastifyRequest {
    adminUsername?: string;
  }
}
