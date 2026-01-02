import { createClient } from "@supabase/supabase-js";

// En Vercel: Settings → Environment Variables
// REACT_APP_SUPABASE_URL
// REACT_APP_SUPABASE_ANON_KEY

const supabaseUrl = process.env.REACT_APP_SUPABASE_URL;
const supabaseAnonKey = process.env.REACT_APP_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  // Esto ayuda a ver el error rápidamente si faltan variables
  // (en producción normalmente no se verá, pero en local sí)
  console.warn("Faltan variables de entorno de Supabase. Revisa REACT_APP_SUPABASE_URL y REACT_APP_SUPABASE_ANON_KEY.");
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey);
