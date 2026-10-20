// Host bridge for the embedded TikZ editor.
//
// The editor runs in an <iframe> on the same origin as its host page. The two
// talk over window.postMessage; every message carries `ns: "tikz-editor-embed"`.
//
//   editor → host  { type: "ready", version }
//   host → editor  { type: "load", id, source, title?, colorScheme? }
//   editor → host  { type: "loaded", id }
//   editor → host  { type: "change", source, dirty }   (debounced while editing)
//   host → editor  { type: "get", id }
//   editor → host  { type: "source", id, source, dirty }
//
// Messages are only accepted from the parent window on the same origin.
import { useEditorStore } from "@tikz-editor/app/store/store";
import { useSettingsStore } from "@tikz-editor/app/settings/useSettingsStore";
import type { StorageLike } from "@tikz-editor/app/platform/storage";

export const NS = "tikz-editor-embed";
const CHANGE_DEBOUNCE_MS = 150;

// The host hands the editor one figure at a time, so the editor's own
// workspace (open tabs, their sources) must not survive a reload: those keys
// live in memory. Settings and panel layout persist in localStorage as usual.
const SESSION_ONLY_KEYS = new Set(["tikz-editor:workspace", "tikz-editor:user-workspaces"]);

export function embedStorage(): StorageLike {
  const memory = new Map<string, string>();
  let persistent: Storage | null = null;
  try {
    persistent = window.localStorage;
  } catch {
    persistent = null;
  }
  return {
    getItem(key) {
      if (SESSION_ONLY_KEYS.has(key) || !persistent) return memory.get(key) ?? null;
      try {
        return persistent.getItem(key);
      } catch {
        return memory.get(key) ?? null;
      }
    },
    setItem(key, value) {
      if (SESSION_ONLY_KEYS.has(key) || !persistent) {
        memory.set(key, value);
        return;
      }
      try {
        persistent.setItem(key, value);
      } catch {
        memory.set(key, value);
      }
    }
  };
}

type HostMessage =
  | { ns: typeof NS; type: "load"; id?: string; source: string; title?: string; colorScheme?: string }
  | { ns: typeof NS; type: "get"; id?: string };

function isHostMessage(data: unknown): data is HostMessage {
  if (typeof data !== "object" || data === null) return false;
  const record = data as Record<string, unknown>;
  if (record.ns !== NS) return false;
  if (record.type === "load") return typeof record.source === "string";
  return record.type === "get";
}

function post(message: Record<string, unknown>): void {
  window.parent.postMessage({ ns: NS, ...message }, window.location.origin);
}

/** Replace every open tab with one document holding `source`. */
function loadSource(source: string, title: string): void {
  const store = useEditorStore.getState();
  const previous = Object.keys(store.documents);
  store.dispatch({ type: "NEW_DOCUMENT", source, title });
  for (const id of previous) {
    useEditorStore.getState().dispatch({ type: "CLOSE_DOCUMENT", documentId: id });
  }
}

export async function startBridge(): Promise<void> {
  if (window.parent === window) return; // opened directly, not embedded
  let loadedSource: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const current = () => useEditorStore.getState().source;
  const dirty = () => loadedSource != null && current() !== loadedSource;

  useEditorStore.subscribe((state, previous) => {
    if (loadedSource == null || state.source === previous.source) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      post({ type: "change", source: current(), dirty: dirty() });
    }, CHANGE_DEBOUNCE_MS);
  });

  window.addEventListener("message", (event: MessageEvent) => {
    if (event.source !== window.parent || event.origin !== window.location.origin) return;
    const data: unknown = event.data;
    if (!isHostMessage(data)) return;
    if (data.type === "load") {
      const scheme = data.colorScheme;
      if (scheme === "light" || scheme === "dark" || scheme === "system") {
        if (useSettingsStore.getState().settings.general.colorScheme !== scheme) {
          useSettingsStore.getState().updateGeneralSettings({ colorScheme: scheme });
        }
      }
      loadSource(data.source, data.title ?? "Figure");
      loadedSource = current();
      post({ type: "loaded", id: data.id ?? null });
      return;
    }
    post({ type: "source", id: data.id ?? null, source: current(), dirty: dirty() });
  });

  post({ type: "ready", version: import.meta.env.TIKZ_EDITOR_VERSION });
}
