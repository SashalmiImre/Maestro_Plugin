import React, { useState, useEffect } from "react";
// Contexts
import { useUser } from "../../../../core/contexts/UserContext.jsx";

export const Login = ({ onSwitchToRegister }) => {
    const { login, logout } = useUser();
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [message, setMessage] = useState("");
    const [isLoading, setIsLoading] = useState(false);

    useEffect(() => {
        if (message) {
            const t = setTimeout(() => setMessage(""), 5000);
            return () => clearTimeout(t);
        }
    }, [message]);

    const handleLogin = async (e) => {
        if (e) e.preventDefault();

        if (!email || !password) {
            setMessage("Mindkét mező kitöltése kötelező!");
            return;
        }

        setIsLoading(true);
        try {
            const currentUser = await login(email, password);

            // Email verificáció ellenőrzés — ha nincs megerősítve, nem engedjük be
            if (currentUser && !currentUser.emailVerification) {
                await logout();
                setMessage("Az email cím nincs megerősítve. Ellenőrizd az email fiókodat!");
                return;
            }
        } catch (err) {
            console.error("Login error:", err);
            setMessage(err?.message ?? "Bejelentkezési hiba");
        } finally {
            setIsLoading(false);
        }
    };

    const handleKeyDown = (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            if (isLoading) return;
            handleLogin();
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
                <sp-detail>Jelentkezz be a folytatáshoz</sp-detail>

                {message && (
                    <div style={{
                        width: "100%",
                        padding: "8px 12px",
                        backgroundColor: "var(--spectrum-global-color-static-red-600)",
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
                    <sp-field-label for="login-email">Email</sp-field-label>
                    <sp-textfield
                        id="login-email"
                        type="email"
                        placeholder="pelda@email.com"
                        value={email}
                        onInput={(e) => setEmail(e.target.value)}
                        onKeyDown={handleKeyDown}
                        style={{ width: "100%" }}
                    ></sp-textfield>
                </div>

                <div style={{ width: "100%", marginBottom: "24px" }}>
                    <sp-field-label for="login-password">Jelszó</sp-field-label>
                    <sp-textfield
                        id="login-password"
                        type="password"
                        placeholder="••••••••"
                        value={password}
                        onInput={(e) => setPassword(e.target.value)}
                        onKeyDown={handleKeyDown}
                        style={{ width: "100%" }}
                    ></sp-textfield>
                </div>

                <sp-button
                    variant="cta"
                    onClick={handleLogin}
                    disabled={isLoading ? true : undefined}
                >
                    {isLoading ? "Bejelentkezés..." : "Bejelentkezés"}
                </sp-button>

                <div style={{
                    marginTop: "16px",
                    fontSize: "12px",
                    color: "var(--spectrum-global-color-gray-600)"
                }}>
                    <span>Nincs még fiókod? </span>
                    <span
                        onClick={onSwitchToRegister}
                        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSwitchToRegister(); } }}
                        tabIndex={0}
                        role="button"
                        aria-label="Regisztrálj"
                        style={{
                            color: "var(--spectrum-global-color-blue-400)",
                            cursor: "pointer",
                            textDecoration: "underline"
                        }}
                    >
                        Regisztrálj
                    </span>
                </div>
            </div>
        </div>
    );
};
