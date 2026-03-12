import { supabase } from '../supabaseClient.js';
import { normalizeCommanderName } from './chatTypes.js';

export class ChatRepositorySupabase {
  async fetchRecent(limit = 50) {
    const { data, error } = await supabase
      .from('chat_messages')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) throw error;
    return (data || []).slice().reverse();
  }

  async insertMessage(row) {
    const { data, error } = await supabase
      .from('chat_messages')
      .insert([row])   
      .select('*')
      .single();

    if (error) throw error;
    return data;
  }

  async resolveUserByCommanderName(name) {
    const commanderName = normalizeCommanderName(name);
    if (!commanderName) return null;

    const { data, error } = await supabase
      .from('commander_data')
      .select('player_id, commander_name')
      .eq('commander_name', commanderName)
      .maybeSingle();

    if (error) throw error;
    if (!data?.player_id) return null;

    return {
      userId: data.player_id,
      commanderName: data.commander_name
    };
  }
}