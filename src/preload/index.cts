import { contextBridge, ipcRenderer } from "electron";
import type { AppState, Command, DesktopAPI, Reply } from "../shared/contracts.js";
const api: DesktopAPI = {
  request: (command: Command): Promise<Reply> => ipcRenderer.invoke("lcodex:request", command),
  subscribe: listener => {
    const callback = (_event: unknown, state: AppState) => listener(state);
    ipcRenderer.on("lcodex:state", callback);
    return () => ipcRenderer.removeListener("lcodex:state", callback);
  },
};
contextBridge.exposeInMainWorld("lcodex", api);
