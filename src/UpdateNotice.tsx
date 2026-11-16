import { useEffect, useState } from "react";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { bridge } from "./bridge";
import { presentUpdate, type UpdateStatus } from "./update";

const EMPTY: UpdateStatus = {
  phase: "checking",
  available: false,
  version: "",
  notes: "",
  url: "",
  canInstall: false,
  message: "",
};

let current = EMPTY;
const listeners = new Set<() => void>();

function setUpdateStatus(next: UpdateStatus) {
  current = next;
  listeners.forEach((listener) => listener());
}

function useUpdateStatus(): UpdateStatus {
  const [status, setStatus] = useState(current);
  useEffect(() => {
    const listener = () => setStatus(current);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  return status;
}

function tauriAvailable() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** Starts the release check once, and keeps the menu bar mark in sync. */
export function UpdateWatcher() {
  useEffect(() => {
    if (!tauriAvailable()) {
      setUpdateStatus({ ...EMPTY, phase: "ready" });
      return;
    }
    let dead = false;
    const apply = (status: UpdateStatus) => {
      if (!dead) setUpdateStatus(status);
    };
    bridge.updateStatus().then(apply).catch((err) => {
      apply({ ...EMPTY, phase: "error", message: String(err) });
    });
    const unlisten = bridge.onUpdateStatus(apply);
    return () => {
      dead = true;
      unlisten.then((stop) => stop());
    };
  }, []);
  return null;
}

export function UpdateBar({ onOpen }: { onOpen: () => void }) {
  const view = presentUpdate(useUpdateStatus());
  if (!view.show) return null;
  return (
    <button type="button" className="update-bar" onClick={onOpen}>
      {view.title} 可用 · 查看更新
    </button>
  );
}

export function UpdateSettings({ appVersion }: { appVersion: string }) {
  const status = useUpdateStatus();
  const view = presentUpdate(status);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");

  async function refresh() {
    if (!tauriAvailable()) return;
    setProgress("");
    setUpdateStatus({ ...status, phase: "checking", available: false, message: "" });
    try {
      setUpdateStatus(await bridge.refreshUpdate());
    } catch (err) {
      setUpdateStatus({ ...EMPTY, phase: "error", message: String(err) });
    }
  }

  async function install() {
    setBusy(true);
    setProgress("正在下载…");
    try {
      const update = await check();
      if (!update) {
        setProgress("安装包还没准备好，请稍后再试");
        return;
      }
      await update.downloadAndInstall((event) => {
        if (event.event === "Finished") setProgress("正在安装…");
      });
      setProgress("正在重启…");
      await relaunch();
    } catch (err) {
      setProgress(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function openDownload() {
    setBusy(true);
    setProgress("");
    try {
      await bridge.openUpdatePage(
        status.url || "https://github.com/junhey/clipsync-app/releases/latest"
      );
    } catch (err) {
      setProgress(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="update-panel">
      <div className="fg-divider" />
      <span className="fg-label fg-section">更新</span>
      <div className="update-body">
        {status.phase === "checking" && <p>正在检查更新…</p>}
        {status.phase === "error" && <p>{status.message || "检查更新失败"}</p>}
        {status.phase === "ready" && !view.show && (
          <p>{appVersion ? `v${appVersion} 已是最新版本` : "已是最新版本"}</p>
        )}
        {view.show && (
          <>
            <p>
              {view.title} 可用
              {appVersion ? `，当前是 v${appVersion}` : ""}
            </p>
            {status.notes && <pre className="update-notes">{status.notes}</pre>}
          </>
        )}
        {progress && <p className="update-progress">{progress}</p>}
        <div className="btn-row">
          {view.action === "install" && (
            <button type="button" onClick={install} disabled={busy}>
              {busy ? "更新中…" : "立即更新"}
            </button>
          )}
          {view.action === "download" && (
            <button type="button" onClick={openDownload} disabled={busy}>
              前往下载
            </button>
          )}
          <button type="button" onClick={refresh} disabled={busy || status.phase === "checking"}>
            检查更新
          </button>
        </div>
      </div>
    </div>
  );
}
