#!/usr/bin/env node
import { openDb } from './db.js';
import { loadConfig } from './config.js';
import { performRun } from './run.js';

const config = loadConfig();
const db = openDb(config.dbPath);

const log = (line) => console.log(`[${new Date().toISOString()}] ${line}`);

try {
  await performRun({ db, config, log });
} catch (error) {
  log(`run failed: ${error.stack}`);
  process.exitCode = 1;
} finally {
  db.close();
}
