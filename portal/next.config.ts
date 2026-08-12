import type { NextConfig } from "next";
import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";

// Portal reads the toolkit's own .env — one credentials file for the whole repo.
loadEnv({ path: resolve(import.meta.dirname, "../.env") });

const nextConfig: NextConfig = {};
export default nextConfig;
