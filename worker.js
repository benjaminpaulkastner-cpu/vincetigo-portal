import { cors } from 'hono/cors';
import { Hono } from 'hono';

const app = new Hono();

/**
 * @typedef {'resident' | 'admin'} UserRole
 * @typedef {{ id: string, email: string, role: UserRole, password_hash: string | null }} UserRecord
 * @typedef {{ sub: string, email: string, role: UserRole, iss: string, aud: string, iat: number, exp: number }} SessionPayload
 * @typedef {{ id: string, unit: string, title: string, category: string, priority: string, status: string, date: string, assignee: string, notes: string }} DispatchTicket
 */

const bindings = {
  STRIPE_SECRET_KEY: 'STRIPE_SECRET_KEY',
  PLAID_CLIENT_ID: 'PLAID_CLIENT_ID',
  PLAID_SECRET: 'PLAID_SECRET',
  PLAID_ENV: 'PLAID_ENV',
  FRONTEND_ORIGINS: 'FRONTEND_ORIGINS',
  PUBLIC_APP_URL: 'PUBLIC_APP_URL',
  JWT_SECRET: 'JWT_SECRET',
  ADMIN_INITIAL_PASSWORD: 'ADMIN_INITIAL_PASSWORD',
};

const SESSION_ISSUER = 'https://api.vincetigo.com';
const SESSION_AUDIENCE = 'vincetigo-portal';
const SESSION_TTL_SECONDS = 60 * 60 * 8;
const PASSWORD_ITERATIONS = 120_000;
const TICKET_STATUSES = new Set([
  'Submitted',
  'Under Review',
  'Contractor Dispatched',
  'In Progress',
  'Completed',
]);

function configuredOrigins(env) {
  const configured = (env[bindings.FRONTEND_ORIGINS] || '')
    .split(',')
    .map((origin) => origin.trim());

  return [
    ...configured,
    'http://localhost:8000',
    'http://127.0.0.1:8000',
    'http://localhost:5502',
    'http://127.0.0.1:5502',
  ].filter(Boolean);
}

app.use('*', async (c, next) => cors({
  origin: (origin) => configuredOrigins(c.env).includes(origin) ? origin : '',
  allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
})(c, next));

function requireBinding(env, name) {
  const value = env[name];
  if (!value) throw new Error(`Missing Worker binding: ${name}`);
  return value;
}

function getDatabase(env) {
  if (!env.DB) throw new Error('Missing Worker binding: DB');
  return env.DB;
}

function encodeBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function decodeBase64Url(value) {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function encodeJson(value) {
  return encodeBase64Url(new TextEncoder().encode(JSON.stringify(value)));
}

function decodeJson(value) {
  return JSON.parse(new TextDecoder().decode(decodeBase64Url(value)));
}

async function passwordDigest(password, salt, iterations = PASSWORD_ITERATIONS) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    key,
    256,
  );
  return new Uint8Array(bits);
}

async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const digest = await passwordDigest(password, salt);
  return `pbkdf2-sha256$${PASSWORD_ITERATIONS}$${encodeBase64Url(salt)}$${encodeBase64Url(digest)}`;
}

async function verifyPassword(password, encodedHash) {
  const [algorithm, iterationText, saltText, digestText] = String(encodedHash || '').split('$');
  const iterations = Number(iterationText);
  if (algorithm !== 'pbkdf2-sha256' || !Number.isInteger(iterations) || iterations < 100_000 || iterations > 1_000_000 || !saltText || !digestText) {
    return false;
  }

  const expected = decodeBase64Url(digestText);
  const actual = await passwordDigest(password, decodeBase64Url(saltText), iterations);
  return expected.length === actual.length && crypto.subtle.timingSafeEqual(expected, actual);
}

async function matchesSecret(provided, expected) {
  const encoder = new TextEncoder();
  const [providedDigest, expectedDigest] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(provided)),
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(providedDigest, expectedDigest);
}

