import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, isAbsolute } from 'node:path';

export const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));

export function loadConfig() {
  try {
    process.loadEnvFile(join(projectRoot, '.env'));
  } catch {
    // no .env file — env vars may still come from the environment itself
  }
  const config = JSON.parse(readFileSync(join(projectRoot, 'config.json'), 'utf8'));
  if (!isAbsolute(config.dbPath)) config.dbPath = join(projectRoot, config.dbPath);
  config.frontendUrl = `http://localhost:${config.port}`;
  config.toastScriptPath = join(projectRoot, 'src', 'toast.ps1');
  config.ntfyTopicDefault = process.env.NTFY_TOPIC || null;
  return config;
}

/** Official portal URL for a notice (uses the short id, e.g. "717600/4/2026"). */
export function officialNoticeUrl(baseUrl, shortId) {
  return `${baseUrl}portal/edital/${shortId}`;
}

/** Official portal URL for a lot within a notice. */
export function officialLotUrl(baseUrl, shortId, lotNumber) {
  return `${baseUrl}portal/edital/${shortId}/lote/${lotNumber}`;
}
