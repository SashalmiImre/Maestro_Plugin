import { useMemo } from 'react';
import { useValidation } from '../../core/contexts/ValidationContext.jsx';
import { useUserValidations } from './useUserValidations.js';
import { VALIDATION_TYPES } from '../../core/utils/messageConstants.js';
import { VALIDATION_SOURCES } from '../../core/utils/validationConstants.js';

const SEVERITY = {
    [VALIDATION_TYPES.ERROR]: 3,
    [VALIDATION_TYPES.WARNING]: 2,
    [VALIDATION_TYPES.INFO]: 1,
    [VALIDATION_TYPES.SUCCESS]: 0
};

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
                isSystem: true
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

    // 5. Unified List — sorrend: (1) system felül severity szerint, (2) user createdAt desc.
    const unifiedList = useMemo(() => {
        return [...activeSystemItems, ...userItems].sort((a, b) => {
            if (a.isSystem !== b.isSystem) return a.isSystem ? -1 : 1;
            if (a.isSystem) {
                return (SEVERITY[b.type] || 0) - (SEVERITY[a.type] || 0);
            }
            const tA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
            const tB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
            if (tA !== tB) return tB - tA;
            return (SEVERITY[b.type] || 0) - (SEVERITY[a.type] || 0);
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
