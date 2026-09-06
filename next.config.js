const path = require("node:path");

/** @type {import('next').NextConfig} */
const nextConfig = {
  outputFileTracingRoot: path.join(__dirname),
  output: "standalone"
};

module.exports = nextConfig;
