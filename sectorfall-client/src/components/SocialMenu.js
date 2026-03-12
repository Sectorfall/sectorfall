import React, { useState, useEffect } from 'react';
import { useDraggable } from '../hooks/useDraggable.js';
import { supabase } from '../supabaseClient.js';
import { useGameState } from '../state/GameState.js';

const JoinSyndicateView = ({ onBack, onSuccess }) => {
    const { commander_id } = useGameState();
    const [searchTerm, setSearchTerm] = useState('');
    const [syndicates, setSyndicates] = useState([]);
    const [loading, setLoading] = useState(false);
    const [joiningId, setJoiningId] = useState(null);
    const [error, setError] = useState(null);
    const [applicationStatus, setApplicationStatus] = useState(null);

    const fetchApplicationStatus = async () => {
        if (!commander_id) return;

        try {
            const { data, error: fetchError } = await supabase
                .from('syndicate_members')
                .select('syndicate_id, role_key')
                .eq('player_id', commander_id)
                .maybeSingle();

            if (fetchError) throw fetchError;
            setApplicationStatus(data);
        } catch (err) {
            console.error("Error fetching application status:", err);
        }
    };

    const searchSyndicates = async () => {
        setLoading(true);
        setError(null);
        try {
            let query = supabase.from('syndicates').select('syndicate_id, name, tag, motto, description, emblem_url');
            if (searchTerm.trim()) {
                const term = `%${searchTerm.trim()}%`;
                query = query.or(`name.ilike.${term},tag.ilike.${term}`);
            }
            const { data, error: searchError } = await query.limit(20);
            if (searchError) throw searchError;
            setSyndicates(data || []);
        } catch (err) {
            setError("Failed to fetch syndicates.");
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchApplicationStatus();
        searchSyndicates();
    }, [commander_id]);

    const handleApply = async (syndicateId) => {
        if (applicationStatus) return;
        setJoiningId(syndicateId);
        setError(null);
        try {
            if (!commander_id) throw new Error('Commander identity lost');

            const { error: joinError } = await supabase
                .from('syndicate_members')
                .insert({
                    syndicate_id: syndicateId,
                    player_id: commander_id,
                    role_key: 'applicant'
                });

            if (joinError) throw joinError;
            await fetchApplicationStatus();
            onSuccess?.();
        } catch (err) {
            setError(err.message || "Failed to submit application.");
        } finally {
            setJoiningId(null);
        }
    };

    if (applicationStatus && applicationStatus.role_key !== 'applicant') {
        return React.createElement('div', { style: { display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: '20px', textAlign: 'center' } },
            React.createElement('div', { style: { fontSize: '14px', color: '#ffcc00' } }, "YOU ARE ALREADY A MEMBER OF A SYNDICATE."),
            React.createElement('button', {
                onClick: onBack,
                style: { padding: '12px 24px', background: 'rgba(255, 204, 0, 0.1)', border: '1px solid #ffcc00', color: '#ffcc00', cursor: 'pointer', borderRadius: '2px' }
            }, "GO TO OVERVIEW")
        );
    }

    return React.createElement('div', {
        style: { display: 'flex', flexDirection: 'column', gap: '20px', animation: 'fadeIn 0.3s ease-out', height: '100%' }
    },
        // Header
        React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
            React.createElement('div', { style: { fontSize: '16px', fontWeight: 'bold', letterSpacing: '2px', color: '#ffcc00' } }, "JOIN A SYNDICATE"),
            React.createElement('button', {
                onClick: onBack,
                style: { background: 'none', border: 'none', color: '#888', cursor: 'pointer', fontSize: '18px' }
            }, "✕")
        ),

        // Search Bar
        React.createElement('div', { style: { position: 'relative' } },
            React.createElement('input', {
                value: searchTerm,
                onChange: (e) => setSearchTerm(e.target.value),
                onKeyDown: (e) => e.key === 'Enter' && searchSyndicates(),
                placeholder: 'SEARCH BY NAME OR TAG...',
                style: { width: '100%', padding: '12px 12px 12px 35px', background: 'rgba(0,0,0,0.4)', border: '1px solid #444', color: '#fff', borderRadius: '4px', fontSize: '13px', boxSizing: 'border-box' }
            }),
            React.createElement('div', {
                onClick: searchSyndicates,
                style: { position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)', cursor: 'pointer', opacity: 0.5 }
            }, "🔍")
        ),

        // List
        React.createElement('div', {
            style: { flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '10px' }
        },
            loading ? (
                [1, 2, 3].map(i => React.createElement('div', { key: i, style: { height: '100px', background: 'rgba(255,255,255,0.02)', borderRadius: '4px', animation: 'skeleton-pulse 1.5s infinite ease-in-out' } }))
            ) : syndicates.length === 0 ? (
                React.createElement('div', { style: { textAlign: 'center', padding: '40px', color: '#666', fontStyle: 'italic' } }, "No syndicates found.")
            ) : (
                syndicates.map(syn => {
                    const isPending = applicationStatus?.syndicate_id === syn.syndicate_id && applicationStatus?.role_key === 'applicant';
                    const hasOtherApp = applicationStatus && !isPending;

                    return React.createElement('div', {
                        key: syn.syndicate_id,
                        style: {
                            padding: '15px',
                            background: 'rgba(255,255,255,0.03)',
                            border: '1px solid #333',
                            borderRadius: '4px',
                            display: 'flex',
                            gap: '15px',
                            alignItems: 'center'
                        }
                    },
                        React.createElement('div', {
                            style: {
                                width: '50px',
                                height: '50px',
                                background: 'rgba(255,255,255,0.05)',
                                borderRadius: '4px',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                fontSize: '20px',
                                flexShrink: 0
                            }
                        }, "💠"),
                        React.createElement('div', { style: { flex: 1, display: 'flex', flexDirection: 'column', gap: '4px' } },
                            React.createElement('div', { style: { display: 'flex', alignItems: 'baseline', gap: '8px' } },
                                React.createElement('span', { style: { fontWeight: 'bold', color: '#fff', fontSize: '14px' } }, syn.name.toUpperCase()),
                                React.createElement('span', { style: { fontSize: '11px', color: '#ffcc00' } }, `[${syn.tag}]`)
                            ),
                            React.createElement('div', { style: { fontSize: '11px', color: '#666', maxWidth: '280px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, syn.motto || "No motto recorded.")
                        ),
                        React.createElement('button', {
                            onClick: () => handleApply(syn.syndicate_id),
                            disabled: joiningId !== null || isPending || hasOtherApp,
                            style: {
                                padding: '8px 12px',
                                background: isPending ? 'rgba(255, 204, 0, 0.1)' : (joiningId === syn.syndicate_id || hasOtherApp ? 'rgba(255,255,255,0.05)' : 'rgba(0, 204, 255, 0.1)'),
                                border: `1px solid ${isPending ? '#ffcc00' : (joiningId === syn.syndicate_id || hasOtherApp ? '#444' : '#00ccff')}`,
                                color: isPending ? '#ffcc00' : (joiningId === syn.syndicate_id || hasOtherApp ? '#666' : '#00ccff'),
                                cursor: isPending || hasOtherApp ? 'default' : 'pointer',
                                fontSize: '10px',
                                fontWeight: 'bold',
                                borderRadius: '2px',
                                minWidth: '100px'
                            }
                        }, isPending ? "PENDING" : (joiningId === syn.syndicate_id ? "SUBMITTING..." : "APPLY"))
                    );
                })
            )
        ),

        error && React.createElement('div', {
            style: { color: '#ff4444', fontSize: '11px', padding: '10px', background: 'rgba(255, 68, 68, 0.1)', border: '1px solid #ff444444', borderRadius: '4px' }
        }, error),

        React.createElement('button', {
            onClick: onBack,
            style: { width: '100%', padding: '12px', background: 'rgba(255,255,255,0.05)', border: '1px solid #333', color: '#888', cursor: 'pointer', fontSize: '11px', fontWeight: 'bold', borderRadius: '2px' }
        }, "BACK")
    );
};

const CreateSyndicateView = ({ onBack, onSuccess }) => {
    const { commander_id } = useGameState();
    const [formData, setFormData] = useState({ name: '', tag: '', motto: '', emblem: 'default' });
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);

    const validateAndCreate = async () => {
        if (!formData.name.trim() || !formData.tag.trim()) {
            setError("Name and Tag are required.");
            return;
        }

        setLoading(true);
        setError(null);

        try {
            if (!commander_id) throw new Error('Commander identity lost');

            // 1. Check if already in syndicate
            const { data: existingMember } = await supabase
                .from('syndicate_members')
                .select('syndicate_id')
                .eq('player_id', commander_id)
                .single();

            if (existingMember) {
                setError("You are already in a syndicate.");
                setLoading(false);
                return;
            }

            // 2. Check name uniqueness
            const { data: nameCheck } = await supabase
                .from('syndicates')
                .select('syndicate_id')
                .eq('name', formData.name.trim())
                .maybeSingle();

            if (nameCheck) {
                setError("Syndicate name already taken.");
                setLoading(false);
                return;
            }

            // 3. Check tag uniqueness
            const { data: tagCheck } = await supabase
                .from('syndicates')
                .select('syndicate_id')
                .eq('tag', formData.tag.trim().toUpperCase())
                .maybeSingle();

            if (tagCheck) {
                setError("Syndicate tag already taken.");
                setLoading(false);
                return;
            }

            // 4. Create Syndicate
            const { data: newSyndicate, error: createError } = await supabase
                .from('syndicates')
                .insert({
                    name: formData.name.trim(),
                    tag: formData.tag.trim().toUpperCase(),
                    motto: formData.motto.trim(),
                    emblem: formData.emblem
                })
                .select()
                .single();

            if (createError) throw createError;

            // 5. Create Leader Membership
            const { error: memberError } = await supabase
                .from('syndicate_members')
                .insert({
                    syndicate_id: newSyndicate.syndicate_id,
                    player_id: commander_id,
                    role_key: 'leader'
                });

            if (memberError) throw memberError;

            // 6. Create Wallet
            const { error: walletError } = await supabase
                .from('syndicate_wallets')
                .insert({ syndicate_id: newSyndicate.syndicate_id });

            if (walletError) throw walletError;

            onSuccess();
        } catch (err) {
            console.error('Syndicate creation failed:', err);
            setError(err.message || "Failed to create syndicate.");
        } finally {
            setLoading(false);
        }
    };

    return React.createElement('div', {
        style: {
            display: 'flex',
            flexDirection: 'column',
            gap: '20px',
            animation: 'fadeIn 0.3s ease-out',
            height: '100%'
        }
    },
        // Header
        React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
            React.createElement('div', { style: { fontSize: '16px', fontWeight: 'bold', letterSpacing: '2px', color: '#ffcc00' } }, "CREATE SYNDICATE"),
            React.createElement('button', {
                onClick: onBack,
                style: { background: 'none', border: 'none', color: '#888', cursor: 'pointer', fontSize: '18px' }
            }, "✕")
        ),

        // Form
        React.createElement('div', {
            style: {
                display: 'flex',
                flexDirection: 'column',
                gap: '15px',
                flex: 1,
                overflowY: 'auto',
                paddingRight: '5px'
            }
        },
            // Name Field
            React.createElement('div', null,
                React.createElement('div', { style: { fontSize: '10px', color: '#888', marginBottom: '5px' } }, "SYNDICATE NAME"),
                React.createElement('input', {
                    value: formData.name,
                    onChange: (e) => setFormData({ ...formData, name: e.target.value.substring(0, 32) }),
                    placeholder: 'ENTER NAME...',
                    style: {
                        width: '100%',
                        padding: '12px',
                        background: 'rgba(0,0,0,0.4)',
                        border: '1px solid #444',
                        color: '#fff',
                        borderRadius: '4px',
                        fontSize: '13px',
                        boxSizing: 'border-box'
                    }
                })
            ),

            // Tag Field
            React.createElement('div', null,
                React.createElement('div', { style: { fontSize: '10px', color: '#888', marginBottom: '5px' } }, "TAG (MAX 4 CHARS)"),
                React.createElement('input', {
                    value: formData.tag,
                    onChange: (e) => setFormData({ ...formData, tag: e.target.value.substring(0, 4).toUpperCase() }),
                    placeholder: 'TAG',
                    style: {
                        width: '100px',
                        padding: '12px',
                        background: 'rgba(0,0,0,0.4)',
                        border: '1px solid #444',
                        color: '#ffcc00',
                        borderRadius: '4px',
                        fontSize: '13px',
                        fontWeight: 'bold',
                        textAlign: 'center',
                        boxSizing: 'border-box'
                    }
                })
            ),

            // Motto Field
            React.createElement('div', null,
                React.createElement('div', { style: { fontSize: '10px', color: '#888', marginBottom: '5px' } }, "MOTTO"),
                React.createElement('textarea', {
                    value: formData.motto,
                    onChange: (e) => setFormData({ ...formData, motto: e.target.value.substring(0, 128) }),
                    placeholder: 'A BRIEF DESCRIPTION OR MOTTO...',
                    style: {
                        width: '100%',
                        height: '80px',
                        padding: '12px',
                        background: 'rgba(0,0,0,0.4)',
                        border: '1px solid #444',
                        color: '#fff',
                        borderRadius: '4px',
                        fontSize: '12px',
                        resize: 'none',
                        boxSizing: 'border-box'
                    }
                })
            ),

            // Emblem Placeholder
            React.createElement('div', null,
                React.createElement('div', { style: { fontSize: '10px', color: '#888', marginBottom: '5px' } }, "EMBLEM SELECTION"),
                React.createElement('div', {
                    style: {
                        display: 'flex',
                        gap: '10px'
                    }
                },
                    ['default', 'shield', 'sword', 'eagle'].map(emb => React.createElement('div', {
                        key: emb,
                        onClick: () => setFormData({ ...formData, emblem: emb }),
                        style: {
                            width: '50px',
                            height: '50px',
                            background: formData.emblem === emb ? 'rgba(255, 204, 0, 0.2)' : 'rgba(255,255,255,0.05)',
                            border: formData.emblem === emb ? '1px solid #ffcc00' : '1px solid #333',
                            borderRadius: '4px',
                            cursor: 'pointer',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            fontSize: '10px',
                            color: formData.emblem === emb ? '#ffcc00' : '#666'
                        }
                    }, emb.toUpperCase()))
                )
            ),

            // Error Message
            error && React.createElement('div', {
                style: {
                    color: '#ff4444',
                    fontSize: '11px',
                    padding: '10px',
                    background: 'rgba(255, 68, 68, 0.1)',
                    border: '1px solid #ff444444',
                    borderRadius: '4px'
                }
            }, error)
        ),

        // Footer Actions
        React.createElement('div', {
            style: {
                display: 'flex',
                gap: '10px'
            }
        },
            React.createElement('button', {
                onClick: onBack,
                style: {
                    flex: 1,
                    padding: '12px',
                    background: 'rgba(255,255,255,0.05)',
                    border: '1px solid #333',
                    color: '#888',
                    cursor: 'pointer',
                    fontSize: '11px',
                    fontWeight: 'bold',
                    borderRadius: '2px'
                }
            }, "CANCEL"),
            React.createElement('button', {
                onClick: validateAndCreate,
                disabled: loading,
                style: {
                    flex: 2,
                    padding: '12px',
                    background: loading ? 'rgba(255, 204, 0, 0.2)' : '#ffcc00',
                    border: 'none',
                    color: '#000',
                    cursor: loading ? 'default' : 'pointer',
                    fontSize: '11px',
                    fontWeight: 'bold',
                    borderRadius: '2px',
                    opacity: loading ? 0.7 : 1
                }
            }, loading ? "ESTABLISHING..." : "CREATE SYNDICATE")
        )
    );
};

