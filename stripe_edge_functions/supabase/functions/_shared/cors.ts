// Shared CORS headers for edge functions called directly from the browser
// (create-checkout-session). The webhook function does NOT use these —
// Stripe calls it server-to-server, not from a browser, so it doesn't need
// CORS headers and must NOT have JWT verification enabled (see README).
export const corsHeaders = {
  'Access-Control-Allow-Origin': '*', // tighten to your exact domain(s) once live
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
