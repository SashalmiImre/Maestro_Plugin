import React from 'react';
import { useToast } from './ToastContext.jsx';
import { Toast } from './Toast.jsx';

export const ToastContainer = () => {
    const { toasts, removeToast } = useToast();

    if (toasts.length === 0) return null;

    return (
        <>
            <style>{`
                @keyframes slideUp {
                    from {
                        opacity: 0;
                        transform: translateY(20px);
                    }
                    to {
                        opacity: 1;
                        transform: translateY(0);
                    }
                }

                @keyframes fadeOut {
                    from {
                        opacity: 1;
                        transform: translateY(0);
                    }
                    to {
                        opacity: 0;
                        transform: translateY(20px);
                    }
                }
            `}</style>
            <div
                aria-live="polite"
                role="status"
                aria-atomic="true"
                style={{
                    position: 'fixed',
                    top: '20px',
                    left: '50%',
                    transform: 'translateX(-50%)',
                    zIndex: 10000,
                    display: 'flex',
                    flexDirection: 'column', // Newest at top
                    alignItems: 'center',
                    pointerEvents: 'none'
                }}
            >
                {toasts.map(toast => (
                    <div key={toast.id} style={{ pointerEvents: 'auto', width: '100%', display: 'flex', justifyContent: 'center' }}>
                        <Toast
                            id={toast.id}
                            message={toast.message}
                            type={toast.type}
                            details={toast.details}
                            duration={toast.duration}
                            onClose={removeToast}
                        />
                    </div>
                ))}
            </div>
        </>
    );
};
