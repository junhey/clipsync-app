import { describe, expect, it } from "vitest";
import { presentUpdate, type UpdateStatus } from "./update";

function status(partial: Partial<UpdateStatus>): UpdateStatus {
  return {
    phase: "ready",
    available: false,
    version: "",
    notes: "",
    url: "",
    canInstall: false,
    message: "",
    ...partial,
  };
}

describe("presentUpdate", () => {
  it("hides the notice when nothing newer is published", () => {
    expect(presentUpdate(status({ available: false }))).toEqual({
      show: false,
      title: "",
      action: "none",
    });
  });

  it("offers a signed install on macOS and Windows", () => {
    expect(
      presentUpdate(
        status({
          available: true,
          canInstall: true,
          version: "0.15.0",
          notes: "一键更新",
        })
      )
    ).toEqual({
      show: true,
      title: "v0.15.0",
      action: "install",
    });
  });

  it("opens the download page on Linux", () => {
    expect(
      presentUpdate(
        status({
          available: true,
          canInstall: false,
          version: "0.15.0",
          url: "https://github.com/junhey/clipsync-app/releases/latest",
        })
      )
    ).toEqual({
      show: true,
      title: "v0.15.0",
      action: "download",
    });
  });

  it("stays hidden while the check is still running", () => {
    expect(presentUpdate(status({ phase: "checking", available: true, canInstall: true }))).toEqual({
      show: false,
      title: "",
      action: "none",
    });
  });
});
