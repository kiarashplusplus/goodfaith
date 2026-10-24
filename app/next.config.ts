import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Self-contained server for the Docker image (app/Dockerfile copies .next/standalone).
  output: "standalone",
};

export default nextConfig;
