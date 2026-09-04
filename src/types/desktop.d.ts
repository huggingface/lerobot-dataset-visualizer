export {};

declare global {
  interface Window {
    desktop?: {
      isElectron: boolean;
      selectDatasetDirectory: () => Promise<string | null>;
    };
  }
}
