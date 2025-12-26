import { createClient } from '@supabase/supabase-js';

const supabaseUrl = 'https://wnvzpjqxnweqdpgvhedy.supabase.co';

const supabaseKey = 'sb_publishable_Datjf6GeYUpKMQtm-GYCqA_De4gqssK';

export const supabase = createClient(supabaseUrl, supabaseKey);
