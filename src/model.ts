export type KV = { id: string; key: string; value: string; enabled: boolean; file?: boolean };
export type AuthType = "none" | "bearer" | "basic" | "apikey";
export type Auth = {
  type: AuthType;
  token: string;
  username: string;
  password: string;
  apiKey: string;
  apiValue: string;
  apiIn: "header" | "query";
};
export type BodyMode = "none" | "raw" | "urlencoded" | "form" | "binary";
export type RawType = "json" | "text" | "xml" | "html";

export type RequestDoc = {
  method: string;
  url: string;
  headers: KV[];
  params: KV[];
  bodyMode: BodyMode;
  rawBody: string;
  rawType: RawType;
  formRows: KV[];
  binaryPath: string;
  auth: Auth;
  timeoutMs: number;
};

export type Tab = RequestDoc & { id: string; savedId: string | null; name: string; dirty: boolean };
export type SavedRequest = RequestDoc & { id: string; name: string };
export type Node =
  | { id: string; name: string; type: "folder"; children: Node[] }
  | { id: string; name: string; type: "request"; request: RequestDoc };
export type HistoryItem = { id: string; at: number; name: string; status: number | null; ms: number; request: RequestDoc };
export type Profile = { id: string; name: string; text: string };

export const uid = () => Math.random().toString(36).slice(2, 9);

export function load<T>(key: string, fallback: T): T {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "") as T;
  } catch {
    return fallback;
  }
}

export const kv = (key = "", value = "", enabled = true): KV => ({ id: uid(), key, value, enabled });

export const blankAuth = (): Auth => ({
  type: "none",
  token: "",
  username: "",
  password: "",
  apiKey: "",
  apiValue: "",
  apiIn: "header",
});

export const blankDoc = (): RequestDoc => ({
  method: "GET",
  url: "{{base_url}}/get",
  headers: [kv("Accept", "application/json")],
  params: [],
  bodyMode: "none",
  rawBody: "",
  rawType: "json",
  formRows: [],
  binaryPath: "",
  auth: blankAuth(),
  timeoutMs: 30000,
});

export const blankTab = (name = "Untitled"): Tab => ({
  ...blankDoc(),
  id: uid(),
  savedId: null,
  name,
  dirty: false,
});

export const tabOf = (doc: RequestDoc, name: string, savedId: string | null = null): Tab => ({
  ...(JSON.parse(JSON.stringify(doc)) as RequestDoc),
  id: uid(),
  savedId,
  name,
  dirty: false,
});

export const docOf = (t: Tab): RequestDoc => ({
  method: t.method,
  url: t.url,
  headers: t.headers,
  params: t.params,
  bodyMode: t.bodyMode,
  rawBody: t.rawBody,
  rawType: t.rawType,
  formRows: t.formRows,
  binaryPath: t.binaryPath,
  auth: t.auth,
  timeoutMs: t.timeoutMs,
});

export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i < 0) continue;
    out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return out;
}

export const subst = (s: string, vars: Record<string, string>) =>
  s.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (m, k: string) => vars[k] ?? m);

export const rawMime: Record<RawType, string> = {
  json: "application/json",
  text: "text/plain",
  xml: "application/xml",
  html: "text/html",
};

const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  json: "application/json",
  txt: "text/plain",
  csv: "text/csv",
  xml: "application/xml",
  zip: "application/zip",
  mp4: "video/mp4",
  mp3: "audio/mpeg",
};

export function guessMime(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return MIME[ext] ?? "application/octet-stream";
}

export function buildUrl(doc: RequestDoc, sub: (s: string) => string): string {
  const q: string[] = [];
  for (const p of doc.params) {
    if (p.enabled && p.key.trim()) {
      q.push(`${encodeURIComponent(sub(p.key))}=${encodeURIComponent(sub(p.value))}`);
    }
  }
  const a = doc.auth;
  if (a.type === "apikey" && a.apiIn === "query" && a.apiKey.trim()) {
    q.push(`${encodeURIComponent(sub(a.apiKey))}=${encodeURIComponent(sub(a.apiValue))}`);
  }
  const base = sub(doc.url).trim();
  return base + (q.length ? (base.includes("?") ? "&" : "?") + q.join("&") : "");
}

