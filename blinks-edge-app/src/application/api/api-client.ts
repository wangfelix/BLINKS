import { appConfig } from "@/application/config/app-config";
import { ApiError } from "@/application/api/api-error";
import { sessionHolder } from "@/authentication/storage/session-holder";

interface RequestOptions {
  method: "GET" | "POST" | "DELETE";
  body?: unknown;
  // The login request must not trigger the global sign-out-on-401 handling.
  skipUnauthorizedHandling?: boolean;
}

const request = async <TResponse>(
  path: string,
  options: RequestOptions,
): Promise<TResponse> => {
  const token = sessionHolder.getToken();
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (options.body !== undefined) headers["Content-Type"] = "application/json";

  let response: Response;
  try {
    response = await fetch(`${appConfig.serverUrl}${path}`, {
      method: options.method,
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
  } catch {
    throw new ApiError(
      0,
      "Server not reachable. Check that the KIT VPN is connected.",
    );
  }

  if (!response.ok) {
    if (response.status === 401 && !options.skipUnauthorizedHandling) {
      sessionHolder.notifyUnauthorized();
    }
    let message = `Request failed (${response.status})`;
    try {
      const payload = (await response.json()) as { error?: string };
      if (payload.error) message = payload.error;
    } catch {
      // non-JSON error body, keep the generic message
    }
    throw new ApiError(response.status, message);
  }

  return (await response.json()) as TResponse;
};

export const apiClient = {
  get: <TResponse>(path: string) =>
    request<TResponse>(path, { method: "GET" }),
  post: <TResponse>(
    path: string,
    body?: unknown,
    options?: Pick<RequestOptions, "skipUnauthorizedHandling">,
  ) => request<TResponse>(path, { method: "POST", body, ...options }),
  delete: <TResponse>(path: string) =>
    request<TResponse>(path, { method: "DELETE" }),
};
