// supabase/functions/create-checkout-session/index.ts
//
// Called from the frontend via: sb.functions.invoke('create-checkout-session', { body: { returnUrl } })
// Requires the caller to be signed in — supabase-js automatically attaches
// their access token in the Authorization header, which is how we identify
// them below (never trust a user id sent in the request body itself).
//
// Required secrets (set with `supabase secrets set NAME=value`):
//   STRIPE_SECRET_KEY   — your Stripe secret key (sk_live_... or sk_test_...)
//   STRIPE_PRICE_ID     — the Price ID of your monthly subscription product
//   SUPABASE_URL              — auto-provided by the platform, no need to set
//   SUPABASE_ANON_KEY         — auto-provided by the platform, no need to set
//   SUPABASE_SERVICE_ROLE_KEY — auto-provided by the platform, no need to set

import Stripe from 'npm:stripe@17';
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { corsHeaders } from '../_shared/cors.ts';

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, {
  apiVersion: '2026-06-24.dahlia',
});

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    // Identify the caller from their JWT (forwarded automatically by
    // supabase-js). Using the anon key + the caller's own Authorization
    // header means this call runs AS that user — RLS still applies to any
    // reads/writes it does, which is exactly what we want here.
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Not signed in.' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } }
    );

    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) {
      return new Response(JSON.stringify({ error: 'Not signed in.' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const { returnUrl } = await req.json().catch(() => ({ returnUrl: null }));
    const fallbackUrl = Deno.env.get('APP_URL') ?? 'https://example.com';
    const baseUrl = returnUrl || fallbackUrl;

    // Reuse an existing Stripe customer if this user already has one
    // (e.g. a lapsed subscriber resubscribing), otherwise let Stripe create
    // one during Checkout — the webhook fills in stripe_customer_id afterward.
    // A service-role client is needed for this read: the profiles row exists,
    // but we only need a system-level lookup here, not a user-scoped one.
    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );
    const { data: profile } = await admin
      .from('profiles')
      .select('stripe_customer_id')
      .eq('id', user.id)
      .single();

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: Deno.env.get('STRIPE_PRICE_ID')!, quantity: 1 }],
      customer: profile?.stripe_customer_id || undefined,
      customer_email: profile?.stripe_customer_id ? undefined : user.email,
      client_reference_id: user.id, // lets the webhook tie the session back to this user
      success_url: `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}checkout=success`,
      cancel_url: `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}checkout=cancelled`,
      allow_promotion_codes: true,
    });

    return new Response(JSON.stringify({ url: session.url }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('create-checkout-session error:', err);
    return new Response(JSON.stringify({ error: err.message ?? 'Unknown error' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