function b64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function requestHeaders(
  doc: RequestDoc,
  sub: (s: string) => string,
  contentType?: string,
): Record<string, string> {
  const h: Record<string, string> = {};
  for (const row of doc.headers) {
    if (row.enabled && row.key.trim()) h[sub(row.key.trim())] = sub(row.value);
  }
  const has = (k: string) => Object.keys(h).some((x) => x.toLowerCase() === k);

  const a = doc.auth;
  if (a.type === "bearer" && a.token && !has("authorization")) {
    h.Authorization = `Bearer ${sub(a.token)}`;
  } else if (a.type === "basic" && (a.username || a.password) && !has("authorization")) {
    h.Authorization = `Basic ${b64(`${a.username}:${a.password}`)}`;
  } else if (a.type === "apikey" && a.apiIn === "header" && a.apiKey.trim() && !has(a.apiKey.toLowerCase())) {
    h[sub(a.apiKey)] = sub(a.apiValue);
  }

  if (contentType && !has("content-type")) h["Content-Type"] = contentType;
  return h;
}

export function urlencodedBody(doc: RequestDoc, sub: (s: string) => string): string {
  const usp = new URLSearchParams();
  for (const r of doc.formRows) {
    if (r.enabled && r.key.trim() && !r.file) usp.append(sub(r.key), sub(r.value));
  }
  return usp.toString();
}

