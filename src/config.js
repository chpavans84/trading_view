/**
 * src/config.js
 *
 * Central config module. Reads process.env at import time, validates
 * required vars are present + non-empty, classifies optional features as
 * enabled or disabled, then exports a frozen object so downstream code
 * can't accidentally mutate it.
 *
 * MUST be imported by something that already ran src/core/env-loader.js
 * (which populates process.env from .env when the shell shadowed it as empty).
 * The entry points (src/server.js, src/web/server.js) take care of this.
 *
 * Behavior on missing REQUIRED vars:
 *   Logs every error, then process.exit(2) with a clear message.
 *   This is intentional — refusing to boot is safer than running half-broken.
 *
 * Behavior on missing RECOMMENDED vars:
 *   Logs warnings, continues booting. Feature is marked disabled in
 *   `config.features` so downstream code can branch on it.
 *
 * Usage:
 *   import { config } from '../config.js';
 *   if (config.features.uw) { ... }
 *   const url = config.databaseUrl;
 */

import { loadEnvOverride } from './core/env-loader.js';

// Make sure .env has been pulled in even if the caller forgot to import env-loader.
loadEnvOverride();

// ─── Schema ─────────────────────────────────────────────────────────────────
// Each entry: { key, required?, validate?, feature?, default? }
// `required: true` → boot fails if missing
// `recommended: true` → warn but continue; feature flag set to false
// `optional: true` → silent if missing
// `feature` → human label for "<feature> disabled because <key> not set"

const SCHEMA = [
  // ── Required for any operation ──────────────────────────────────────────
  { key: 'DATABASE_URL',         required: true,  feature: 'database' },
  { key: 'SESSION_SECRET',       required: true,  feature: 'sessions',
    validate: v => v.length < 32 ? 'must be at least 32 chars (use `openssl rand -hex 32`)' : null },
  { key: 'ANTHROPIC_API_KEY',    required: true,  feature: 'claude',
    validate: v => v.startsWith('sk-ant-') ? null : 'must start with "sk-ant-"' },

  // ── Required for the dashboard (web/server.js will need these) ──────────
  { key: 'DASHBOARD_PASSWORD',   required: true,  feature: 'dashboard_login' },
  { key: 'CREDENTIAL_ENCRYPTION_KEY', required: true, feature: 'credential_encryption',
    validate: v => v.length < 32 ? 'must be at least 32 hex chars (use `openssl rand -hex 32`)' : null },

  // ── Strongly recommended (degrade visibly when missing) ─────────────────
  { key: 'ALPACA_API_KEY',       recommended: true, feature: 'alpaca_paper' },
  { key: 'ALPACA_SECRET_KEY',    recommended: true, feature: 'alpaca_paper' },
  { key: 'ACTION_SIGNING_SECRET', recommended: true, feature: 'sentinel_one_click' },
  { key: 'RESEND_API',           recommended: true, feature: 'email_send' },

  // ── Live broker tier (alpaca live + tiger live) ─────────────────────────
  { key: 'ALPACA_LIVE_API_KEY',    optional: true,  feature: 'alpaca_live' },
  { key: 'ALPACA_LIVE_SECRET_KEY', optional: true,  feature: 'alpaca_live' },
  { key: 'TIGER_ID',               optional: true,  feature: 'tiger' },
  { key: 'TIGER_PRIVATE_KEY',      optional: true,  feature: 'tiger' },

  // ── Unusual Whales (graceful degradation when missing) ──────────────────
  { key: 'UW_API_KEY',           optional: true,  feature: 'unusual_whales' },
  { key: 'UW_WS_URL',            optional: true,  feature: 'unusual_whales_ws' },

  // ── Telegram bridge (opt-in via TELEGRAM_BOT_ENABLED) ───────────────────
  { key: 'TELEGRAM_BOT_ENABLED', optional: true,  feature: 'telegram',
    transform: v => v === '1' },
  { key: 'TELEGRAM_BOT_TOKEN',   optional: true,  feature: 'telegram' },
  { key: 'TELEGRAM_CHAT_ID',     optional: true,  feature: 'telegram' },
  { key: 'TELEGRAM_USERNAME',    optional: true,  feature: 'telegram' },
  { key: 'TELEGRAM_USERNAME_MAP', optional: true, feature: 'telegram' },
  { key: 'TELEGRAM_SHARED_HISTORY', optional: true, transform: v => v === '1' },

  // ── Push notifications (mobile PWA) ─────────────────────────────────────
  { key: 'VAPID_PUBLIC_KEY',     optional: true,  feature: 'push_notifications' },
  { key: 'VAPID_PRIVATE_KEY',    optional: true,  feature: 'push_notifications' },
  { key: 'VAPID_SUBJECT',        optional: true,  feature: 'push_notifications' },
  { key: 'WA_RP_NAME',           optional: true,  feature: 'webauthn' },

  // ── External data feeds ─────────────────────────────────────────────────
  { key: 'BENZINGA_API',         optional: true,  feature: 'benzinga' },

  // ── Moomoo OpenD ────────────────────────────────────────────────────────
  { key: 'MOOMOO_OPEND_HOST',    optional: true,  feature: 'moomoo' },
  { key: 'MOOMOO_OPEND_PORT',    optional: true,  feature: 'moomoo' },
  { key: 'MOOMOO_TRADE_ENV',     optional: true,  feature: 'moomoo' },
  { key: 'MOOMOO_TRADE_PASSWORD', optional: true, feature: 'moomoo' },

  // ── WhatsApp (Twilio) ───────────────────────────────────────────────────
  { key: 'TWILIO_ACCOUNT_SID',   optional: true,  feature: 'whatsapp' },
  { key: 'TWILIO_AUTH_TOKEN',    optional: true,  feature: 'whatsapp' },
  { key: 'TWILIO_FROM',          optional: true,  feature: 'whatsapp' },
  { key: 'TWILIO_TO',            optional: true,  feature: 'whatsapp' },

  // ── HTTPS termination (optional — usually behind a reverse proxy) ──────
  { key: 'HTTPS_PORT',           optional: true,  default: null },
  { key: 'SSL_CERT_PATH',        optional: true },
  { key: 'SSL_KEY_PATH',         optional: true },
  { key: 'PUBLIC_URL',           optional: true,  default: 'http://localhost:3000' },

  // ── Tunables with sensible defaults ─────────────────────────────────────
  { key: 'NODE_ENV',             optional: true,  default: 'development' },
  { key: 'DASHBOARD_PORT',       optional: true,  default: '3000' },
  { key: 'SECURE_COOKIE',        optional: true,  transform: v => v === '1' },
  { key: 'DAILY_API_CAP_USD',    optional: true,  default: '10', transform: v => Number(v) },
  { key: 'SENTINEL_DRIFT_TOLERANCE', optional: true, default: '0.10', transform: v => Number(v) },
  { key: 'REGIME_BOT_LIVE',      optional: true,  transform: v => v === '1' },
  { key: 'ALPACA_BASE_URL',      optional: true,  default: 'https://paper-api.alpaca.markets' },
  { key: 'OLLAMA_URL',           optional: true,  default: 'http://localhost:11434' },
  { key: 'OLLAMA_MODEL',         optional: true,  default: 'trading-coach' },
  { key: 'OLLAMA_KNOWLEDGE_MODEL', optional: true, default: 'llama3.2:3b' },

  // ── UW retention windows (days) ─────────────────────────────────────────
  { key: 'UW_FLOW_RETENTION_DAYS',         optional: true, default: '90' },
  { key: 'UW_MOVERS_RETENTION_DAYS',       optional: true, default: '30' },
  { key: 'UW_OPTIONS_FLOW_RETENTION_DAYS', optional: true, default: '90' },

  // ── Email allow-list (for the send_email AI tool) ───────────────────────
  { key: 'EMAIL_ALLOW_LIST',     optional: true },
  { key: 'ALERT_EMAIL',          recommended: true, feature: 'alert_emails' },
  { key: 'SENTINEL_EMAIL_TO',    optional: true },
  { key: 'RESEND_FROM',          optional: true,  default: 'info@dlpinnovations.com' },
];

