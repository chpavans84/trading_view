/**
 * src/web/routes/webauthn.js
 *
 * WebAuthn (biometric / passkey) registration + authentication. Sets
 * `req.session.biometric_verified = true` on successful authentication,
 * which the order-confirmation flow checks before placing trades.
 *
 * Routes:
 *   POST /api/webauthn/register/begin       — emit challenge for new key
 *   POST /api/webauthn/register/finish      — verify + store credential
 *   POST /api/webauthn/authenticate/begin   — emit challenge for sign-in
 *   POST /api/webauthn/authenticate/finish  — verify + flip session flag
 */

import { query, isDbAvailable } from '../../core/db.js';

// Cache the @simplewebauthn/server import — heavy module, only load when WebAuthn
// is actually used (first request).
let _wa = null;
async function getWebAuthn() {
  if (_wa) return _wa;
  _wa = await import('@simplewebauthn/server');
  return _wa;
}

function getWaRpId() {
  try {
    const pub = process.env.PUBLIC_URL || 'http://localhost:3000';
    return new URL(pub).hostname;
  } catch {
    return 'localhost';
  }
}

export function registerWebAuthnRoutes(app, { requireAuth, port }) {
  const expectedOrigin = () => process.env.PUBLIC_URL || `http://localhost:${port}`;

  app.post('/api/webauthn/register/begin', requireAuth, async (req, res) => {
    if (!isDbAvailable()) return res.status(503).json({ error: 'DB unavailable' });
    const username = req.session.username;
    try {
      const wa = await getWebAuthn();
      const { rows: existing } = await query(
        'SELECT credential_id FROM webauthn_credentials WHERE username = $1',
        [username]
      );
      const excludeCredentials = existing.map(r => ({
        id:   r.credential_id,
        type: 'public-key',
      }));
      const options = await wa.generateRegistrationOptions({
        rpName:                 process.env.WA_RP_NAME || 'Trading Dashboard',
        rpID:                   getWaRpId(),
        userID:                 Buffer.from(username),
        userName:               username,
        attestationType:        'none',
        excludeCredentials,
        authenticatorSelection: { userVerification: 'required', residentKey: 'preferred' },
      });
      req.session.webauthn_challenge = options.challenge;
      res.json(options);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/webauthn/register/finish', requireAuth, async (req, res) => {
    if (!isDbAvailable()) return res.status(503).json({ error: 'DB unavailable' });
    const username  = req.session.username;
    const challenge = req.session.webauthn_challenge;
    if (!challenge) return res.status(400).json({ error: 'No challenge in session' });
    try {
      const wa = await getWebAuthn();
      const verification = await wa.verifyRegistrationResponse({
        response:                req.body,
        expectedChallenge:       challenge,
        expectedOrigin:          expectedOrigin(),
        expectedRPID:            getWaRpId(),
        requireUserVerification: true,
      });
      if (!verification.verified) return res.status(400).json({ error: 'Verification failed' });
      const { credentialID, credentialPublicKey, counter } = verification.registrationInfo;
      const deviceName = req.body.deviceName || req.headers['user-agent']?.slice(0, 80) || 'Unknown device';
      await query(
        `INSERT INTO webauthn_credentials (username, credential_id, public_key, counter, device_name)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (credential_id) DO UPDATE SET counter = $4`,
        [username, Buffer.from(credentialID), Buffer.from(credentialPublicKey), counter, deviceName]
      );
      delete req.session.webauthn_challenge;
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/webauthn/authenticate/begin', requireAuth, async (req, res) => {
    if (!isDbAvailable()) return res.status(503).json({ error: 'DB unavailable' });
    const username = req.session.username;
    try {
      const wa = await getWebAuthn();
      const { rows } = await query(
        'SELECT credential_id FROM webauthn_credentials WHERE username = $1',
        [username]
      );
      if (!rows.length) return res.status(404).json({ error: 'No credentials registered' });
      const allowCredentials = rows.map(r => ({ id: r.credential_id, type: 'public-key' }));
      const options = await wa.generateAuthenticationOptions({
        rpID:             getWaRpId(),
        allowCredentials,
        userVerification: 'required',
      });
      req.session.webauthn_challenge = options.challenge;
      res.json(options);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/webauthn/authenticate/finish', requireAuth, async (req, res) => {
    if (!isDbAvailable()) return res.status(503).json({ error: 'DB unavailable' });
    const username  = req.session.username;
    const challenge = req.session.webauthn_challenge;
    if (!challenge) return res.status(400).json({ error: 'No challenge in session' });
    try {
      const wa     = await getWebAuthn();
      const credId = Buffer.from(req.body.rawId || req.body.id, 'base64url');
      const { rows } = await query(
        'SELECT * FROM webauthn_credentials WHERE username = $1 AND credential_id = $2',
        [username, credId]
      );
      if (!rows.length) return res.status(404).json({ error: 'Credential not found' });
      const cred = rows[0];
      const verification = await wa.verifyAuthenticationResponse({
        response:                req.body,
        expectedChallenge:       challenge,
        expectedOrigin:          expectedOrigin(),
        expectedRPID:            getWaRpId(),
        authenticator: {
          credentialID:        cred.credential_id,
          credentialPublicKey: cred.public_key,
          counter:             Number(cred.counter),
        },
        requireUserVerification: true,
      });
      if (!verification.verified) return res.status(400).json({ error: 'Authentication failed' });
      await query(
        'UPDATE webauthn_credentials SET counter = $1 WHERE id = $2',
        [verification.authenticationInfo.newCounter, cred.id]
      );
      delete req.session.webauthn_challenge;
      req.session.biometric_verified = true;
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
}
