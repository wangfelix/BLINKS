import * as SecureStore from "expo-secure-store";

const TOKEN_KEY = "blinks.auth-token";
const USERNAME_KEY = "blinks.username";

export interface StoredSession {
  token: string;
  username: string;
}

export const loadStoredSession = async (): Promise<StoredSession | null> => {
  const [token, username] = await Promise.all([
    SecureStore.getItemAsync(TOKEN_KEY),
    SecureStore.getItemAsync(USERNAME_KEY),
  ]);
  if (!token || !username) return null;
  return { token, username };
};

export const storeSession = async (session: StoredSession): Promise<void> => {
  await Promise.all([
    SecureStore.setItemAsync(TOKEN_KEY, session.token),
    SecureStore.setItemAsync(USERNAME_KEY, session.username),
  ]);
};

export const clearStoredSession = async (): Promise<void> => {
  await Promise.all([
    SecureStore.deleteItemAsync(TOKEN_KEY),
    SecureStore.deleteItemAsync(USERNAME_KEY),
  ]);
};