const SyndicateSettingsView = ({ syndicateId, currentUserRole, onBack, onUpdateSuccess, onLeaveSuccess }) => {
    const { commander_id } = useGameState();
    const [formData, setFormData] = useState({ description: '', motto: '', emblem_url: '', tax_rate: 0 });
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [isLeaving, setIsLeaving] = useState(false);
    const [error, setError] = useState(null);

    const isLeader = currentUserRole?.role_key === 'leader' || currentUserRole?.is_leader;

    useEffect(() => {
        const fetchSettings = async () => {
            setLoading(true);
            try {
                const { data, error: fetchError } = await supabase
                    .from('syndicates')
                    .select('description, motto, emblem_url, tax_rate')
                    .eq('syndicate_id', syndicateId)
                    .single();
                if (fetchError) throw fetchError;
                setFormData({
                    description: data.description || '',
                    motto: data.motto || '',
                    emblem_url: data.emblem_url || '',
                    tax_rate: data.tax_rate || 0
                });
            } catch (err) {
                console.error("Error fetching settings:", err);
                setError("Failed to load settings.");
            } finally {
                setLoading(false);
            }
        };
        if (syndicateId) fetchSettings();
    }, [syndicateId]);

    const handleSave = async () => {
        if (!isLeader) return;
        setSaving(true);
        setError(null);
        try {
            const { error: updateError } = await supabase
                .from('syndicates')
                .update({
                    description: formData.description.trim(),
                    motto: formData.motto.trim(),
                    emblem_url: formData.emblem_url.trim(),
                    tax_rate: parseFloat(formData.tax_rate) || 0
                })
                .eq('syndicate_id', syndicateId);
            
            if (updateError) throw updateError;
            onUpdateSuccess?.();
            onBack();
        } catch (err) {
            console.error("Error updating settings:", err);
            setError(err.message || "Failed to save settings.");
        } finally {
            setSaving(false);
        }
    };

    const handleLeave = async () => {
        if (isLeader) return;
        const confirmLeave = window.confirm("Are you sure you want to leave this syndicate? You will lose all access immediately.");
        if (!confirmLeave) return;

        setIsLeaving(true);
        try {
            if (!commander_id) throw new Error("Commander identity lost");

            const { error: deleteError } = await supabase
                .from('syndicate_members')
                .delete()
                .eq('player_id', commander_id);
            
            if (deleteError) throw deleteError;
            onLeaveSuccess?.();
        } catch (err) {
            console.error("Failed to leave syndicate:", err);
            setError(err.message || "Failed to leave syndicate.");
        } finally {
            setIsLeaving(false);
        }
    };

    if (loading) {
        return React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: '20px', animation: 'fadeIn 0.3s ease-out' } },
            [1, 2, 3].map(i => React.createElement('div', { key: i, style: { height: '60px', background: 'rgba(255,255,255,0.02)', borderRadius: '4px', animation: 'skeleton-pulse 1.5s infinite ease-in-out' } }))
        );
    }

    return React.createElement('div', {
        style: { display: 'flex', flexDirection: 'column', gap: '20px', animation: 'fadeIn 0.3s ease-out', height: '100%' }
    },
        React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
            React.createElement('div', { style: { fontSize: '16px', fontWeight: 'bold', letterSpacing: '2px', color: '#ffcc00' } }, "SYNDICATE SETTINGS"),
            React.createElement('button', { onClick: onBack, style: { background: 'none', border: 'none', color: '#888', cursor: 'pointer', fontSize: '18px' } }, "✕")
        ),

        !isLeader && React.createElement('div', {
            style: { padding: '12px', background: 'rgba(0, 204, 255, 0.05)', border: '1px solid #00ccff44', color: '#00ccff', fontSize: '11px', borderRadius: '4px', textAlign: 'center' }
        }, "As a member, you can view settings but only the leader can modify them."),

        React.createElement('div', {
            style: { flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '15px', paddingRight: '5px' }
        },
            // Motto
            React.createElement('div', null,
                React.createElement('div', { style: { fontSize: '10px', color: '#888', marginBottom: '5px' } }, "MOTTO"),
                React.createElement('input', {
                    disabled: !isLeader,
                    value: formData.motto,
                    onChange: (e) => setFormData({ ...formData, motto: e.target.value }),
                    placeholder: 'Enter motto...',
                    style: { width: '100%', padding: '12px', background: 'rgba(0,0,0,0.4)', border: '1px solid #444', color: '#fff', borderRadius: '4px', fontSize: '13px', boxSizing: 'border-box' }
                })
            ),

            // Description
            React.createElement('div', null,
                React.createElement('div', { style: { fontSize: '10px', color: '#888', marginBottom: '5px' } }, "DESCRIPTION"),
                React.createElement('textarea', {
                    disabled: !isLeader,
                    value: formData.description,
                    onChange: (e) => setFormData({ ...formData, description: e.target.value }),
                    placeholder: 'Briefly describe your syndicate...',
                    style: { width: '100%', height: '100px', padding: '12px', background: 'rgba(0,0,0,0.4)', border: '1px solid #444', color: '#fff', borderRadius: '4px', fontSize: '13px', boxSizing: 'border-box', resize: 'none' }
                })
            ),

            // Emblem URL
            React.createElement('div', null,
                React.createElement('div', { style: { fontSize: '10px', color: '#888', marginBottom: '5px' } }, "EMBLEM URL"),
                React.createElement('input', {
                    disabled: !isLeader,
                    value: formData.emblem_url,
                    onChange: (e) => setFormData({ ...formData, emblem_url: e.target.value }),
                    placeholder: 'https://...',
                    style: { width: '100%', padding: '12px', background: 'rgba(0,0,0,0.4)', border: '1px solid #444', color: '#fff', borderRadius: '4px', fontSize: '13px', boxSizing: 'border-box' }
                })
            ),

            // Tax Rate
            React.createElement('div', null,
                React.createElement('div', { style: { fontSize: '10px', color: '#888', marginBottom: '5px' } }, "TAX RATE (%)"),
                React.createElement('input', {
                    type: 'number',
                    disabled: !isLeader,
                    value: formData.tax_rate,
                    min: 0,
                    max: 100,
                    onChange: (e) => setFormData({ ...formData, tax_rate: e.target.value }),
                    style: { width: '100px', padding: '12px', background: 'rgba(0,0,0,0.4)', border: '1px solid #444', color: '#00ff66', borderRadius: '4px', fontSize: '13px', boxSizing: 'border-box', fontWeight: 'bold' }
                })
            ),

            error && React.createElement('div', { style: { color: '#ff4444', fontSize: '11px', background: 'rgba(255, 68, 68, 0.1)', padding: '10px', borderRadius: '4px' } }, error),

            // Leave Section
            React.createElement('div', { style: { marginTop: '20px', borderTop: '1px solid #222', paddingTop: '20px', display: 'flex', flexDirection: 'column', gap: '10px' } },
                React.createElement('div', { style: { fontSize: '10px', color: '#666', fontStyle: 'italic' } }, 
                    isLeader ? "You must transfer leadership before leaving the syndicate." : "Warning: Leaving will revoke all syndicate access immediately."
                ),
                React.createElement('button', {
                    disabled: isLeader || isLeaving,
                    onClick: handleLeave,
                    style: { 
                        width: '100%', 
                        padding: '12px', 
                        background: isLeader ? 'rgba(255,255,255,0.05)' : 'rgba(255, 68, 68, 0.1)', 
                        border: `1px solid ${isLeader ? '#333' : '#ff4444'}`, 
                        color: isLeader ? '#444' : '#ff4444', 
                        cursor: isLeader ? 'default' : 'pointer', 
                        fontSize: '11px', 
                        fontWeight: 'bold', 
                        borderRadius: '2px',
                        transition: 'all 0.2s'
                    }
                }, isLeader ? "TRANSFER LEADERSHIP REQUIRED" : (isLeaving ? "DEPARTING..." : "LEAVE SYNDICATE"))
            )
        ),

        React.createElement('div', { style: { display: 'flex', gap: '10px' } },
            React.createElement('button', {
                onClick: onBack,
                style: { flex: 1, padding: '12px', background: 'rgba(255,255,255,0.05)', border: '1px solid #333', color: '#888', cursor: 'pointer', fontSize: '11px', fontWeight: 'bold', borderRadius: '2px' }
            }, "CLOSE"),
            isLeader && React.createElement('button', {
                disabled: saving,
                onClick: handleSave,
                style: { flex: 2, padding: '12px', background: '#ffcc00', border: 'none', color: '#000', cursor: 'pointer', fontSize: '11px', fontWeight: 'bold', borderRadius: '2px', opacity: saving ? 0.7 : 1 }
            }, saving ? "SAVING..." : "SAVE SETTINGS")
        )
    );
};

