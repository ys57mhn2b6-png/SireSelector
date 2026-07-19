// supabase/functions/create-portal-session/index.ts
//
// Creates a Stripe Billing Portal session for the authenticated user so they
// can manage/cancel their own subscription, instead of only via the Stripe
// dashboard.
//
// Deploy with: supabase functions deploy create-portal-session
// Requires these secrets (same pattern as create-checkout-session / stripe-webhook):
//   STRIPE_SECRET_KEY
//   SUPABASE_URL              (auto-provided by Supabase)
//   SUPABASE_ANON_KEY         (auto-provided by Supabase)
//   SUPABASE_SERVICE_ROLE_KEY (auto-provided by Supabase)
//
// NOTE: verify the Stripe npm specifier/version and apiVersion string below
// against Stripe's current docs before deploying — I can't check those live
// from here.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Stripe from "npm:stripe@14.21.0?target=deno";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") ?? "", {
  apiVersion: "2023-10-16", // verify this is still current for your Stripe account/SDK
});

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // Client scoped to the caller's own JWT, just to identify who they are.
    const supabaseClient = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_ANON_KEY") ?? "",
      {
        global: {
          headers: { Authorization: req.headers.get("Authorization") ?? "" },
        },
      }
    );

    const {
      data: { user },
      error: userError,
    } = await supabaseClient.auth.getUser();

    if (userError || !user) {
      return new Response(
        JSON.stringify({ error: "Not authenticated" }),
        {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Service-role client to read the profile row directly (bypasses RLS).
    // Remember the "explicit GRANT per role" lesson from earlier in this
    // project — service_role needs its own grant on `profiles`, it's not
    // automatic just because `authenticated` has one.
    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

    // ASSUMPTION: your `profiles` table has a `stripe_customer_id` column.
    // Adjust the column name here if yours differs — I inferred this from
    // the checkout flow needing to store a customer ID somewhere, but I
    // don't have your actual schema to confirm the exact name.
    const { data: profile, error: profileError } = await supabaseAdmin
      .from("profiles")
      .select("stripe_customer_id")
      .eq("id", user.id)
      .single();

    if (profileError || !profile?.stripe_customer_id) {
      return new Response(
        JSON.stringify({ error: "No Stripe customer found for this user" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Optional: let the frontend tell us where to send the user back to.
    // Falls back to your production URL if not provided.
    const body = await req.json().catch(() => ({}));
    const returnUrl = body?.return_url || "https://apps.sires4u.com/";

    const portalSession = await stripe.billingPortal.sessions.create({
      customer: profile.stripe_customer_id,
      return_url: returnUrl,
    });

    return new Response(JSON.stringify({ url: portalSession.url }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("create-portal-session error:", err);
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
