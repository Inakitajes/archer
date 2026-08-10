import { readFile, writeFile } from "node:fs/promises"

const tokenUrl = "https://auth.openai.com/oauth/token"
const codexClientId = "app_EMoamEEZ73f0CkXaXp7hrann"
const refreshMarginMs = 5 * 60_000
const fetchTimeoutMs = 10_000

export type CodexAuth = {
  tokens?: { access_token?: string; refresh_token?: string; id_token?: string; account_id?: string }
  last_refresh?: string
}

/** Expiry of a JWT access token in epoch ms, or null when undecodable. */
function jwtExpMs(token: string): number | null {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString())
    return typeof payload.exp === "number" ? payload.exp * 1000 : null
  } catch {
    return null
  }
}

/**
 * Refreshes an expiring Codex token and persists a rotation only if another
 * process has not already replaced the refresh token on disk.
 */
export async function refreshCodexIfNeeded(
  auth: CodexAuth,
  authPath: string,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<{ token: string; authError?: string }> {
  const token = auth.tokens!.access_token!
  const refreshToken = auth.tokens?.refresh_token
  const expMs = jwtExpMs(token)
  if (!refreshToken || expMs === null || expMs > Date.now() + refreshMarginMs) return { token }

  let res: Response
  try {
    res = await fetcher(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: codexClientId,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        scope: "openid profile email",
      }),
      signal: AbortSignal.timeout(fetchTimeoutMs),
    })
  } catch {
    return { token }
  }
  if (res.status === 400 || res.status === 401) return { token, authError: "codex login" }
  if (!res.ok) return { token }

  try {
    const fresh = (await res.json()) as { access_token?: string; refresh_token?: string; id_token?: string }
    if (!fresh.access_token) return { token }
    const current = JSON.parse(await readFile(authPath, "utf8")) as CodexAuth
    if (current.tokens?.refresh_token === refreshToken) {
      current.tokens.access_token = fresh.access_token
      if (fresh.refresh_token) current.tokens.refresh_token = fresh.refresh_token
      if (fresh.id_token) current.tokens.id_token = fresh.id_token
      current.last_refresh = new Date().toISOString()
      await writeFile(authPath, JSON.stringify(current, null, 2))
    }
    return { token: fresh.access_token }
  } catch {
    return { token }
  }
}
