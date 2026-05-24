#!/usr/bin/env node

const { main } = require('./src/cli');

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