function shellQuote(s: string): string {
  return s.replace(/'/g, `'\\''`);
}

export function curlOf(doc: RequestDoc, sub: (s: string) => string): string {
  const url = buildUrl(doc, sub);
  let contentType: string | undefined;
  if (doc.bodyMode === "raw" && doc.rawBody.trim()) contentType = rawMime[doc.rawType];
  if (doc.bodyMode === "urlencoded") contentType = "application/x-www-form-urlencoded";

  const headers = requestHeaders(doc, sub, contentType);
  let cmd = `curl -X ${doc.method} '${shellQuote(url)}'`;
  for (const [k, v] of Object.entries(headers)) cmd += ` -H '${shellQuote(`${k}: ${v}`)}'`;

  if (doc.bodyMode === "raw" && doc.rawBody.trim()) {
    cmd += ` --data-raw '${shellQuote(sub(doc.rawBody))}'`;
  } else if (doc.bodyMode === "urlencoded") {
    const body = urlencodedBody(doc, sub);
    if (body) cmd += ` --data '${shellQuote(body)}'`;
  } else if (doc.bodyMode === "binary" && doc.binaryPath) {
    cmd += ` --data-binary @'${shellQuote(doc.binaryPath)}'`;
  } else if (doc.bodyMode === "form") {
    cmd += " # multipart: isi manual (-F key=value / -F key=@path)";
  }
  return cmd;
}

/* ── collections tree ── */

export function findNode(nodes: Node[], id: string): Node | null {
  for (const n of nodes) {
    if (n.id === id) return n;
    if (n.type === "folder") {
      const hit = findNode(n.children, id);
      if (hit) return hit;
    }
  }
  return null;
}

export function updateNode(nodes: Node[], id: string, fn: (n: Node) => Node): Node[] {
  return nodes.map((n) => {
    if (n.id === id) return fn(n);
    if (n.type === "folder") return { ...n, children: updateNode(n.children, id, fn) };
    return n;
  });
}

export function removeNode(nodes: Node[], id: string): Node[] {
  return nodes
    .filter((n) => n.id !== id)
    .map((n) => (n.type === "folder" ? { ...n, children: removeNode(n.children, id) } : n));
}

export function addNode(nodes: Node[], parentId: string, node: Node): Node[] {
  return nodes.map((n) => {
    if (n.id === parentId && n.type === "folder") return { ...n, children: [...n.children, node] };
    if (n.type === "folder") return { ...n, children: addNode(n.children, parentId, node) };
    return n;
  });
}

export function countRequests(nodes: Node[]): number {
  return nodes.reduce((n, x) => n + (x.type === "request" ? 1 : countRequests(x.children)), 0);
}

/* ── import ── */

function urlFromPostman(u: any): string {
  if (!u) return "";
  if (typeof u === "string") return u;
  if (u.raw) return u.raw;
  const host = Array.isArray(u.host) ? u.host.join(".") : (u.host ?? "");
  const path = Array.isArray(u.path) ? u.path.join("/") : (u.path ?? "");
  const proto = u.protocol ? `${u.protocol}://` : "";
  return proto + host + (path ? "/" + path : "");
}

function importDoc(r: any): RequestDoc {
  const doc = blankDoc();
  doc.method = String(r.method ?? "GET").toUpperCase();
  const u = r.url;
  doc.url = urlFromPostman(u);
  if (u && typeof u === "object") {
    if (Array.isArray(u.query)) {
      doc.params = u.query.map((q: any) => ({
        id: uid(),
        key: q.key ?? "",
        value: q.value ?? "",
        enabled: !q.disabled,
      }));
    }
  }
  if (Array.isArray(r.header)) {
    doc.headers = r.header.map((h: any) => ({
      id: uid(),
      key: h.key ?? "",
      value: h.value ?? "",
      enabled: !h.disabled,
    }));
  }

  const b = r.body;
  if (b && b.mode === "raw") {
    doc.bodyMode = "raw";
    doc.rawBody = b.raw ?? "";
    const lang = b.options?.raw?.language;
    doc.rawType = lang === "xml" ? "xml" : lang === "html" ? "html" : lang === "text" ? "text" : "json";
  } else if (b && b.mode === "urlencoded") {
    doc.bodyMode = "urlencoded";
    doc.formRows = (b.urlencoded ?? []).map((x: any) => ({
      id: uid(),
      key: x.key ?? "",
      value: x.value ?? "",
      enabled: !x.disabled,
    }));
  } else if (b && b.mode === "formdata") {
    doc.bodyMode = "form";
    doc.formRows = (b.formdata ?? []).map((x: any) => {
      const isFile = x.type === "file";
      const src = Array.isArray(x.src) ? x.src[0] : x.src;
      return {
        id: uid(),
        key: x.key ?? "",
        value: isFile ? (src ?? "") : (x.value ?? ""),
        enabled: !x.disabled,
        file: isFile,
      };
    });
  }

  const a = r.auth;
  if (a && a.type === "bearer") {
    doc.auth = { ...blankAuth(), type: "bearer", token: a.bearer?.find((x: any) => x.key === "token")?.value ?? "" };
  } else if (a && a.type === "basic") {
    doc.auth = {
      ...blankAuth(),
      type: "basic",
      username: a.basic?.find((x: any) => x.key === "username")?.value ?? "",
      password: a.basic?.find((x: any) => x.key === "password")?.value ?? "",
    };
  } else if (a && a.type === "apikey") {
    const g = (k: string) => a.apikey?.find((x: any) => x.key === k)?.value ?? "";
    doc.auth = {
      ...blankAuth(),
      type: "apikey",
      apiKey: g("key"),
      apiValue: g("value"),
      apiIn: g("in") === "query" ? "query" : "header",
    };
  }

  return doc;
}

function importItem(it: any): Node | null {
  if (Array.isArray(it.item)) {
    return {
      id: uid(),
      name: it.name ?? "Folder",
      type: "folder",
      children: it.item.map(importItem).filter((n: Node | null): n is Node => n !== null),
    };
  }
  if (!it.request) return null;
  return { id: uid(), name: it.name ?? "Request", type: "request", request: importDoc(it.request) };
}

export function importPostman(json: any): Node[] {
  return [
    {
      id: uid(),
      name: json.info?.name ?? "Imported",
      type: "folder",
      children: (json.item ?? []).map(importItem).filter((n: Node | null): n is Node => n !== null),
    },
  ];
}

/* ── import HTTPie collection ── */

function httpieAuth(a: any, fallback: Auth): Auth {
  if (!a || a.type === "none" || a.type === "inherited") return fallback;
  const c = a.credentials ?? {};
  if (a.type === "bearer") {
    return { ...blankAuth(), type: "bearer", token: c.password || c.token || "" };
  }
  if (a.type === "basic") {
    return { ...blankAuth(), type: "basic", username: c.username ?? "", password: c.password ?? "" };
  }
  if (a.type === "apikey") {
    return {
      ...blankAuth(),
      type: "apikey",
      apiKey: c.key ?? c.name ?? "",
      apiValue: c.value ?? "",
      apiIn: a.target === "queryParams" || a.target === "query" ? "query" : "header",
    };
  }
  return fallback;
}

function rawTypeFromFormat(format?: string): RawType {
  if (format === "application/xml" || format === "text/xml") return "xml";
  if (format === "text/html") return "html";
  if (format === "text/plain") return "text";
  return "json";
}

function httpieDoc(r: any, inherited: Auth): RequestDoc {
  const doc = blankDoc();
  doc.method = String(r.method ?? "GET").toUpperCase();
  doc.url = r.url ?? "";

  if (Array.isArray(r.pathParams)) {
    for (const p of r.pathParams) {
      if (p.value) doc.url = doc.url.replace(`:${p.name}`, encodeURIComponent(p.value));
    }
  }
  if (Array.isArray(r.queryParams)) {
    doc.params = r.queryParams.map((p: any) => ({
      id: uid(),
      key: p.name ?? p.key ?? "",
      value: p.value ?? "",
      enabled: p.enabled !== false,
    }));
  }
  if (Array.isArray(r.headers)) {
    doc.headers = r.headers.map((h: any) => ({
      id: uid(),
      key: h.name ?? h.key ?? "",
      value: h.value ?? "",
      enabled: h.enabled !== false,
    }));
  }
  doc.auth = httpieAuth(r.auth, inherited);

  const b = r.body;
  if (b) {
    if (b.type === "text" && b.text?.value) {
      doc.bodyMode = "raw";
      doc.rawBody = b.text.value;
      doc.rawType = rawTypeFromFormat(b.text.format);
    } else if (b.type === "file") {
      const path = b.file?.path ?? b.file?.name ?? "";
      if (path) {
        doc.bodyMode = "binary";
        doc.binaryPath = path;
      }
    } else if (b.type === "form") {
      doc.bodyMode = b.form?.isMultipart === false ? "urlencoded" : "form";
      doc.formRows = (b.form?.fields ?? []).map((f: any) => ({
        id: uid(),
        key: f.name ?? f.key ?? "",
        value: f.value ?? "",
        enabled: f.enabled !== false,
        file: f.type === "file",
      }));
    } else if (b.type === "graphql" && (b.graphql?.query || b.graphql?.variables)) {
      let variables: unknown = {};
      try {
        variables = JSON.parse(b.graphql.variables || "{}");
      } catch {
        variables = {};
      }
      doc.bodyMode = "raw";
      doc.rawType = "json";
      doc.rawBody = JSON.stringify({ query: b.graphql.query ?? "", variables }, null, 2);
    }
  }
  return doc;
}

export function importHttpie(json: any): Node[] {
  const entry = json.entry ?? {};
  const rootAuth = httpieAuth(entry.auth, blankAuth());

  const walk = (items: any[], inherited: Auth): Node[] => {
    const out: Node[] = [];
    for (const it of items) {
      if (Array.isArray(it.requests)) {
        out.push({
          id: uid(),
          name: it.name ?? "Folder",
          type: "folder",
          children: walk(it.requests, httpieAuth(it.auth, inherited)),
        });
      } else if (it.url) {
        out.push({
          id: uid(),
          name: it.name || `${it.method ?? "GET"} ${it.url}`,
          type: "request",
          request: httpieDoc(it, inherited),
        });
      }
    }
    return out;
  };

  return [
    {
      id: uid(),
      name: entry.name ?? "HTTPie",
      type: "folder",
      children: walk(entry.requests ?? [], rootAuth),
    },
  ];
}

