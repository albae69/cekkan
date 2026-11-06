import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type SetStateAction } from "react";
import { invoke } from "@tauri-apps/api/core";
import { fetch } from "@tauri-apps/plugin-http";
import { open, save } from "@tauri-apps/plugin-dialog";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import logo from "./assets/logo.png";
import {
  addNode,
  blankTab,
  buildUrl,
  countRequests,
  curlOf,
  docOf,
  findNode,
  guessMime,
  importHttpie,
  importPostman,
  kv,
  load,
  parseEnv,
  rawMime,
  removeNode,
  requestHeaders,
  subst,
  tabOf,
  uid,
  updateNode,
  urlencodedBody,
  type Auth,
  type BodyMode,
  type HistoryItem,
  type KV,
  type Node,
  type Profile,
  type RawType,
  type Tab,
} from "./model";
import "./App.css";

type Session = { tabs: Tab[]; activeId: string };
type EnvState = { profiles: Profile[]; activeId: string };
type Ask = { title: string; value?: string; okLabel?: string; dangerous?: boolean; onOk: (value: string) => void };

const initialSession = load<Session | null>("cekkan.session", null);
const DEFAULT_COLLECTION = "My Collection";

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

async function readFileBytes(path: string): Promise<ArrayBuffer> {
  const bytes = await invoke<number[]>("read_bytes", { path });
  return new Uint8Array(bytes).buffer;
}