async function importSessionKey(env) {
  const secret = requireBinding(env, bindings.JWT_SECRET);
  if (secret.length < 32) throw new Error('JWT_SECRET must be at least 32 characters long');
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

async function createSessionToken(env, user) {
  const now = Math.floor(Date.now() / 1000);
  const header = encodeJson({ alg: 'HS256', typ: 'JWT' });
  /** @type {SessionPayload} */
  const payload = {
    sub: user.id,
    email: user.email,
    role: user.role,
    iss: SESSION_ISSUER,
    aud: SESSION_AUDIENCE,
    iat: now,
    exp: now + SESSION_TTL_SECONDS,
  };
  const body = `${header}.${encodeJson(payload)}`;
  const signature = await crypto.subtle.sign('HMAC', await importSessionKey(env), new TextEncoder().encode(body));
  return `${body}.${encodeBase64Url(new Uint8Array(signature))}`;
}

async function verifySessionToken(env, token) {
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  try {
    const [headerPart, payloadPart, signaturePart] = parts;
    const header = decodeJson(headerPart);
    const payload = decodeJson(payloadPart);
    if (header.alg !== 'HS256' || header.typ !== 'JWT') return null;
    const signatureValid = await crypto.subtle.verify(
      'HMAC',
      await importSessionKey(env),
      decodeBase64Url(signaturePart),
      new TextEncoder().encode(`${headerPart}.${payloadPart}`),
    );
    const now = Math.floor(Date.now() / 1000);
    if (
      !signatureValid
      || typeof payload.sub !== 'string'
      || typeof payload.email !== 'string'
      || !['resident', 'admin'].includes(payload.role)
      || payload.iss !== SESSION_ISSUER
      || payload.aud !== SESSION_AUDIENCE
      || !Number.isInteger(payload.exp)
      || payload.exp <= now
      || !Number.isInteger(payload.iat)
      || payload.iat > now + 60
    ) return null;

    return /** @type {SessionPayload} */ (payload);
  } catch {
    return null;
  }
}

async function getBearerSession(c) {
  const authorization = c.req.header('Authorization') || '';
  const match = authorization.match(/^Bearer ([^\s]+)$/i);
  if (!match) return null;
  return verifySessionToken(c.env, match[1]);
}

async function requireAdmin(c, next) {
  const payload = await getBearerSession(c);
  if (!payload) return c.json({ error: 'Authentication required' }, 401);
  c.set('jwtPayload', payload);
  if (c.get('jwtPayload')?.role !== 'admin') return c.json({ error: 'Unauthorized access' }, 403);

  const user = await getDatabase(c.env)
    .prepare('SELECT id, email, role FROM users WHERE id = ?')
    .bind(payload.sub)
    .first();
  if (!user) return c.json({ error: 'Authentication required' }, 401);
  if (user.role !== 'admin') return c.json({ error: 'Unauthorized access' }, 403);

  c.set('sessionUser', /** @type {UserRecord} */ ({ ...user }));
  await next();
}

async function requireAuthenticatedUser(c, next) {
  const payload = await getBearerSession(c);
  if (!payload) return c.json({ error: 'Authentication required' }, 401);

  const user = await getDatabase(c.env)
    .prepare('SELECT id, email, role FROM users WHERE id = ?')
    .bind(payload.sub)
    .first();
  if (!user) return c.json({ error: 'Authentication required' }, 401);
  if (user.role !== payload.role) return c.json({ error: 'Session is no longer valid' }, 401);

  c.set('sessionUser', /** @type {UserRecord} */ ({ ...user }));
  await next();
}

function plaidBaseUrl(environment) {
  return environment === 'production'
    ? 'https://production.plaid.com'
    : 'https://sandbox.plaid.com';
}

async function plaidRequest(env, endpoint, body) {
  const response = await fetch(`${plaidBaseUrl(env[bindings.PLAID_ENV] || 'sandbox')}${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'PLAID-CLIENT-ID': requireBinding(env, bindings.PLAID_CLIENT_ID),
      'PLAID-SECRET': requireBinding(env, bindings.PLAID_SECRET),
    },
    body: JSON.stringify(body),
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error_message || payload.display_message || `Plaid request failed with ${response.status}`);
  }

  return payload;
}

function stripeFormValue(form, key, value) {
  if (value !== undefined && value !== null && value !== '') form.set(key, String(value));
}

async function stripeRequest(env, endpoint, params) {
  const form = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => stripeFormValue(form, key, value));

  const response = await fetch(`https://api.stripe.com/v1/${endpoint}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${requireBinding(env, bindings.STRIPE_SECRET_KEY)}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: form,
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error?.message || `Stripe request failed with ${response.status}`);
  }

  return payload;
}

