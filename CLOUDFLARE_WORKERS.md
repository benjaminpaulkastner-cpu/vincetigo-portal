# Cloudflare Workers deployment

The Cloudflare entrypoint is `worker.js`. It preserves these routes:

- `GET /api/health`
- `POST /api/create_link_token`
- `POST /api/set_access_token`
- `POST /api/checkout`
- `POST /api/create-checkout-session`
- `POST /api/charge-rent`

The Worker calls Stripe and Plaid over their HTTPS APIs. This avoids Node-only SDK runtime dependencies and is compatible with Cloudflare Workers' web-standard `fetch` runtime.

## Secure Stripe Checkout

The resident portal sends only a `unitId`. The Worker looks up the rent amount in `worker.js`; it never accepts a client-provided amount. The current mapping is `unit-3b` to 215000 cents ($2,150). Add future units to `RENTAL_UNITS` in the Worker.

The Worker serves the repository's static assets on `https://vincetigo.com` and `https://www.vincetigo.com`, and exposes its API on `https://api.vincetigo.com`. These custom domains are configured in `wrangler.jsonc`. The Worker CORS allowlist is configured by `FRONTEND_ORIGINS` in that file.

## 1. Install and authenticate

From the project directory:

```bash
npm install
npx wrangler login
```

## 2. Configure the Stripe secret and frontend origins

Store the Stripe key as a Worker secret. Wrangler prompts for the value; do not put the key in HTML, JavaScript, `wrangler.jsonc`, or a committed `.env` file:

```bash
npx wrangler secret put STRIPE_SECRET_KEY
```

Use an `sk_test_...` key while testing and an `sk_live_...` key only for production. Local Wrangler development can read `STRIPE_SECRET_KEY` from the git-ignored `.dev.vars` file:

```dotenv
STRIPE_SECRET_KEY="sk_test_..."
```

`FRONTEND_ORIGINS` and `PUBLIC_APP_URL` are public configuration, not secrets. They are set in `wrangler.jsonc`; adjust `FRONTEND_ORIGINS` if the frontend uses another production or preview hostname. The Worker also allows the local Live Server origins on port 5502.

The `routes` configuration provisions the apex, `www`, and API hostnames as Worker custom domains. The `vincetigo.com` zone must be active in the same Cloudflare account as the Worker.

## 3. Run locally

Start the Worker locally:

```bash
npm run worker:dev
```

Wrangler prints a local URL, normally `http://localhost:8787`. Test health:

```bash
curl http://localhost:8787/api/health
```

The portal sends this request; the amount is resolved by the Worker:

```bash
curl -i http://127.0.0.1:8787/api/checkout \
  -H 'Origin: http://127.0.0.1:5502' \
  -H 'Content-Type: application/json' \
  --data '{"unitId":"unit-3b"}'
```

The response contains `sessionId` and `url`. The browser redirects to `url`, which is hosted by Stripe. Requests with unknown unit IDs return `400`; submitting an `amount` has no effect.

## 4. Deploy

```bash
npm run worker:deploy
```

After deployment, the site is served at `https://vincetigo.com` and `https://www.vincetigo.com`; the API is available at `https://api.vincetigo.com/api/checkout`. Keep Stripe in test mode until the deployed flow has been verified.

## Cloudflare Dashboard alternative

1. Open **Workers & Pages** in the Cloudflare Dashboard.
2. Select **Create application**, then **Create Worker**.
3. Choose **Deploy from Git** if this repository is connected, or create the Worker and paste the contents of `worker.js` into the editor.
4. In **Settings > Variables and Secrets**, add:
   - Secret `STRIPE_SECRET_KEY`
   - Secret `PLAID_CLIENT_ID`
   - Secret `PLAID_SECRET`
   - Variable `PLAID_ENV` with `sandbox` or `production`
   - Variable `FRONTEND_ORIGINS` with comma-separated allowed origins, such as `https://vincetigo.com,https://www.vincetigo.com`
   - Variable `PUBLIC_APP_URL` with `https://vincetigo.com`
5. Configure the Worker custom domains `vincetigo.com`, `www.vincetigo.com`, and `api.vincetigo.com`, deploy, and keep secrets in the Worker Secrets settings.

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