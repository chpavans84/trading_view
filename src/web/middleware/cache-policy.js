/**
 * Explicit cache-policy middleware.
 *
 * Classifies every response by request path and sets Cache-Control headers
 * before any route handler runs. Routes that need a different policy (e.g.
 * SSE streams, /api/forecast 60 s cache) can override by calling
 * res.setHeader('Cache-Control', ...) after this middleware fires.
 *
 * Policy table
 * ─────────────────────────────────────────────────────────────────
 * /sw.js, /manifest.json          no-cache, no-store + Surrogate-Control: no-store
 * /api/*                          no-store
 * Versioned static assets         immutable, max-age=31536000 (1 year)
 *   (URL contains .v\d or a 7–40 char hex hash in the filename/query)
 * Other static assets             no-cache, must-revalidate (ETag-based)
 *   (.css .js .png .jpg .svg .woff2)
 * /images/*, /fonts/*             public, max-age=2592000 (30 days)
 * Everything else (HTML routes)   no-cache, must-revalidate
 * ─────────────────────────────────────────────────────────────────
 */

const NO_STORE     = 'no-store';
const NO_CACHE     = 'no-cache, must-revalidate';
const IMMUTABLE_1Y = 'public, max-age=31536000, immutable';
const REVALIDATE   = 'no-cache, must-revalidate';
const LONG_PUBLIC  = 'public, max-age=2592000';

// Matches ?v=20260520f, ?v=v25, or a 7–40 hex content hash in path/query
const VERSIONED_RE = /[?&]v=[^&]+|[/.]([0-9a-f]{7,40})\./i;

const STATIC_EXT_RE = /\.(css|js|png|jpg|jpeg|svg|webp|ico|woff2?)(\?|$)/i;

export function cachePolicy() {
  return function cachePolicyMiddleware(req, res, next) {
    const path = req.path;

    // Bootstrap files — must always be fresh; CDNs must not cache
    if (path === '/sw.js' || path === '/manifest.json') {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate, max-age=0');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      res.setHeader('Surrogate-Control', 'no-store');
      return next();
    }

    // API responses — never cache (SSE routes can override to 'no-cache')
    if (path.startsWith('/api/')) {
      res.setHeader('Cache-Control', NO_STORE);
      return next();
    }

    // Long-lived directories (project images, fonts)
    if (path.startsWith('/images/') || path.startsWith('/fonts/')) {
      res.setHeader('Cache-Control', LONG_PUBLIC);
      return next();
    }

    // Static asset extensions
    const fullUrl = path + (req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '');
    if (STATIC_EXT_RE.test(fullUrl)) {
      if (VERSIONED_RE.test(fullUrl)) {
        // Content-versioned — safe to cache forever
        res.setHeader('Cache-Control', IMMUTABLE_1Y);
      } else {
        // Unversioned static asset — revalidate on every request
        res.setHeader('Cache-Control', REVALIDATE);
      }
      return next();
    }

    // HTML routes and everything else — no heuristic caching
    res.setHeader('Cache-Control', NO_CACHE);
    next();
  };
}
