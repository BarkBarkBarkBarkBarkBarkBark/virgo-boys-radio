/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ['@virgo-boys-radio/shared', '@virgo-boys-radio/ui'],
  // The workspace uses a custom root ESLint config (@typescript-eslint) rather
  // than eslint-config-next, so the Next.js lint rules (e.g. @next/next/*) are
  // not loaded during `next build`. Linting is run separately via `pnpm lint`;
  // don't let it block production builds.
  eslint: {
    ignoreDuringBuilds: true,
  },
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
    ];
  },
};

module.exports = nextConfig;
