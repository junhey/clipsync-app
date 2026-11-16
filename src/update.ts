export interface UpdateStatus {
  phase: "checking" | "ready" | "error";
  available: boolean;
  version: string;
  notes: string;
  url: string;
  canInstall: boolean;
  message: string;
}

export interface UpdatePresentation {
  show: boolean;
  title: string;
  action: "install" | "download" | "none";
}

/** What the menu bar and settings should do with a check result. */
export function presentUpdate(status: UpdateStatus): UpdatePresentation {
  if (status.phase !== "ready" || !status.available || !status.version) {
    return { show: false, title: "", action: "none" };
  }
  return {
    show: true,
    title: `v${status.version.replace(/^v/, "")}`,
    action: status.canInstall ? "install" : "download",
  };
}
