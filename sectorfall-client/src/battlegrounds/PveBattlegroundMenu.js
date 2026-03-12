import React, { useEffect, useMemo, useState } from 'react';
import { supabase } from '../supabaseClient.js';
import { BATTLEGROUND_UI_TABS } from './battlegroundTypes.js';

const overlayStyle = {
  position: 'absolute',
  inset: 0,
  background: 'transparent',
  zIndex: 2550,
  pointerEvents: 'auto'
};

const shellStyle = {
  position: 'absolute',
  top: '50%',
  left: '50%',
  transform: 'translate(-50%, -50%)',
  display: 'flex',
  alignItems: 'stretch',
  gap: '14px',
  pointerEvents: 'auto'
};

const panelStyle = {
  width: '520px',
  minHeight: '380px',
  background: 'linear-gradient(180deg, rgba(10,17,28,0.985), rgba(4,8,14,0.985))',
  border: '1px solid rgba(0,204,255,0.28)',
  boxShadow: '0 0 44px rgba(0,0,0,0.72), inset 0 0 28px rgba(0,204,255,0.05)',
  borderRadius: '6px',
  padding: '16px',
  color: '#fff',
  fontFamily: 'monospace',
  pointerEvents: 'auto'
};

const leaderboardPanelStyle = {
  width: '420px',
  minHeight: '380px',
  maxHeight: '380px',
  background: 'linear-gradient(180deg, rgba(10,17,28,0.985), rgba(4,8,14,0.985))',
  border: '1px solid rgba(0,204,255,0.20)',
  boxShadow: '0 0 44px rgba(0,0,0,0.72), inset 0 0 28px rgba(0,204,255,0.04)',
  borderRadius: '6px',
  padding: '16px',
  color: '#fff',
  fontFamily: 'monospace',
  pointerEvents: 'auto',
  display: 'flex',
  flexDirection: 'column'
};

const buttonBase = {
  padding: '12px 14px',
  borderRadius: '4px',
  fontFamily: 'monospace',
  fontWeight: 'bold',
  letterSpacing: '1.5px',
  cursor: 'pointer'
};

function formatCredits(value = 0) {
  return `${Number(value || 0).toLocaleString()} CR`;
}

