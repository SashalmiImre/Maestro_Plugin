import React, { useState, useEffect, useRef, useCallback } from 'react';
import './Toast.css';

export const Toast = ({ id, message, type, details, onClose, duration }) => {
    const [isExiting, setIsExiting] = useState(false);
    const [isHovered, setIsHovered] = useState(false);
    const dismissTimerRef = useRef(null);
    const exitTimerRef = useRef(null);
    const creationTimeRef = useRef(Date.now());
    const pausedDurationRef = useRef(0);
    const pauseStartRef = useRef(null);

    // Stable close handler
    const handleClose = useCallback(() => {
        if (exitTimerRef.current) return;

        setIsExiting(true);
        exitTimerRef.current = setTimeout(() => {
            onClose(id);
        }, 300); // Match animation duration
    }, [id, onClose]);

    // Handle auto-dismiss with hover pause
    useEffect(() => {
        const DISMISS_DURATION = duration || (type === 'error' && details ? 6000 : 5000);

        if (isHovered) {
            // Clear timer when hovering and record pause start
            if (dismissTimerRef.current) {
                clearTimeout(dismissTimerRef.current);
                dismissTimerRef.current = null;
            }
            pauseStartRef.current = Date.now();
        } else {
            // Calculate paused duration if we were paused
            if (pauseStartRef.current) {
                const pauseInterval = Date.now() - pauseStartRef.current;
                pausedDurationRef.current += pauseInterval;
                pauseStartRef.current = null;
            }

            // Calculate remaining time: Total Duration - (Time since creation - Total time paused)
            const elapsedActive = Date.now() - creationTimeRef.current - pausedDurationRef.current;
            const remaining = DISMISS_DURATION - elapsedActive;

            if (remaining <= 0) {
                // Time already expired, dismiss immediately
                handleClose();
            } else {
                dismissTimerRef.current = setTimeout(() => {
                    handleClose();
                }, remaining);

                return () => {
                    if (dismissTimerRef.current) {
                        clearTimeout(dismissTimerRef.current);
                    }
                };
            }
        }
    }, [isHovered, handleClose, duration, type, details]);

    // Cleanup exit timer on unmount
    useEffect(() => {
        return () => {
            if (exitTimerRef.current) {
                clearTimeout(exitTimerRef.current);
            }
        };
    }, []);

    const getBackgroundColor = () => {
        switch (type) {
            case 'success':
                return '#0d7d56'; // Green from UXP Dev Tool
            case 'error':
                return '#d7373f'; // Red
            case 'info':
            default:
                return '#378ef0'; // Blue
        }
    };

    const getIcon = () => {
        switch (type) {
            case 'success':
                return (
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0 }}>
                        <circle cx="12" cy="12" r="10" fill="white" fillOpacity="0.3" />
                        <path d="M8 12l3 3 5-5" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                );
            case 'error':
                return (
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0 }}>
                        <circle cx="12" cy="12" r="10" fill="white" fillOpacity="0.3" />
                        <path d="M8 8l8 8M16 8l-8 8" stroke="white" strokeWidth="2" strokeLinecap="round" />
                    </svg>
                );
            default:
                return null;
        }
    };

    return (
        <div
            onMouseEnter={() => setIsHovered(true)}
            onMouseLeave={() => setIsHovered(false)}
            style={{
                backgroundColor: getBackgroundColor(),
                color: 'white',
                padding: '12px 16px',
                borderRadius: '4px',
                boxShadow: '0 4px 12px rgba(0, 0, 0, 0.3)',
                display: 'flex',
                alignItems: details ? 'flex-start' : 'center',
                minWidth: '300px',
                maxWidth: 'calc(100% - 40px)',
                marginBottom: '8px',
                animation: isExiting ? 'fadeOut 0.3s ease-out forwards' : 'slideUp 0.3s ease-out forwards',
                // opacity and transform handled by animation
            }}
        >
            <div style={{ flexShrink: 0, marginRight: '12px' }}>{getIcon()}</div>
            <div style={{ flex: 1 }}>
                <div style={{ fontSize: '14px', fontWeight: '500' }}>{message}</div>
                {details && (
                    <div style={{ fontSize: '12px', marginTop: '4px', opacity: 0.9, whiteSpace: 'pre-wrap' }}>{details}</div>
                )}
            </div>
            <button
                onClick={handleClose}
                aria-label="Close notification"
                style={{
                    background: 'transparent',
                    border: 'none',
                    color: 'white',
                    cursor: 'pointer',
                    padding: '4px',
                    marginLeft: '12px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    opacity: 1,
                    flexShrink: 0
                }}
                onMouseEnter={(e) => e.currentTarget.style.opacity = '0.7'}
                onMouseLeave={(e) => e.currentTarget.style.opacity = '1'}
            >
                <svg width="18" height="18" viewBox="0 0 16 16" fill="none">
                    <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
                </svg>
            </button>
        </div>
    );
};
