import { ChatRepositorySupabase } from './ChatRepositorySupabase.js';
import { ChatTransportSupabase } from './ChatTransportSupabase.js';
import { CHAT_SCOPE, parseDirectMention, normalizeCommanderName } from './chatTypes.js';

class ChatService {
  constructor() {
    this.repo = new ChatRepositorySupabase();
    this.transport = new ChatTransportSupabase();
    this.identity = { userId: null, commanderName: '' };
    this._subscribed = false;
    this._onMessage = null;
  }

  setIdentity({ userId, commanderName }) {
    this.identity.userId = userId;
    this.identity.commanderName = normalizeCommanderName(commanderName);
  }

  async fetchRecent(limit = 50) {
    const rows = await this.repo.fetchRecent(limit);
    return rows.map((r) => this._rowToMessage(r)).filter(Boolean);
  }

  subscribe(onMessage) {
    this._onMessage = onMessage;
    if (this._subscribed) return;
    this._subscribed = true;

    this.transport.subscribe((row) => {
      const msg = this._rowToMessage(row);
      if (!msg) return;
      if (typeof this._onMessage === 'function') this._onMessage(msg);
    });
  }

  unsubscribe() {
    this._subscribed = false;
    this._onMessage = null;
    this.transport.unsubscribe();
  }

  async send(text, context = {}) {
    const raw = (text || '').trim();
    if (!raw) return;

    if (!this.identity.userId) {
      throw new Error('Not authenticated');
    }

    // Direct message overrides scope if @NAME is present.
    const mention = parseDirectMention(raw);

    let scope = context.scope || CHAT_SCOPE.SYSTEM;
    let body = raw;
    let to = null;

    if (mention) {
      scope = CHAT_SCOPE.DIRECT;
      body = mention.body;
      if (!body) throw new Error('Direct message is empty');

      to = await this.repo.resolveUserByCommanderName(mention.toName);
      if (!to) throw new Error(`Unknown commander: ${mention.toName}`);
      if (to.userId === this.identity.userId) throw new Error('Cannot DM yourself');
    }

    const row = {
      from_user_id: this.identity.userId,
      from_name: this.identity.commanderName || null,
      body,
      scope,

      // routing
      system_id: scope === CHAT_SCOPE.SYSTEM ? (context.systemId || null) : null,
      fleet_id: scope === CHAT_SCOPE.FLEET ? (context.fleetId || null) : null,
      syndicate_id: scope === CHAT_SCOPE.SYNDICATE ? (context.syndicateId || null) : null,
      to_user_id: scope === CHAT_SCOPE.DIRECT ? to?.userId : null,
      to_name: scope === CHAT_SCOPE.DIRECT ? to?.commanderName : null
    };

    await this.repo.insertMessage(row);
  }

  _rowToMessage(r) {
    if (!r) return null;
    // NOTE: App.js / ChatWindow expect `userId` + `userName`.
    // Keep legacy-friendly aliases too (playerId/playerName) to avoid regressions elsewhere.
    const userId = r.from_user_id;
    const userName = r.from_name || r.from_user_id;

    return {
      id: r.id,
      channel: r.scope || CHAT_SCOPE.SYSTEM,
      content: r.body || '',
      timestamp: r.created_at,

      // ✅ UI expected fields
      userId,
      userName,

      // legacy aliases (safe to keep)
      playerId: userId,
      playerName: userName,

      // metadata used by UI filters
      systemId: r.system_id || null,
      fleetId: r.fleet_id || null,
      syndicateId: r.syndicate_id || null,
      toUserId: r.to_user_id || null,
      toName: r.to_name || null
    };
  }
}

export const chatService = new ChatService();