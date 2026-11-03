import type { NextConfig } from 'next';

// API_ORIGIN (deploy): the browser calls /api on this site and Next forwards it to the API server, so no CORS is needed.
// Rewrites are fixed at build time. Embarko builds without env vars, so the deployed API address is committed here
// (a public value); Render and local runs still set API_ORIGIN themselves.
const EMBARKO_API_ORIGIN = 'https://workflow-poc-agentic-api.embarko.app';
const apiOrigin = process.env.API_ORIGIN || (process.env.NODE_ENV === 'production' ? EMBARKO_API_ORIGIN : '');

const nextConfig: NextConfig = {
  devIndicators: false, // the dev badge would overlap the embedded widget
  async rewrites() {
    return apiOrigin ? [{ source: '/api/:path*', destination: `${apiOrigin}/:path*` }] : [];
  },
};

export default nextConfig;