const SyndicateTreasuryView = ({ syndicateId, currentUserRole, onBack }) => {
    const { commander_id } = useGameState();
    const [wallet, setWallet] = useState({ funds: 0 });
    const [ledger, setLedger] = useState([]);
    const [loading, setLoading] = useState(true);
    const [isProcessing, setIsProcessing] = useState(false);
    const [amount, setAmount] = useState('');
    const [memo, setMemo] = useState('');

    const fetchData = async () => {
        setLoading(true);
        try {
            const [walletRes, ledgerRes] = await Promise.all([
                supabase.from('syndicate_wallets').select('funds').eq('syndicate_id', syndicateId).maybeSingle(),
                supabase.from('syndicate_ledger')
                    .select(`
                        type, amount, ts, memo, actor_id,
                        commander_data (commander_name)
                    `)
                    .eq('syndicate_id', syndicateId)
                    .order('ts', { ascending: false })
                    .limit(50)
            ]);

            if (walletRes.data) setWallet(walletRes.data);
            setLedger(ledgerRes.data || []);
        } catch (err) {
            console.error("Error fetching treasury data:", err);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        if (syndicateId) fetchData();
    }, [syndicateId]);

    const handleTransaction = async (type) => {
        const val = parseInt(amount);
        if (isNaN(val) || val <= 0) return;
        if (type === 'withdraw' && val > wallet.funds) {
            alert("Insufficient syndicate funds.");
            return;
        }

        setIsProcessing(true);
        try {
            if (!commander_id) throw new Error("Commander identity lost");
            
            // 1. Update Wallet
            const newFunds = type === 'deposit' ? wallet.funds + val : wallet.funds - val;
            const { error: walletErr } = await supabase
                .from('syndicate_wallets')
                .update({ funds: newFunds })
                .eq('syndicate_id', syndicateId);
            
            if (walletErr) throw walletErr;

            // 2. Log to Ledger
            const { error: ledgerErr } = await supabase
                .from('syndicate_ledger')
                .insert({
                    syndicate_id: syndicateId,
                    type: type,
                    amount: val,
                    memo: memo || `${type.toUpperCase()} BY COMMANDER`,
                    actor_id: commander_id
                });

            if (ledgerErr) throw ledgerErr;

            setAmount('');
            setMemo('');
            await fetchData();
        } catch (err) {
            console.error("Transaction failed:", err);
            alert("Transaction failed. Check network logs.");
        } finally {
            setIsProcessing(false);
        }
    };

    const isOfficer = currentUserRole?.is_officer || currentUserRole?.role_key === 'leader';

    return React.createElement('div', {
        style: { display: 'flex', flexDirection: 'column', gap: '20px', animation: 'fadeIn 0.3s ease-out', height: '100%' }
    },
        // Header
        React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
            React.createElement('div', { style: { fontSize: '16px', fontWeight: 'bold', letterSpacing: '2px', color: '#00ccff' } }, "SYNDICATE TREASURY"),
            React.createElement('button', { onClick: onBack, style: { background: 'none', border: 'none', color: '#888', cursor: 'pointer', fontSize: '18px' } }, "✕")
        ),

        // Balance Card
        React.createElement('div', {
            style: {
                padding: '20px',
                background: 'rgba(0, 204, 255, 0.05)',
                border: '1px solid #00ccff44',
                borderRadius: '4px',
                textAlign: 'center',
                display: 'flex',
                flexDirection: 'column',
                gap: '5px'
            }
        },
            React.createElement('div', { style: { fontSize: '10px', color: '#00ccff', letterSpacing: '1px' } }, "CURRENT OPERATING CAPITAL"),
            React.createElement('div', { style: { fontSize: '24px', fontWeight: 'bold', color: '#fff' } }, 
                loading ? "---" : `${wallet.funds.toLocaleString()} CR`
            )
        ),

        // Officer Actions
        isOfficer && React.createElement('div', {
            style: {
                padding: '15px',
                background: 'rgba(255,255,255,0.03)',
                border: '1px solid #333',
                borderRadius: '4px',
                display: 'flex',
                flexDirection: 'column',
                gap: '10px'
            }
        },
            React.createElement('div', { style: { fontSize: '10px', color: '#888', marginBottom: '5px' } }, "FINANCIAL OPERATIONS"),
            React.createElement('div', { style: { display: 'flex', gap: '10px' } },
                React.createElement('input', {
                    type: 'number',
                    value: amount,
                    onChange: (e) => setAmount(e.target.value),
                    placeholder: 'AMOUNT',
                    style: { flex: 1, padding: '10px', background: 'rgba(0,0,0,0.4)', border: '1px solid #444', color: '#fff', fontSize: '12px', borderRadius: '2px' }
                }),
                React.createElement('input', {
                    type: 'text',
                    value: memo,
                    onChange: (e) => setMemo(e.target.value),
                    placeholder: 'MEMO (OPTIONAL)',
                    style: { flex: 2, padding: '10px', background: 'rgba(0,0,0,0.4)', border: '1px solid #444', color: '#fff', fontSize: '12px', borderRadius: '2px' }
                })
            ),
            React.createElement('div', { style: { display: 'flex', gap: '10px' } },
                React.createElement('button', {
                    disabled: isProcessing || !amount,
                    onClick: () => handleTransaction('deposit'),
                    style: { flex: 1, padding: '10px', background: 'rgba(0, 255, 102, 0.1)', border: '1px solid #00ff66', color: '#00ff66', cursor: 'pointer', fontSize: '10px', fontWeight: 'bold', borderRadius: '2px' }
                }, "DEPOSIT"),
                React.createElement('button', {
                    disabled: isProcessing || !amount,
                    onClick: () => handleTransaction('withdraw'),
                    style: { flex: 1, padding: '10px', background: 'rgba(255, 68, 68, 0.1)', border: '1px solid #ff4444', color: '#ff4444', cursor: 'pointer', fontSize: '10px', fontWeight: 'bold', borderRadius: '2px' }
                }, "WITHDRAW")
            )
        ),

        // Ledger History
        React.createElement('div', { style: { flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '5px' } },
            React.createElement('div', { style: { fontSize: '10px', color: '#444', marginBottom: '5px', letterSpacing: '1px' } }, "TRANSACTION LEDGER"),
            loading ? [1, 2, 3].map(i => React.createElement('div', { key: i, style: { height: '50px', background: 'rgba(255,255,255,0.02)', borderRadius: '2px', animation: 'skeleton-pulse 1.5s infinite ease-in-out' } }))
            : ledger.length === 0 ? React.createElement('div', { style: { textAlign: 'center', padding: '20px', color: '#444', fontSize: '11px' } }, "NO TRANSACTION HISTORY.")
            : ledger.map((entry, i) => React.createElement('div', {
                key: i,
                style: {
                    padding: '10px',
                    background: 'rgba(255,255,255,0.02)',
                    borderLeft: `2px solid ${entry.type === 'deposit' ? '#00ff66' : entry.type === 'withdraw' ? '#ff4444' : '#ffcc00'}`,
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    fontSize: '11px'
                }
            },
                React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: '2px' } },
                    React.createElement('div', { style: { color: '#fff', fontWeight: 'bold' } }, 
                        `${entry.type.toUpperCase()}: ${entry.amount.toLocaleString()} CR`
                    ),
                    React.createElement('div', { style: { color: '#666', fontSize: '9px' } }, 
                        `${entry.memo.toUpperCase()} // BY ${entry.commander_data?.commander_name?.toUpperCase() || 'SYSTEM'}`
                    )
                ),
                React.createElement('div', { style: { color: '#444', fontSize: '9px' } }, 
                    new Date(entry.ts).toLocaleDateString()
                )
            ))
        ),

        // Footer
        React.createElement('button', {
            onClick: onBack,
            style: { width: '100%', padding: '12px', background: 'rgba(255,255,255,0.05)', border: '1px solid #333', color: '#888', cursor: 'pointer', fontSize: '11px', fontWeight: 'bold', borderRadius: '2px' }
        }, "BACK")
    );
};

