# Cloudflare Workers deployment

The Cloudflare entrypoint is `worker.js`. It preserves these routes:

- `GET /api/health`
- `POST /api/create_link_token`
- `POST /api/set_access_token`
- `POST /api/create-checkout-session`
- `POST /api/charge-rent`

The Worker calls Stripe and Plaid over their HTTPS APIs. This avoids Node-only SDK runtime dependencies and is compatible with Cloudflare Workers' web-standard `fetch` runtime.

## 1. Install and authenticate

From the project directory:

```bash
npm install
npx wrangler login
```

## 2. Configure CORS and environment

The Worker always allows local Live Server origins:

- `http://127.0.0.1:5500`
- `http://localhost:5500`

Set the deployed frontend origin before deploying. Replace the example domain with the real domain:

```bash
npx wrangler secret put FRONTEND_ORIGIN
# enter: http://127.0.0.1:5500

npx wrangler secret put LIVE_FRONTEND_ORIGIN
# enter: https://your-live-frontend.example.com

npx wrangler secret put STRIPE_SECRET_KEY
npx wrangler secret put PLAID_CLIENT_ID
npx wrangler secret put PLAID_SECRET
```

For sandbox testing, keep this in `wrangler.jsonc`:

```json
"PLAID_ENV": "sandbox"
```

For production, change it to `production` and use production Plaid credentials plus a Stripe live secret key. Do not mix sandbox Plaid credentials with production credentials.

You can set the URL Stripe uses after Checkout with:

```bash
npx wrangler secret put PUBLIC_APP_URL
# enter: https://your-live-frontend.example.com
```

The default is the request origin, so this binding is optional for local testing.

## 3. Run locally

Start the Worker locally:

```bash
npm run worker:dev
```

Wrangler prints a local URL, normally `http://localhost:8787`. Test health:

```bash
curl http://localhost:8787/api/health
```

The frontend must call the deployed Worker origin when it is hosted separately. For example:

```js
const API_BASE_URL = 'https://vincetigo-portal-api.<your-subdomain>.workers.dev';
fetch(`${API_BASE_URL}/api/create-checkout-session`, { ... });
```

When frontend and Worker share the same origin through a custom route, relative `/api/...` URLs continue to work.

## 4. Deploy

```bash
npm run worker:deploy
```

Wrangler prints the deployed `workers.dev` URL. Use that URL as `API_BASE_URL` if the frontend is hosted elsewhere.

## Cloudflare Dashboard alternative

1. Open **Workers & Pages** in the Cloudflare Dashboard.
2. Select **Create application**, then **Create Worker**.
3. Choose **Deploy from Git** if this repository is connected, or create the Worker and paste the contents of `worker.js` into the editor.
4. In **Settings > Variables and Secrets**, add:
   - Secret `STRIPE_SECRET_KEY`
   - Secret `PLAID_CLIENT_ID`
   - Secret `PLAID_SECRET`
   - Variable `PLAID_ENV` with `sandbox` or `production`
   - Variable `FRONTEND_ORIGIN` with the local or primary frontend origin
   - Variable `LIVE_FRONTEND_ORIGIN` with the live frontend origin
   - Optional variable `PUBLIC_APP_URL` for Stripe success/cancel redirects
5. Deploy, then copy the Worker URL into the frontend API base URL if the frontend is on another host.

## Route payloads

`POST /api/set_access_token`:

```json
{
  "public_token": "public-sandbox-...",
  "account_id": "..."
}
```

`POST /api/charge-rent` expects a Stripe customer created by the Plaid linking route:

```json
{
  "customer_id": "cus_...",
  "amount": 215000,
  "currency": "usd",
  "description": "Rent Payment - Unit 3B"
}
```

Amounts are integer cents. Use Stripe test keys and Plaid sandbox while testing. The charge route creates a real test-mode charge when test credentials are configured; it is not a mock endpoint.