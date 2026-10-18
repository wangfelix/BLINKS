// In-memory SecureStore for Node test scripts (see scripts/tsconfig.node.json).
export const memory = new Map<string, string>();
export const getItemAsync = async (key: string) => memory.get(key) ?? null;
export const setItemAsync = async (key: string, value: string) => {
  if (!/^[\w.-]+$/.test(key)) throw new Error(`invalid SecureStore key ${key}`);
  memory.set(key, value);
};
export const deleteItemAsync = async (key: string) => {
  memory.delete(key);
};