const StarportLogsView = ({ systemId, systemName, onBack }) => {
    const [logs, setLogs] = useState([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        const fetchLogs = async () => {
            setLoading(true);
            try {
                const { data, error } = await supabase
                    .from('starport_damage_log')
                    .select('*')
                    .eq('starport_id', systemId)
                    .order('timestamp', { ascending: false })
                    .limit(30);
                if (error) throw error;
                setLogs(data || []);
            } catch (err) {
                console.error("Error fetching logs:", err);
            } finally {
                setLoading(false);
            }
        };
        fetchLogs();
    }, [systemId]);

    return React.createElement('div', {
        style: { display: 'flex', flexDirection: 'column', gap: '20px', animation: 'fadeIn 0.3s ease-out', height: '100%' }
    },
        React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
            React.createElement('div', { style: { fontSize: '16px', fontWeight: 'bold', letterSpacing: '2px', color: '#ff4444' } }, `LOGS: ${systemName.toUpperCase()}`),
            React.createElement('button', { onClick: onBack, style: { background: 'none', border: 'none', color: '#888', cursor: 'pointer', fontSize: '18px' } }, "✕")
        ),
        React.createElement('div', { style: { flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '5px' } },
            loading ? [1, 2, 3].map(i => React.createElement('div', { key: i, style: { height: '40px', background: 'rgba(255,255,255,0.02)', borderRadius: '4px', animation: 'skeleton-pulse 1.5s infinite ease-in-out' } }))
            : logs.length === 0 ? React.createElement('div', { style: { textAlign: 'center', padding: '40px', color: '#444' } }, "NO DAMAGE LOGS DETECTED.")
            : logs.map((log, i) => React.createElement('div', {
                key: i,
                style: { padding: '10px', background: 'rgba(255,68,68,0.05)', borderLeft: '2px solid #ff4444', fontSize: '11px', display: 'flex', justifyContent: 'space-between' }
            },
                React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: '2px' } },
                    React.createElement('div', { style: { color: '#ff4444', fontWeight: 'bold' } }, `DAMAGE RECEIVED: ${log.damage_amount} HP`),
                    React.createElement('div', { style: { color: '#666' } }, `SOURCE: ${log.source || 'UNKNOWN'}`)
                ),
                React.createElement('div', { style: { color: '#444' } }, new Date(log.timestamp).toLocaleTimeString())
            ))
        ),
        React.createElement('button', {
            onClick: onBack,
            style: { width: '100%', padding: '12px', background: 'rgba(255,255,255,0.05)', border: '1px solid #333', color: '#888', cursor: 'pointer', fontSize: '11px', fontWeight: 'bold', borderRadius: '2px' }
        }, "RETURN TO PORTS")
    );
};

const SyndicateStarportsView = ({ syndicateId, currentUserRole, onBack, onNavigateToLogs }) => {
    const { commander_id } = useGameState();
    const [starports, setStarports] = useState([]);
    const [loading, setLoading] = useState(true);
    const [repairingId, setRepairingId] = useState(null);

    const fetchStarports = async () => {
        setLoading(true);
        try {
            const { data, error } = await supabase
                .from('syndicate_starports')
                .select(`
                    system_id, hp, shields, tier, vulnerability_start, vulnerability_end,
                    systems (name, region)
                `)
                .eq('syndicate_id', syndicateId);
            if (error) throw error;
            setStarports(data || []);
        } catch (err) {
            console.error("Error fetching starports:", err);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        if (syndicateId) fetchStarports();
    }, [syndicateId]);

    const handleRepair = async (systemId) => {
        setRepairingId(systemId);
        try {
            if (!commander_id) throw new Error("Commander identity lost");
            const { error } = await supabase
                .from('starport_repairs')
                .insert({
                    starport_id: systemId,
                    repaired_by: commander_id,
                    amount: 250 
                });
            if (error) throw error;
            await fetchStarports();
        } catch (err) {
            console.error("Repair failed:", err);
        } finally {
            setRepairingId(null);
        }
    };

    const isOfficer = currentUserRole?.is_officer || currentUserRole?.role_key === 'leader';

    const renderProgressBar = (value, max, color) => React.createElement('div', {
        style: { width: '100%', height: '4px', background: 'rgba(255,255,255,0.05)', borderRadius: '2px', overflow: 'hidden', marginTop: '4px' }
    },
        React.createElement('div', {
            style: { width: `${(value / max) * 100}%`, height: '100%', background: color, boxShadow: `0 0 10px ${color}44` }
        })
    );

    return React.createElement('div', {
        style: { display: 'flex', flexDirection: 'column', gap: '20px', animation: 'fadeIn 0.3s ease-out', height: '100%' }
    },
        React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
            React.createElement('div', { style: { fontSize: '16px', fontWeight: 'bold', letterSpacing: '2px', color: '#00ccff' } }, "SYNDICATE STARPORTS"),
            React.createElement('button', { onClick: onBack, style: { background: 'none', border: 'none', color: '#888', cursor: 'pointer', fontSize: '18px' } }, "✕")
        ),
        React.createElement('div', { style: { flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '15px', paddingRight: '5px' } },
            loading ? [1, 2].map(i => React.createElement('div', { key: i, style: { height: '140px', background: 'rgba(255,255,255,0.02)', borderRadius: '4px', animation: 'skeleton-pulse 1.5s infinite ease-in-out' } }))
            : starports.length === 0 ? React.createElement('div', { style: { textAlign: 'center', padding: '40px', color: '#666' } }, "No starports under syndicate control.")
            : starports.map(port => React.createElement('div', {
                key: port.system_id,
                style: { padding: '15px', background: 'rgba(255,255,255,0.03)', border: '1px solid #333', borderRadius: '4px', display: 'flex', flexDirection: 'column', gap: '12px' }
            },
                React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' } },
                    React.createElement('div', null,
                        React.createElement('div', { style: { fontSize: '14px', fontWeight: 'bold', color: '#fff' } }, (port.systems?.name || 'UNKNOWN').toUpperCase()),
                        React.createElement('div', { style: { fontSize: '10px', color: '#666' } }, `REGION: ${port.systems?.region || 'UNKNOWN'} // TIER ${port.tier || 1}`)
                    ),
                    React.createElement('div', { style: { fontSize: '10px', color: '#ffcc00', fontWeight: 'bold', textAlign: 'right' } }, 
                        "VULNERABILITY WINDOW",
                        React.createElement('div', { style: { color: '#888', fontSize: '9px' } }, `${port.vulnerability_start} - ${port.vulnerability_end}`)
                    )
                ),
                React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
                    React.createElement('div', null,
                        React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: '9px', color: '#888' } },
                            React.createElement('span', null, "STRUCTURE INTEGRITY"),
                            React.createElement('span', { style: { color: '#fff' } }, `${port.hp} / 10000`)
                        ),
                        renderProgressBar(port.hp, 10000, '#00ff66')
                    ),
                    React.createElement('div', null,
                        React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: '9px', color: '#888' } },
                            React.createElement('span', null, "SHIELD CAPACITY"),
                            React.createElement('span', { style: { color: '#fff' } }, `${port.shields} / 5000`)
                        ),
                        renderProgressBar(port.shields, 5000, '#00ccff')
                    )
                ),
                React.createElement('div', { style: { display: 'flex', gap: '10px', marginTop: '5px' } },
                    isOfficer && React.createElement('button', {
                        disabled: repairingId === port.system_id,
                        onClick: () => handleRepair(port.system_id),
                        style: { flex: 1, padding: '8px', background: 'rgba(0, 255, 102, 0.1)', border: '1px solid #00ff66', color: '#00ff66', cursor: 'pointer', fontSize: '10px', fontWeight: 'bold', borderRadius: '2px' }
                    }, repairingId === port.system_id ? "REPAIRING..." : "REPAIR PORT"),
                    React.createElement('button', {
                        onClick: () => onNavigateToLogs(port.system_id, port.systems?.name),
                        style: { flex: 1, padding: '8px', background: 'rgba(255,255,255,0.05)', border: '1px solid #444', color: '#888', cursor: 'pointer', fontSize: '10px', fontWeight: 'bold', borderRadius: '2px' }
                    }, "VIEW LOGS")
                )
            ))
        ),
        React.createElement('button', {
            onClick: onBack,
            style: { width: '100%', padding: '12px', background: 'rgba(255,255,255,0.05)', border: '1px solid #333', color: '#888', cursor: 'pointer', fontSize: '11px', fontWeight: 'bold', borderRadius: '2px' }
        }, "BACK")
    );
};

const SyndicateSystemsView = ({ syndicateId, onBack, onNavigate }) => {
    const [systems, setSystems] = useState([]);
    const [loading, setLoading] = useState(true);

    const fetchSystems = async () => {
        setLoading(true);
        try {
            const { data, error } = await supabase
                .from('syndicate_systems')
                .select(`
                    captured_at,
                    systems (id, name, region)
                `)
                .eq('syndicate_id', syndicateId);

            if (error) throw error;

            const systemsWithPorts = await Promise.all((data || []).map(async (entry) => {
                const { count } = await supabase
                    .from('syndicate_starports')
                    .select('*', { count: 'exact', head: true })
                    .eq('system_id', entry.systems.id)
                    .eq('syndicate_id', syndicateId);
                
                return {
                    ...entry.systems,
                    captured_at: entry.captured_at,
                    portCount: count || 0
                };
            }));

            setSystems(systemsWithPorts);
        } catch (err) {
            console.error("Error fetching systems:", err);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        if (syndicateId) fetchSystems();
    }, [syndicateId]);

    return React.createElement('div', {
        style: {
            display: 'flex',
            flexDirection: 'column',
            gap: '20px',
            animation: 'fadeIn 0.3s ease-out',
            height: '100%'
        }
    },
        // Header
        React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
            React.createElement('div', { style: { fontSize: '16px', fontWeight: 'bold', letterSpacing: '2px', color: '#ffcc00' } }, "CONTROLLED SYSTEMS"),
            React.createElement('button', {
                onClick: onBack,
                style: { background: 'none', border: 'none', color: '#888', cursor: 'pointer', fontSize: '18px' }
            }, "✕")
        ),

        // Systems List
        React.createElement('div', {
            style: {
                flex: 1,
                overflowY: 'auto',
                display: 'flex',
                flexDirection: 'column',
                gap: '10px',
                paddingRight: '5px'
            }
        },
            loading ? (
                [1, 2, 3].map(i => React.createElement('div', {
                    key: i,
                    style: { height: '80px', background: 'rgba(255,255,255,0.02)', borderRadius: '4px', animation: 'skeleton-pulse 1.5s infinite ease-in-out' }
                }))
            ) : systems.length === 0 ? (
                React.createElement('div', { style: { textAlign: 'center', padding: '40px', color: '#666', fontStyle: 'italic' } }, "No systems under syndicate control.")
            ) : (
                systems.map(system => React.createElement('div', {
                    key: system.id,
                    style: {
                        padding: '15px',
                        background: 'rgba(255,255,255,0.03)',
                        border: '1px solid #333',
                        borderRadius: '4px',
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center'
                    }
                },
                    React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
                        React.createElement('div', { style: { fontSize: '14px', fontWeight: 'bold', color: '#fff' } }, system.name.toUpperCase()),
                        React.createElement('div', { style: { fontSize: '10px', color: '#666' } }, `REGION: ${system.region || 'UNKNOWN'}`),
                        React.createElement('div', { style: { fontSize: '9px', color: '#444' } }, `OCCUPIED SINCE: ${new Date(system.captured_at).toLocaleDateString()}`)
                    ),
                    React.createElement('div', { style: { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '8px' } },
                        React.createElement('div', { style: { fontSize: '10px', color: '#00ccff', fontWeight: 'bold' } }, `${system.portCount} STARPORTS`),
                        React.createElement('button', {
                            onClick: () => onNavigate('starports'),
                            style: {
                                padding: '6px 12px',
                                background: 'rgba(0, 204, 255, 0.1)',
                                border: '1px solid #00ccff',
                                color: '#00ccff',
                                cursor: 'pointer',
                                fontSize: '10px',
                                fontWeight: 'bold',
                                borderRadius: '2px'
                            }
                        }, "MANAGE PORTS")
                    )
                ))
            )
        ),

        // Footer
        React.createElement('button', {
            onClick: onBack,
            style: {
                width: '100%',
                padding: '12px',
                background: 'rgba(255,255,255,0.05)',
                border: '1px solid #333',
                color: '#888',
                cursor: 'pointer',
                fontSize: '11px',
                fontWeight: 'bold',
                borderRadius: '2px'
            }
        }, "BACK")
    );
};