async function jsonError(c, error) {
  console.error(error);
  return c.json({ error: error instanceof Error ? error.message : 'Unexpected server error' }, 500);
}

app.get('/api/health', (c) => c.json({ ok: true, message: 'Vincetigo Cloudflare Worker is running.' }));

app.post('/api/login', async (c) => {
  try {
    const body = await c.req.json();
    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
    const password = typeof body?.password === 'string' ? body.password : '';
    if (!email || email.length > 254 || !password || password.length > 256) {
      return c.json({ error: 'Email and password are required.' }, 400);
    }

    const db = getDatabase(c.env);
    /** @type {UserRecord | null} */
    const user = await db.prepare('SELECT id, email, password_hash, role FROM users WHERE email = ?')
      .bind(email)
      .first();

    if (!user) {
      await passwordDigest(password, new Uint8Array(16));
      return c.json({ error: 'Invalid email or password.' }, 401);
    }

    let passwordValid = false;
    if (user.role === 'admin' && !user.password_hash) {
      const initialPassword = c.env[bindings.ADMIN_INITIAL_PASSWORD];
      if (!initialPassword) {
        return c.json({ error: 'Initial administrator password is not configured.' }, 503);
      }
      if (password.length >= 12 && await matchesSecret(password, initialPassword)) {
        const passwordHash = await hashPassword(password);
        await db.prepare('UPDATE users SET password_hash = ? WHERE id = ? AND password_hash IS NULL')
          .bind(passwordHash, user.id)
          .run();
        const initialized = await db.prepare('SELECT id, email, password_hash, role FROM users WHERE id = ?')
          .bind(user.id)
          .first();
        passwordValid = Boolean(initialized?.password_hash && await verifyPassword(password, initialized.password_hash));
        if (passwordValid) {
          user.password_hash = initialized.password_hash;
        }
      }
    } else if (user.password_hash) {
      passwordValid = await verifyPassword(password, user.password_hash);
    }

    if (!passwordValid) return c.json({ error: 'Invalid email or password.' }, 401);
    const token = await createSessionToken(c.env, user);
    return c.json({
      token,
      expiresIn: SESSION_TTL_SECONDS,
      user: { id: user.id, email: user.email, role: user.role },
    });
  } catch (error) {
    return jsonError(c, error);
  }
});

app.get('/api/auth/me', requireAuthenticatedUser, (c) => {
  const user = c.get('sessionUser');
  return c.json({ user: { id: user.id, email: user.email, role: user.role } });
});

app.use('/api/admin/*', requireAdmin);
app.use('/api/dispatch/*', requireAdmin);

app.post('/api/admin/users', async (c) => {
  try {
    const body = await c.req.json();
    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
    const password = typeof body?.password === 'string' ? body.password : '';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
      return c.json({ error: 'A valid email address is required.' }, 400);
    }
    if (password.length < 12 || password.length > 256) {
      return c.json({ error: 'Password must be between 12 and 256 characters.' }, 400);
    }

    const id = crypto.randomUUID();
    const passwordHash = await hashPassword(password);
    await getDatabase(c.env)
      .prepare('INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)')
      .bind(id, email, passwordHash, 'resident')
      .run();
    return c.json({ user: { id, email, role: 'resident' } }, 201);
  } catch (error) {
    if (error instanceof Error && error.message.includes('UNIQUE constraint failed: users.email')) {
      return c.json({ error: 'A user with this email already exists.' }, 409);
    }
    return jsonError(c, error);
  }
});

app.get('/api/admin/dispatch/tickets', async (c) => {
  try {
    const { results } = await getDatabase(c.env)
      .prepare('SELECT id, unit, title, category, priority, status, date, assignee, notes FROM dispatch_tickets ORDER BY updated_at DESC, id DESC')
      .all();
    return c.json({ tickets: results || [] });
  } catch (error) {
    return jsonError(c, error);
  }
});

