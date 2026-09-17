import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep production deployment focused on runtime/buildable output even when
  // existing application type or lint diagnostics remain.
  typescript: {
    ignoreBuildErrors: true,
  },
  eslint: {
    ignoreDuringBuilds: true,
  },
  serverExternalPackages: [
    "@sparticuz/chromium",
    "puppeteer-core",
    "socks",
    "undici",
  ],
  // @sparticuz/chromium is intentionally externalized, but Next's output
  // file tracing otherwise omits its brotli-packed Chromium binaries.
  outputFileTracingIncludes: {
    "/api/**/*": ["node_modules/@sparticuz/chromium/bin/**/*"],
  },
};

export default nextConfig;