const SyndicateApplicationsView = ({ syndicateId, currentUserRole, onBack }) => {
    const [applicants, setApplicants] = useState([]);
    const [loading, setLoading] = useState(true);
    const [actionLoading, setActionLoading] = useState(null);

    const fetchApplicants = async () => {
        setLoading(true);
        try {
            const { data, error } = await supabase
                .from('syndicate_members')
                .select(`
                    player_id,
                    joined_at,
                    commander_data (id, commander_name)
                `)
                .eq('syndicate_id', syndicateId)
                .eq('role_key', 'applicant');

            if (error) throw error;
            setApplicants(data || []);
        } catch (err) {
            console.error("Error fetching applicants:", err);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        if (syndicateId) fetchApplicants();
    }, [syndicateId]);

    const handleApplication = async (playerId, action) => {
        setActionLoading(playerId);
        try {
            if (action === 'approve') {
                const { error } = await supabase
                    .from('syndicate_members')
                    .update({ 
                        role_key: 'member',
                        joined_at: new Date().toISOString() // Refresh joined date on approval
                    })
                    .eq('player_id', playerId)
                    .eq('syndicate_id', syndicateId);
                if (error) throw error;
            } else if (action === 'deny') {
                const { error } = await supabase
                    .from('syndicate_members')
                    .delete()
                    .eq('player_id', playerId)
                    .eq('syndicate_id', syndicateId);
                if (error) throw error;
            }
            await fetchApplicants();
        } catch (err) {
            console.error(`Application ${action} failed:`, err);
            alert(`Action failed: ${err.message}`);
        } finally {
            setActionLoading(null);
        }
    };

    return React.createElement('div', {
        style: {
            display: 'flex',
            flexDirection: 'column',
            gap: '20px',
            animation: 'fadeIn 0.3s ease-out',
            height: '100%'
        }
    },
        // Header
        React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
            React.createElement('div', { style: { fontSize: '16px', fontWeight: 'bold', letterSpacing: '2px', color: '#ffcc00' } }, "PENDING APPLICATIONS"),
            React.createElement('button', {
                onClick: onBack,
                style: { background: 'none', border: 'none', color: '#888', cursor: 'pointer', fontSize: '18px' }
            }, "✕")
        ),

        // List
        React.createElement('div', {
            style: {
                flex: 1,
                overflowY: 'auto',
                display: 'flex',
                flexDirection: 'column',
                gap: '10px',
                paddingRight: '5px'
            }
        },
            loading ? (
                [1, 2].map(i => React.createElement('div', {
                    key: i,
                    style: { height: '80px', background: 'rgba(255,255,255,0.02)', borderRadius: '4px', animation: 'skeleton-pulse 1.5s infinite ease-in-out' }
                }))
            ) : applicants.length === 0 ? (
                React.createElement('div', { style: { textAlign: 'center', padding: '40px', color: '#666', fontStyle: 'italic' } }, "No pending applications.")
            ) : (
                applicants.map(app => React.createElement('div', {
                    key: app.player_id,
                    style: {
                        padding: '15px',
                        background: 'rgba(255,255,255,0.03)',
                        border: '1px solid #333',
                        borderRadius: '4px',
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        opacity: actionLoading === app.player_id ? 0.6 : 1
                    }
                },
                    React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
                        React.createElement('div', { style: { fontSize: '14px', fontWeight: 'bold', color: '#fff' } }, (app.commander_data?.commander_name || 'UNKNOWN').toUpperCase()),
                        React.createElement('div', { style: { fontSize: '10px', color: '#666' } }, `APPLIED: ${new Date(app.joined_at).toLocaleDateString()}`)
                    ),
                    React.createElement('div', { style: { display: 'flex', gap: '8px' } },
                        React.createElement('button', {
                            disabled: actionLoading !== null,
                            onClick: () => handleApplication(app.player_id, 'approve'),
                            style: {
                                padding: '8px 16px',
                                background: 'rgba(0, 255, 102, 0.1)',
                                border: '1px solid #00ff66',
                                color: '#00ff66',
                                cursor: 'pointer',
                                fontSize: '10px',
                                fontWeight: 'bold',
                                borderRadius: '2px'
                            }
                        }, "APPROVE"),
                        React.createElement('button', {
                            disabled: actionLoading !== null,
                            onClick: () => handleApplication(app.player_id, 'deny'),
                            style: {
                                padding: '8px 16px',
                                background: 'rgba(255, 68, 68, 0.1)',
                                border: '1px solid #ff4444',
                                color: '#ff4444',
                                cursor: 'pointer',
                                fontSize: '10px',
                                fontWeight: 'bold',
                                borderRadius: '2px'
                            }
                        }, "DENY")
                    )
                ))
            )
        ),

        // Footer
        React.createElement('button', {
            onClick: onBack,
            style: {
                width: '100%',
                padding: '12px',
                background: 'rgba(255,255,255,0.05)',
                border: '1px solid #333',
                color: '#888',
                cursor: 'pointer',
                fontSize: '11px',
                fontWeight: 'bold',
                borderRadius: '2px'
            }
        }, "BACK")
    );
};

const SyndicateMembersView = ({ syndicateId, currentUserRole, onBack }) => {
    const { commander_id } = useGameState();
    const [members, setMembers] = useState([]);
    const [roles, setRoles] = useState([]);
    const [loading, setLoading] = useState(true);
    const [actionLoading, setActionLoading] = useState(null);

    const fetchMembers = async () => {
        setLoading(true);
        try {
            const [membersRes, rolesRes] = await Promise.all([
                supabase.from('syndicate_members')
                    .select(`
                        player_id,
                        joined_at,
                        role_key,
                        commander_data (id, commander_name),
                        syndicate_roles (role_name, is_officer)
                    `)
                    .eq('syndicate_id', syndicateId),
                supabase.from('syndicate_roles').select('*').order('is_officer', { ascending: true })
            ]);

            if (membersRes.error) throw membersRes.error;
            if (rolesRes.error) throw rolesRes.error;

            setMembers(membersRes.data || []);
            setRoles(rolesRes.data || []);
        } catch (err) {
            console.error("Error fetching members:", err);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        if (syndicateId) fetchMembers();
    }, [syndicateId]);

    const handleAction = async (playerId, action, roleKey = null) => {
        setActionLoading(playerId);
        try {
            if (action === 'kick') {
                const { error } = await supabase
                    .from('syndicate_members')
                    .delete()
                    .eq('player_id', playerId)
                    .eq('syndicate_id', syndicateId);
                if (error) throw error;
            } else if (action === 'update_role') {
                const { error } = await supabase
                    .from('syndicate_members')
                    .update({ role_key: roleKey })
                    .eq('player_id', playerId)
                    .eq('syndicate_id', syndicateId);
                if (error) throw error;
            }
            await fetchMembers();
        } catch (err) {
            console.error(`Action ${action} failed:`, err);
            alert(`Action failed: ${err.message}`);
        } finally {
            setActionLoading(null);
        }
    };

    const isOfficer = currentUserRole?.is_officer || currentUserRole?.role_key === 'leader';
    const isLeader = currentUserRole?.role_key === 'leader';

    return React.createElement('div', {
        style: {
            display: 'flex',
            flexDirection: 'column',
            gap: '20px',
            animation: 'fadeIn 0.3s ease-out',
            height: '100%'
        }
    },
        // Header
        React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
            React.createElement('div', { style: { fontSize: '16px', fontWeight: 'bold', letterSpacing: '2px', color: '#00ccff' } }, "SYNDICATE MEMBERS"),
            React.createElement('button', {
                onClick: onBack,
                style: { background: 'none', border: 'none', color: '#888', cursor: 'pointer', fontSize: '18px' }
            }, "✕")
        ),

        // Member List
        React.createElement('div', {
            style: {
                flex: 1,
                overflowY: 'auto',
                display: 'flex',
                flexDirection: 'column',
                gap: '8px',
                paddingRight: '5px'
            }
        },
            loading ? (
                [1, 2, 3, 4].map(i => React.createElement('div', {
                    key: i,
                    style: { height: '60px', background: 'rgba(255,255,255,0.02)', borderRadius: '4px', animation: 'skeleton-pulse 1.5s infinite ease-in-out' }
                }))
            ) : members.length === 0 ? (
                React.createElement('div', { style: { textAlign: 'center', padding: '40px', color: '#666' } }, "No members found.")
            ) : (
                members.map(member => {
                    const isSelf = member.player_id === commander_id;
                    const canManage = isOfficer && !isSelf && member.role_key !== 'leader';
                    
                    return React.createElement('div', {
                        key: member.player_id,
                        style: {
                            padding: '12px',
                            background: 'rgba(255,255,255,0.03)',
                            border: '1px solid #333',
                            borderRadius: '4px',
                            display: 'flex',
                            flexDirection: 'column',
                            gap: '8px',
                            opacity: actionLoading === member.player_id ? 0.6 : 1
                        }
                    },
                        React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
                            React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
                                React.createElement('div', {
                                    style: {
                                        width: '6px',
                                        height: '6px',
                                        borderRadius: '50%',
                                        background: member.syndicate_roles?.is_officer ? '#ffcc00' : '#00ff66',
                                        boxShadow: `0 0 5px ${member.syndicate_roles?.is_officer ? '#ffcc00' : '#00ff66'}`
                                    }
                                }),
                                React.createElement('span', { style: { fontWeight: 'bold', color: isSelf ? '#00ccff' : '#fff', fontSize: '13px' } }, 
                                    (member.commander_data?.commander_name || 'UNKNOWN').toUpperCase()
                                ),
                                isSelf && React.createElement('span', { style: { fontSize: '9px', color: '#00ccff', opacity: 0.6 } }, "(YOU)")
                            ),
                            React.createElement('div', {
                                style: {
                                    fontSize: '10px',
                                    padding: '2px 6px',
                                    background: member.syndicate_roles?.is_officer ? 'rgba(255,204,0,0.1)' : 'rgba(255,255,255,0.05)',
                                    color: member.syndicate_roles?.is_officer ? '#ffcc00' : '#888',
                                    borderRadius: '2px',
                                    border: `1px solid ${member.syndicate_roles?.is_officer ? '#ffcc0044' : '#333'}`,
                                    fontWeight: 'bold'
                                }
                            }, (member.syndicate_roles?.role_name || 'MEMBER').toUpperCase())
                        ),
                        React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
                            React.createElement('span', { style: { fontSize: '10px', color: '#555' } }, 
                                `JOINED: ${new Date(member.joined_at).toLocaleDateString()}`
                            ),
                            canManage && React.createElement('div', { style: { display: 'flex', gap: '5px' } },
                                isLeader && React.createElement('button', {
                                    onClick: () => {
                                        const newRole = member.role_key === 'officer' ? 'member' : 'officer';
                                        handleAction(member.player_id, 'update_role', newRole);
                                    },
                                    style: { padding: '4px 8px', background: 'rgba(0, 204, 255, 0.1)', border: '1px solid #00ccff44', color: '#00ccff', fontSize: '9px', borderRadius: '2px', cursor: 'pointer' }
                                }, member.role_key === 'officer' ? 'DEMOTE' : 'PROMOTE'),
                                React.createElement('button', {
                                    onClick: () => handleAction(member.player_id, 'kick'),
                                    style: { padding: '4px 8px', background: 'rgba(255, 68, 68, 0.1)', border: '1px solid #ff444444', color: '#ff4444', fontSize: '9px', borderRadius: '2px', cursor: 'pointer' }
                                }, "KICK")
                            )
                        )
                    );
                })
            )
        ),

        // Footer
        React.createElement('button', {
            onClick: onBack,
            style: {
                width: '100%',
                padding: '12px',
                background: 'rgba(255,255,255,0.05)',
                border: '1px solid #333',
                color: '#888',
                cursor: 'pointer',
                fontSize: '11px',
                fontWeight: 'bold',
                borderRadius: '2px'
            }
        }, "BACK")
    );
};

