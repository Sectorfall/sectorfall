import { createClient } from "@supabase/supabase-js";
import { SUPABASE_URL } from "./supabaseClient.js";

const SERVICE_ROLE_KEY = typeof process !== 'undefined' ? process.env.SUPABASE_SERVICE_ROLE_KEY : null;

// Only initialize if the key is available
export const supabaseAdmin = SERVICE_ROLE_KEY 
    ? createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
        auth: {
            persistSession: false,
            autoRefreshToken: false,
            detectSessionInUrl: false
        }
    })
    : null;
