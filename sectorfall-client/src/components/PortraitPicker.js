import React, { useState, useEffect } from 'react';
import { supabase } from '../supabaseClient.js';
import { useGameState } from '../state/GameState.js';

/**
 * PortraitPicker Component
 * Allows commanders to view, select, and purchase character portraits.
 */
const PortraitPicker = ({ onClose }) => {
    const { commander_id, refreshCommanderData } = useGameState();
    const [portraits, setPortraits] = useState([]);
    const [ownedPortraits, setOwnedPortraits] = useState(new Set());
    const [activePortraitId, setActivePortraitId] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [processingId, setProcessingId] = useState(null);

    const fetchData = async () => {
        if (!commander_id) return;
        setLoading(true);
        setError(null);

        try {
            // 1. Fetch all available portraits
            const { data: allPortraits, error: portraitsError } = await supabase
                .from('portraits')
                .select('*')
                .order('price', { ascending: true });

            if (portraitsError) throw portraitsError;

            // 2. Fetch commander's owned portraits
            const { data: owned, error: ownedError } = await supabase
                .from('commander_portraits')
                .select('portrait_id')
                .eq('commander_id', commander_id);

            if (ownedError) throw ownedError;

            // 3. Fetch commander's active portrait mapping
            const { data: activeMapping, error: activeError } = await supabase
                .from('commander_portraits')
                .select('portrait_id')
                .eq('commander_id', commander_id)
                .maybeSingle();

            if (activeError) throw activeError;

            setPortraits(allPortraits || []);
            // Normalize IDs to strings for robust Set operations
            setOwnedPortraits(new Set((owned || []).map(p => String(p.portrait_id))));
            setActivePortraitId(activeMapping?.portrait_id || null);
        } catch (err) {
            console.error('Error fetching portrait data:', err);
            setError('Failed to load portraits. Please try again.');
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchData();
    }, [commander_id]);

    const handleSelectPortrait = async (portraitId) => {
        if (!commander_id || processingId) return;
        setProcessingId(portraitId);

        try {
            // Use upsert to handle the case where the record might not exist yet,
            // especially for free portraits that haven't been selected before.
            const { error: updateError } = await supabase
                .from('commander_portraits')
                .upsert({ 
                    commander_id: commander_id, 
                    portrait_id: portraitId,
                    updated_at: new Date().toISOString()
                }, { onConflict: 'commander_id' });

            if (updateError) throw updateError;
            setActivePortraitId(portraitId);
            await refreshCommanderData();
        } catch (err) {
            console.error('Error updating portrait:', err);
            alert('Failed to update active portrait.');
        } finally {
            setProcessingId(null);
        }
    };

    const handlePurchasePortrait = async (portrait) => {
        if (!commander_id || processingId) return;
        
        const confirmPurchase = window.confirm(`Purchase ${portrait.name} for ${portrait.price} CR?`);
        if (!confirmPurchase) return;

        setProcessingId(portrait.portrait_id);
        console.log(`STUB: Purchasing portrait ${portrait.portrait_id} for commander ${commander_id}`);
        
        // This is a stub as requested. In a real scenario, this would call a Supabase function or API.
        setTimeout(() => {
            alert(`Purchase feature for ${portrait.name} is coming soon!`);
            setProcessingId(null);
        }, 500);
    };

    const renderContent = () => {
        if (loading) {
            return React.createElement('div', { 
                style: { 
                    display: 'grid', 
                    gridTemplateColumns: 'repeat(3, 1fr)', 
                    gap: '10px', 
                    padding: '10px' 
                } 
            },
                [1, 2, 3, 4, 5, 6].map(i => React.createElement('div', {
                    key: i,
                    style: {
                        aspectRatio: '1/1',
                        background: 'rgba(255,255,255,0.05)',
                        borderRadius: '4px',
                        animation: 'skeleton-pulse 1.5s infinite ease-in-out'
                    }
                }))
            );
        }

        if (error) {
            return React.createElement('div', { 
                style: { 
                    color: '#ff4444', 
                    padding: '20px', 
                    textAlign: 'center', 
                    fontSize: '12px' 
                } 
            }, error);
        }

        return React.createElement('div', {
            style: {
                display: 'flex',
                flexDirection: 'column',
                gap: '15px',
                height: '100%',
                animation: 'fadeIn 0.3s ease-out'
            }
        },
            React.createElement('div', { 
                style: { 
                    fontSize: '11px', 
                    color: '#888', 
                    letterSpacing: '1px' 
                } 
            }, "SELECT COMMANDER AVATAR"),
            
            React.createElement('div', {
                style: {
                    display: 'grid',
                    gridTemplateColumns: 'repeat(3, 1fr)',
                    gap: '12px',
                    overflowY: 'auto',
                    flex: 1,
                    paddingRight: '5px'
                }
            },
                portraits.map(portrait => {
                    const portraitIdStr = String(portrait.portrait_id);
                    // Free portraits (price 0) are always considered owned.
                    // Also check against the set of explicitly owned portraits from the database.
                    const isOwned = ownedPortraits.has(portraitIdStr) || Number(portrait.price) === 0;
                    const isActive = String(activePortraitId) === portraitIdStr;
                    const isProcessing = processingId === portrait.portrait_id;

                    return React.createElement('div', {
                        key: portrait.portrait_id,
                        onClick: () => isOwned ? handleSelectPortrait(portrait.portrait_id) : handlePurchasePortrait(portrait),
                        style: {
                            position: 'relative',
                            aspectRatio: '1/1',
                            background: 'rgba(0,0,0,0.4)',
                            border: `2px solid ${isActive ? '#ffcc00' : (isOwned ? '#444' : 'rgba(255, 255, 255, 0.05)')}`,
                            borderRadius: '4px',
                            cursor: isProcessing ? 'default' : 'pointer',
                            overflow: 'hidden',
                            transition: 'all 0.2s',
                            opacity: isProcessing ? 0.6 : 1,
                            boxShadow: isActive ? '0 0 15px rgba(255, 204, 0, 0.2)' : 'none'
                        },
                        onMouseEnter: (e) => {
                            if (!isProcessing) {
                                e.currentTarget.style.borderColor = isActive ? '#ffcc00' : (isOwned ? '#888' : '#666');
                                e.currentTarget.style.transform = 'scale(1.02)';
                            }
                        },
                        onMouseLeave: (e) => {
                            if (!isProcessing) {
                                e.currentTarget.style.borderColor = isActive ? '#ffcc00' : (isOwned ? '#444' : 'rgba(255, 255, 255, 0.05)');
                                e.currentTarget.style.transform = 'scale(1)';
                            }
                        }
                    },
                        // Image
                        React.createElement('img', {
                            src: portrait.image_url,
                            alt: portrait.name,
                            style: {
                                width: '100%',
                                height: '100%',
                                objectFit: 'cover',
                                filter: isOwned ? 'none' : 'grayscale(100%) opacity(0.4)'
                            }
                        }),

                        // Lock Overlay
                        !isOwned && React.createElement('div', {
                            style: {
                                position: 'absolute',
                                top: 0,
                                left: 0,
                                width: '100%',
                                height: '100%',
                                display: 'flex',
                                flexDirection: 'column',
                                alignItems: 'center',
                                justifyContent: 'center',
                                background: 'rgba(0,0,0,0.3)',
                                gap: '4px'
                            }
                        },
                            React.createElement('span', { style: { fontSize: '14px' } }, "🔒"),
                            React.createElement('span', { style: { fontSize: '9px', color: '#ffcc00', fontWeight: 'bold' } }, `${portrait.price} CR`)
                        ),

                        // Active Badge
                        isActive && React.createElement('div', {
                            style: {
                                position: 'absolute',
                                top: '5px',
                                right: '5px',
                                background: '#ffcc00',
                                color: '#000',
                                fontSize: '8px',
                                padding: '2px 4px',
                                borderRadius: '2px',
                                fontWeight: 'bold'
                            }
                        }, "ACTIVE"),

                        // Rarity Bar
                        React.createElement('div', {
                            style: {
                                position: 'absolute',
                                bottom: 0,
                                left: 0,
                                width: '100%',
                                height: '3px',
                                background: portrait.rarity === 'legendary' ? '#ff00ff' : (portrait.rarity === 'epic' ? '#a335ee' : (portrait.rarity === 'rare' ? '#0070dd' : '#9d9d9d'))
                            }
                        })
                    );
                })
            ),

            // Info footer
            React.createElement('div', {
                style: {
                    padding: '10px',
                    background: 'rgba(255, 255, 255, 0.02)',
                    borderRadius: '4px',
                    fontSize: '10px',
                    color: '#666',
                    lineHeight: '1.4'
                }
            }, "Owned portraits are unlocked across the entire Directorate network. Select a portrait to update your profile identification.")
        );
    };

    return React.createElement('div', {
        style: {
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            width: '400px',
            height: '500px',
            background: 'rgba(20, 22, 25, 0.98)',
            border: '2px solid #444',
            borderRadius: '8px',
            boxShadow: '0 0 30px rgba(0,0,0,0.8), inset 0 0 20px rgba(255,255,255,0.02)',
            padding: '25px',
            color: '#fff',
            fontFamily: 'monospace',
            zIndex: 3000,
            pointerEvents: 'auto',
            display: 'flex',
            flexDirection: 'column',
            transition: 'all 0.3s ease'
        }
    },
        // Close Button
        React.createElement('div', {
            onClick: onClose,
            style: {
                position: 'absolute',
                top: '10px',
                right: '15px',
                cursor: 'pointer',
                color: '#888',
                fontSize: '20px'
            }
        }, '✕'),

        // Title
        React.createElement('div', {
            style: {
                fontSize: '18px',
                fontWeight: 'bold',
                color: '#00ccff',
                marginBottom: '20px',
                borderBottom: '1px solid #444',
                paddingBottom: '10px',
                letterSpacing: '2px'
            }
        }, 'PORTRAIT REGISTRY'),

        renderContent()
    );
};


export default PortraitPicker;
