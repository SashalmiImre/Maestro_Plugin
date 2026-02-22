import React, { createContext, useContext, useState, useCallback } from 'react';

const ToastContext = createContext();

let toastIdCounter = 0;

export const ToastProvider = ({ children }) => {
    const [toasts, setToasts] = useState([]);

    const showToast = useCallback((message, type = 'info', details = null, duration = null) => {
        const id = `toast-${++toastIdCounter}`;
        const toast = {
            id,
            message,
            type, // 'success', 'error', 'info'
            details, // optional detailed information
            duration, // optional custom duration in ms
            createdAt: Date.now()
        };

        setToasts(prev => [...prev, toast]);

        return id;
    }, []);

    const removeToast = useCallback((id) => {
        setToasts(prev => prev.filter(toast => toast.id !== id));
    }, []);

    return (
        <ToastContext.Provider value={{ toasts, showToast, removeToast }}>
            {children}
        </ToastContext.Provider>
    );
};

export const useToast = () => {
    const context = useContext(ToastContext);
    if (!context) {
        throw new Error('useToast must be used within a ToastProvider');
    }
    return context;
};