app.patch('/api/admin/dispatch/tickets/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const body = await c.req.json();
    const updates = [];
    const values = [];

    if (Object.hasOwn(body, 'status')) {
      if (!TICKET_STATUSES.has(body.status)) return c.json({ error: 'Invalid ticket status.' }, 400);
      updates.push('status = ?');
      values.push(body.status);
    }
    if (Object.hasOwn(body, 'assignee')) {
      if (typeof body.assignee !== 'string' || body.assignee.length > 160) return c.json({ error: 'Invalid assignee.' }, 400);
      updates.push('assignee = ?');
      values.push(body.assignee.trim());
    }
    if (Object.hasOwn(body, 'notes')) {
      if (typeof body.notes !== 'string' || body.notes.length > 2000) return c.json({ error: 'Invalid ticket note.' }, 400);
      updates.push('notes = ?');
      values.push(body.notes.trim());
    }
    if (!updates.length) return c.json({ error: 'No supported ticket fields were provided.' }, 400);

    values.push(new Date().toISOString(), id);
    const db = getDatabase(c.env);
    const result = await db.prepare(`UPDATE dispatch_tickets SET ${updates.join(', ')}, updated_at = ? WHERE id = ?`)
      .bind(...values)
      .run();
    if (!result.meta?.changes) return c.json({ error: 'Dispatch ticket not found.' }, 404);

    const ticket = await db.prepare('SELECT id, unit, title, category, priority, status, date, assignee, notes FROM dispatch_tickets WHERE id = ?')
      .bind(id)
      .first();
    return c.json({ ticket });
  } catch (error) {
    return jsonError(c, error);
  }
});

app.delete('/api/admin/dispatch/tickets/:id', async (c) => {
  try {
    const result = await getDatabase(c.env)
      .prepare('DELETE FROM dispatch_tickets WHERE id = ?')
      .bind(c.req.param('id'))
      .run();
    if (!result.meta?.changes) return c.json({ error: 'Dispatch ticket not found.' }, 404);
    return c.json({ ok: true });
  } catch (error) {
    return jsonError(c, error);
  }
});

app.post('/api/admin/dispatch/tickets/reset', async (c) => {
  try {
    const db = getDatabase(c.env);
    await db.batch([
      db.prepare('DELETE FROM dispatch_tickets'),
      db.prepare(`INSERT INTO dispatch_tickets (id, unit, title, category, priority, status, date, assignee, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).
        bind('VIN-102', 'Unit 3B (Address undisclosed)', 'Master bath ventilation motor resonance', 'Electrical', 'Standard', 'Contractor Dispatched', 'Sept 12, 2026', 'Apex Electricians LLC', 'Tech scheduled for Tuesday window 10am-12pm.'),
      db.prepare(`INSERT INTO dispatch_tickets (id, unit, title, category, priority, status, date, assignee, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).
        bind('VIN-101', 'Unit 3B (Address undisclosed)', 'Kitchen drainage cycle slow discharge', 'Plumbing', 'Urgent', 'In Progress', 'Sept 14, 2026', 'Center City Plumbing Co.', 'Main trap cleared. Technician replacing rubber gaskets.'),
    ]);
    const { results } = await db.prepare('SELECT id, unit, title, category, priority, status, date, assignee, notes FROM dispatch_tickets ORDER BY updated_at DESC, id DESC').all();
    return c.json({ tickets: results || [] });
  } catch (error) {
    return jsonError(c, error);
  }
});

app.get('/api/plaid-status', async (c) => {
  try {
    const accessToken = c.req.query('access_token');
    if (!accessToken) {
      return c.json({ linked: false, message: 'No Plaid access token configured.' });
    }

    const payload = await plaidRequest(c.env, '/accounts/get', { access_token: accessToken });
    const accounts = (payload.accounts || []).map((account) => ({
      account_id: account.account_id,
      name: account.name,
      subtype: account.subtype || 'checking',
      balances: {
        available: Number(account.balances?.available ?? account.balances?.current ?? 0),
        current: Number(account.balances?.current ?? account.balances?.available ?? 0),
      },
    }));

    return c.json({
      linked: true,
      item: {
        institution_name: payload.item?.institution_name || 'Connected institution',
        item_id: payload.item?.item_id,
      },
      accounts,
    });
  } catch (error) {
    return jsonError(c, error);
  }
});

app.get('/api/test-unit', (c) => c.json({
  property: {
    address: 'Undisclosed',
    monthlyRent: 2150.00,
    securityDeposit: 2150.00,
  },
  tenant: {
    id: 'tenant_test_001',
    name: 'Ben Kastner (Test Account)',
    email: 'benjaminpaulkastner@gmail.com',
    stripeCustomerId: 'cus_test_sandbox_12345',
    leaseStatus: 'Active',
  },
}));

app.post('/api/create_link_token', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const payload = await plaidRequest(c.env, '/link/token/create', {
      user: { client_user_id: body.client_user_id || 'user_resident_3b' },
      client_name: 'Vincetigo Portal',
      products: ['auth', 'transactions'],
      country_codes: ['US'],
      language: 'en',
    });

    return c.json({ link_token: payload.link_token });
  } catch (error) {
    return jsonError(c, error);
  }
});

