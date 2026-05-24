/**
 * src/web/routes/index.js
 *
 * Route-module aggregator. As routes are extracted from the 11k-line
 * server.js (review item #6), they get registered here. The main server
 * imports ONE function — registerExtractedRoutes(app, deps) — instead of
 * accumulating dozens of imports.
 *
 * Deps object documents what each route module is allowed to consume:
 *   { requireAuth, requireAdmin, query, ... }
 *
 * Order matters only if two modules register the same path — the FIRST
 * registration wins for Express. Keep the order alphabetical for clarity.
 */

import { registerNotesRoutes }        from './notes.js';
import { registerPushRoutes }         from './push.js';
import { registerRemindersRoutes }    from './reminders.js';
import { registerSentinelRoutes }     from './sentinel.js';
import { registerSystemAlertsRoutes } from './system-alerts.js';
import { registerWebAuthnRoutes }     from './webauthn.js';

export function registerExtractedRoutes(app, deps) {
  registerNotesRoutes(app, deps);
  registerPushRoutes(app, deps);
  registerRemindersRoutes(app, deps);
  registerSentinelRoutes(app, deps);
  registerSystemAlertsRoutes(app, deps);
  registerWebAuthnRoutes(app, deps);
}