// ─── Validation ─────────────────────────────────────────────────────────────
const errors  = [];
const warnings = [];
const featureStatus = {};   // feature_name → boolean
const values = {};

for (const def of SCHEMA) {
  const raw = process.env[def.key];
  const present = typeof raw === 'string' && raw.trim().length > 0;

  if (!present) {
    if (def.required) {
      errors.push(`MISSING REQUIRED: ${def.key} — needed for "${def.feature || def.key}"`);
    } else if (def.recommended) {
      warnings.push(`MISSING: ${def.key} — "${def.feature || def.key}" feature disabled`);
    }
    // Apply default if defined
    if (def.default !== undefined) {
      values[def.key] = def.transform ? def.transform(def.default) : def.default;
    } else {
      values[def.key] = null;
    }
    if (def.feature) featureStatus[def.feature] = featureStatus[def.feature] ?? false;
    continue;
  }

  // Present — validate
  const trimmed = raw.trim();
  if (def.validate) {
    const err = def.validate(trimmed);
    if (err) {
      errors.push(`INVALID ${def.key}: ${err}`);
      if (def.feature) featureStatus[def.feature] = false;
      continue;
    }
  }

  values[def.key] = def.transform ? def.transform(trimmed) : trimmed;
  if (def.feature) {
    // A feature is enabled only when all its keys are present + valid
    // (we set to true here; loop over remaining keys may set false below)
    featureStatus[def.feature] = featureStatus[def.feature] === false ? false : true;
  }
}

// ─── Report ─────────────────────────────────────────────────────────────────
if (errors.length) {
  console.error('━━━ [config] CRITICAL: missing or invalid required env vars ━━━');
  for (const e of errors) console.error('  ✗', e);
  console.error('Refusing to boot. Fix .env and try again.');
  process.exit(2);
}

if (warnings.length && process.env.NODE_ENV !== 'test') {
  console.warn('[config] ⚠ disabled features:');
  for (const w of warnings) console.warn('  ·', w);
}

