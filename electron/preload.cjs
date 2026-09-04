const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktop", {
  isElectron: true,
  selectDatasetDirectory: () =>
    ipcRenderer.invoke("desktop:select-dataset-directory"),
});
