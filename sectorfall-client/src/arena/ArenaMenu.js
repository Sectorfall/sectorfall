import React from 'react';

const panelStyle = {
  position: 'absolute',
  top: '50%',
  left: '50%',
  transform: 'translate(-50%, -50%)',
  width: '420px',
  minHeight: '300px',
  background: 'linear-gradient(180deg, rgba(8,16,26,0.98), rgba(4,8,14,0.98))',
  border: '1px solid rgba(0,204,255,0.35)',
  boxShadow: '0 0 40px rgba(0,0,0,0.65), inset 0 0 25px rgba(0,204,255,0.06)',
  borderRadius: '6px',
  padding: '16px',
  color: '#fff',
  fontFamily: 'monospace',
  zIndex: 2600,
  pointerEvents: 'auto'
};

const tabStyle = {
  padding: '8px 16px',
  border: '1px solid rgba(0,204,255,0.3)',
  borderRadius: '4px 4px 0 0',
  background: 'rgba(0,204,255,0.12)',
  color: '#00ccff',
  fontWeight: 'bold',
  fontSize: '12px',
  letterSpacing: '1px',
  display: 'inline-flex'
};

export const ArenaMenu = ({ state, onClose, onEnter, onLeave, inArena = false }) => {
  const joining = state?.status === 'joining';
  const leaving = state?.status === 'leaving';
  return React.createElement('div', {
    style: {
      position: 'absolute', inset: 0, background: 'transparent', zIndex: 2550, pointerEvents: 'auto'
    },
    onMouseDown: onClose
  },
    React.createElement('div', { style: panelStyle, onMouseDown: (e) => e.stopPropagation() },
      React.createElement('div', {
        style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px', borderBottom: '1px solid rgba(255,255,255,0.08)', paddingBottom: '10px' }
      },
        React.createElement('div', null,
          React.createElement('div', { style: { color: '#00ccff', fontSize: '18px', fontWeight: 'bold', letterSpacing: '2px' } }, 'ARENA'),
          React.createElement('div', { style: { color: '#6f8aa0', fontSize: '11px', marginTop: '4px' } }, 'FEDERATION COMBAT ACCESS NODE')
        ),
        React.createElement('button', {
          onClick: onClose,
          style: { background: 'transparent', border: '1px solid rgba(255,255,255,0.14)', color: '#8aa3b5', borderRadius: '4px', padding: '6px 10px', cursor: 'pointer', fontFamily: 'monospace' }
        }, 'CLOSE')
      ),
      React.createElement('div', { style: { marginBottom: '14px' } },
        React.createElement('div', { style: tabStyle }, 'ARENA')
      ),
      React.createElement('div', {
        style: { border: '1px solid rgba(0,204,255,0.14)', borderRadius: '4px', padding: '14px', background: 'rgba(255,255,255,0.02)' }
      },
        React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', marginBottom: '10px', fontSize: '12px' } },
          React.createElement('span', { style: { color: '#9fb7c8' } }, 'SECTOR'),
          React.createElement('span', { style: { color: '#fff', fontWeight: 'bold' } }, 'ARENA INSTANCE')
        ),
        React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', marginBottom: '10px', fontSize: '12px' } },
          React.createElement('span', { style: { color: '#9fb7c8' } }, 'SECURITY'),
          React.createElement('span', { style: { color: '#ff6666', fontWeight: 'bold' } }, '0.0')
        ),
        React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', marginBottom: '16px', fontSize: '12px' } },
          React.createElement('span', { style: { color: '#9fb7c8' } }, 'SHIP LOADOUT'),
          React.createElement('span', { style: { color: '#fff', fontWeight: 'bold' } }, 'CURRENT COMMAND SHIP')
        ),
        React.createElement('div', { style: { color: '#7f96a7', fontSize: '11px', lineHeight: 1.6, marginBottom: '18px' } },
          'Arena instances use your current ship and fittings. Vessel destruction is suppressed inside the arena and replaced with an in-instance combat respawn.'
        ),
        React.createElement('div', { style: { display: 'flex', gap: '10px' } },
          !inArena && React.createElement('button', {
            onClick: onEnter,
            disabled: joining,
            style: {
              flex: 1, padding: '12px 14px', borderRadius: '4px', cursor: joining ? 'default' : 'pointer',
              background: joining ? 'rgba(0,204,255,0.12)' : 'linear-gradient(180deg, rgba(0,204,255,0.28), rgba(0,110,170,0.28))',
              border: '1px solid rgba(0,204,255,0.45)', color: '#fff', fontFamily: 'monospace', fontWeight: 'bold', letterSpacing: '2px'
            }
          }, joining ? 'LINKING...' : 'ENTER'),
          inArena && React.createElement('button', {
            onClick: onLeave,
            disabled: leaving,
            style: {
              flex: 1, padding: '12px 14px', borderRadius: '4px', cursor: leaving ? 'default' : 'pointer',
              background: leaving ? 'rgba(255,120,120,0.12)' : 'linear-gradient(180deg, rgba(255,90,90,0.24), rgba(120,20,20,0.24))',
              border: '1px solid rgba(255,110,110,0.45)', color: '#fff', fontFamily: 'monospace', fontWeight: 'bold', letterSpacing: '2px'
            }
          }, leaving ? 'RETURNING...' : 'LEAVE ARENA')
        )
      )
    )
  );
};

export default ArenaMenu;