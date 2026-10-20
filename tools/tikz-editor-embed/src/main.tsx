// Entry point of the embedded TikZ editor (see ../README.md).
// Same boot sequence as apps/web/src/main.tsx, plus the host bridge.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { setActiveEditorPlatform } from "@tikz-editor/app/platform/current";
import { createBrowserPlatformAdapter } from "../../web/src/platform/browser-platform";
import { embedStorage, startBridge } from "./bridge";

async function bootstrap() {
  setActiveEditorPlatform(createBrowserPlatformAdapter({ storage: embedStorage() }));
  const { App } = await import("@tikz-editor/app");
  const root = document.getElementById("root");
  if (!root) throw new Error("Missing app root element");
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>
  );
  await startBridge();
}

void bootstrap();
