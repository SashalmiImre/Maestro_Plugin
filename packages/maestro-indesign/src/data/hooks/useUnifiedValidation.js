import { useMemo } from 'react';
import { useValidation } from '../../core/contexts/ValidationContext.jsx';
import { useUserValidations } from './useUserValidations.js';
import { VALIDATION_TYPES } from '../../core/utils/messageConstants.js';
import { VALIDATION_SOURCES } from '../../core/utils/validationConstants.js';

/**
 * Hook to get unified validation items (System + User Validations) for an article.
 * Handles merging, sorting, and override logic (downgrading system errors).
 * 
 * @param {Object} article - The article object
 * @returns {Object} { unifiedList, hasErrors, isLoading, ...methods }
 */
export const useUnifiedValidation = (article) => {
    const { validationResults } = useValidation();
    
    // Unified list generation
    const { 
        validations, 
        loading: validationsLoading, 
        addValidation, 
        resolveValidation, 
        downgradeSystemError 
    } = useUserValidations(article?.$id);

    // 1. System Items (from ValidationContext)
    const systemItems = useMemo(() => {
        if (!article?.$id) return [];
        const rawItems = validationResults.get(article.$id) || [];
        
        return rawItems
            .filter(item => item.source !== VALIDATION_SOURCES.USER && item.source !== VALIDATION_SOURCES.SYSTEM_OVERRIDE)
            .map(item => ({
                ...item,
                type: Object.values(VALIDATION_TYPES).includes(item.type) ? item.type : VALIDATION_TYPES.ERROR,
                isSystem: true,
                createdAt: new Date().toISOString() // System errors are active "now"
            }));
    }, [validationResults, article?.$id]);

    // 2. Override Messages (User messages that downgrade system errors)
    const overrideMessages = useMemo(() => {
        return validations.filter(m => m.source === VALIDATION_SOURCES.SYSTEM_OVERRIDE && m.contextId);
    }, [validations]);

    // 3. Active System Items (Filter out overridden ones)
    const activeSystemItems = useMemo(() => {
        return systemItems.map(item => {
            if (item.contextId) {
                const override = overrideMessages.find(m => ((m.contextId === item.contextId) || (m.contextId === item.id)));
                // If overridden, the system error is "hidden" (replaced by the override message in the user list)
                if (override) return null;
            }
            return item;
        }).filter(Boolean);
    }, [systemItems, overrideMessages]);

    // 4. User Items
    // - Override messages count as User Items (type=WARNING usually)
    // - User notes (type=ERROR/WARNING/INFO)
    const userItems = useMemo(() => {
        return validations.map(m => ({
            ...m,
            // Ensure consistent fields (Context vs Row)
            id: m.id || m.$id,
            $id: m.$id || m.id,
            description: m.description || m.message,
            message: m.message || m.description,
            createdAt: m.createdAt || m.$createdAt,
            
            isSystem: false,
            // If it's an override, ensure it's treated as its recorded type (usually Warning)
            // If originalType is present, it's an override. 
            // The display logic usually shows it as 'warning'.
        }));
    }, [validations]);

    // 5. Unified List
    const unifiedList = useMemo(() => {
        return [...activeSystemItems, ...userItems].sort((a, b) => {
            // Sort by Date (newest first)
            // Use createdAt if available, otherwise assume new
            const dateA = a.createdAt ? new Date(a.createdAt) : new Date();
            const dateB = b.createdAt ? new Date(b.createdAt) : new Date();
            
            // Ha a dátumok megegyeznek (pl. egyszerre jönnek rendszerüzenetek),
            // akkor a típust vesszük másodlagos rendezőnek (Hiba > Warning)
            if (dateA.getTime() === dateB.getTime()) {
                const severity = { 
                    [VALIDATION_TYPES.ERROR]: 3, 
                    [VALIDATION_TYPES.WARNING]: 2, 
                    [VALIDATION_TYPES.INFO]: 1, 
                    [VALIDATION_TYPES.SUCCESS]: 0 
                };
                return (severity[b.type] || 0) - (severity[a.type] || 0);
            }

            return dateB - dateA;
        });
    }, [activeSystemItems, userItems]);

    // 6. Has Errors Check
    // Checks for any unresolved ERROR type items.
    const hasErrors = useMemo(() => {
        return unifiedList.some(item => 
            item.type === VALIDATION_TYPES.ERROR && !item.isResolved
        );
    }, [unifiedList]);

    return {
        unifiedList,
        hasErrors,
        isLoading: validationsLoading,
        addValidation,
        resolveValidation,
        downgradeSystemError
    };
};
