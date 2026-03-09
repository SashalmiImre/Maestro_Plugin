# Maestro Proxy Server

A proxy server for handling Realtime connections and Appwrite API requests, with optional AI-powered text clustering.

## Environment Variables

The proxy server requires the following environment variables for deployment:

### Required
- **`APPWRITE_PROJECT_ID`** — Appwrite Cloud project ID (used for email verification and password reset endpoints)
- **`APPWRITE_API_KEY`** — Appwrite Cloud Server API key (with permissions for user management; keep this secret)

### Optional
- **`GROQ_API_KEY`** — Groq API key for AI-powered article clustering endpoint. If not set, the `/api/cluster-article` endpoint returns 501 (Not Implemented). The plugin gracefully falls back to local clustering when this is unavailable. This key should **never** be exposed to the browser or UXP client.
- **`PORT`** — HTTP server port (default: 3000)
- **`VERIFICATION_URL`** — Email verification callback URL (default: `https://gallant-balance-production-b513.up.railway.app/verify`)
- **`RECOVERY_URL`** — Password reset callback URL (default: `https://gallant-balance-production-b513.up.railway.app/reset-password`)

## Security Notes

- **API Keys are server-side only**: All credentials (`APPWRITE_API_KEY`, `GROQ_API_KEY`) must be set as environment variables. Never commit them to the repository.
- **Groq SDK safety**: The Groq SDK is initialized server-side without `dangerouslyAllowBrowser` flag enabled. This prevents client-side key exposure.
- **CORS configuration**: The proxy accepts requests from UXP plugins with proper authentication injection.

## Usage

```bash
# Install dependencies
npm install

# Start the server (ensure all required environment variables are set)
npm start
```