const SyndicateOverview = ({ syndicateId, onBack, onNavigate }) => {
    const [data, setData] = useState(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        const fetchData = async () => {
            setLoading(true);
            try {
                // Parallel fetching of basic stats
                const [synRes, memCountRes, sysCountRes, portCountRes, walletRes] = await Promise.all([
                    supabase.from('syndicates').select('*').eq('syndicate_id', syndicateId).single(),
                    supabase.from('syndicate_members').select('*', { count: 'exact', head: true }).eq('syndicate_id', syndicateId),
                    supabase.from('syndicate_systems').select('*', { count: 'exact', head: true }).eq('syndicate_id', syndicateId),
                    supabase.from('syndicate_starports').select('*', { count: 'exact', head: true }).eq('syndicate_id', syndicateId),
                    supabase.from('syndicate_wallets').select('funds').eq('syndicate_id', syndicateId).maybeSingle()
                ]);

                if (synRes.error) throw synRes.error;
                const syndicate = synRes.data;

                // Fetch leader specific info
                const [leaderRes, leaderRoleRes] = await Promise.all([
                    supabase.from('commander_data').select('commander_name').eq('id', syndicate.leader_id).maybeSingle(),
                    supabase.from('syndicate_members')
                        .select('role_key, syndicate_roles(role_name)')
                        .eq('player_id', syndicate.leader_id)
                        .eq('syndicate_id', syndicateId)
                        .maybeSingle()
                ]);

                setData({
                    syndicate,
                    memberCount: memCountRes.count || 0,
                    systemsCount: sysCountRes.count || 0,
                    starportsCount: portCountRes.count || 0,
                    walletFunds: walletRes.data?.funds || 0,
                    leaderName: leaderRes.data?.commander_name || 'UNKNOWN',
                    leaderRole: leaderRoleRes.data?.syndicate_roles?.role_name || 'COMMANDER-IN-CHIEF'
                });
            } catch (err) {
                console.error("Error fetching overview data:", err);
            } finally {
                setLoading(false);
            }
        };

        if (syndicateId) fetchData();
    }, [syndicateId]);

    const renderCard = (title, children) => React.createElement('div', {
        style: {
            background: 'rgba(255,255,255,0.03)',
            border: '1px solid #333',
            borderRadius: '4px',
            padding: '15px',
            display: 'flex',
            flexDirection: 'column',
            gap: '10px'
        }
    },
        React.createElement('div', { style: { fontSize: '10px', color: '#888', letterSpacing: '1px', borderBottom: '1px solid #222', paddingBottom: '5px' } }, title),
        children
    );

    const renderStat = (label, value, color = '#fff') => React.createElement('div', {
        style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '12px' }
    },
        React.createElement('span', { style: { color: '#666' } }, label),
        React.createElement('span', { style: { color, fontWeight: 'bold' } }, value)
    );

    if (loading) {
        return React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: '20px', animation: 'fadeIn 0.3s ease-out' } },
            React.createElement('div', { style: { height: '30px', width: '200px', background: 'rgba(255,255,255,0.05)', borderRadius: '4px', animation: 'skeleton-pulse 1.5s infinite ease-in-out' } }),
            [1, 2].map(i => React.createElement('div', {
                key: i,
                style: { height: '150px', background: 'rgba(255,255,255,0.02)', borderRadius: '4px', animation: 'skeleton-pulse 1.5s infinite ease-in-out' }
            }))
        );
    }

    if (!data) return React.createElement('div', null, "Failed to load data.");

    return React.createElement('div', {
        style: {
            display: 'flex',
            flexDirection: 'column',
            gap: '20px',
            animation: 'fadeIn 0.3s ease-out',
            height: '100%',
            overflowY: 'auto',
            paddingRight: '5px'
        }
    },
        // Header
        React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
            React.createElement('div', { style: { fontSize: '16px', fontWeight: 'bold', letterSpacing: '2px', color: '#ffcc00' } }, "SYNDICATE OVERVIEW"),
            React.createElement('button', {
                onClick: onBack,
                style: { background: 'none', border: 'none', color: '#888', cursor: 'pointer', fontSize: '18px' }
            }, "✕")
        ),

        // Card 1: Identity
        renderCard("SYNDICATE IDENTITY", [
            React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '15px' } },
                React.createElement('div', {
                    style: {
                        width: '50px',
                        height: '50px',
                        background: 'rgba(255,204,0,0.1)',
                        border: '1px solid #ffcc0044',
                        borderRadius: '4px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontSize: '20px'
                    }
                }, "💠"),
                React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: '2px' } },
                    React.createElement('div', { style: { fontSize: '18px', fontWeight: 'bold', color: '#fff' } }, data.syndicate.name.toUpperCase()),
                    React.createElement('div', { style: { fontSize: '11px', color: '#ffcc00' } }, `TAG: ${data.syndicate.tag}`)
                )
            ),
            React.createElement('div', { style: { fontSize: '11px', color: '#666', fontStyle: 'italic', padding: '10px', background: 'rgba(0,0,0,0.2)', borderRadius: '4px' } }, 
                data.syndicate.motto || "No motto recorded in databanks."
            )
        ]),

        // Card 2: Leadership & Stats
        renderCard("LEADERSHIP & STATISTICS", [
            renderStat("FOUNDER", data.leaderName.toUpperCase(), '#ffcc00'),
            renderStat("RANK", data.leaderRole.toUpperCase()),
            renderStat("ACTIVE MEMBERS", data.memberCount),
            renderStat("SYSTEMS CONTROLLED", data.systemsCount),
            renderStat("STARPORTS CONTROLLED", data.starportsCount),
            renderStat("TAX RATE", `${data.syndicate.tax_rate || 0}%`, '#00ff66'),
            renderStat("WALLET FUNDS", `${data.walletFunds.toLocaleString()} CR`, '#00ccff')
        ]),

        // Navigation Actions
        React.createElement('div', {
            style: {
                display: 'flex',
                flexDirection: 'column',
                gap: '10px',
                marginTop: 'auto'
            }
        },
            React.createElement('div', { style: { display: 'flex', gap: '10px' } },
                React.createElement('button', {
                    onClick: () => onNavigate('members'),
                    style: { flex: 1, padding: '12px', background: 'rgba(255,255,255,0.05)', border: '1px solid #333', color: '#ccc', fontSize: '11px', fontWeight: 'bold', borderRadius: '2px', cursor: 'pointer' }
                }, "MEMBERS"),
                React.createElement('button', {
                    onClick: () => onNavigate('systems'),
                    style: { flex: 1, padding: '12px', background: 'rgba(255,255,255,0.05)', border: '1px solid #333', color: '#ccc', fontSize: '11px', fontWeight: 'bold', borderRadius: '2px', cursor: 'pointer' }
                }, "SYSTEMS")
            ),
            React.createElement('div', { style: { display: 'flex', gap: '10px' } },
                React.createElement('button', {
                    onClick: () => onNavigate('starports'),
                    style: { flex: 1, padding: '12px', background: 'rgba(255,255,255,0.05)', border: '1px solid #333', color: '#ccc', fontSize: '11px', fontWeight: 'bold', borderRadius: '2px', cursor: 'pointer' }
                }, "STARPORTS"),
                React.createElement('button', {
                    onClick: () => onNavigate('treasury'),
                    style: { flex: 1, padding: '12px', background: 'rgba(255,255,255,0.05)', border: '1px solid #333', color: '#ccc', fontSize: '11px', fontWeight: 'bold', borderRadius: '2px', cursor: 'pointer' }
                }, "TREASURY")
            ),
            React.createElement('button', {
                onClick: () => onNavigate('leave'),
                style: { width: '100%', padding: '12px', background: 'rgba(255, 68, 68, 0.05)', border: '1px solid #ff444444', color: '#ff4444', fontSize: '11px', fontWeight: 'bold', borderRadius: '2px', cursor: 'pointer' }
            }, "LEAVE SYNDICATE"),
            React.createElement('button', {
                onClick: onBack,
                style: { width: '100%', padding: '12px', background: 'rgba(255,255,255,0.05)', border: '1px solid #333', color: '#888', fontSize: '11px', fontWeight: 'bold', borderRadius: '2px', cursor: 'pointer' }
            }, "CLOSE OVERVIEW")
        )
    );
};