export default function App() {
  const [tabs, setTabs] = useState<Tab[]>(initialSession?.tabs?.length ? initialSession.tabs : [blankTab()]);
  const [activeId, setActiveId] = useState(initialSession?.activeId ?? "");
  const [collections, setCollections] = useState<Node[]>(() => load("cekkan.collections", []));
  const [history, setHistory] = useState<HistoryItem[]>(() => load("cekkan.history", []));
  const [envState, setEnvState] = useState<EnvState>(() => {
    const s = load<EnvState | null>("cekkan.envs", null);
    if (s?.profiles?.length) return s;
    return {
      profiles: [{ id: uid(), name: "default", text: load("cekkan.env", "base_url=https://httpbin.org\n# token=abc123") }],
      activeId: "",
    };
  });

  const [reqTab, setReqTab] = useState<"params" | "headers" | "body" | "auth">("params");
  const [respTab, setRespTab] = useState<"body" | "headers">("body");
  const [pretty, setPretty] = useState(true);
  const [raw, setRaw] = useState("");
  const [respHeaders, setRespHeaders] = useState<[string, string][]>([]);
  const [status, setStatus] = useState<{ code: number; text: string; ms: number; size: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [filter, setFilter] = useState("");
  const [foldersOpen, setFoldersOpen] = useState<Set<string>>(new Set());
  const [ask, setAsk] = useState<Ask | null>(null);
  const [saveModal, setSaveModal] = useState<{ name: string; collectionId: string; asNew: boolean } | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const saveRef = useRef<() => void>(() => {});

  const active = tabs.find((t) => t.id === activeId) ?? tabs[0];
  const profile = envState.profiles.find((p) => p.id === envState.activeId) ?? envState.profiles[0];
  const vars = useMemo(() => parseEnv(profile?.text ?? ""), [profile]);
  const sub = useCallback((s: string) => subst(s, vars), [vars]);
  const fullUrl = useMemo(() => buildUrl(active, sub), [active, sub]);

  useEffect(() => {
    localStorage.setItem("cekkan.session", JSON.stringify({ tabs, activeId: active.id } satisfies Session));
  }, [tabs, active.id]);

  useEffect(() => {
    localStorage.setItem("cekkan.collections", JSON.stringify(collections));
  }, [collections]);

  useEffect(() => {
    localStorage.setItem("cekkan.history", JSON.stringify(history));
  }, [history]);

  useEffect(() => {
    localStorage.setItem("cekkan.envs", JSON.stringify(envState));
  }, [envState]);

  const patch = (p: Partial<Tab>) =>
    setTabs((ts) => ts.map((t) => (t.id === active.id ? { ...t, ...p, dirty: true } : t)));
  const setAuth = (p: Partial<Auth>) => patch({ auth: { ...active.auth, ...p } });

  /* ── send ── */

  async function send() {
    const doc = docOf(active);
    const url = buildUrl(doc, sub);
    if (!/^https?:\/\//i.test(url)) {
      setError("URL harus diawali http:// atau https:// (cek env base_url)");
      return;
    }

    let payload: BodyInit | undefined;
    let contentType: string | undefined;

    if (doc.bodyMode === "raw" && doc.rawBody.trim()) {
      payload = sub(doc.rawBody);
      contentType = rawMime[doc.rawType];
    } else if (doc.bodyMode === "urlencoded") {
      const body = urlencodedBody(doc, sub);
      if (body) {
        payload = body;
        contentType = "application/x-www-form-urlencoded";
      }
    } else if (doc.bodyMode === "form") {
      const fd = new FormData();
      for (const r of doc.formRows) {
        if (!r.enabled || !r.key.trim()) continue;
        if (r.file) {
          if (!r.value) continue;
          const bytes = await readFileBytes(r.value);
          const filename = r.value.split(/[\\/]/).pop() || "file";
          fd.append(sub(r.key), new File([bytes], filename, { type: guessMime(r.value) }));
        } else {
          fd.append(sub(r.key), sub(r.value));
        }
      }
      payload = fd;
    } else if (doc.bodyMode === "binary" && doc.binaryPath) {
      payload = await readFileBytes(doc.binaryPath);
      contentType = guessMime(doc.binaryPath);
    }

    const headers = requestHeaders(doc, sub, contentType);
    if (payload instanceof FormData) {
      for (const k of Object.keys(headers)) {
        if (k.toLowerCase() === "content-type") delete headers[k];
      }
    }

    const ac = new AbortController();
    abortRef.current = ac;
    let timedOut = false;
    const timer = window.setTimeout(() => {
      timedOut = true;
      ac.abort();
    }, Math.max(1000, doc.timeoutMs));

    setLoading(true);
    setError(null);
    setStatus(null);
    setRaw("");
    setRespHeaders([]);

    const t0 = performance.now();
    try {
      const res = await fetch(url, { method: doc.method, headers, body: payload, signal: ac.signal });
      const text = await res.text();
      const ms = Math.round(performance.now() - t0);

      setRaw(text);
      setRespHeaders([...res.headers.entries()]);
      setStatus({ code: res.status, text: res.statusText, ms, size: new TextEncoder().encode(text).length });
      setRespTab("body");
      setHistory((h) =>
        [
          { id: uid(), at: Date.now(), name: active.name, status: res.status, ms, request: doc },
          ...h,
        ].slice(0, 100),
      );
    } catch (e) {
      setError(timedOut ? `Timeout setelah ${doc.timeoutMs} ms` : e instanceof Error ? e.message : String(e));
    } finally {
      window.clearTimeout(timer);
      setLoading(false);
      abortRef.current = null;
    }
  }

  const sendRef = useRef(send);
  sendRef.current = send;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        void sendRef.current();
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        saveRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /* ── tabs ── */

  function newTab() {
    const t = blankTab();
    setTabs((ts) => [...ts, t]);
    setActiveId(t.id);
  }

  function closeTab(id: string) {
    const idx = tabs.findIndex((t) => t.id === id);
    const next = tabs.filter((t) => t.id !== id);
    if (!next.length) {
      const t = blankTab();
      setTabs([t]);
      setActiveId(t.id);
      return;
    }
    setTabs(next);
    if (active.id === id) setActiveId(next[Math.max(0, Math.min(idx, next.length - 1))].id);
  }

  function openNode(n: Node) {
    if (n.type !== "request") return;
    const existing = tabs.find((t) => t.savedId === n.id);
    if (existing) {
      setActiveId(existing.id);
      return;
    }
    const tab = tabOf(n.request, n.name, n.id);
    setTabs((ts) => [...ts, tab]);
    setActiveId(tab.id);
  }

  function openHistory(h: HistoryItem) {
    const tab = tabOf(h.request, h.name);
    setTabs((ts) => [...ts, tab]);
    setActiveId(tab.id);
  }

  /* ── collections ── */

  function saveRequest(asNew: boolean, name: string, collectionId: string) {
    const doc = docOf(active);
    const savedId = asNew ? null : active.savedId;

    if (savedId && findNode(collections, savedId)) {
      setCollections((cs) => updateNode(cs, savedId, (n) => (n.type === "request" ? { ...n, name, request: doc } : n)));
      setTabs((ts) => ts.map((t) => (t.id === active.id ? { ...t, name, savedId, dirty: false } : t)));
      return;
    }

    const node: Node = { id: uid(), name, type: "request", request: doc };
    if (collectionId && findNode(collections, collectionId)) {
      setCollections((cs) => addNode(cs, collectionId, node));
    } else {
      setCollections((cs) => {
        const found = cs.find((n) => n.type === "folder" && n.name === DEFAULT_COLLECTION);
        if (found) return addNode(cs, found.id, node);
        return [...cs, { id: uid(), name: DEFAULT_COLLECTION, type: "folder", children: [node] }];
      });
    }
    setTabs((ts) => ts.map((t) => (t.id === active.id ? { ...t, name, savedId: node.id, dirty: false } : t)));
  }

  function onSave(asNew: boolean) {
    if (!asNew && active.savedId && findNode(collections, active.savedId)) {
      saveRequest(false, active.name, "");
      return;
    }
    const firstFolder = collections.find((n) => n.type === "folder");
    setSaveModal({
      name: active.name === "Untitled" ? "" : active.name,
      collectionId: firstFolder?.id ?? "",
      asNew,
    });
  }
  saveRef.current = () => onSave(false);

  function renameNode(n: Node) {
    setAsk({
      title: "Nama baru",
      value: n.name,
      onOk: (v) => {
        if (v.trim()) setCollections((cs) => updateNode(cs, n.id, (x) => ({ ...x, name: v.trim() })));
      },
    });
  }

  const idsOf = (n: Node): string[] => (n.type === "request" ? [n.id] : [n.id, ...n.children.flatMap(idsOf)]);

  function deleteNode(n: Node) {
    setAsk({
      title: `Hapus "${n.name}"?`,
      okLabel: "Hapus",
      dangerous: true,
      onOk: () => {
        setCollections((cs) => removeNode(cs, n.id));
        const gone = new Set(idsOf(n));
        setTabs((ts) => ts.map((t) => (t.savedId && gone.has(t.savedId) ? { ...t, savedId: null, dirty: true } : t)));
      },
    });
  }

  function parentOf(nodes: Node[], id: string): string | null {
    for (const n of nodes) {
      if (n.type !== "folder") continue;
      if (n.children.some((c) => c.id === id)) return n.id;
      const hit = parentOf(n.children, id);
      if (hit) return hit;
    }
    return null;
  }

  function duplicateNode(n: Node) {
    if (n.type !== "request") return;
    const copy: Node = {
      id: uid(),
      name: `${n.name} (copy)`,
      type: "request",
      request: JSON.parse(JSON.stringify(n.request)),
    };
    const parent = parentOf(collections, n.id);
    setCollections((cs) => (parent ? addNode(cs, parent, copy) : [...cs, copy]));
  }

  function newCollection() {
    setAsk({
      title: "Nama collection",
      value: "",
      onOk: (v) => {
        if (!v.trim()) return;
        const id = uid();
        setCollections((cs) => [...cs, { id, name: v.trim(), type: "folder", children: [] }]);
        setFoldersOpen((s) => new Set(s).add(id));
      },
    });
  }

  function newFolderIn(parentId: string) {
    setAsk({
      title: "Nama folder",
      value: "",
      onOk: (v) => {
        if (!v.trim()) return;
        const id = uid();
        setCollections((cs) => addNode(cs, parentId, { id, name: v.trim(), type: "folder", children: [] }));
        setFoldersOpen((s) => new Set(s).add(parentId).add(id));
      },
    });
  }

  async function importFile() {
    try {
      const path = await open({ multiple: false, filters: [{ name: "JSON", extensions: ["json"] }] });
      if (typeof path !== "string") return;
      const text = new TextDecoder().decode(await readFileBytes(path));
      const json = JSON.parse(text);
      const imported: Node[] = Array.isArray(json.collections)
        ? json.collections
        : json.meta?.format === "httpie" || Array.isArray(json.entry?.requests)
          ? importHttpie(json)
          : importPostman(json);
      if (countRequests(imported) === 0) {
        throw new Error("Tidak ada request yang bisa diimpor — hanya Postman v2.1, HTTPie, atau export cekkan");
      }
      setCollections((cs) => [...cs, ...imported]);
      setFoldersOpen((s) => {
        const next = new Set(s);
        for (const c of imported) next.add(c.id);
        return next;
      });
    } catch (e) {
      setError(`Import gagal: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function exportFile() {
    try {
      const path = await save({
        defaultPath: "cekkan-collections.json",
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (!path) return;
      await invoke("write_text", {
        path,
        contents: JSON.stringify({ app: "cekkan", version: 1, collections }, null, 2),
      });
    } catch (e) {
      setError(`Export gagal: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /* ── misc ── */

  async function copyCurl() {
    try {
      await writeText(curlOf(docOf(active), sub));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch (e) {
      setError(`Copy gagal: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function pickBinary() {
    const p = await open({ multiple: false });
    if (typeof p === "string") patch({ binaryPath: p });
  }

  function patchProfile(text: string) {
    setEnvState((s) => {
      const id = s.activeId || s.profiles[0]?.id;
      return { ...s, profiles: s.profiles.map((p) => (p.id === id ? { ...p, text } : p)) };
    });
  }

  function addProfile() {
    setAsk({
      title: "Nama env",
      value: "",
      onOk: (v) => {
        if (!v.trim()) return;
        const id = uid();
        setEnvState((s) => ({ profiles: [...s.profiles, { id, name: v.trim(), text: "" }], activeId: id }));
      },
    });
  }

  function deleteProfile() {
    if (envState.profiles.length < 2) return;
    setEnvState((s) => {
      const left = s.profiles.filter((p) => p.id !== (s.activeId || s.profiles[0].id));
      return { profiles: left, activeId: left[0].id };
    });
  }

  const jsonBody = useMemo(() => {
    try {
      return JSON.stringify(JSON.parse(raw), null, 2);
    } catch {
      return null;
    }
  }, [raw]);
  const showBody = pretty ? (jsonBody ?? raw) : raw;

  const q = filter.trim().toLowerCase();
  const filteredHistory = useMemo(() => {
    if (!q) return history;
    return history.filter(
      (h) =>
        h.name.toLowerCase().includes(q) ||
        h.request.url.toLowerCase().includes(q) ||
        h.request.method.toLowerCase().includes(q),
    );
  }, [history, q]);
  const filteredCollections = useMemo(() => filterTree(collections, q), [collections, q]);

  const folderChoices = useMemo(() => folderOptions(collections), [collections]);

  function toggleFolder(id: string) {
    setFoldersOpen((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function renderTree(nodes: Node[], depth = 0): ReactNode {
    return nodes.map((n) => (
      <div key={n.id}>
        {n.type === "folder" ? (
          <div
            className="tree-row folder"
            style={{ paddingLeft: 4 + depth * 12 }}
            onClick={() => toggleFolder(n.id)}
          >
            <span className="tw">{foldersOpen.has(n.id) ? "▾" : "▸"}</span>
            <span className="tree-name">{n.name}</span>
            <span className="tree-actions" onClick={(e) => e.stopPropagation()}>
              <button title="Folder baru" onClick={() => newFolderIn(n.id)}>
                +
              </button>
              <button title="Rename" onClick={() => renameNode(n)}>
                ✎
              </button>
              <button title="Hapus" onClick={() => deleteNode(n)}>
                ×
              </button>
            </span>
          </div>
        ) : (
          <div
            className={"tree-row req" + (active.savedId === n.id ? " on" : "")}
            style={{ paddingLeft: 16 + depth * 12 }}
            onClick={() => openNode(n)}
          >
            <span className="tree-method">{n.request.method}</span>
            <span className="tree-name">{n.name}</span>
            <span className="tree-actions" onClick={(e) => e.stopPropagation()}>
              <button title="Duplicate" onClick={() => duplicateNode(n)}>
                ⧉
              </button>
              <button title="Rename" onClick={() => renameNode(n)}>
                ✎
              </button>
              <button title="Hapus" onClick={() => deleteNode(n)}>
                ×
              </button>
            </span>
          </div>
        )}
        {n.type === "folder" && foldersOpen.has(n.id) && renderTree(n.children, depth + 1)}
      </div>
    ));
  }

  return (
    <div className="app">
      <aside className="side">
        <h1>
          <img src={logo} alt="" /> cekkan
        </h1>
        <input className="search" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Cari request…" />

        <section className="collections">
          <div className="side-head">
            <span>Collections ({countRequests(collections)})</span>
            <span className="head-actions">
              <button className="ghost" title="Collection baru" onClick={newCollection}>
                +
              </button>
              <button className="ghost" title="Import JSON (Postman/cekkan)" onClick={() => void importFile()}>
                ↧
              </button>
              <button className="ghost" title="Export JSON" onClick={() => void exportFile()}>
                ↥
              </button>
            </span>
          </div>
          <div className="tree">
            {filteredCollections.length === 0 && (
              <p className="empty">{collections.length ? "Tidak ada yang cocok." : "Simpan request untuk mulai."}</p>
            )}
            {renderTree(filteredCollections)}
          </div>
        </section>

        <section className="history-wrap">
          <div className="side-head">
            <span>History</span>
            <button className="ghost" onClick={() => setHistory([])} disabled={!history.length}>
              Clear
            </button>
          </div>
          <div className="history">
            {filteredHistory.length === 0 && <p className="empty">{history.length ? "Tidak ada yang cocok." : "Belum ada request."}</p>}
            {filteredHistory.map((h) => (
              <button key={h.id} className="hist-item" onClick={() => openHistory(h)} title={`${h.request.method} ${h.request.url}`}>
                <span className={"code " + codeClass(h.status)}>{h.status ?? "ERR"}</span>
                <span className="hist-method">{h.request.method}</span>
                <span className="hist-url">{h.request.url}</span>
                <span className="hist-ms">{h.ms} ms</span>
              </button>
            ))}
          </div>
        </section>

        <section className="env-box">
          <div className="side-head">
            <span>Env</span>
            <span className="head-actions">
              <button className="ghost" title="Env baru" onClick={addProfile}>
                +
              </button>
              <button className="ghost" title="Hapus env" onClick={deleteProfile} disabled={envState.profiles.length < 2}>
                ×
              </button>
            </span>
          </div>
          <select
            value={profile?.id ?? ""}
            onChange={(e) => setEnvState((s) => ({ ...s, activeId: e.target.value }))}
          >
            {envState.profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <textarea className="env" value={profile?.text ?? ""} onChange={(e) => patchProfile(e.target.value)} spellCheck={false} />
        </section>
      </aside>

      <section className="pane center">
        <div className="tabbar">
          {tabs.map((t) => (
            <div
              key={t.id}
              className={"rtab" + (t.id === active.id ? " on" : "")}
              onClick={() => setActiveId(t.id)}
              title={t.name}
            >
              <span className="rtab-name">
                {t.dirty ? "• " : ""}
                {t.name}
              </span>
              <button
                className="rtab-x"
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(t.id);
                }}
              >
                ×
              </button>
            </div>
          ))}
          <button className="ghost" title="Tab baru" onClick={newTab}>
            +
          </button>
          <span className="spacer" />
          <button className="ghost" onClick={() => onSave(false)} title="Simpan (⌘S)">
            Save
          </button>
          <button className="ghost" onClick={() => onSave(true)}>
            Save as
          </button>
        </div>

        <div className="bar">
          <select value={active.method} onChange={(e) => patch({ method: e.target.value })}>
            {METHODS.map((m) => (
              <option key={m}>{m}</option>
            ))}
          </select>
          <input
            className="url"
            value={active.url}
            onChange={(e) => patch({ url: e.target.value })}
            onKeyDown={(e) => e.key === "Enter" && !e.metaKey && !e.ctrlKey && void send()}
            placeholder="https://api.example.com/endpoint"
            spellCheck={false}
          />
          <input
            className="timeout"
            type="number"
            min={1000}
            step={1000}
            value={active.timeoutMs}
            onChange={(e) => patch({ timeoutMs: Number(e.target.value) || 30000 })}
            title="Timeout (ms)"
          />
          {loading ? (
            <button className="danger" onClick={() => abortRef.current?.abort()}>
              Cancel
            </button>
          ) : (
            <button className="primary" onClick={() => void send()}>
              Send
            </button>
          )}
        </div>

        <div className="tabs">
          {(
            [
              ["params", `Params${active.params.filter((p) => p.enabled && p.key).length || ""}`],
              ["headers", `Headers${active.headers.filter((h) => h.enabled && h.key).length || ""}`],
              ["body", active.bodyMode === "none" ? "Body" : "Body •"],
              ["auth", active.auth.type === "none" ? "Auth" : "Auth •"],
            ] as const
          ).map(([tab, label]) => (
            <button key={tab} className={reqTab === tab ? "tab on" : "tab"} onClick={() => setReqTab(tab)}>
              {label}
            </button>
          ))}
          <span className="spacer" />
          <button className="ghost" onClick={() => void copyCurl()}>
            {copied ? "cURL ✓" : "cURL"}
          </button>
          <span className="url-preview" title={fullUrl}>
            {fullUrl || "—"}
          </span>
        </div>

        <div className="req-pane">
          {reqTab === "params" && (
            <KVEditor
              rows={active.params}
              setRows={(v) => patch({ params: typeof v === "function" ? v(active.params) : v })}
              keyPlaceholder="param"
            />
          )}
          {reqTab === "headers" && (
            <KVEditor
              rows={active.headers}
              setRows={(v) => patch({ headers: typeof v === "function" ? v(active.headers) : v })}
              keyPlaceholder="Header-Name"
            />
          )}
          {reqTab === "body" && (
            <div className="body-pane">
              <div className="bodybar">
                <select value={active.bodyMode} onChange={(e) => patch({ bodyMode: e.target.value as BodyMode })}>
                  <option value="none">none</option>
                  <option value="raw">raw</option>
                  <option value="urlencoded">x-www-form-urlencoded</option>
                  <option value="form">form-data</option>
                  <option value="binary">binary</option>
                </select>
                {active.bodyMode === "raw" && (
                  <select value={active.rawType} onChange={(e) => patch({ rawType: e.target.value as RawType })}>
                    <option value="json">JSON</option>
                    <option value="text">Text</option>
                    <option value="xml">XML</option>
                    <option value="html">HTML</option>
                  </select>
                )}
              </div>
              {active.bodyMode === "none" && <p className="empty">Tanpa body.</p>}
              {active.bodyMode === "raw" && (
                <textarea
                  className="body-input"
                  value={active.rawBody}
                  onChange={(e) => patch({ rawBody: e.target.value })}
                  placeholder={active.rawType === "json" ? '{\n  "hello": "world"\n}' : "body…"}
                  spellCheck={false}
                />
              )}
              {active.bodyMode === "urlencoded" && (
                <KVEditor
                  rows={active.formRows}
                  setRows={(v) => patch({ formRows: typeof v === "function" ? v(active.formRows) : v })}
                  keyPlaceholder="key"
                />
              )}
              {active.bodyMode === "form" && (
                <KVEditor
                  rows={active.formRows}
                  setRows={(v) => patch({ formRows: typeof v === "function" ? v(active.formRows) : v })}
                  keyPlaceholder="field"
                  withFiles
                />
              )}
              {active.bodyMode === "binary" && (
                <div className="file-row">
                  <input value={active.binaryPath} onChange={(e) => patch({ binaryPath: e.target.value })} placeholder="path file…" spellCheck={false} />
                  <button onClick={() => void pickBinary()}>Pilih file</button>
                </div>
              )}
            </div>
          )}
          {reqTab === "auth" && (
            <div className="auth">
              <label>
                Type
                <select value={active.auth.type} onChange={(e) => setAuth({ type: e.target.value as Auth["type"] })}>
                  <option value="none">none</option>
                  <option value="bearer">Bearer token</option>
                  <option value="basic">Basic auth</option>
                  <option value="apikey">API key</option>
                </select>
              </label>
              {active.auth.type === "bearer" && (
                <label>
                  Token
                  <input value={active.auth.token} onChange={(e) => setAuth({ token: e.target.value })} placeholder="{{token}}" spellCheck={false} />
                </label>
              )}
              {active.auth.type === "basic" && (
                <>
                  <label>
                    Username
                    <input value={active.auth.username} onChange={(e) => setAuth({ username: e.target.value })} spellCheck={false} />
                  </label>
                  <label>
                    Password
                    <input value={active.auth.password} onChange={(e) => setAuth({ password: e.target.value })} type="password" spellCheck={false} />
                  </label>
                </>
              )}
              {active.auth.type === "apikey" && (
                <>
                  <label>
                    Key
                    <input value={active.auth.apiKey} onChange={(e) => setAuth({ apiKey: e.target.value })} placeholder="X-Api-Key" spellCheck={false} />
                  </label>
                  <label>
                    Value
                    <input value={active.auth.apiValue} onChange={(e) => setAuth({ apiValue: e.target.value })} placeholder="{{api_key}}" spellCheck={false} />
                  </label>
                  <label>
                    Kirim di
                    <select value={active.auth.apiIn} onChange={(e) => setAuth({ apiIn: e.target.value as Auth["apiIn"] })}>
                      <option value="header">Header</option>
                      <option value="query">Query</option>
                    </select>
                  </label>
                </>
              )}
            </div>
          )}
        </div>
      </section>

      <section className="pane right">
        <div className="resp-bar">
          {status ? (
            <>
              <span className={"code " + codeClass(status.code)}>{status.code}</span>
              <span className="meta">{status.text}</span>
              <span className="meta">{status.ms} ms</span>
              <span className="meta">{fmtBytes(status.size)}</span>
            </>
          ) : (
            <span className="meta">{error ? "Error" : "Response"}</span>
          )}
          <span className="spacer" />
          {raw && (
            <label className="pretty">
              <input type="checkbox" checked={pretty} onChange={(e) => setPretty(e.target.checked)} /> Pretty
            </label>
          )}
        </div>

        {error && <pre className="panel error">{error}</pre>}

        {!error && raw !== "" && (
          <>
            <div className="tabs sub">
              <button className={respTab === "body" ? "tab on" : "tab"} onClick={() => setRespTab("body")}>
                Body
              </button>
              <button className={respTab === "headers" ? "tab on" : "tab"} onClick={() => setRespTab("headers")}>
                Headers ({respHeaders.length})
              </button>
            </div>
            {respTab === "body" ? (
              <pre className="panel">{pretty && jsonBody ? highlightJson(showBody) : showBody}</pre>
            ) : (
              <pre className="panel">{respHeaders.map(([k, v]) => `${k}: ${v}`).join("\n")}</pre>
            )}
          </>
        )}

        {!error && raw === "" && !loading && <p className="empty">Tekan Send (⌘↩) untuk mengirim request.</p>}
        {loading && <p className="empty">Mengirim…</p>}
      </section>

      {ask && (
        <div className="overlay" onClick={() => setAsk(null)}>
          <form
            className="modal"
            onClick={(e) => e.stopPropagation()}
            onSubmit={(e) => {
              e.preventDefault();
              ask.onOk(ask.value ?? "");
              setAsk(null);
            }}
          >
            <h2>{ask.title}</h2>
            {ask.value !== undefined && (
              <input autoFocus value={ask.value} onChange={(e) => setAsk({ ...ask, value: e.target.value })} />
            )}
            <div className="modal-actions">
              <button type="button" className="ghost" onClick={() => setAsk(null)}>
                Batal
              </button>
              <button type="submit" className={ask.dangerous ? "danger" : "primary"}>
                {ask.okLabel ?? "OK"}
              </button>
            </div>
          </form>
        </div>
      )}

      {saveModal && (
        <div className="overlay" onClick={() => setSaveModal(null)}>
          <form
            className="modal"
            onClick={(e) => e.stopPropagation()}
            onSubmit={(e) => {
              e.preventDefault();
              if (!saveModal.name.trim()) return;
              saveRequest(saveModal.asNew, saveModal.name.trim(), saveModal.collectionId);
              setSaveModal(null);
            }}
          >
            <h2>Simpan request</h2>
            <input
              autoFocus
              value={saveModal.name}
              onChange={(e) => setSaveModal({ ...saveModal, name: e.target.value })}
              placeholder="Nama request"
            />
            <select
              value={saveModal.collectionId}
              onChange={(e) => setSaveModal({ ...saveModal, collectionId: e.target.value })}
            >
              {folderChoices.length === 0 && <option value="">{DEFAULT_COLLECTION} (baru)</option>}
              {folderChoices.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.label}
                </option>
              ))}
            </select>
            <div className="modal-actions">
              <button type="button" className="ghost" onClick={() => setSaveModal(null)}>
                Batal
              </button>
              <button type="submit" className="primary">
                Simpan
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}

function KVEditor({
  rows,
  setRows,
  keyPlaceholder,
  withFiles,
}: {
  rows: KV[];
  setRows: (v: SetStateAction<KV[]>) => void;
  keyPlaceholder: string;
  withFiles?: boolean;
}) {
  const patchRow = (id: string, p: Partial<KV>) => setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...p } : r)));

  async function pickFile(id: string) {
    const p = await open({ multiple: false });
    if (typeof p === "string") patchRow(id, { value: p });
  }

  return (
    <div className="kv">
      {rows.map((r) => (
        <div className={r.enabled ? "kv-row" : "kv-row off"} key={r.id}>
          <input type="checkbox" checked={r.enabled} onChange={(e) => patchRow(r.id, { enabled: e.target.checked })} />
          <input value={r.key} onChange={(e) => patchRow(r.id, { key: e.target.value })} placeholder={keyPlaceholder} spellCheck={false} />
          <input
            value={r.value}
            onChange={(e) => patchRow(r.id, { value: e.target.value })}
            placeholder={r.file ? "path file…" : "value"}
            spellCheck={false}
          />
          {withFiles && (
            <button className="ghost tiny" title={r.file ? "Jadikan teks" : "Jadikan file"} onClick={() => patchRow(r.id, { file: !r.file })}>
              {r.file ? "file" : "text"}
            </button>
          )}
          {withFiles && r.file && (
            <button className="ghost" title="Pilih file" onClick={() => void pickFile(r.id)}>
              …
            </button>
          )}
          <button className="ghost" onClick={() => setRows((rs) => rs.filter((x) => x.id !== r.id))} title="Hapus">
            ×
          </button>
        </div>
      ))}
      <span className="kv-actions">
        <button className="ghost add" onClick={() => setRows((rs) => [...rs, kv()])}>
          + Add
        </button>
        {withFiles && (
          <button className="ghost add" onClick={() => setRows((rs) => [...rs, { ...kv(), file: true }])}>
            + File
          </button>
        )}
      </span>
    </div>
  );
}

function highlightJson(src: string): ReactNode {
  const re =
    /("(?:\\.|[^"\\])*")(?=\s*:)|("(?:\\.|[^"\\])*")|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;
  const out: ReactNode[] = [];
  let last = 0;
  let key = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    if (m.index > last) out.push(src.slice(last, m.index));
    const cls = m[1] ? "j-key" : m[2] ? "j-str" : m[3] ? "j-lit" : "j-num";
    out.push(
      <span key={key++} className={cls}>
        {m[0]}
      </span>,
    );
    last = re.lastIndex;
  }
  if (last < src.length) out.push(src.slice(last));
  return <>{out}</>;
}

function codeClass(code: number | null) {
  if (code === null) return "bad";
  if (code < 300) return "good";
  if (code < 400) return "warn";
  return "bad";
}

function fmtBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function filterTree(nodes: Node[], q: string): Node[] {
  if (!q) return nodes;
  const out: Node[] = [];
  for (const n of nodes) {
    if (n.type === "folder") {
      const children = filterTree(n.children, q);
      if (n.name.toLowerCase().includes(q) || children.length) out.push({ ...n, children });
    } else if (
      n.name.toLowerCase().includes(q) ||
      n.request.url.toLowerCase().includes(q) ||
      n.request.method.toLowerCase().includes(q)
    ) {
      out.push(n);
    }
  }
  return out;
}

function folderOptions(nodes: Node[], depth = 0): { id: string; label: string }[] {
  const out: { id: string; label: string }[] = [];
  for (const n of nodes) {
    if (n.type !== "folder") continue;
    out.push({ id: n.id, label: `${"  ".repeat(depth)}${n.name}` });
    out.push(...folderOptions(n.children, depth + 1));
  }
  return out;
}
