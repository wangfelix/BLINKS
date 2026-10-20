// In-memory expo-file-system (File/Paths subset) for Node test scripts.
export const files = new Map<string, string>();
export const Paths = { document: "document://", cache: "cache://" };
export class File {
  readonly uri: string;
  constructor(directory: string, name: string) {
    this.uri = `${directory}${name}`;
  }
  get exists() {
    return files.has(this.uri);
  }
  async text() {
    const value = files.get(this.uri);
    if (value === undefined) throw new Error("not found");
    return value;
  }
  write(content: string) {
    files.set(this.uri, content);
  }
  delete() {
    files.delete(this.uri);
  }
}
