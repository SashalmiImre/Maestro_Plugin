import React, { useState, useRef, useEffect } from "react";

export const ConfirmDialog = ({ isOpen, title, message, onConfirm = () => { }, onCancel = () => { }, isAlert = false, confirmLabel, verificationExpected }) => {
    const dialogRef = useRef(null);
    const [verificationInput, setVerificationInput] = useState("");

    // Reset input when opening
    useEffect(() => {
        if (isOpen) {
            setVerificationInput("");
        }
    }, [isOpen]);

    // Handle showModal/close for native dialog
    useEffect(() => {
        const dialog = dialogRef.current;
        if (dialog) {
            if (isOpen) {
                if (!dialog.open) {
                    dialog.showModal();
                }
            } else {
                if (dialog.open) {
                    dialog.close();
                }
            }
        }
    }, [isOpen]);

    // Handle native close events (e.g. Esc key)
    useEffect(() => {
        const dialog = dialogRef.current;
        if (dialog) {
            const handleCancel = (e) => {
                // Esc key was pressed - call onCancel
                e.preventDefault(); // Prevent native close, let React state control it
                onCancel();
            };

            dialog.addEventListener("cancel", handleCancel);

            return () => {
                dialog.removeEventListener("cancel", handleCancel);
            };
        }
    }, [onCancel]);


    const isConfirmDisabled = verificationExpected && verificationInput !== verificationExpected;

    // A <dialog>-ot mindig rendereljük — a native showModal()/close() kezeli a láthatóságot.
    // Conditional rendering (null) mellett elveszne a ref, és nem tudnánk showModal-t hívni.
    return (
            <dialog
                ref={dialogRef}
                style={{
                    background: "transparent",
                    border: "none",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center"
                }}
                onClick={(e) => {
                    if (e.target === dialogRef.current && !isAlert) {
                        onCancel();
                    }
                }}
            >
                <sp-dialog
                    size="s"
                    dismissable={!isAlert ? true : undefined}
                    style={{
                        borderRadius: "4px",
                        width: "300px",
                        display: "flex",
                        flexDirection: "column",
                        padding: "0"
                    }}
                >
                    <div
                        slot="heading"
                    >
                        <sp-heading>{title}</sp-heading>
                    </div>

                    <sp-body>
                        {message}

                        {verificationExpected && (
                            <div style={{
                                display: "flex",
                                flexDirection: "column",
                                marginTop: "16px"
                            }}>
                                <sp-details style={{ fontSize: "12px" }}>
                                    A megerősítéshez írd be:
                                </sp-details>
                                <sp-textfield
                                    value={verificationInput}
                                    onInput={(e) => setVerificationInput(e.target.value)}
                                    placeholder={verificationExpected}
                                    style={{
                                        width: "100%",
                                        marginTop: "8px"
                                    }}
                                />
                            </div>
                        )}
                    </sp-body>

                    <sp-footer
                        slot="footer"
                        style={{ paddingTop: "24px" }}
                        alignItems="right">
                        {!isAlert && (
                            <sp-button variant="secondary" onClick={onCancel}>
                                Mégsem
                            </sp-button>
                        )}
                        <sp-button
                            style={{ marginLeft: "8px" }}
                            variant={isAlert ? "accent" : "negative"}
                            onClick={onConfirm}
                            disabled={isConfirmDisabled ? true : undefined}
                        >
                            {confirmLabel || (isAlert ? "OK" : "Törlés")}
                        </sp-button>
                    </sp-footer>
                </sp-dialog>
            </dialog>
    );
};
