// supabase/functions/create-portal-session/index.ts
//
// Called from the frontend via: sb.functions.invoke('create-portal-session', { body: { returnUrl } })
// Creates a Stripe Billing Portal session for the signed-in user so they can
// manage/cancel their own subscription, instead of only via the Stripe dashboard.
//
// Required secrets (same as create-checkout-session — no new ones needed):
//   STRIPE_SECRET_KEY   — your Stripe secret key (sk_live_... or sk_test_...)
//   SUPABASE_URL              — auto-provided by the platform
//   SUPABASE_ANON_KEY         — auto-provided by the platform
//   SUPABASE_SERVICE_ROLE_KEY — auto-provided by the platform
//   APP_URL              — optional fallback return URL, same as checkout function
//
// NOTE before going live: in the Stripe Dashboard, go to
// Settings → Billing → Customer portal and activate/configure it
// (test mode first, then again separately in live mode).

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
    // supabase-js), same pattern as create-checkout-session.
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

    // Service-role lookup — same reasoning as create-checkout-session:
    // we need the stored Stripe customer id, not a user-scoped read.
    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );
    const { data: profile } = await admin
      .from('profiles')
      .select('stripe_customer_id')
      .eq('id', user.id)
      .single();

    if (!profile?.stripe_customer_id) {
      return new Response(
        JSON.stringify({ error: 'No Stripe customer found for this account yet.' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const portalSession = await stripe.billingPortal.sessions.create({
      customer: profile.stripe_customer_id,
      return_url: baseUrl,
    });

    return new Response(JSON.stringify({ url: portalSession.url }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('create-portal-session error:', err);
    return new Response(JSON.stringify({ error: err.message ?? 'Unknown error' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