app.post('/api/set_access_token', async (c) => {
  try {
    const { public_token: publicToken, account_id: accountId } = await c.req.json();
    if (!publicToken || !accountId) {
      return c.json({ error: 'Missing public_token or account_id' }, 400);
    }

    const exchange = await plaidRequest(c.env, '/item/public_token/exchange', {
      public_token: publicToken,
    });
    const processor = await plaidRequest(c.env, '/processor/token/create', {
      access_token: exchange.access_token,
      account_id: accountId,
      processor: 'stripe',
    });
    const customer = await stripeRequest(c.env, 'customers', {
      source: processor.processor_token,
    });

    return c.json({ status: 'success', itemId: exchange.item_id, customerId: customer.id });
  } catch (error) {
    return jsonError(c, error);
  }
});

const RENTAL_UNITS = new Map([
  ['unit-3b', { label: 'Unit 3B', rentCents: 215000 }],
]);

async function createCheckoutSession(c) {
  try {
    const body = await c.req.json().catch(() => ({}));
    const unitId = typeof body?.unitId === 'string' ? body.unitId.trim().toLowerCase() : '';
    const unit = RENTAL_UNITS.get(unitId);
    if (!unit) {
      return c.json({ error: 'Unknown or missing unitId' }, 400);
    }

    const appUrl = requireBinding(c.env, bindings.PUBLIC_APP_URL).replace(/\/+$/, '');
    const session = await stripeRequest(c.env, 'checkout/sessions', {
      'payment_method_types[0]': 'card',
      'line_items[0][price_data][currency]': 'usd',
      'line_items[0][price_data][product_data][name]': `Rent Payment - ${unit.label}`,
      'line_items[0][price_data][unit_amount]': unit.rentCents,
      'line_items[0][quantity]': 1,
      mode: 'payment',
      success_url: `${appUrl}/resident-portal/?payment=success`,
      cancel_url: `${appUrl}/resident-portal/?payment=cancelled`,
    });

    return c.json({ sessionId: session.id, url: session.url });
  } catch (error) {
    return jsonError(c, error);
  }
}

app.post('/api/checkout', createCheckoutSession);
app.post('/api/create-checkout-session', createCheckoutSession);

const redirectAdminDispatch = (c) => c.redirect('/resident-portal/?view=admin-dispatch', 302);
app.get('/admin/dispatch', redirectAdminDispatch);
app.get('/admin/dispatch/', redirectAdminDispatch);

app.post('/api/charge-rent', async (c) => {
  try {
    const body = await c.req.json();
    const amount = Number(body.amount || 215000);
    const customerId = body.customer_id || body.customerId;

    if (!Number.isInteger(amount) || amount <= 0 || !customerId) {
      return c.json({ error: 'amount and customer_id are required; amount must be in cents' }, 400);
    }

    const charge = await stripeRequest(c.env, 'charges', {
      amount,
      currency: body.currency || 'usd',
      customer: customerId,
      description: body.description || 'Rent Payment - Unit 3B',
    });

    return c.json({
      id: charge.id,
      status: charge.status,
      amount: charge.amount,
      currency: charge.currency,
      customerId: charge.customer,
      receiptUrl: charge.receipt_url,
    });
  } catch (error) {
    return jsonError(c, error);
  }
});

app.notFound((c) => c.json({ error: 'Route not found' }, 404));

export default app;
