/** Browser-visible, non-secret locations only. NEVER expose streaming source passwords. */
export const PUBLIC_STREAM_URL = (process.env.NEXT_PUBLIC_STREAM_URL ?? '').trim();
export const USE_ICECAST = /^https?:\/\//i.test(PUBLIC_STREAM_URL);
export const BROADCAST_HOST = (process.env.NEXT_PUBLIC_BROADCAST_HOST ?? '').trim();
export const BROADCAST_PORT = (process.env.NEXT_PUBLIC_BROADCAST_PORT ?? '').trim();
export const BROADCAST_MOUNT = (process.env.NEXT_PUBLIC_BROADCAST_MOUNT ?? '/live').trim();
