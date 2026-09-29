require('dotenv').config();
const express = require('express');
const path = require('path');
const cors = require('cors');
const Stripe = require('stripe');
const { Resend } = require('resend');
const { Configuration, PlaidApi, PlaidEnvironments } = require('plaid');

const app = express();
const maintenanceMode = process.env.MAINTENANCE_MODE === 'true';
const betaAccessKey = process.env.BETA_ACCESS_KEY || '';
const testData = require('./seed');

const allowedOrigins = new Set([
  'http://127.0.0.1:5500',
  'http://localhost:5500',
  'http://127.0.0.1:8000',
  'http://localhost:8000',
]);

app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.has(origin)) {
      return callback(null, true);
    }

    return callback(new Error('Origin is not allowed by CORS'));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.options(/.*/, cors());

app.use(express.json());

app.use((req, res, next) => {
  const isApiRequest = req.path.startsWith('/api/');
  const providedBetaKey = req.headers['x-beta-access'] || req.query.beta;
  const hasBetaAccess = betaAccessKey && providedBetaKey === betaAccessKey;

  if (!maintenanceMode || isApiRequest || hasBetaAccess) {
    return next();
  }

  return res.status(503).sendFile(path.join(__dirname, 'index.html'));
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'untitled folder', 'website4.html'));
});

app.get('/api/test-unit', (req, res) => {
  res.json(testData);
});

app.use(express.static(__dirname));

const PLAID_CLIENT_ID = process.env.PLAID_CLIENT_ID;
const PLAID_SECRET = process.env.PLAID_SECRET;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const PLAID_SANDBOX_ACCESS_TOKEN = process.env.PLAID_SANDBOX_ACCESS_TOKEN || process.env.PLAID_ACCESS_TOKEN;

if (!PLAID_CLIENT_ID || !PLAID_SECRET) {
  console.warn('Missing Plaid credentials in .env file. Add your PLAID_CLIENT_ID and PLAID_SECRET before testing Link Bank.');
}

if (!STRIPE_SECRET_KEY) {
  console.warn('Missing Stripe secret key in .env file. Add your STRIPE_SECRET_KEY before testing checkout.');
}

const stripe = Stripe(STRIPE_SECRET_KEY || 'sk_test_placeholder');
const resend = new Resend(process.env.RESEND_API_KEY || 're_xxxxxxxxx');

const plaidConfig = new Configuration({
  basePath: PlaidEnvironments[process.env.PLAID_ENV || 'sandbox'],
  baseOptions: {
    headers: {
      'PLAID-CLIENT-ID': PLAID_CLIENT_ID || 'placeholder_client_id',
      'PLAID-SECRET': PLAID_SECRET || 'placeholder_secret',
    },
  },
});
const plaidClient = new PlaidApi(plaidConfig);

async function getPlaidAccounts(accessToken) {
  const response = await plaidClient.accountsGet({ access_token: accessToken });
  const accounts = (response.data.accounts || []).map((account) => ({
    account_id: account.account_id,
    name: account.name,
    subtype: account.subtype || 'checking',
    balances: {
      available: Number(account.balances?.available ?? account.balances?.current ?? 0),
      current: Number(account.balances?.current ?? account.balances?.available ?? 0),
    },
  }));

  return {
    item: {
      institution_name: 'Navy Federal Credit Union',
      item_id: response.data.item?.item_id || 'sandbox-token',
    },
    accounts,
  };
}

app.get('/api/health', (req, res) => {
  res.json({ ok: true, message: 'Vincetigo backend is running.' });
});

app.get('/api/plaid-status', async (req, res) => {
  const accessToken = req.query.access_token || PLAID_SANDBOX_ACCESS_TOKEN;

  if (!accessToken) {
    return res.json({ linked: false, message: 'No Plaid access token configured.' });
  }

  try {
    const result = await getPlaidAccounts(accessToken);
    res.json({ linked: true, ...result });
  } catch (error) {
    res.status(500).json({ linked: false, error: error.message });
  }
});

app.post('/api/create-checkout-session', async (req, res) => {
  try {
    const amount = Number(req.body?.amount || 150000);

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: { name: 'Rent Payment - Unit 3B' },
            unit_amount: amount,
          },
          quantity: 1,
        },
      ],
      mode: 'payment',
      success_url: 'http://localhost:3000/untitled%20folder/website4.html#properties',
      cancel_url: 'http://localhost:3000/untitled%20folder/website4.html#properties',
    });

    res.json({ url: session.url });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/create_link_token', async (req, res) => {
  try {
    const response = await plaidClient.linkTokenCreate({
      user: { client_user_id: 'user_resident_3b' },
      client_name: 'Vincetigo Portal',
      products: ['auth', 'transactions'],
      country_codes: ['US'],
      language: 'en',
    });

    res.json({ link_token: response.data.link_token });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/set_access_token', async (req, res) => {
  const { public_token, account_id: accountId } = req.body || {};

  if (!public_token || !accountId) {
    return res.status(400).json({ error: 'Missing public_token or account_id' });
  }

  try {
    const response = await plaidClient.itemPublicTokenExchange({ public_token });
    const accessToken = response.data.access_token;
    const itemId = response.data.item_id;
    const processorResponse = await plaidClient.processorTokenCreate({
      access_token: accessToken,
      account_id: accountId,
      processor: 'stripe',
    });
    const processorToken = processorResponse.data.processor_token;
    const customer = await stripe.customers.create({
      source: processorToken,
    });

    res.json({ status: 'success', itemId, customerId: customer.id });
  } catch (error) {
    console.error('Error linking Plaid to Stripe:', error.response?.data || error.message);
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 8000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