const SyndicateContent = ({ onOpenSyndicateMenu }) => {
    const { commander_id } = useGameState();
    const [loading, setLoading] = useState(true);
    const [syndicate, setSyndicate] = useState(null);
    const [currentUserRole, setCurrentUserRole] = useState(null);
    const [memberCount, setMemberCount] = useState(0);
    const [subView, setSubView] = useState('main'); // 'main', 'create', 'join', 'overview', 'members', 'applications', 'systems', 'starports', 'starport_logs', 'treasury', 'settings', 'leave'
    const [selectedLogTarget, setSelectedLogTarget] = useState(null);
    const [pendingCount, setPendingCount] = useState(0);

    const fetchSyndicateData = async () => {
        setLoading(true);
        try {
            if (!commander_id) {
                setLoading(false);
                setSyndicate(null);
                return;
            }

            // Check membership
            const { data: membership, error: memError } = await supabase
                .from('syndicate_members')
                .select(`
                    syndicate_id,
                    role_key,
                    syndicate_roles (role_name, is_officer, is_leader)
                `)
                .eq('player_id', commander_id)
                .maybeSingle();

            if (memError || !membership) {
                setLoading(false);
                setSyndicate(null);
                return;
            }

            setCurrentUserRole({
                role_key: membership.role_key,
                ...membership.syndicate_roles
            });

            // Get syndicate info
            const { data: synData, error: synError } = await supabase
                .from('syndicates')
                .select('syndicate_id, name, tag')
                .eq('syndicate_id', membership.syndicate_id)
                .single();

            if (synError || !synData) {
                setLoading(false);
                setSyndicate(null);
                return;
            }

            // Get member count and pending apps count
            const [memCountRes, pendingCountRes] = await Promise.all([
                supabase.from('syndicate_members').select('*', { count: 'exact', head: true }).eq('syndicate_id', synData.syndicate_id).neq('role_key', 'applicant'),
                supabase.from('syndicate_members').select('*', { count: 'exact', head: true }).eq('syndicate_id', synData.syndicate_id).eq('role_key', 'applicant')
            ]);

            setSyndicate(synData);
            setMemberCount(memCountRes.count || 0);
            setPendingCount(pendingCountRes.count || 0);
        } catch (err) {
            console.error('Error fetching syndicate data:', err);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchSyndicateData();
    }, [commander_id]);

    if (subView === 'create') {
        return React.createElement(CreateSyndicateView, {
            onBack: () => setSubView('main'),
            onSuccess: () => {
                setSubView('main');
                fetchSyndicateData();
            }
        });
    }

    if (subView === 'join') {
        return React.createElement(JoinSyndicateView, {
            onBack: () => setSubView('main'),
            onSuccess: () => {
                setSubView('main');
                fetchSyndicateData();
            }
        });
    }

    if (subView === 'overview' && syndicate) {
        return React.createElement(SyndicateOverview, {
            syndicateId: syndicate.id,
            onBack: () => setSubView('main'),
            onNavigate: (view) => {
                if (view === 'overview') setSubView('overview');
                else if (view === 'members') setSubView('members');
                else if (view === 'systems') setSubView('systems');
                else if (view === 'starports') setSubView('starports');
                else if (view === 'treasury') setSubView('treasury');
                else if (view === 'settings') setSubView('settings');
                else onOpenSyndicateMenu(view);
            }
        });
    }

    if (subView === 'starports' && syndicate) {
        return React.createElement(SyndicateStarportsView, {
            syndicateId: syndicate.id,
            currentUserRole,
            onBack: () => setSubView('overview'),
            onNavigateToLogs: (id, name) => {
                setSelectedLogTarget({ id, name });
                setSubView('starport_logs');
            }
        });
    }

    if (subView === 'starport_logs' && selectedLogTarget) {
        return React.createElement(StarportLogsView, {
            systemId: selectedLogTarget.id,
            systemName: selectedLogTarget.name,
            onBack: () => setSubView('starports')
        });
    }

    if (subView === 'treasury' && syndicate) {
        return React.createElement(SyndicateTreasuryView, {
            syndicateId: syndicate.id,
            currentUserRole,
            onBack: () => setSubView('main')
        });
    }

    if (subView === 'settings' && syndicate) {
        return React.createElement(SyndicateSettingsView, {
            syndicateId: syndicate.id,
            currentUserRole,
            onBack: () => setSubView('main'),
            onUpdateSuccess: fetchSyndicateData,
            onLeaveSuccess: () => {
                setSubView('main');
                fetchSyndicateData();
            }
        });
    }

    if (subView === 'systems' && syndicate) {
        return React.createElement(SyndicateSystemsView, {
            syndicateId: syndicate.id,
            onBack: () => setSubView('overview'),
            onNavigate: (view) => {
                if (view === 'starports') onOpenSyndicateMenu('starports');
            }
        });
    }

    if (subView === 'members' && syndicate) {
        return React.createElement(SyndicateMembersView, {
            syndicateId: syndicate.id,
            currentUserRole,
            onBack: () => setSubView('overview')
        });
    }

    if (subView === 'applications' && syndicate) {
        return React.createElement(SyndicateApplicationsView, {
            syndicateId: syndicate.id,
            currentUserRole,
            onBack: () => setSubView('main')
        });
    }

    if (loading) {
        return React.createElement('div', { 
            style: { 
                display: 'flex', 
                flexDirection: 'column', 
                gap: '15px',
                padding: '20px'
            } 
        },
            // Skeletons
            [1, 2, 3].map(i => React.createElement('div', {
                key: i,
                style: {
                    height: i === 1 ? '40px' : '20px',
                    width: i === 1 ? '70%' : '100%',
                    background: 'linear-gradient(90deg, #1a1a1a 25%, #222 50%, #1a1a1a 75%)',
                    backgroundSize: '200% 100%',
                    animation: 'skeleton-pulse 1.5s infinite ease-in-out',
                    borderRadius: '4px'
                }
            })),
            React.createElement('div', {
                style: {
                    height: '150px',
                    width: '100%',
                    background: 'linear-gradient(90deg, #1a1a1a 25%, #222 50%, #1a1a1a 75%)',
                    backgroundSize: '200% 100%',
                    animation: 'skeleton-pulse 1.5s infinite ease-in-out',
                    borderRadius: '4px',
                    marginTop: '20px'
                }
            })
        );
    }

    if (!syndicate) {
        return React.createElement('div', { 
            style: { 
                display: 'flex', 
                flexDirection: 'column', 
                alignItems: 'center',
                justifyContent: 'center',
                height: '100%',
                gap: '20px',
                textAlign: 'center',
                padding: '40px',
                animation: 'fadeIn 0.3s ease-out'
            } 
        },
            React.createElement('div', { style: { fontSize: '14px', color: '#888', marginBottom: '10px' } }, 
                "You are not currently in a syndicate."
            ),
            React.createElement('div', { style: { display: 'flex', gap: '10px', width: '100%' } },
                React.createElement('button', {
                    style: {
                        flex: 1,
                        padding: '12px',
                        background: 'rgba(0, 204, 255, 0.1)',
                        border: '1px solid #00ccff',
                        color: '#00ccff',
                        cursor: 'pointer',
                        fontSize: '11px',
                        fontWeight: 'bold',
                        letterSpacing: '1px',
                        borderRadius: '2px'
                    },
                    onClick: () => setSubView('create')
                }, "CREATE SYNDICATE"),
                React.createElement('button', {
                    style: {
                        flex: 1,
                        padding: '12px',
                        background: 'rgba(255, 204, 0, 0.1)',
                        border: '1px solid #ffcc00',
                        color: '#ffcc00',
                        cursor: 'pointer',
                        fontSize: '11px',
                        fontWeight: 'bold',
                        letterSpacing: '1px',
                        borderRadius: '2px'
                    },
                    onClick: () => setSubView('join')
                }, "JOIN SYNDICATE")
            )
        );
    }

    const isOfficer = currentUserRole?.is_officer || currentUserRole?.role_key === 'leader';

    const navButtons = [
        { label: 'OVERVIEW', id: 'overview' },
        { label: 'MEMBERS', id: 'members' },
        ...(isOfficer ? [{ label: 'APPLICATIONS', id: 'applications', badge: pendingCount }] : []),
        { label: 'SYSTEMS', id: 'systems' },
        { label: 'STARPORTS', id: 'starports' },
        { label: 'TREASURY', id: 'treasury' },
        { label: 'SETTINGS', id: 'settings' }
    ];

    return React.createElement('div', { 
        style: { 
            display: 'flex', 
            flexDirection: 'column', 
            height: '100%',
            gap: '20px',
            animation: 'fadeIn 0.3s ease-out'
        } 
    },
        // Syndicate Header
        React.createElement('div', {
            style: {
                padding: '15px',
                background: 'rgba(255, 204, 0, 0.05)',
                border: '1px solid #ffcc0044',
                borderRadius: '4px',
                display: 'flex',
                flexDirection: 'column',
                gap: '5px'
            }
        },
            React.createElement('div', { style: { display: 'flex', alignItems: 'baseline', gap: '10px' } },
                React.createElement('span', { style: { fontSize: '18px', fontWeight: 'bold', color: '#ffcc00' } }, syndicate.name.toUpperCase()),
                React.createElement('span', { style: { fontSize: '12px', color: '#888' } }, `[${syndicate.tag}]`)
            ),
            React.createElement('div', { style: { fontSize: '11px', color: '#666' } }, `${memberCount} ACTIVE MEMBERS`)
        ),

        // Navigation List
        React.createElement('div', {
            style: {
                display: 'flex',
                flexDirection: 'column',
                gap: '5px',
                overflowY: 'auto',
                flex: 1
            }
        },
            navButtons.map(btn => React.createElement('button', {
                key: btn.id,
                style: {
                    padding: '12px 15px',
                    background: 'rgba(255,255,255,0.02)',
                    border: '1px solid #333',
                    color: '#ccc',
                    textAlign: 'left',
                    cursor: 'pointer',
                    fontSize: '12px',
                    fontWeight: 'bold',
                    letterSpacing: '1px',
                    borderRadius: '2px',
                    transition: 'all 0.2s',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center'
                },
                onMouseEnter: (e) => {
                    e.currentTarget.style.background = 'rgba(0, 204, 255, 0.1)';
                    e.currentTarget.style.borderColor = '#00ccff';
                    e.currentTarget.style.color = '#fff';
                },
                onMouseLeave: (e) => {
                    e.currentTarget.style.background = 'rgba(255,255,255,0.02)';
                    e.currentTarget.style.borderColor = '#333';
                    e.currentTarget.style.color = '#ccc';
                },
                onClick: () => {
                    if (btn.id === 'overview') {
                        setSubView('overview');
                    } else if (btn.id === 'members') {
                        setSubView('members');
                    } else if (btn.id === 'applications') {
                        setSubView('applications');
                    } else if (btn.id === 'systems') {
                        setSubView('systems');
                    } else if (btn.id === 'starports') {
                        setSubView('starports');
                    } else if (btn.id === 'treasury') {
                        setSubView('treasury');
                    } else if (btn.id === 'settings') {
                        setSubView('settings');
                    } else {
                        onOpenSyndicateMenu(btn.id);
                    }
                }
            }, 
                React.createElement('span', null, btn.label),
                btn.badge > 0 && React.createElement('span', {
                    style: {
                        background: '#ffcc00',
                        color: '#000',
                        fontSize: '9px',
                        padding: '2px 6px',
                        borderRadius: '10px',
                        fontWeight: 'bold'
                    }
                }, btn.badge)
            ))
        )
    );
};

