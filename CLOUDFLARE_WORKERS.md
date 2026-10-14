# Cloudflare Workers deployment

The Cloudflare entrypoint is `worker.js`. It preserves these routes:

- `GET /api/health`
- `POST /api/create_link_token`
- `POST /api/set_access_token`
- `POST /api/checkout`
- `POST /api/create-checkout-session`
- `POST /api/charge-rent`

The Worker calls Stripe and Plaid over their HTTPS APIs. This avoids Node-only SDK runtime dependencies and is compatible with Cloudflare Workers' web-standard `fetch` runtime.

## Admin Dispatch authentication and D1 setup

Admin Dispatch uses the D1 database bound as `DB`. `migrations/0001_auth_and_dispatch.sql` creates the `users` and `dispatch_tickets` tables and marks `ben@vincetigo.com` as an administrator. Only `/api/admin/*` and `/api/dispatch/*` are protected by the admin middleware; the public Stripe `POST /api/checkout` route is not covered by authentication. Admin API routes require a signed eight-hour session and re-check the user's current role in D1 on every request.

Create the production database and copy its returned ID into the `database_id` field for the `DB` binding in `wrangler.jsonc`:

```bash
npx wrangler d1 create vincetigo-portal
```

Apply the migrations to local D1 for development and to the remote database for production:

```bash
npx wrangler d1 migrations apply vincetigo-portal --local --config wrangler.local.jsonc
npx wrangler d1 migrations apply vincetigo-portal --remote --config wrangler.jsonc
```

Configure a random JWT signing secret (at least 32 characters) and the one-time initial admin password as Worker secrets. Wrangler prompts for each value; enter the admin password privately at the prompt and do not put it in source control:

```bash
npx wrangler secret put JWT_SECRET
npx wrangler secret put ADMIN_INITIAL_PASSWORD
```

On the first successful login as `ben@vincetigo.com`, the Worker stores a salted password hash in D1. Remove the bootstrap password secret after that login:

```bash
npx wrangler secret delete ADMIN_INITIAL_PASSWORD
```

For local development, set `JWT_SECRET` and `ADMIN_INITIAL_PASSWORD` in the git-ignored `.dev.vars` file instead. Run `npm run worker:dev`, serve the portal from an allowed origin, and sign in through the portal login form. The explicit Resident Demo button remains browser-only and does not grant an authenticated role.

Protected API routes include `POST /api/admin/users` (creates a resident account), `GET /api/admin/dispatch/tickets`, `PATCH` and `DELETE /api/admin/dispatch/tickets/:id`, and `POST /api/admin/dispatch/tickets/reset`. The admin navigation is shown only for an authenticated admin; the Worker remains the security boundary.

To provision a resident after signing in as the administrator, call the user endpoint with the admin session token and a password of at least 12 characters:

```bash
curl -i https://api.vincetigo.com/api/admin/users \
  -H 'Authorization: Bearer <admin-session-token>' \
  -H 'Content-Type: application/json' \
  --data '{"email":"resident@example.com","password":"<resident-password>"}'
```

## Secure Stripe Checkout

The resident portal sends only a `unitId`. The Worker looks up the rent amount in `worker.js`; it never accepts a client-provided amount. The current mapping is `unit-3b` to 215000 cents ($2,150). Add future units to `RENTAL_UNITS` in the Worker.

Resident portal payment links are centralized in `resident-portal/payments.js`. Set each unit's `rent` or `deposit` URL there to an HTTPS Stripe Payment Link. When a unit has no configured link, the portal shows a demo-mode payment dialog instead of navigating to a placeholder URL.

The Worker serves the repository's static assets on `https://vincetigo.com` and `https://www.vincetigo.com`, and exposes its API on `https://api.vincetigo.com`. These custom domains are configured in `wrangler.jsonc`. The Worker CORS allowlist is configured by `FRONTEND_ORIGINS` in that file; local development allows `localhost` and `127.0.0.1` on ports 5502 and 8000 for JSON POST preflights.

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