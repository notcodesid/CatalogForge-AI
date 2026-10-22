import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  // pg-boss runs SQL migrations and timers, so load it with plain Node require instead of bundling it
  serverExternalPackages: ["pg-boss"],
  turbopack: {
    // The project folder is the root. Without this, a lockfile in a parent folder (e.g. the home folder) makes
    // Next.js guess the wrong root and warn
    root: __dirname,
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
