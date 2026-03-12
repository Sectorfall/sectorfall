import { supabase } from '../supabaseClient.js';

export class ChatTransportSupabase {
  constructor() {
    this.channel = null;
  }

  subscribe(onInsert) {
    // One global insert stream; RLS ensures the client only receives rows it can read.
    this.channel = supabase
      .channel('chat_messages_inserts')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'chat_messages' },
        (payload) => {
          try {
            if (payload?.new) onInsert(payload.new);
          } catch (e) {
            console.warn('[ChatTransport] onInsert failed:', e);
          }
        }
      )
      .subscribe();

    return this.channel;
  }

  unsubscribe() {
    if (this.channel) {
      try {
        supabase.removeChannel(this.channel);
      } catch (e) {
        // ignore
      }
      this.channel = null;
    }
  }
}