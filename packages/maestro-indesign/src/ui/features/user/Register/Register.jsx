import React, { useState, useEffect } from "react";

// Contexts
import { useUser } from "../../../../core/contexts/UserContext.jsx";

/** Jelszó minimális hossza (Appwrite követelmény). */
const MIN_PASSWORD_LENGTH = 8;

export const Register = ({ onSwitchToLogin }) => {
    const { register } = useUser();
    const [name, setName] = useState("");
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [confirmPassword, setConfirmPassword] = useState("");
    const [message, setMessage] = useState("");
    const [isSuccess, setIsSuccess] = useState(false);
    const [isLoading, setIsLoading] = useState(false);

    // Hibaüzenet automatikus eltüntetése
    useEffect(() => {
        if (message && !isSuccess) {
            const t = setTimeout(() => setMessage(""), 5000);
            return () => clearTimeout(t);
        }
    }, [message, isSuccess]);

    // Sikeres regisztráció után automatikus átváltás a Login nézetre
    useEffect(() => {
        if (isSuccess) {
            const t = setTimeout(() => onSwitchToLogin(), 3000);
            return () => clearTimeout(t);
        }
    }, [isSuccess, onSwitchToLogin]);

    const handleRegister = async (e) => {
        if (e) e.preventDefault();

        if (!name || !email || !password || !confirmPassword) {
            setMessage("Minden mező kitöltése kötelező!");
            return;
        }

        if (password.length < MIN_PASSWORD_LENGTH) {
            setMessage(`A jelszónak legalább ${MIN_PASSWORD_LENGTH} karakter hosszúnak kell lennie!`);
            return;
        }

        if (password !== confirmPassword) {
            setMessage("A megadott jelszavak nem egyeznek!");
            return;
        }

        setIsLoading(true);
        setIsSuccess(false);
        try {
            await register(name, email, password);
            setIsSuccess(true);
            setMessage("Ellenőrizd az email fiókodat a regisztráció megerősítéséhez!");
        } catch (err) {
            console.error("Regisztráció sikertelen:", err);
            setMessage(err?.message ?? "Regisztrációs hiba");
        } finally {
            setIsLoading(false);
        }
    };

    const handleKeyDown = (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            if (isLoading) return;
            handleRegister();
        }
    };

    return (
        <div style={{
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
            alignItems: "center",
            height: "100vh",
            width: "100%",
            boxSizing: "border-box",
            padding: "20px"
        }}>
            <div style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                width: "100%",
                maxWidth: "320px"
            }}>
                <sp-heading size="XL">Maestro</sp-heading>
                <sp-detail>Új fiók létrehozása</sp-detail>

                {message && (
                    <div style={{
                        width: "100%",
                        padding: "8px 12px",
                        backgroundColor: isSuccess
                            ? "var(--spectrum-global-color-static-green-600)"
                            : "var(--spectrum-global-color-static-red-600)",
                        color: "white",
                        borderRadius: "4px",
                        fontSize: "12px",
                        marginBottom: "16px",
                        textAlign: "center",
                        boxSizing: "border-box"
                    }}>
                        {message}
                    </div>
                )}

                <div style={{ width: "100%", marginBottom: "16px" }}>
                    <sp-field-label for="register-name">Név</sp-field-label>
                    <sp-textfield
                        id="register-name"
                        placeholder="Teljes név"
                        value={name}
                        onInput={(e) => setName(e.target.value)}
                        onKeyDown={handleKeyDown}
                        style={{ width: "100%" }}
                    ></sp-textfield>
                </div>

                <div style={{ width: "100%", marginBottom: "16px" }}>
                    <sp-field-label for="register-email">Email</sp-field-label>
                    <sp-textfield
                        id="register-email"
                        type="email"
                        placeholder="pelda@email.com"
                        value={email}
                        onInput={(e) => setEmail(e.target.value)}
                        onKeyDown={handleKeyDown}
                        style={{ width: "100%" }}
                    ></sp-textfield>
                </div>

                <div style={{ width: "100%", marginBottom: "16px" }}>
                    <sp-field-label for="register-password">Jelszó</sp-field-label>
                    <sp-textfield
                        id="register-password"
                        type="password"
                        placeholder="••••••••"
                        value={password}
                        onInput={(e) => setPassword(e.target.value)}
                        onKeyDown={handleKeyDown}
                        style={{ width: "100%" }}
                    ></sp-textfield>
                </div>

                <div style={{ width: "100%", marginBottom: "24px" }}>
                    <sp-field-label for="register-confirm-password">Jelszó megerősítés</sp-field-label>
                    <sp-textfield
                        id="register-confirm-password"
                        type="password"
                        placeholder="••••••••"
                        value={confirmPassword}
                        onInput={(e) => setConfirmPassword(e.target.value)}
                        onKeyDown={handleKeyDown}
                        style={{ width: "100%" }}
                    ></sp-textfield>
                </div>

                <sp-button
                    variant="cta"
                    onClick={handleRegister}
                    disabled={isLoading ? true : undefined}
                >
                    {isLoading ? "Regisztráció..." : "Regisztráció"}
                </sp-button>

                <div style={{
                    marginTop: "16px",
                    fontSize: "12px",
                    color: "var(--spectrum-global-color-gray-600)"
                }}>
                    <span>Már van fiókod? </span>
                    <span
                        onClick={onSwitchToLogin}
                        style={{
                            color: "var(--spectrum-global-color-blue-400)",
                            cursor: "pointer",
                            textDecoration: "underline"
                        }}
                    >
                        Jelentkezz be
                    </span>
                </div>
            </div>
        </div>
    );
};