export const PveBattlegroundMenu = ({ state, onClose, onEnter }) => {
  const [activeTab, setActiveTab] = useState('wave_assault');
  const [leaderboardRows, setLeaderboardRows] = useState([]);
  const [leaderboardLoading, setLeaderboardLoading] = useState(false);
  const [leaderboardError, setLeaderboardError] = useState(null);
  const definition = state?.definition || null;
  const structure = state?.structure || null;
  const status = state?.status || 'idle';
  const loading = status === 'loading';
  const entering = status === 'entering';
  const tabs = useMemo(() => {
    const fromDef = definition?.config?.tabs;
    if (Array.isArray(fromDef) && fromDef.length) return fromDef;
    return BATTLEGROUND_UI_TABS;
  }, [definition]);

  const rewardMode = String(definition?.reward_mode || structure?.structureRow?.config?.rewardMode || 'extract_bank');
  const maxWave = Number(definition?.max_public_wave || 10) || 10;
  const title = definition?.display_name || structure?.name || 'OMNI DIRECTORATE TACTICAL TRIAL';
  const subtitle = structure?.name || 'OMNI DIRECTORATE COMBAT RELAY';
  const selectedTab = tabs.find(tab => tab?.key === activeTab) || tabs[0] || { key: 'wave_assault', label: 'WAVE ASSAULT', enabled: true };
  const shellMessage = loading
    ? 'Syncing battleground definition...'
    : 'Wave runtime active. Clear each wave, bank credits, then extract or continue.';
  const battlegroundKey = String(definition?.key || structure?.config?.battlegroundKey || '').trim();

  useEffect(() => {
    let cancelled = false;
    const loadLeaderboard = async () => {
      if (!battlegroundKey) {
        setLeaderboardRows([]);
        setLeaderboardLoading(false);
        setLeaderboardError(null);
        return;
      }
      setLeaderboardLoading(true);
      setLeaderboardError(null);
      const { data, error } = await supabase
        .from('battleground_leaderboard_runs')
        .select('id, player_id, commander_name, highest_wave, reward_secured, duration_seconds, created_at')
        .eq('battleground_key', battlegroundKey)
        .order('highest_wave', { ascending: false })
        .order('reward_secured', { ascending: false })
        .order('created_at', { ascending: true })
        .limit(500);
      if (cancelled) return;
      if (error) {
        setLeaderboardRows([]);
        setLeaderboardError(error.message || 'Leaderboard unavailable');
      } else {
        const rows = Array.isArray(data) ? data.slice() : [];
        rows.sort((a, b) => {
          const waveDelta = Number(b?.highest_wave || 0) - Number(a?.highest_wave || 0);
          if (waveDelta) return waveDelta;
          const rewardDelta = Number(b?.reward_secured || 0) - Number(a?.reward_secured || 0);
          if (rewardDelta) return rewardDelta;
          const aDuration = Number.isFinite(Number(a?.duration_seconds)) ? Number(a.duration_seconds) : Number.POSITIVE_INFINITY;
          const bDuration = Number.isFinite(Number(b?.duration_seconds)) ? Number(b.duration_seconds) : Number.POSITIVE_INFINITY;
          if (aDuration !== bDuration) return aDuration - bDuration;
          return String(a?.created_at || '').localeCompare(String(b?.created_at || ''));
        });
        const seenPlayers = new Set();
        const uniqueRows = [];
        for (const row of rows) {
          const dedupeKey = String(row?.player_id || row?.commander_name || '').trim().toLowerCase();
          if (!dedupeKey || seenPlayers.has(dedupeKey)) continue;
          seenPlayers.add(dedupeKey);
          uniqueRows.push(row);
          if (uniqueRows.length >= 100) break;
        }
        setLeaderboardRows(uniqueRows);
        setLeaderboardError(null);
      }
      setLeaderboardLoading(false);
    };
    loadLeaderboard().catch((err) => {
      if (cancelled) return;
      setLeaderboardRows([]);
      setLeaderboardLoading(false);
      setLeaderboardError(err?.message || 'Leaderboard unavailable');
    });
    return () => {
      cancelled = true;
    };
  }, [battlegroundKey, state?.open]);

  return React.createElement('div', { style: overlayStyle, onMouseDown: onClose },
    React.createElement('div', { style: shellStyle, onMouseDown: (e) => e.stopPropagation() },
      React.createElement('div', { style: panelStyle },
        React.createElement('div', {
          style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px', borderBottom: '1px solid rgba(255,255,255,0.08)', paddingBottom: '10px' }
        },
          React.createElement('div', null,
            React.createElement('div', { style: { color: '#00ccff', fontSize: '18px', fontWeight: 'bold', letterSpacing: '2px' } }, 'BATTLEGROUND'),
            React.createElement('div', { style: { color: '#6f8aa0', fontSize: '11px', marginTop: '4px' } }, subtitle)
          ),
          React.createElement('button', {
            onClick: onClose,
            style: { background: 'transparent', border: '1px solid rgba(255,255,255,0.14)', color: '#8aa3b5', borderRadius: '4px', padding: '6px 10px', cursor: 'pointer', fontFamily: 'monospace' }
          }, 'CLOSE')
        ),
        React.createElement('div', { style: { display: 'flex', gap: '8px', marginBottom: '14px' } },
          tabs.map((tab) => React.createElement('button', {
            key: tab.key,
            onClick: () => tab.enabled !== false && setActiveTab(tab.key),
            disabled: tab.enabled === false,
            style: {
              padding: '8px 12px',
              border: '1px solid ' + (activeTab === tab.key ? 'rgba(0,204,255,0.42)' : 'rgba(255,255,255,0.12)'),
              borderRadius: '4px 4px 0 0',
              background: tab.enabled === false ? 'rgba(255,255,255,0.04)' : (activeTab === tab.key ? 'rgba(0,204,255,0.14)' : 'rgba(255,255,255,0.03)'),
              color: tab.enabled === false ? '#5f7482' : (activeTab === tab.key ? '#00ccff' : '#a8c3d2'),
              fontWeight: 'bold',
              fontSize: '11px',
              letterSpacing: '1px',
              cursor: tab.enabled === false ? 'default' : 'pointer',
              fontFamily: 'monospace'
            }
          }, tab.label))
        ),
        React.createElement('div', {
          style: { border: '1px solid rgba(0,204,255,0.14)', borderRadius: '4px', padding: '14px', background: 'rgba(255,255,255,0.02)' }
        },
          React.createElement('div', { style: { color: '#d7efff', fontSize: '17px', fontWeight: 'bold', marginBottom: '6px', letterSpacing: '1px' } }, title),
          React.createElement('div', { style: { color: '#6f8aa0', fontSize: '11px', marginBottom: '14px' } }, selectedTab.label),
          React.createElement('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginBottom: '14px' } },
            React.createElement('div', { style: { padding: '10px', border: '1px solid rgba(255,255,255,0.08)', background: 'rgba(255,255,255,0.02)', borderRadius: '4px' } },
              React.createElement('div', { style: { color: '#8ea9b9', fontSize: '10px', marginBottom: '4px' } }, 'MODE'),
              React.createElement('div', { style: { color: '#fff', fontSize: '12px', fontWeight: 'bold' } }, 'PRIVATE WAVE ENGAGEMENT')
            ),
            React.createElement('div', { style: { padding: '10px', border: '1px solid rgba(255,255,255,0.08)', background: 'rgba(255,255,255,0.02)', borderRadius: '4px' } },
              React.createElement('div', { style: { color: '#8ea9b9', fontSize: '10px', marginBottom: '4px' } }, 'PUBLIC WAVE CAP'),
              React.createElement('div', { style: { color: '#fff', fontSize: '12px', fontWeight: 'bold' } }, String(maxWave))
            ),
            React.createElement('div', { style: { padding: '10px', border: '1px solid rgba(255,255,255,0.08)', background: 'rgba(255,255,255,0.02)', borderRadius: '4px' } },
              React.createElement('div', { style: { color: '#8ea9b9', fontSize: '10px', marginBottom: '4px' } }, 'REWARD MODE'),
              React.createElement('div', { style: { color: '#fff', fontSize: '12px', fontWeight: 'bold' } }, rewardMode === 'extract_bank' ? 'EXTRACT TO CLAIM' : String(rewardMode).toUpperCase())
            ),
            React.createElement('div', { style: { padding: '10px', border: '1px solid rgba(255,255,255,0.08)', background: 'rgba(255,255,255,0.02)', borderRadius: '4px' } },
              React.createElement('div', { style: { color: '#8ea9b9', fontSize: '10px', marginBottom: '4px' } }, 'DROP POLICY'),
              React.createElement('div', { style: { color: '#fff', fontSize: '12px', fontWeight: 'bold' } }, 'NO NPC LOOT DROPS')
            )
          ),
          React.createElement('div', { style: { color: '#7f96a7', fontSize: '11px', lineHeight: 1.65, marginBottom: '14px' } },
            'Survive escalating pirate waves inside a private Omni Directorate combat instance. Credits are banked during the run and only paid when you extract. Destruction loses the banked total.'
          ),
          React.createElement('div', { style: { color: status === 'error' ? '#ff8c8c' : '#73d5ff', fontSize: '11px', marginBottom: '16px' } }, shellMessage),
          React.createElement('div', { style: { display: 'flex', gap: '10px' } },
            React.createElement('button', {
              onClick: onEnter,
              disabled: loading || entering || selectedTab?.enabled === false,
              style: {
                ...buttonBase,
                flex: 1,
                background: loading || entering ? 'rgba(0,204,255,0.10)' : 'linear-gradient(180deg, rgba(0,204,255,0.26), rgba(0,110,170,0.28))',
                border: '1px solid rgba(0,204,255,0.45)',
                color: '#fff',
                cursor: loading || entering || selectedTab?.enabled === false ? 'default' : 'pointer'
              }
            }, entering ? 'LINKING...' : (loading ? 'SYNCING...' : 'ENTER BATTLEGROUND')),
            React.createElement('button', {
              onClick: onClose,
              style: {
                ...buttonBase,
                width: '140px',
                background: 'transparent',
                border: '1px solid rgba(255,255,255,0.14)',
                color: '#9db5c4'
              }
            }, 'CLOSE')
          )
        )
      ),
      React.createElement('div', { style: leaderboardPanelStyle },
        React.createElement('div', {
          style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px', borderBottom: '1px solid rgba(255,255,255,0.08)', paddingBottom: '10px' }
        },
          React.createElement('div', null,
            React.createElement('div', { style: { color: '#00ccff', fontSize: '16px', fontWeight: 'bold', letterSpacing: '2px' } }, 'LEADERBOARD'),
            React.createElement('div', { style: { color: '#6f8aa0', fontSize: '11px', marginTop: '4px' } }, 'TOP 100 EXTRACTED RUNS')
          ),
          React.createElement('div', { style: { color: '#8aa3b5', fontSize: '10px' } }, battlegroundKey || 'NO KEY')
        ),
        React.createElement('div', {
          style: {
            display: 'grid',
            gridTemplateColumns: '48px minmax(0, 1fr) 74px 96px',
            gap: '8px',
            padding: '0 8px 8px 8px',
            color: '#8ea9b9',
            fontSize: '10px',
            letterSpacing: '1px',
            borderBottom: '1px solid rgba(255,255,255,0.08)',
            marginBottom: '8px'
          }
        },
          React.createElement('div', null, '#'),
          React.createElement('div', null, 'COMMANDER'),
          React.createElement('div', { style: { textAlign: 'right' } }, 'WAVE'),
          React.createElement('div', { style: { textAlign: 'right' } }, 'CREDITS')
        ),
        React.createElement('div', {
          style: {
            flex: 1,
            overflowY: 'auto',
            paddingRight: '4px'
          }
        },
          leaderboardLoading && React.createElement('div', { style: { color: '#73d5ff', fontSize: '12px', padding: '12px 8px' } }, 'SYNCING LEADERBOARD...'),
          (!leaderboardLoading && leaderboardError) && React.createElement('div', { style: { color: '#ff8c8c', fontSize: '12px', padding: '12px 8px' } }, leaderboardError),
          (!leaderboardLoading && !leaderboardError && leaderboardRows.length <= 0) && React.createElement('div', { style: { color: '#8ea9b9', fontSize: '12px', padding: '12px 8px' } }, 'No extracted runs recorded yet.'),
          (!leaderboardLoading && !leaderboardError) && leaderboardRows.map((row, index) => React.createElement('div', {
            key: row.id || `${row.commander_name || 'commander'}-${index}`,
            style: {
              display: 'grid',
              gridTemplateColumns: '48px minmax(0, 1fr) 74px 96px',
              gap: '8px',
              alignItems: 'center',
              padding: '8px',
              borderBottom: '1px solid rgba(255,255,255,0.05)',
              background: index % 2 === 0 ? 'rgba(255,255,255,0.015)' : 'transparent'
            }
          },
            React.createElement('div', { style: { color: index < 3 ? '#73d5ff' : '#9cc7d9', fontSize: '12px', fontWeight: 'bold' } }, `#${index + 1}`),
            React.createElement('div', {
              style: {
                color: '#ffffff',
                fontSize: '12px',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis'
              },
              title: row.commander_name || 'Unknown Commander'
            }, row.commander_name || 'Unknown Commander'),
            React.createElement('div', { style: { color: '#ffffff', fontSize: '12px', textAlign: 'right' } }, String(Number(row.highest_wave || 0))),
            React.createElement('div', { style: { color: '#d7efff', fontSize: '12px', textAlign: 'right' } }, formatCredits(row.reward_secured || 0))
          ))
        )
      )
    )
  );
};

export default PveBattlegroundMenu;