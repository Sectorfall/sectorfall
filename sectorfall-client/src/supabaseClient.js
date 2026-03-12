import { createClient } from "@supabase/supabase-js";

export const SUPABASE_URL = "https://ztiwkadvvjfwkpdujhdd.supabase.co";
export const SUPABASE_ANON_KEY = "sb_publishable_gZSmtB6ZzgUWCN3Oj3EsVA_CCi5-sGR";

// Standard Supabase client initialization
// The client automatically manages auth headers when a session is active.
export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true
    }
});