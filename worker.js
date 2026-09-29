import { cors } from 'hono/cors';
import { Hono } from 'hono';

const app = new Hono();

const bindings = {
  STRIPE_SECRET_KEY: 'STRIPE_SECRET_KEY',
  PLAID_CLIENT_ID: 'PLAID_CLIENT_ID',
  PLAID_SECRET: 'PLAID_SECRET',
  PLAID_ENV: 'PLAID_ENV',
  FRONTEND_ORIGIN: 'FRONTEND_ORIGIN',
  LIVE_FRONTEND_ORIGIN: 'LIVE_FRONTEND_ORIGIN',
};

function configuredOrigins(env) {
  return [
    'http://127.0.0.1:5500',
    'http://localhost:5500',
    env[bindings.FRONTEND_ORIGIN],
    env[bindings.LIVE_FRONTEND_ORIGIN],
  ].filter(Boolean);
}

app.use('*', async (c, next) => {
  const origins = configuredOrigins(c.env);
  return cors({
    origin: (origin) => origins.includes(origin) ? origin : '',
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
  })(c, next);
});

function requireBinding(env, name) {
  const value = env[name];
  if (!value) throw new Error(`Missing Worker binding: ${name}`);
  return value;
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
    address: '606 Union St, Apt 3B, Philadelphia, PA 19104',
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

app.post('/api/create-checkout-session', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const amount = Number(body.amount || 150000);
    if (!Number.isInteger(amount) || amount <= 0) {
      return c.json({ error: 'amount must be a positive integer in cents' }, 400);
    }

    const appUrl = c.env.PUBLIC_APP_URL || new URL(c.req.url).origin;
    const session = await stripeRequest(c.env, 'checkout/sessions', {
      'payment_method_types[0]': 'card',
      'line_items[0][price_data][currency]': 'usd',
      'line_items[0][price_data][product_data][name]': 'Rent Payment - Unit 3B',
      'line_items[0][price_data][unit_amount]': amount,
      'line_items[0][quantity]': 1,
      mode: 'payment',
      success_url: `${appUrl}/?payment=success`,
      cancel_url: `${appUrl}/?payment=cancelled`,
    });

    return c.json({ url: session.url, id: session.id });
  } catch (error) {
    return jsonError(c, error);
  }
});

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
