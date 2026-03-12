import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { cloudService } from '../CloudService.js';
import { supabase } from '../supabaseClient.js';

const GameStateContext = createContext(null);

export const GameStateProvider = ({ children }) => {
    const [commanderId, setCommanderId] = useState(null);
    const [commanderData, setCommanderData] = useState(null);
    const [loading, setLoading] = useState(true);

    const syncCommander = useCallback(async (userId) => {
        console.log(`[GameState] [SYNC START] Verifying identity for UID: ${userId}`);
        try {
            // 1. Fetch commander data
            const commanderDataResult = await cloudService.getCommanderData(userId);
            if (!commanderDataResult) {
                console.warn(`[GameState] [SYNC ABORT] No commander_data found for UID: ${userId}`);
                return;
            }

            console.log(`[GameState] [SYNC] Commander data verified: ${commanderDataResult.id}`);
            setCommanderId(commanderDataResult.id);

            // 2. Ensure the commander has a portrait record
            console.log(`[GameState] [PORTRAIT] Checking registry for commander: ${userId}`);
            let { data: mapping, error: fetchError } = await supabase
                .from('commander_portraits')
                .select('portrait_id')
                .eq('commander_id', userId)
                .maybeSingle();

            if (fetchError) {
                console.error(`[GameState] [PORTRAIT ERROR] Registry lookup failed:`, fetchError);
            }

            if (!mapping) {
                console.log(`[GameState] [PORTRAIT] No record found. MANIFESTING default entry (ID: 1)...`);
                // No record found, create default entry
                const { data: newMapping, error: insertError } = await supabase
                    .from('commander_portraits')
                    .insert({ commander_id: userId, portrait_id: 1 })
                    .select('portrait_id')
                    .single();
                
                if (insertError) {
                    console.error(`[GameState] [PORTRAIT ERROR] Default manifestation failed:`, insertError);
                } else {
                    console.log(`[GameState] [PORTRAIT SUCCESS] Default record created for ${userId}`);
                    mapping = newMapping;
                }
            } else {
                console.log(`[GameState] [PORTRAIT] Existing mapping found: ID ${mapping.portrait_id}`);
            }

            let portraitUrl = '/assets/captain-portrait.png.webp';

            // 3. Fetch the actual image URL for the assigned portrait_id
            if (mapping?.portrait_id) {
                console.log(`[GameState] [PORTRAIT] Resolving asset URL for ID: ${mapping.portrait_id}`);
                const { data: portraitRecord, error: assetError } = await supabase
                    .from('portraits')
                    .select('image_url')
                    .eq('portrait_id', mapping.portrait_id)
                    .maybeSingle();
                
                if (assetError) {
                    console.error(`[GameState] [PORTRAIT ERROR] Asset resolution failed:`, assetError);
                }

                if (portraitRecord?.image_url) {
                    console.log(`[GameState] [PORTRAIT] Asset resolved: ${portraitRecord.image_url}`);
                    portraitUrl = portraitRecord.image_url;
                }
            }

            // Merge portrait into commanderData
            setCommanderData({
                ...commanderDataResult,
                portrait_url: portraitUrl
            });
            console.log(`[GameState] [SYNC COMPLETE] Profile hydrated with portrait: ${portraitUrl}`);
        } catch (err) {
            console.error("[GameState] [CRITICAL] Failed to sync commander:", err);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        const init = async () => {
            // Wait for cloudService to login if it's not yet
            let user = cloudService.user;
            if (!user) {
                const checkUser = setInterval(() => {
                    if (cloudService.user) {
                        clearInterval(checkUser);
                        syncCommander(cloudService.user.id);
                    }
                }, 100);
                return;
            }
            syncCommander(user.id);
        };

        init();

        // Listen for changes to commander_data
        const commanderFilter = commanderId ? `id=eq.${commanderId}` : null;
        const subscription = supabase
            .channel(`commander_updates_${commanderId || 'pending'}`)
            .on('postgres_changes', { 
                event: 'UPDATE', 
                schema: 'public', 
                table: 'commander_data',
                ...(commanderFilter ? { filter: commanderFilter } : {})
            }, payload => {
                if (payload.new.id === commanderId) {
                    setCommanderData(prev => ({ ...prev, ...payload.new }));
                }
            })
            .subscribe();

        return () => {
            supabase.removeChannel(subscription);
        };
    }, [commanderId, syncCommander]);

    const value = {
        commander_id: commanderId,
        commanderData,
        loading,
        refreshCommanderData: async () => {
            if (commanderId) {
                await syncCommander(commanderId);
            }
        }
    };

    return React.createElement(GameStateContext.Provider, { value }, children);
};

export const useGameState = () => {
    const context = useContext(GameStateContext);
    if (!context) {
        throw new Error('useGameState must be used within a GameStateProvider');
    }
    return context;
};