export const SocialMenu = ({ onClose, onOpenSyndicateMenu, fleet = [], userId = null, onLeaveFleet, onKickMember, onPromoteMember }) => {
    const { commander_id } = useGameState();
    const { offset, isDragging, dragProps } = useDraggable();
    const [activeTab, setActiveTab] = useState('fleet');
    const [searchQuery, setSearchQuery] = useState('');

    useEffect(() => {
        const styleId = 'social-menu-styles';
        if (!document.getElementById(styleId)) {
            const style = document.createElement('style');
            style.id = styleId;
            style.textContent = `
                @keyframes fadeIn {
                    from { opacity: 0; transform: translateY(5px); }
                    to { opacity: 1; transform: translateY(0); }
                }
                @keyframes skeleton-pulse {
                    0% { background-position: 200% 0; }
                    100% { background-position: -200% 0; }
                }
            `;
            document.head.appendChild(style);
        }
    }, []);


    const renderFleetTab = () => {
        const normalizedFleet = Array.isArray(fleet) ? fleet.filter(member => !!member?.id) : [];
        const isInParty = normalizedFleet.length > 0;
        const leaderId = normalizedFleet.find(member => member.isLeader)?.id || null;
        const isLeader = !!userId && userId === leaderId;

        const renderBar = (value, maxValue, color) => {
            const safeMax = Math.max(1, Number(maxValue || 0));
            const safeValue = Math.max(0, Number(value || 0));
            const pct = Math.max(0, Math.min(100, (safeValue / safeMax) * 100));
            return React.createElement('div', {
                style: {
                    height: '4px',
                    background: 'rgba(255,255,255,0.08)',
                    borderRadius: '2px',
                    overflow: 'hidden'
                }
            }, React.createElement('div', {
                style: {
                    width: `${pct}%`,
                    height: '100%',
                    background: color,
                    transition: 'width 0.2s ease'
                }
            }));
        };

        return React.createElement('div', { 
            style: { 
                display: 'flex', 
                flexDirection: 'column', 
                gap: '15px', 
                height: '100%',
                animation: 'fadeIn 0.2s ease-out'
            } 
        },
            !isInParty ? (
                React.createElement('div', {
                    style: {
                        flex: 1,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        color: '#666',
                        fontSize: '14px',
                        fontStyle: 'italic',
                        background: 'rgba(0,0,0,0.2)',
                        borderRadius: '4px',
                        border: '1px dashed #444',
                        textAlign: 'center',
                        padding: '20px'
                    }
                }, "You are not currently in a fleet.")
            ) : (
                React.createElement('div', { 
                    style: { 
                        flex: 1, 
                        background: 'rgba(0,0,0,0.3)', 
                        borderRadius: '4px', 
                        padding: '10px',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '8px',
                        overflowY: 'auto'
                    } 
                },
                    React.createElement('div', { style: { fontSize: '11px', color: '#888', marginBottom: '5px' } }, "AUTHORITATIVE FLEET ROSTER"),
                    normalizedFleet.map(member => {
                        const isSelf = member.id === userId;
                        return React.createElement('div', {
                            key: member.id,
                            style: {
                                padding: '10px',
                                background: 'rgba(255,255,255,0.05)',
                                border: '1px solid #333',
                                borderRadius: '4px',
                                display: 'flex',
                                flexDirection: 'column',
                                gap: '8px'
                            }
                        },
                            React.createElement('div', {
                                style: {
                                    display: 'flex',
                                    justifyContent: 'space-between',
                                    alignItems: 'center',
                                    gap: '10px'
                                }
                            },
                                React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 } },
                                    React.createElement('div', { 
                                        style: { 
                                            width: '8px', 
                                            height: '8px', 
                                            borderRadius: '50%', 
                                            background: member.isLeader ? '#ffcc00' : '#00ff66',
                                            boxShadow: `0 0 5px ${member.isLeader ? '#ffcc00' : '#00ff66'}`,
                                            flexShrink: 0
                                        } 
                                    }),
                                    React.createElement('span', { style: { fontSize: '13px', fontWeight: 'bold', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, (isSelf ? 'YOU' : member.name || 'COMMANDER').toUpperCase()),
                                    member.isLeader && React.createElement('span', { style: { fontSize: '9px', background: '#ffcc00', color: '#000', padding: '1px 4px', borderRadius: '2px', fontWeight: 'bold', flexShrink: 0 } }, "LEADER")
                                ),
                                React.createElement('span', { style: { fontSize: '11px', color: member.docked ? '#9cc7d9' : '#666', flexShrink: 0 } }, member.docked ? 'DOCKED' : (member.systemId || 'ONLINE').toUpperCase())
                            ),
                            React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
                                Number(member.maxShields || 0) > 0 && renderBar(member.shields, member.maxShields, '#00ccff'),
                                renderBar(member.hp, member.maxHp, '#ff4444'),
                                renderBar(member.energy, member.maxEnergy, '#00ff66')
                            ),
                            React.createElement('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: '8px', flexWrap: 'wrap' } },
                                isSelf && React.createElement('button', {
                                    style: {
                                        padding: '8px 10px',
                                        background: 'rgba(255, 68, 68, 0.1)',
                                        border: '1px solid #ff4444',
                                        color: '#ff4444',
                                        cursor: 'pointer',
                                        fontSize: '10px',
                                        fontWeight: 'bold',
                                        letterSpacing: '1px',
                                        borderRadius: '2px'
                                    },
                                    onClick: () => onLeaveFleet?.()
                                }, "LEAVE"),
                                (!isSelf && isLeader) && React.createElement(React.Fragment, null,
                                    React.createElement('button', {
                                        style: {
                                            padding: '8px 10px',
                                            background: 'rgba(255, 204, 0, 0.1)',
                                            border: '1px solid #ffcc00',
                                            color: '#ffcc00',
                                            cursor: 'pointer',
                                            fontSize: '10px',
                                            fontWeight: 'bold',
                                            letterSpacing: '1px',
                                            borderRadius: '2px'
                                        },
                                        onClick: () => onPromoteMember?.(member.id)
                                    }, "PROMOTE"),
                                    React.createElement('button', {
                                        style: {
                                            padding: '8px 10px',
                                            background: 'rgba(255, 68, 68, 0.1)',
                                            border: '1px solid #ff4444',
                                            color: '#ff4444',
                                            cursor: 'pointer',
                                            fontSize: '10px',
                                            fontWeight: 'bold',
                                            letterSpacing: '1px',
                                            borderRadius: '2px'
                                        },
                                        onClick: () => onKickMember?.(member.id)
                                    }, "KICK")
                                )
                            )
                        );
                    })
                )
            ),
            React.createElement('div', { style: { fontSize: '10px', color: '#666', textAlign: 'center', letterSpacing: '1px' } }, "Invite commanders from the right-click social menu.")
        );
    };

    const renderContactsTab = () => {
        return React.createElement('div', { 
            style: { 
                display: 'flex', 
                flexDirection: 'column', 
                gap: '15px', 
                height: '100%',
                animation: 'fadeIn 0.2s ease-out'
            } 
        },
            React.createElement('div', { style: { position: 'relative' } },
                React.createElement('input', {
                    type: 'text',
                    placeholder: 'SEARCH CONTACTS...',
                    value: searchQuery,
                    onChange: (e) => setSearchQuery(e.target.value),
                    style: {
                        width: '100%',
                        padding: '12px 12px 12px 35px',
                        background: 'rgba(0,0,0,0.4)',
                        border: '1px solid #444',
                        color: '#fff',
                        fontFamily: 'monospace',
                        fontSize: '12px',
                        borderRadius: '4px',
                        boxSizing: 'border-box'
                    }
                }),
                React.createElement('div', {
                    style: {
                        position: 'absolute',
                        left: '10px',
                        top: '50%',
                        transform: 'translateY(-50%)',
                        color: '#666'
                    }
                }, "🔍")
            ),
            React.createElement('div', {
                style: {
                    flex: 1,
                    background: 'rgba(0,0,0,0.3)',
                    border: '1px solid #333',
                    borderRadius: '4px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: '#555',
                    fontSize: '13px',
                    fontStyle: 'italic'
                }
            }, "Contacts list coming soon.")
        );
    };

    return React.createElement('div', {
        style: {
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: `translate(calc(-50% + ${offset.x}px), calc(-50% + ${offset.y}px))`,
            display: 'flex',
            zIndex: 3000,
            pointerEvents: 'none',
            transition: isDragging ? 'none' : 'transform 0.6s cubic-bezier(0.19, 1, 0.22, 1)'
        }
    },
        React.createElement('div', {
            style: {
                width: '450px',
                height: '550px',
                background: 'rgba(15, 20, 25, 0.98)',
                border: '2px solid #00ccff88',
                borderRadius: '8px',
                boxShadow: '0 0 40px rgba(0,0,0,0.9), inset 0 0 20px rgba(0,204,255,0.05)',
                padding: '25px',
                color: '#fff',
                fontFamily: 'monospace',
                display: 'flex',
                flexDirection: 'column',
                pointerEvents: 'auto',
                position: 'relative'
            }
        },
            // Draggable Handle
            React.createElement('div', {
                ...dragProps,
                style: {
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    height: '60px',
                    cursor: 'grab',
                    zIndex: 1
                }
            }),

            // Header
            React.createElement('div', {
                style: {
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    marginBottom: '20px',
                    borderBottom: '1px solid #333',
                    paddingBottom: '15px',
                    position: 'relative',
                    zIndex: 2,
                    pointerEvents: 'none' // Let drag through to handle, but children override
                }
            },
                React.createElement('div', {
                    style: {
                        fontSize: '20px',
                        fontWeight: 'bold',
                        letterSpacing: '4px',
                        color: '#00ccff',
                        textShadow: '0 0 10px rgba(0,204,255,0.3)'
                    }
                }, "SOCIAL"),
                React.createElement('button', {
                    onClick: onClose,
                    onPointerDown: (e) => e.stopPropagation(),
                    style: {
                        background: 'none',
                        border: 'none',
                        color: '#888',
                        fontSize: '20px',
                        cursor: 'pointer',
                        padding: '5px',
                        pointerEvents: 'auto'
                    }
                }, "✕")
            ),

        // Tabs
        React.createElement('div', {
            style: {
                display: 'flex',
                gap: '2px',
                marginBottom: '20px',
                background: 'rgba(0,0,0,0.3)',
                padding: '2px',
                borderRadius: '4px'
            }
        },
            ['fleet', 'syndicate', 'contacts'].map(tab => (
                React.createElement('button', {
                    key: tab,
                    onClick: () => setActiveTab(tab),
                    style: {
                        flex: 1,
                        padding: '10px',
                        background: activeTab === tab ? '#ffcc00' : 'transparent',
                        border: 'none',
                        color: activeTab === tab ? '#000' : '#888',
                        fontSize: '11px',
                        fontWeight: 'bold',
                        cursor: 'pointer',
                        transition: 'all 0.2s',
                        letterSpacing: '1px',
                        borderRadius: '2px',
                        textTransform: 'uppercase'
                    }
                }, tab)
            ))
        ),

        // Content
        React.createElement('div', {
            style: { flex: 1, overflow: 'hidden' }
        },
            activeTab === 'fleet' && renderFleetTab(),
            activeTab === 'syndicate' && React.createElement(SyndicateContent, { onOpenSyndicateMenu }),
            activeTab === 'contacts' && renderContactsTab()
        ),

        // Footer
        React.createElement('div', {
            style: {
                marginTop: '15px',
                fontSize: '9px',
                color: '#444',
                textAlign: 'center',
                letterSpacing: '1px'
            }
        }, "OMNI DIRECTORATE SOCIAL NETWORK // SECURE LINK ACTIVE")
    )
);
};