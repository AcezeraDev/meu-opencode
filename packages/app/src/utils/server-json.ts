import { usePlatform } from "@/context/platform"
import { useServer } from "@/context/server"
import { authTokenFromCredentials } from "@/utils/server"

/**
 * Reads one of the server's JSON routes that the generated client does not
 * cover yet, with the server's password. Undefined when there is no server or
 * the route fails, so a page can show its empty state instead of an error.
 * A `body` is sent as JSON.
 */
export function useServerJson() {
  const server = useServer()
  const platform = usePlatform()
  return async <T>(
    path: string,
    params: Record<string, string> = {},
    method = "GET",
    body?: unknown,
  ): Promise<T | undefined> => {
    const connection = server.current
    if (!connection) return undefined
    const url = new URL(path, connection.http.url)
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
    const headers: Record<string, string> = {
      ...(connection.http.password
        ? {
            Authorization: `Basic ${authTokenFromCredentials({
              username: connection.http.username,
              password: connection.http.password,
            })}`,
          }
        : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    }
    const response = await (platform.fetch ?? fetch)(url, {
      headers,
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
    }).catch(() => undefined)
    if (!response?.ok) return undefined
    return (await response.json().catch(() => undefined)) as T | undefined
  }
}
