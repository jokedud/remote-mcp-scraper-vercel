import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
