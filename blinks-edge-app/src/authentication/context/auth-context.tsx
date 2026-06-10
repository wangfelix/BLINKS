import { useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

import { login as loginRequest } from "@/authentication/api/auth-api";
import { sessionHolder } from "@/authentication/storage/session-holder";
import {
  clearStoredSession,
  loadStoredSession,
  storeSession,
} from "@/authentication/storage/token-storage";

type AuthStatus = "restoring" | "signedOut" | "signedIn";

interface AuthContextValue {
  status: AuthStatus;
  username: string | null;
  signIn: (username: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export const AuthProvider = ({ children }: { children: ReactNode }) => {
  const [status, setStatus] = useState<AuthStatus>("restoring");
  const [username, setUsername] = useState<string | null>(null);
  const queryClient = useQueryClient();

  useEffect(() => {
    loadStoredSession()
      .then((stored) => {
        if (stored) {
          sessionHolder.setSession(stored.token, stored.username);
          setUsername(stored.username);
          setStatus("signedIn");
        } else {
          setStatus("signedOut");
        }
      })
      .catch(() => setStatus("signedOut"));
  }, []);

  const signOut = useCallback(async () => {
    sessionHolder.setSession(null, null);
    setUsername(null);
    setStatus("signedOut");
    queryClient.clear();
    await clearStoredSession().catch(() => {});
  }, [queryClient]);

  // A 401 from any endpoint means the token is no longer valid: sign out so
  // the participant lands back on the login screen instead of seeing errors.
  useEffect(() => {
    sessionHolder.setOnUnauthorized(() => {
      void signOut();
    });
    return () => sessionHolder.setOnUnauthorized(null);
  }, [signOut]);

  const signIn = useCallback(async (name: string, password: string) => {
    const response = await loginRequest(name, password);
    sessionHolder.setSession(response.token, response.username);
    await storeSession({ token: response.token, username: response.username });
    setUsername(response.username);
    setStatus("signedIn");
  }, []);

  const value = useMemo(
    () => ({ status, username, signIn, signOut }),
    [status, username, signIn, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export const useAuth = (): AuthContextValue => {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used inside AuthProvider");
  return context;
};
