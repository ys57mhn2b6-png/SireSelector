# Deploying the Stripe Edge Functions

Two functions, two very different trust levels — read the note on each before deploying.

## Files

```
supabase/functions/
  _shared/cors.ts                    — shared CORS headers
  create-checkout-session/index.ts   — called by the frontend when a signed-in user clicks "Upgrade"
  stripe-webhook/index.ts            — called by Stripe itself, server-to-server, whenever a subscription changes
```

Copy the `supabase/` folder (containing `functions/`) into your project repo — the Supabase CLI expects this exact folder structure.

## 1. Prerequisites

- Supabase CLI installed and logged in (`supabase login`), project linked (`supabase link --project-ref <your-project-ref>`)
- A Stripe account with a subscription Product + Price already created (grab the Price ID, looks like `price_1AbC...`)
- Your Stripe **secret** key (Dashboard → Developers → API keys) — never the publishable key for this

## 2. Set secrets

```bash
supabase secrets set STRIPE_SECRET_KEY=sk_live_...
supabase secrets set STRIPE_PRICE_ID=price_...
supabase secrets set APP_URL=https://yourusername.github.io/sire-selector/
```

(`SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` are provided automatically inside every edge function — you don't set those yourself.)

`STRIPE_WEBHOOK_SECRET` comes later, in step 4, since Stripe only generates it once the endpoint exists.

## 3. Deploy create-checkout-session

```bash
supabase functions deploy create-checkout-session
```

This one **should** require a valid Supabase JWT (the default) — it's called from your signed-in frontend via `sb.functions.invoke(...)`, which attaches the user's session token automatically. Don't add `--no-verify-jwt` here.

## 4. Deploy stripe-webhook — different flag, read this part carefully

```bash
supabase functions deploy stripe-webhook --no-verify-jwt
```

This function is called directly by Stripe's servers, not by your frontend — there is no Supabase user session involved, so it carries no JWT. If you deploy it with the default JWT check on, Supabase will reject every request from Stripe with a 401 before your code ever runs, and webhooks will silently fail. `--no-verify-jwt` is required here. (Security here comes from Stripe's own signature check inside the function, not from Supabase's JWT layer — that's what `STRIPE_WEBHOOK_SECRET` and `stripe.webhooks.constructEventAsync(...)` are doing.)

## 5. Register the webhook endpoint in Stripe

Once deployed, your webhook's URL is:

```
https://<your-project-ref>.functions.supabase.co/stripe-webhook
```

In the Stripe Dashboard: **Developers → Webhooks → Add endpoint**, paste that URL, and subscribe it to these three events:

- `checkout.session.completed`
- `customer.subscription.updated`
- `customer.subscription.deleted`

Stripe will show you a signing secret (`whsec_...`) right after you create the endpoint — copy it and set it:

```bash
supabase secrets set STRIPE_WEBHOOK_SECRET=whsec_...
```

## 6. Test it

- Stripe Dashboard → your webhook endpoint → **Send test webhook** lets you fire a fake `checkout.session.completed` at your function without a real payment, to confirm the plumbing works.
- For a full real test: use one of [Stripe's test card numbers](https://docs.stripe.com/testing) (e.g. `4242 4242 4242 4242`, any future expiry, any CVC) while your Stripe account is in test mode, and confirm the matching `profiles` row's `subscription_status` flips to `active` afterward.
- Check function logs with `supabase functions logs stripe-webhook` if something doesn't update as expected — the code logs the specific error rather than failing silently.

## What I could not verify from here

I don't have a live Stripe account, a live Supabase project, or outbound network access in this environment, so this code has been checked for structural correctness (balanced braces, the shapes of the Stripe/Supabase API calls match their current documented signatures) but **not actually executed against a real Stripe/Supabase project**. The most likely thing to need a tweak on first real deploy: the Stripe API version pinned in both files (`2024-06-20`) — if your Stripe dashboard is on a newer default API version, either update that string to match or leave it, since pinning an older-but-supported version is normal practice and won't break anything on its own.
