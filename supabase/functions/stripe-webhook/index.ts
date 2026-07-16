// supabase/functions/stripe-webhook/index.ts
//
// Stripe calls this directly (server-to-server) whenever a subscription
// event happens. It is NOT called by the frontend and carries no Supabase
// JWT — so this function MUST be deployed with JWT verification disabled,
// otherwise Supabase will reject Stripe's request before it ever reaches
// this code. Deploy with:
//   supabase functions deploy stripe-webhook --no-verify-jwt
//
// Required secrets (set with `supabase secrets set NAME=value`):
//   STRIPE_SECRET_KEY          — same key used by create-checkout-session
//   STRIPE_WEBHOOK_SECRET      — from the Stripe Dashboard webhook endpoint (whsec_...)
//   SUPABASE_URL               — auto-provided by the platform
//   SUPABASE_SERVICE_ROLE_KEY  — auto-provided by the platform
//
// After deploying, add the endpoint in the Stripe Dashboard
// (Developers -> Webhooks -> Add endpoint) pointing at:
//   https://<your-project-ref>.functions.supabase.co/stripe-webhook
// and subscribe it to: checkout.session.completed, customer.subscription.updated,
// customer.subscription.deleted

import Stripe from 'npm:stripe@17';
import { createClient } from 'jsr:@supabase/supabase-js@2';

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, {
  apiVersion: '2024-06-20',
});
const webhookSecret = Deno.env.get('STRIPE_WEBHOOK_SECRET')!;

// service_role bypasses RLS — appropriate here since this is a trusted,
// server-to-server context authenticated by Stripe's signature, not a user.
const admin = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
);

Deno.serve(async (req) => {
  const signature = req.headers.get('stripe-signature');
  if (!signature) {
    return new Response('Missing stripe-signature header', { status: 400 });
  }

  // Signature verification needs the exact raw request body — do not
  // req.json() this first, it would re-serialize the body and break the
  // signature check.
  const rawBody = await req.text();

  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(rawBody, signature, webhookSecret);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return new Response(`Webhook signature verification failed: ${err.message}`, { status: 400 });
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;
        const userId = session.client_reference_id;
        if (!userId) {
          console.error('checkout.session.completed with no client_reference_id — cannot map to a user.');
          break;
        }
        const { error } = await admin
          .from('profiles')
          .update({
            subscription_status: 'active',
            stripe_customer_id: session.customer as string,
            stripe_subscription_id: session.subscription as string,
          })
          .eq('id', userId);
        if (error) console.error('Failed to update profile after checkout:', error.message);
        break;
      }

      case 'customer.subscription.updated': {
        const subscription = event.data.object as Stripe.Subscription;
        // Stripe's own statuses: active, trialing, past_due, canceled,
        // unpaid, incomplete, incomplete_expired, paused. Anything other
        // than active/trialing should not keep premium features unlocked.
        const isActive = ['active', 'trialing'].includes(subscription.status);
        const { error } = await admin
          .from('profiles')
          .update({
            subscription_status: isActive ? 'active' : subscription.status,
            stripe_subscription_id: subscription.id,
          })
          .eq('stripe_customer_id', subscription.customer as string);
        if (error) console.error('Failed to update profile on subscription update:', error.message);
        break;
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object as Stripe.Subscription;
        const { error } = await admin
          .from('profiles')
          .update({ subscription_status: 'canceled' })
          .eq('stripe_customer_id', subscription.customer as string);
        if (error) console.error('Failed to update profile on subscription deletion:', error.message);
        break;
      }

      default:
        // Unhandled event types are fine to ignore — Stripe sends many
        // events we don't need to act on.
        break;
    }

    return new Response(JSON.stringify({ received: true }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('stripe-webhook handler error:', err);
    return new Response(JSON.stringify({ error: err.message ?? 'Unknown error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
});
