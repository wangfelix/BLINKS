// Module-level holder for the active session credentials so that non-React
// code (the API client and the WebSocket frame uploader) can read the token
// without going through React context. The AuthProvider is the only writer.
interface SessionHolderState {
  token: string | null;
  username: string | null;
  onUnauthorized: (() => void) | null;
}

const state: SessionHolderState = {
  token: null,
  username: null,
  onUnauthorized: null,
};

export const sessionHolder = {
  getToken: () => state.token,
  getUsername: () => state.username,
  setSession: (token: string | null, username: string | null) => {
    state.token = token;
    state.username = username;
  },
  setOnUnauthorized: (handler: (() => void) | null) => {
    state.onUnauthorized = handler;
  },
  // Called by the API client on a 401: the token was revoked or is invalid,
  // so the AuthProvider signs the participant out.
  notifyUnauthorized: () => {
    state.onUnauthorized?.();
  },
};