// Summary line — helpful during boot diagnosis
const enabledFeatures = Object.entries(featureStatus).filter(([, on]) => on).map(([f]) => f);
if (process.env.NODE_ENV !== 'test') {
  console.log(`[config] ✓ ${enabledFeatures.length} features enabled: ${enabledFeatures.join(', ')}`);
}

// ─── Export ─────────────────────────────────────────────────────────────────
/**
 * The frozen config object. Downstream code should use this in preference to
 * process.env so unset/invalid vars are caught at boot, not at first use.
 */
export const config = Object.freeze({
  // Database
  databaseUrl: values.DATABASE_URL,

  // Sessions / auth
  sessionSecret:           values.SESSION_SECRET,
  dashboardPassword:       values.DASHBOARD_PASSWORD,
  credentialEncryptionKey: values.CREDENTIAL_ENCRYPTION_KEY,
  secureCookie:            values.SECURE_COOKIE === true,

  // External APIs
  anthropicApiKey:  values.ANTHROPIC_API_KEY,
  resendApiKey:     values.RESEND_API,
  resendFrom:       values.RESEND_FROM,
  benzingaApiKey:   values.BENZINGA_API,
  uwApiKey:         values.UW_API_KEY,
  uwWsUrl:          values.UW_WS_URL,

  // Brokers
  alpacaPaper: {
    apiKey:    values.ALPACA_API_KEY,
    secretKey: values.ALPACA_SECRET_KEY,
    baseUrl:   values.ALPACA_BASE_URL,
  },
  alpacaLive: {
    apiKey:    values.ALPACA_LIVE_API_KEY,
    secretKey: values.ALPACA_LIVE_SECRET_KEY,
  },
  tiger: {
    id:         values.TIGER_ID,
    privateKey: values.TIGER_PRIVATE_KEY,
  },
  moomoo: {
    host:     values.MOOMOO_OPEND_HOST,
    port:     values.MOOMOO_OPEND_PORT,
    tradeEnv: values.MOOMOO_TRADE_ENV,
    password: values.MOOMOO_TRADE_PASSWORD,
  },

  // Telegram
  telegram: {
    enabled:        values.TELEGRAM_BOT_ENABLED === true,
    token:          values.TELEGRAM_BOT_TOKEN,
    allowedChats:   (values.TELEGRAM_CHAT_ID || '').split(',').map(s => s.trim()).filter(Boolean),
    defaultUser:    values.TELEGRAM_USERNAME,
    usernameMapRaw: values.TELEGRAM_USERNAME_MAP,
    sharedHistory:  values.TELEGRAM_SHARED_HISTORY === true,
  },

  // Push / WebAuthn
  push: {
    vapidPublicKey:  values.VAPID_PUBLIC_KEY,
    vapidPrivateKey: values.VAPID_PRIVATE_KEY,
    vapidSubject:    values.VAPID_SUBJECT,
  },
  webauthn: { rpName: values.WA_RP_NAME ?? 'Trading Dashboard' },

  // Email
  email: {
    alertTo:       values.ALERT_EMAIL,
    sentinelTo:    values.SENTINEL_EMAIL_TO,
    allowList:     values.EMAIL_ALLOW_LIST,
  },

  // WhatsApp (Twilio)
  whatsapp: {
    accountSid: values.TWILIO_ACCOUNT_SID,
    authToken:  values.TWILIO_AUTH_TOKEN,
    from:       values.TWILIO_FROM,
    to:         values.TWILIO_TO,
  },

  // HTTPS / server
  publicUrl:    values.PUBLIC_URL,
  dashboardPort: Number(values.DASHBOARD_PORT),
  httpsPort:    values.HTTPS_PORT ? Number(values.HTTPS_PORT) : null,
  sslCertPath:  values.SSL_CERT_PATH,
  sslKeyPath:   values.SSL_KEY_PATH,

  // Ollama
  ollama: {
    url:            values.OLLAMA_URL,
    model:          values.OLLAMA_MODEL,
    knowledgeModel: values.OLLAMA_KNOWLEDGE_MODEL,
  },

  // Tunables
  nodeEnv:                  values.NODE_ENV,
  dailyApiCapUsd:           values.DAILY_API_CAP_USD,
  sentinelDriftTolerance:   values.SENTINEL_DRIFT_TOLERANCE,
  regimeBotLive:            values.REGIME_BOT_LIVE === true,
  actionSigningSecret:      values.ACTION_SIGNING_SECRET,

  // UW retention
  uwRetention: {
    flowDays:        Number(values.UW_FLOW_RETENTION_DAYS),
    moversDays:      Number(values.UW_MOVERS_RETENTION_DAYS),
    optionsFlowDays: Number(values.UW_OPTIONS_FLOW_RETENTION_DAYS),
  },

  // Feature flags (computed)
  features: Object.freeze({ ...featureStatus }),
});

/**
 * Convenience for tests + debugging.
 */
export function describeConfig() {
  return {
    enabledFeatures,
    disabledFeatures: Object.entries(featureStatus).filter(([, on]) => !on).map(([f]) => f),
    warnings,
  };
}
