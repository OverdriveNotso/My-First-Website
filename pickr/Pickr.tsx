/**
 * Pickr — dev-only in-page annotator (Windows, Ctrl shortcuts only).
 *
 * Pick elements, describe what is wrong and what it should become, and copy a
 * single prompt for Claude Code that names each element's source file:line.
 *
 * Mount <Pickr /> anywhere; it renders nothing in production builds.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { createPortal } from "react-dom";

/* ------------------------------------------------------------------ types */

type Target = { label: string; source: string; selector: string; tag: string };
type Status = "open" | "done" | "wontfix";
type Annotation = {
  id: string;
  path: string;
  targets: Target[];
  comment: string;
  tags: string[];
  status: Status;
  createdAt: number;
};
type Settings = {
  theme: "light" | "dark" | "page";
  accent: string;
  highlight: "dashed" | "solid";
  fill: boolean;
  position: "bottom" | "top";
};
type Draft = { mode: "new" } | { mode: "edit"; id: string };
type Fiber = {
  type?: unknown;
  return?: Fiber | null;
  _debugSource?: { fileName?: string; lineNumber?: number } | null;
};

/* -------------------------------------------------------------- constants */

const STORE_KEY = "pickr.v1";
const SETTINGS_KEY = "pickr.settings.v1";
const OPEN_KEY = "pickr.open";
const TAGS = ["Layout", "Style", "Copy", "Bug", "A11y", "Remove"];
const STATUS_LABEL: Record<Status, string> = { open: "Open", done: "Done", wontfix: "Won't fix" };
const DEFAULT_SETTINGS: Settings = {
  theme: "page",
  accent: "#7c5cff",
  highlight: "dashed",
  fill: false,
  position: "bottom",
};
const TOOLBAR_SPACE = 72; // px reserved for the toolbar (16px margin + bar)
const POPOVER_W = 340;

/* ---------------------------------------------------------------- storage */

function readJSON(storage: Storage, key: string): unknown {
  try {
    const raw = storage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
function writeJSON(storage: Storage, key: string, value: unknown) {
  try {
    storage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage full or blocked: keep working in memory */
  }
}
function loadAnnotations(): Annotation[] {
  const v = readJSON(localStorage, STORE_KEY);
  return Array.isArray(v) ? (v as Annotation[]) : [];
}
function loadSettings(): Settings {
  const v = readJSON(localStorage, SETTINGS_KEY);
  return v && typeof v === "object" ? { ...DEFAULT_SETTINGS, ...(v as Partial<Settings>) } : DEFAULT_SETTINGS;
}
function loadOpen(): boolean {
  try {
    return sessionStorage.getItem(OPEN_KEY) === "1";
  } catch {
    return false;
  }
}

/* ---------------------------------------------------------------- helpers */

const uid = () => Math.random().toString(36).slice(2, 8) + Date.now().toString(36);
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

function isPickr(node: unknown): boolean {
  return node instanceof Element && node.closest("[data-pickr]") !== null;
}

function isHex(v: string) {
  return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v);
}
function hex6(v: string) {
  return v.length === 4 ? "#" + [...v.slice(1)].map((c) => c + c).join("") : v;
}
function textOn(hex: string) {
  const h = hex6(hex);
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? "#111" : "#fff";
}

function pageIsDark(): boolean {
  for (const n of [document.body, document.documentElement]) {
    if (!n) continue;
    const m = getComputedStyle(n).backgroundColor.match(/[\d.]+/g);
    if (m && m.length >= 3 && (m.length < 4 || Number(m[3]) > 0)) {
      const [r, g, b] = m.map(Number);
      return 0.299 * r + 0.587 * g + 0.114 * b < 128;
    }
  }
  return matchMedia("(prefers-color-scheme: dark)").matches;
}

function fiberOf(el: Element): Fiber | null {
  const key = Object.keys(el).find((k) => k.startsWith("__reactFiber$"));
  return key ? ((el as unknown as Record<string, Fiber>)[key] ?? null) : null;
}

function componentName(el: Element): string | null {
  for (let n: Element | null = el; n; n = n.parentElement) {
    const fiber = fiberOf(n);
    if (!fiber) continue;
    for (let f = fiber.return ?? null; f; f = f.return ?? null) {
      const t = f.type as { displayName?: string; name?: string; render?: Function; type?: Function } | Function | undefined;
      if (typeof t === "function") {
        const name = (t as { displayName?: string }).displayName || t.name;
        if (name) return name;
      } else if (t && typeof t === "object") {
        const inner = t.render ?? t.type;
        const name = t.displayName || (inner as { displayName?: string } | undefined)?.displayName || inner?.name;
        if (name) return name;
      }
    }
    return null;
  }
  return null;
}

function shortPath(p: string) {
  const n = p.replace(/\\/g, "/");
  const i = n.lastIndexOf("/src/");
  return i >= 0 ? n.slice(i + 1) : n;
}

/** React ≤18 `_debugSource` → build-plugin `data-source` → "unknown". */
function sourceOf(el: Element): string {
  for (let f = fiberOf(el); f; f = f.return ?? null) {
    const s = f._debugSource;
    if (s?.fileName) return `${shortPath(s.fileName)}:${s.lineNumber ?? "?"}`;
  }
  return el.closest("[data-source]")?.getAttribute("data-source") || "unknown";
}

function cssSelector(el: Element): string {
  const parts: string[] = [];
  let node: Element | null = el;
  while (node && node !== document.documentElement) {
    if (node.id && document.querySelectorAll(`#${CSS.escape(node.id)}`).length === 1) {
      parts.unshift(`#${CSS.escape(node.id)}`);
      break;
    }
    const tag = node.tagName.toLowerCase();
    let part = tag;
    const parent: Element | null = node.parentElement;
    if (parent) {
      const same = Array.from(parent.children).filter((c) => c.tagName === node!.tagName);
      if (same.length > 1) part += `:nth-of-type(${same.indexOf(node) + 1})`;
    }
    parts.unshift(part);
    if (tag === "body") break;
    node = parent;
  }
  return parts.join(" > ");
}

function labelOf(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const pretty = tag.charAt(0).toUpperCase() + tag.slice(1);
  const comp = componentName(el);
  const r = el.getBoundingClientRect();
  return `${pretty}${comp ? ` · ${comp}` : ""} ${Math.round(r.width)}×${Math.round(r.height)}`;
}

function describe(el: Element): Target {
  return { label: labelOf(el), source: sourceOf(el), selector: cssSelector(el), tag: el.tagName.toLowerCase() };
}

function safeQuery(selector: string | undefined): Element | null {
  if (!selector) return null;
  try {
    const el = document.querySelector(selector);
    return el && !isPickr(el) ? el : null;
  } catch {
    return null;
  }
}

function firstChild(el: Element): Element | null {
  return Array.from(el.children).find((c) => !isPickr(c) && c.tagName !== "SCRIPT" && c.tagName !== "STYLE") ?? null;
}
function parentOf(el: Element): Element | null {
  const p = el.parentElement;
  return p && p !== document.documentElement ? p : null;
}

/* --------------------------------------------------------------- prompt */

function buildPrompt(list: Annotation[]): string {
  const active = list.filter((a) => a.status === "open");
  if (!active.length) return "";
  const groups = new Map<string, Annotation[]>();
  for (const a of active) groups.set(a.path, [...(groups.get(a.path) ?? []), a]);

  const indent = (text: string, pad: string) => text.split("\n").join("\n" + pad);
  const out = [
    `Please make the following changes to my website (${location.origin}).`,
    "Each item names the element, its source file:line, a CSS selector and tag to locate it, and a comment describing what is wrong and what it should become.",
  ];
  let n = 0;
  for (const [path, items] of groups) {
    out.push("", `## Page: ${path}`);
    for (const a of items) {
      n++;
      const tags = a.tags.length ? ` [${a.tags.join(", ")}]` : "";
      out.push("", `${n}. ${a.targets.map((t) => t.label).join(" + ")}${tags}`);
      const single = a.targets.length === 1;
      a.targets.forEach((t, i) => {
        const pad = single ? "   " : "     ";
        if (!single) out.push(`   - Element ${i + 1}: ${t.label}`);
        out.push(`${pad}- Source: ${t.source}`, `${pad}- Selector: \`${t.selector}\``, `${pad}- Tag: <${t.tag}>`);
      });
      out.push(`   - Comment: ${indent(a.comment || "(no comment)", "     ")}`);
    }
  }
  return out.join("\n");
}

/* -------------------------------------------------------------- icons */

const Eye = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);
const Gear = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" />
  </svg>
);

/* ----------------------------------------------------------- component */

export default function Pickr() {
  return process.env.NODE_ENV !== "production" ? <PickrImpl /> : null;
}

function PickrImpl() {
  const [open, setOpenState] = useState(loadOpen);
  const [picking, setPicking] = useState(false);
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [annotations, setAnnotations] = useState<Annotation[]>(loadAnnotations);
  const [hover, setHover] = useState<Element | null>(null);
  const [selection, setSelection] = useState<Element[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [comment, setComment] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [panel, setPanel] = useState<"none" | "list" | "settings">("none");
  const [scope, setScope] = useState<"page" | "all">("page");
  const [preview, setPreview] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [accentText, setAccentText] = useState(settings.accent);
  const [toast, setToast] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [path, setPath] = useState(() => location.pathname);
  const [pageDark, setPageDark] = useState(pageIsDark);
  const [popH, setPopH] = useState(220);
  const [, setTick] = useState(0);

  const hoverStack = useRef<Element[]>([]);
  const popStack = useRef<Element[]>([]);
  const popRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const toastTimer = useRef<number | undefined>(undefined);
  const skipBlurSave = useRef(false);

  /* persistence */
  useEffect(() => writeJSON(localStorage, STORE_KEY, annotations), [annotations]);
  useEffect(() => writeJSON(localStorage, SETTINGS_KEY, settings), [settings]);

  const pageList = useMemo(() => annotations.filter((a) => a.path === path), [annotations, path]);
  const visible = scope === "page" ? pageList : annotations;
  const dark = settings.theme === "dark" || (settings.theme === "page" && pageDark);

  /* actions */
  const notify = (msg: string) => {
    setToast(msg);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2200);
  };

  const cancelDraft = () => {
    setDraft(null);
    setSelection([]);
    setComment("");
    setTags([]);
    popStack.current = [];
  };

  const stopPicking = () => {
    setPicking(false);
    setHover(null);
    hoverStack.current = [];
  };

  const setOpen = (v: boolean) => {
    try {
      sessionStorage.setItem(OPEN_KEY, v ? "1" : "0");
    } catch {
      /* ignore */
    }
    setOpenState(v);
    if (!v) {
      stopPicking();
      cancelDraft();
      setPanel("none");
    }
  };

  const openAndPick = () => {
    setOpen(true);
    setPicking(true);
  };

  const copyPrompt = async (list: Annotation[]) => {
    const active = list.filter((a) => a.status === "open");
    if (!active.length) {
      notify("Nothing to copy — no open annotations");
      return;
    }
    try {
      await navigator.clipboard.writeText(buildPrompt(active));
      notify(`Copied prompt · ${active.length} change${active.length === 1 ? "" : "s"}`);
    } catch {
      notify("Copy failed — clipboard access was blocked");
    }
  };

  /** Dev server opens a new Claude Code conversation in VS Code with this prompt. */
  const sendToClaude = async (list: Annotation[]) => {
    const prompt = buildPrompt(list);
    if (!prompt) {
      notify("Nothing to send — no open annotations");
      return;
    }
    setSending(true);
    try {
      const res = await fetch("/__pickr/send", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Pickr": "1" },
        body: JSON.stringify({ prompt }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (res.ok) notify("Sent to Claude Code in VS Code");
      else if (res.status === 404) notify("Send to Claude needs the Pickr dev server (npm run dev)");
      else notify(`Send failed: ${data.error ?? res.statusText}`);
    } catch {
      notify("Send failed — is the dev server running?");
    } finally {
      setSending(false);
    }
  };

  const pick = (el: Element, add: boolean) => {
    popStack.current = [];
    if (add && draft) {
      const next = selection.includes(el) ? selection.filter((x) => x !== el) : [...selection, el];
      if (next.length) setSelection(next);
      else cancelDraft();
      return;
    }
    setSelection([el]);
    setComment("");
    setTags([]);
    setDraft({ mode: "new" });
  };

  const startEdit = (a: Annotation) => {
    popStack.current = [];
    setSelection(a.targets.map((t) => safeQuery(t.selector)).filter((x): x is Element => x !== null));
    setComment(a.comment);
    setTags(a.tags);
    setDraft({ mode: "edit", id: a.id });
  };

  const save = (andCopy: boolean) => {
    if (!draft) return;
    const text = comment.trim();
    if (!text && !tags.length) {
      notify("Add a comment or a tag first");
      textRef.current?.focus();
      return;
    }
    const targets = selection.map(describe);
    let next: Annotation[];
    if (draft.mode === "new") {
      if (!targets.length) return;
      next = [
        ...annotations,
        { id: uid(), path, targets, comment: text, tags, status: "open", createdAt: Date.now() },
      ];
    } else {
      next = annotations.map((a) =>
        a.id === draft.id ? { ...a, comment: text, tags, targets: targets.length ? targets : a.targets } : a,
      );
    }
    setAnnotations(next);
    cancelDraft();
    if (andCopy) void copyPrompt(next);
  };

  const removeAnnotation = (id: string) => setAnnotations((prev) => prev.filter((a) => a.id !== id));

  const updateAnnotation = (id: string, patch: Partial<Annotation>) =>
    setAnnotations((prev) => prev.map((a) => (a.id === id ? { ...a, ...patch } : a)));

  const move = (id: string, dir: -1 | 1) => {
    const i = visible.findIndex((a) => a.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= visible.length) return;
    const aId = visible[i].id;
    const bId = visible[j].id;
    setAnnotations((prev) => {
      const arr = [...prev];
      const ia = arr.findIndex((a) => a.id === aId);
      const ib = arr.findIndex((a) => a.id === bId);
      [arr[ia], arr[ib]] = [arr[ib], arr[ia]];
      return arr;
    });
  };

  const clearAll = () => {
    if (!visible.length) return;
    const what = scope === "page" ? "on this page" : "on all pages";
    if (!window.confirm(`Delete all ${visible.length} annotations ${what}?`)) return;
    const ids = new Set(visible.map((a) => a.id));
    setAnnotations((prev) => prev.filter((a) => !ids.has(a.id)));
    cancelDraft();
  };

  const locate = (a: Annotation) => {
    if (a.path !== path) {
      notify(`This annotation is on ${a.path}`);
      return;
    }
    safeQuery(a.targets[0]?.selector)?.scrollIntoView({ block: "center", behavior: "smooth" });
    startEdit(a);
  };

  /** Move the hover highlight to the parent (up) or back down to a child. */
  const climb = (up: boolean) => {
    if (!hover) return;
    if (up) {
      const p = parentOf(hover);
      if (p) {
        hoverStack.current.push(hover);
        setHover(p);
      }
    } else {
      const c = hoverStack.current.pop() ?? firstChild(hover);
      if (c) setHover(c);
    }
  };

  /** Popover Parent / Child: retarget the most recently picked element. */
  const retarget = (up: boolean) => {
    const last = selection[selection.length - 1];
    if (!last) return;
    let next: Element | null;
    if (up) {
      next = parentOf(last);
      if (next) popStack.current.push(last);
    } else {
      next = popStack.current.pop() ?? firstChild(last);
    }
    if (next) setSelection([...selection.slice(0, -1), next]);
    textRef.current?.focus();
  };

  /* Global capture-phase listeners, registered once; they read the latest state via a ref. */
  const latest = useRef({ open, picking, hover, draft, path, pick, climb, stopPicking, openAndPick, setPicking, cancelDraft });
  latest.current = { open, picking, hover, draft, path, pick, climb, stopPicking, openAndPick, setPicking, cancelDraft };

  useEffect(() => {
    const L = () => latest.current;
    const swallow = (e: Event) => {
      e.preventDefault();
      e.stopImmediatePropagation();
    };

    const onKey = (e: KeyboardEvent) => {
      const s = L();
      if (e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey && e.key.toLowerCase() === "i") {
        swallow(e);
        if (!s.open) s.openAndPick();
        else if (s.picking) s.stopPicking();
        else s.setPicking(true);
        return;
      }
      if (!s.open || isPickr(e.target)) return;
      if (s.draft && e.key === "Escape") {
        swallow(e);
        s.cancelDraft();
        return;
      }
      if (!s.picking) return;
      if (e.key === "Escape") s.stopPicking();
      else if (e.key === "ArrowUp") s.climb(true);
      else if (e.key === "ArrowDown") s.climb(false);
      else if (e.key === "Enter" && s.hover) s.pick(s.hover, e.shiftKey);
      else return;
      swallow(e);
    };

    const onMove = (e: PointerEvent) => {
      const s = L();
      if (!s.open || !s.picking || isPickr(e.target)) return;
      const t = e.target;
      if (t instanceof Element && t !== s.hover && t !== document.documentElement) {
        hoverStack.current = [];
        setHover(t);
      }
    };

    const onBlock = (e: Event) => {
      const s = L();
      if (s.open && s.picking && !isPickr(e.target)) swallow(e);
    };

    const onClick = (e: MouseEvent) => {
      const s = L();
      if (!s.open || !s.picking || isPickr(e.target)) return;
      swallow(e);
      const t = e.target;
      if (t instanceof Element && t !== document.documentElement) s.pick(t, e.shiftKey);
    };

    let raf = 0;
    const bump = () => {
      if (!raf)
        raf = requestAnimationFrame(() => {
          raf = 0;
          setTick((n) => n + 1);
        });
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORE_KEY) setAnnotations(loadAnnotations());
      if (e.key === SETTINGS_KEY) setSettings(loadSettings());
    };
    const interval = window.setInterval(() => {
      if (location.pathname !== L().path) setPath(location.pathname);
      setPageDark(pageIsDark());
      bump();
    }, 1000);

    const opts = { capture: true, passive: false } as const;
    const blocked = ["pointerdown", "mousedown", "pointerup", "mouseup", "dblclick", "auxclick"];
    window.addEventListener("keydown", onKey, opts);
    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("click", onClick, opts);
    blocked.forEach((t) => window.addEventListener(t, onBlock, opts));
    window.addEventListener("scroll", bump, true);
    window.addEventListener("resize", bump);
    window.addEventListener("storage", onStorage);
    window.addEventListener("popstate", bump);
    return () => {
      window.removeEventListener("keydown", onKey, opts);
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("click", onClick, opts);
      blocked.forEach((t) => window.removeEventListener(t, onBlock, opts));
      window.removeEventListener("scroll", bump, true);
      window.removeEventListener("resize", bump);
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("popstate", bump);
      window.clearInterval(interval);
      cancelAnimationFrame(raf);
    };
  }, []);

  /* Focus the comment field whenever a new popover opens. */
  useEffect(() => {
    if (draft) textRef.current?.focus();
  }, [draft]);

  /* Measure the popover so it can be clamped to the viewport. */
  useLayoutEffect(() => {
    const h = popRef.current?.offsetHeight;
    if (h && h !== popH) setPopH(h);
  });

  useEffect(() => setAccentText(settings.accent), [settings.accent]);

  /* --------------------------------------------------------- rendering */

  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const narrow = vw < 640;
  const atTop = settings.position === "top";
  const minTop = atTop ? TOOLBAR_SPACE + 8 : 8;
  const maxBottom = atTop ? vh - 8 : vh - TOOLBAR_SPACE - 8;
  const edgeSide: CSSProperties = atTop ? { top: TOOLBAR_SPACE + 4 } : { bottom: TOOLBAR_SPACE + 4 };

  const rootStyle = {
    "--pk-accent": settings.accent,
    "--pk-on-accent": textOn(settings.accent),
  } as CSSProperties;

  const box = (el: Element, kind: "hover" | "selected", key: string | number): ReactNode => {
    if (!el.isConnected) return null;
    const r = el.getBoundingClientRect();
    const style: CSSProperties = {
      left: r.left,
      top: r.top,
      width: r.width,
      height: r.height,
      borderStyle: kind === "hover" ? settings.highlight : "solid",
    };
    const fill = kind === "selected" || settings.fill;
    return (
      <div key={key} data-pickr className={`pk-box ${fill ? "pk-fill" : ""}`} style={style}>
        {kind === "hover" && (
          <span className="pk-label" style={r.top > 24 ? { bottom: "100%", marginBottom: 4 } : { top: 2, left: 2 }}>
            {labelOf(el)}
          </span>
        )}
      </div>
    );
  };

  const anchor = selection[selection.length - 1] ?? null;
  const popoverStyle = (): { style: CSSProperties; sheet: boolean } => {
    if (narrow || !anchor || !anchor.isConnected) return { style: edgeSide, sheet: true };
    const r = anchor.getBoundingClientRect();
    let left = r.right + 12;
    let top = r.top;
    if (left + POPOVER_W > vw - 8) left = r.left - POPOVER_W - 12;
    if (left < 8) {
      left = clamp(r.left, 8, vw - POPOVER_W - 8);
      top = r.bottom + 12;
      if (top + popH > maxBottom) top = r.top - popH - 12;
    }
    top = clamp(top, minTop, Math.max(minTop, maxBottom - popH));
    return { style: { left, top, width: POPOVER_W }, sheet: false };
  };

  const onTextKey = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && e.ctrlKey) {
      e.preventDefault();
      save(true);
    } else if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      save(false);
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancelDraft();
    }
  };

  const keepFocus = (e: { preventDefault(): void }) => e.preventDefault();
  const toggleTag = (t: string) => setTags((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]));
  const openCount = pageList.filter((a) => a.status === "open").length;

  const seg = <T extends string>(value: T, options: [T, string][], onChange: (v: T) => void) => (
    <div className="pk-seg" role="group">
      {options.map(([v, label]) => (
        <button key={v} type="button" className={value === v ? "pk-on" : ""} aria-pressed={value === v} onClick={() => onChange(v)}>
          {label}
        </button>
      ))}
    </div>
  );

  const ui = (
    <div
      data-pickr
      className={`pk-root ${dark ? "pk-dark" : "pk-light"}`}
      style={rootStyle}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <style>{CSS_TEXT}</style>

      {!open && (
        <button
          type="button"
          data-pickr
          className="pk-fab pk-ui"
          style={atTop ? { top: 20 } : { bottom: 20 }}
          onClick={openAndPick}
          title="Open Pickr (Ctrl+I)"
          aria-label="Open Pickr"
        >
          P
        </button>
      )}

      {open && (
        <>
          {/* highlights */}
          {selection.map((el, i) => box(el, "selected", `s${i}`))}
          {picking && hover && !selection.includes(hover) && box(hover, "hover", "hover")}

          {/* pins */}
          {pageList.map((a, i) => {
            const el = safeQuery(a.targets[0]?.selector);
            if (!el) return null;
            const r = el.getBoundingClientRect();
            if (r.bottom < 0 || r.top > vh) return null;
            return (
              <button
                key={a.id}
                type="button"
                data-pickr
                className={`pk-pin pk-ui ${a.status !== "open" ? "pk-dim" : ""}`}
                style={{ left: clamp(r.left - 11, 2, vw - 24), top: clamp(r.top - 11, 2, vh - 24) }}
                onClick={() => startEdit(a)}
                title={`${i + 1}. ${a.comment || a.targets[0]?.label}`}
                aria-label={`Edit annotation ${i + 1}`}
              >
                {i + 1}
              </button>
            );
          })}

          {/* popover */}
          {draft &&
            (() => {
              const { style, sheet } = popoverStyle();
              const editing = draft.mode === "edit" ? annotations.find((a) => a.id === draft.id) : undefined;
              const title =
                selection.length > 1
                  ? `${selection.length} elements`
                  : anchor
                    ? labelOf(anchor)
                    : (editing?.targets[0]?.label ?? "Element not found");
              return (
                <div
                  ref={popRef}
                  data-pickr
                  role="dialog"
                  aria-label="Annotate element"
                  className={`pk-pop pk-ui ${sheet ? "pk-sheet" : ""}`}
                  style={style}
                >
                  <div className="pk-pop-head">
                    <div className="pk-pop-title">
                      <strong title={title}>{title}</strong>
                      <span className="pk-muted">{anchor ? sourceOf(anchor) : editing?.targets[0]?.source}</span>
                    </div>
                    <button type="button" className="pk-mini" onMouseDown={keepFocus} onClick={() => retarget(true)} disabled={!anchor}>
                      Parent
                    </button>
                    <button type="button" className="pk-mini" onMouseDown={keepFocus} onClick={() => retarget(false)} disabled={!anchor}>
                      Child
                    </button>
                  </div>
                  <textarea
                    ref={textRef}
                    className="pk-text"
                    rows={3}
                    value={comment}
                    placeholder="What is wrong, and what should it become?"
                    onChange={(e) => setComment(e.target.value)}
                    onKeyDown={onTextKey}
                  />
                  <div className="pk-tags">
                    {TAGS.map((t) => (
                      <button
                        key={t}
                        type="button"
                        className={`pk-tag ${tags.includes(t) ? "pk-on" : ""}`}
                        aria-pressed={tags.includes(t)}
                        onMouseDown={keepFocus}
                        onClick={() => toggleTag(t)}
                      >
                        {t}
                      </button>
                    ))}
                  </div>
                  <div className="pk-pop-foot">
                    {draft.mode === "edit" && (
                      <button
                        type="button"
                        className="pk-mini pk-danger"
                        onClick={() => {
                          removeAnnotation(draft.id);
                          cancelDraft();
                        }}
                      >
                        Delete
                      </button>
                    )}
                    <span className="pk-muted pk-keys">Enter save · Ctrl+Enter save &amp; copy · Esc cancel</span>
                    <button type="button" className="pk-btn pk-primary" onMouseDown={keepFocus} onClick={() => save(false)}>
                      Save
                    </button>
                  </div>
                </div>
              );
            })()}

          {/* annotations panel */}
          {panel === "list" && (
            <div data-pickr className="pk-panel pk-ui" style={edgeSide}>
              <div className="pk-panel-head">
                {seg(scope, [["page", `This page (${pageList.length})`], ["all", `All pages (${annotations.length})`]], setScope)}
                <button
                  type="button"
                  className={`pk-icon ${preview ? "pk-on" : ""}`}
                  aria-pressed={preview}
                  onClick={() => setPreview((p) => !p)}
                  title="Preview prompt"
                  aria-label="Preview prompt"
                >
                  <Eye />
                </button>
              </div>

              {preview ? (
                <pre className="pk-preview">{buildPrompt(visible) || "Nothing to include — every annotation is done or won't fix."}</pre>
              ) : visible.length === 0 ? (
                <p className="pk-empty">No annotations yet. Press Ctrl+I and click an element.</p>
              ) : (
                <ol className="pk-list">
                  {visible.map((a, i) => (
                    <li key={a.id} className={`pk-item ${a.status !== "open" ? "pk-dim" : ""}`}>
                      <div className="pk-item-head">
                        <span className="pk-num">{i + 1}</span>
                        <button type="button" className="pk-link" onClick={() => locate(a)} title="Show on page">
                          {a.targets[0]?.label ?? "Element"}
                          {a.targets.length > 1 ? ` +${a.targets.length - 1}` : ""}
                        </button>
                        <span className="pk-actions">
                          <button type="button" className="pk-icon pk-sm" onClick={() => move(a.id, -1)} disabled={i === 0} aria-label="Move up">↑</button>
                          <button type="button" className="pk-icon pk-sm" onClick={() => move(a.id, 1)} disabled={i === visible.length - 1} aria-label="Move down">↓</button>
                          <button
                            type="button"
                            className="pk-icon pk-sm"
                            onClick={() => {
                              skipBlurSave.current = false;
                              setEditingId(a.id);
                              setEditText(a.comment);
                            }}
                            aria-label="Edit comment"
                          >
                            ✎
                          </button>
                          <button type="button" className="pk-icon pk-sm pk-danger" onClick={() => removeAnnotation(a.id)} aria-label="Delete">
                            ×
                          </button>
                        </span>
                      </div>
                      <div className="pk-muted pk-meta">
                        {scope === "all" && <span>{a.path} · </span>}
                        {a.targets[0]?.source}
                      </div>
                      {editingId === a.id ? (
                        <textarea
                          className="pk-text"
                          rows={3}
                          autoFocus
                          value={editText}
                          onChange={(e) => setEditText(e.target.value)}
                          onBlur={() => {
                            if (!skipBlurSave.current) updateAnnotation(a.id, { comment: editText.trim() });
                            skipBlurSave.current = false;
                            setEditingId(null);
                          }}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" && !e.shiftKey) {
                              e.preventDefault();
                              updateAnnotation(a.id, { comment: editText.trim() });
                              setEditingId(null);
                            } else if (e.key === "Escape") {
                              e.preventDefault();
                              skipBlurSave.current = true;
                              setEditingId(null);
                            }
                          }}
                        />
                      ) : (
                        <p className="pk-comment">{a.comment || <em className="pk-muted">No comment</em>}</p>
                      )}
                      <div className="pk-item-foot">
                        {a.tags.map((t) => (
                          <span key={t} className="pk-chip">{t}</span>
                        ))}
                        <select
                          className="pk-select"
                          value={a.status}
                          onChange={(e) => updateAnnotation(a.id, { status: e.target.value as Status })}
                          aria-label="Status"
                        >
                          {(Object.keys(STATUS_LABEL) as Status[]).map((s) => (
                            <option key={s} value={s}>{STATUS_LABEL[s]}</option>
                          ))}
                        </select>
                      </div>
                    </li>
                  ))}
                </ol>
              )}

              <div className="pk-panel-foot">
                <button type="button" className="pk-btn pk-danger" onClick={clearAll} disabled={!visible.length}>
                  Clear all
                </button>
                <button type="button" className="pk-btn" onClick={() => void copyPrompt(visible)}>
                  Copy all
                </button>
                <button
                  type="button"
                  className="pk-btn pk-primary"
                  onClick={() => void sendToClaude(visible)}
                  disabled={sending || !visible.some((a) => a.status === "open")}
                  title="Open a new Claude Code conversation in VS Code with this prompt"
                >
                  {sending ? "Sending…" : "Send to Claude"}
                </button>
              </div>
            </div>
          )}

          {/* appearance settings */}
          {panel === "settings" && (
            <div data-pickr className="pk-panel pk-ui pk-settings" style={edgeSide}>
              <h3 className="pk-h">Appearance</h3>
              <label className="pk-row">
                <span>Theme</span>
                {seg(settings.theme, [["light", "Light"], ["dark", "Dark"], ["page", "Page"]], (theme) => setSettings({ ...settings, theme }))}
              </label>
              <div className="pk-row">
                <span>Accent</span>
                <span className="pk-accent">
                  <input
                    type="color"
                    value={hex6(settings.accent)}
                    onChange={(e) => setSettings({ ...settings, accent: e.target.value })}
                    aria-label="Accent colour picker"
                  />
                  <input
                    className="pk-input"
                    value={accentText}
                    spellCheck={false}
                    aria-label="Accent colour hex"
                    onChange={(e) => {
                      const v = e.target.value.trim();
                      setAccentText(v);
                      if (isHex(v)) setSettings({ ...settings, accent: v });
                    }}
                  />
                </span>
              </div>
              <div className="pk-row">
                <span>Highlight</span>
                {seg(settings.highlight, [["dashed", "Dashed"], ["solid", "Solid"]], (highlight) => setSettings({ ...settings, highlight }))}
              </div>
              <label className="pk-row">
                <span>Fill highlight</span>
                <input type="checkbox" checked={settings.fill} onChange={(e) => setSettings({ ...settings, fill: e.target.checked })} />
              </label>
              <div className="pk-row">
                <span>Toolbar</span>
                {seg(settings.position, [["bottom", "Bottom"], ["top", "Top"]], (position) => setSettings({ ...settings, position }))}
              </div>
              <div className="pk-panel-foot">
                <button type="button" className="pk-btn" onClick={() => setSettings(DEFAULT_SETTINGS)}>
                  Reset
                </button>
              </div>
            </div>
          )}

          {/* hint + toast */}
          {(toast || (picking && !draft)) && (
            <div data-pickr className="pk-hint" style={atTop ? { top: TOOLBAR_SPACE } : { bottom: TOOLBAR_SPACE }} role="status">
              {toast ?? "Click to pick · Shift+click to add · ↑/↓ parent/child · Enter to pick · Esc to stop"}
            </div>
          )}

          {/* toolbar */}
          <div data-pickr className={`pk-toolbar pk-ui ${atTop ? "pk-top" : "pk-bottom"}`} role="toolbar" aria-label="Pickr">
            <span className="pk-brand">
              <span className="pk-dot" />
              Pickr
            </span>
            <button
              type="button"
              className={`pk-btn ${picking ? "pk-on" : ""}`}
              aria-pressed={picking}
              onClick={() => (picking ? stopPicking() : setPicking(true))}
              title="Ctrl+I"
            >
              {picking ? "Picking…" : "Pick"} <kbd>Ctrl+I</kbd>
            </button>
            <button
              type="button"
              className={`pk-btn ${panel === "list" ? "pk-on" : ""}`}
              onClick={() => setPanel((p) => (p === "list" ? "none" : "list"))}
            >
              {openCount} change{openCount === 1 ? "" : "s"}
            </button>
            <button type="button" className="pk-btn pk-primary" onClick={() => void copyPrompt(pageList)}>
              Copy prompt
            </button>
            <button
              type="button"
              className={`pk-icon ${panel === "settings" ? "pk-on" : ""}`}
              onClick={() => setPanel((p) => (p === "settings" ? "none" : "settings"))}
              title="Appearance"
              aria-label="Appearance settings"
            >
              <Gear />
            </button>
            <button type="button" className="pk-icon" onClick={() => setOpen(false)} title="Close" aria-label="Close Pickr">
              ×
            </button>
          </div>
        </>
      )}
    </div>
  );

  return createPortal(ui, document.body);
}

/* ------------------------------------------------------------------ styles */

const CSS_TEXT = `
.pk-root{position:fixed;inset:0;pointer-events:none;z-index:2147483647;
  font:13px/1.4 "Segoe UI",system-ui,sans-serif;color:var(--pk-fg);text-align:left;letter-spacing:normal;
  --pk-bg:#fff;--pk-fg:#1b1f24;--pk-muted:#5b6470;--pk-border:#d9dee4;--pk-surface:#f3f5f7;
  --pk-danger:#c93434;--pk-shadow:0 10px 32px rgba(0,0,0,.18)}
.pk-root.pk-dark{--pk-bg:#1c2128;--pk-fg:#e8ecef;--pk-muted:#9aa5b1;--pk-border:#363d47;--pk-surface:#262c35;
  --pk-danger:#ff7b7b;--pk-shadow:0 10px 32px rgba(0,0,0,.55)}
.pk-root *,.pk-root *::before,.pk-root *::after{box-sizing:border-box}
.pk-root button,.pk-root input,.pk-root textarea,.pk-root select{font:inherit;color:inherit;margin:0;text-transform:none}
.pk-root :focus-visible{outline:2px solid var(--pk-accent);outline-offset:2px}
.pk-root kbd{font:11px/1 ui-monospace,Consolas,monospace;padding:2px 5px;border-radius:4px;border:1px solid currentColor;opacity:.7}
.pk-ui{pointer-events:auto}
.pk-muted{color:var(--pk-muted)}
.pk-danger{color:var(--pk-danger)!important}

.pk-box{position:fixed;pointer-events:none;border:2px dashed var(--pk-accent);border-radius:2px}
.pk-fill{background:color-mix(in srgb,var(--pk-accent) 14%,transparent)}
.pk-label{position:absolute;left:-2px;white-space:nowrap;background:var(--pk-accent);color:var(--pk-on-accent);
  font-size:11px;font-weight:600;padding:2px 6px;border-radius:4px}

.pk-toolbar{position:fixed;left:50%;transform:translateX(-50%);display:flex;flex-wrap:wrap;justify-content:center;
  align-items:center;gap:6px;padding:6px;max-width:calc(100vw - 16px);background:var(--pk-bg);
  border:1px solid var(--pk-border);border-radius:12px;box-shadow:var(--pk-shadow)}
.pk-toolbar.pk-bottom{bottom:16px}.pk-toolbar.pk-top{top:16px}
.pk-brand{display:flex;align-items:center;gap:6px;font-weight:700;padding:0 6px}
.pk-dot{width:10px;height:10px;border-radius:50%;background:var(--pk-accent)}

.pk-btn{display:inline-flex;align-items:center;gap:6px;height:32px;padding:0 12px;border-radius:8px;cursor:pointer;
  white-space:nowrap;border:1px solid var(--pk-border);background:var(--pk-surface)}
.pk-btn:hover:not(:disabled){border-color:var(--pk-accent)}
.pk-root button:disabled{opacity:.45;cursor:default}
.pk-primary{background:var(--pk-accent);border-color:var(--pk-accent);color:var(--pk-on-accent)}
.pk-btn.pk-on,.pk-icon.pk-on{border-color:var(--pk-accent);background:color-mix(in srgb,var(--pk-accent) 18%,var(--pk-surface))}
.pk-icon{display:inline-grid;place-items:center;width:32px;height:32px;border-radius:8px;cursor:pointer;font-size:18px;line-height:1;
  border:1px solid transparent;background:transparent}
.pk-icon:hover:not(:disabled){background:var(--pk-surface)}
.pk-icon.pk-sm{width:24px;height:24px;font-size:14px}
.pk-mini{height:26px;padding:0 9px;border-radius:6px;border:1px solid var(--pk-border);background:var(--pk-surface);cursor:pointer;font-size:12px}
.pk-mini:hover:not(:disabled){border-color:var(--pk-accent)}

.pk-fab{position:fixed;right:20px;width:44px;height:44px;border-radius:50%;border:0;cursor:pointer;font-weight:800;font-size:16px;
  background:var(--pk-accent);color:var(--pk-on-accent);box-shadow:var(--pk-shadow)}

.pk-pin{position:fixed;display:grid;place-items:center;width:22px;height:22px;padding:0;border-radius:50%;cursor:pointer;
  font-size:11px;font-weight:700;background:var(--pk-accent);color:var(--pk-on-accent);border:2px solid var(--pk-bg);
  box-shadow:0 2px 6px rgba(0,0,0,.3)}
.pk-pin:hover{transform:scale(1.15)}
.pk-pin.pk-dim,.pk-item.pk-dim{opacity:.5}

.pk-pop{position:fixed;display:flex;flex-direction:column;gap:8px;padding:10px;background:var(--pk-bg);
  border:1px solid var(--pk-border);border-radius:12px;box-shadow:var(--pk-shadow)}
.pk-pop.pk-sheet{left:8px;right:8px;margin:0 auto;max-width:560px;border-radius:14px}
.pk-pop-head{display:flex;align-items:center;gap:6px}
.pk-pop-title{flex:1;min-width:0;display:flex;flex-direction:column}
.pk-pop-title>*{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pk-pop-title .pk-muted{font:11px/1.3 ui-monospace,Consolas,monospace}
.pk-text{width:100%;resize:vertical;min-height:64px;padding:8px;border-radius:8px;border:1px solid var(--pk-border);
  background:var(--pk-surface)}
.pk-text:focus{outline:none;border-color:var(--pk-accent)}
.pk-tags{display:flex;flex-wrap:wrap;gap:6px}
.pk-tag{height:24px;padding:0 10px;border-radius:999px;cursor:pointer;font-size:12px;border:1px solid var(--pk-border);background:transparent}
.pk-tag.pk-on{background:var(--pk-accent);border-color:var(--pk-accent);color:var(--pk-on-accent)}
.pk-pop-foot{display:flex;align-items:center;gap:8px}
.pk-keys{flex:1;font-size:11px}

.pk-panel{position:fixed;right:16px;width:400px;max-width:calc(100vw - 16px);max-height:calc(100vh - ${TOOLBAR_SPACE + 24}px);
  display:flex;flex-direction:column;gap:10px;padding:12px;background:var(--pk-bg);border:1px solid var(--pk-border);
  border-radius:12px;box-shadow:var(--pk-shadow)}
@media (max-width:639px){.pk-panel{left:8px;right:8px;width:auto}}
.pk-panel-head,.pk-panel-foot{display:flex;align-items:center;justify-content:space-between;gap:8px}
.pk-panel-foot{justify-content:flex-end}
.pk-seg{display:inline-flex;border:1px solid var(--pk-border);border-radius:8px;overflow:hidden}
.pk-seg button{height:28px;padding:0 10px;border:0;background:transparent;cursor:pointer;font-size:12px}
.pk-seg button+button{border-left:1px solid var(--pk-border)}
.pk-seg button.pk-on{background:var(--pk-accent);color:var(--pk-on-accent)}
.pk-list{list-style:none;margin:0;padding:0;overflow:auto;display:flex;flex-direction:column;gap:8px}
.pk-item{padding:8px 10px;border:1px solid var(--pk-border);border-radius:10px;background:var(--pk-surface)}
.pk-item-head{display:flex;align-items:center;gap:6px}
.pk-num{display:grid;place-items:center;min-width:20px;height:20px;border-radius:50%;font-size:11px;font-weight:700;
  background:var(--pk-accent);color:var(--pk-on-accent)}
.pk-link{flex:1;min-width:0;text-align:left;border:0;background:none;cursor:pointer;font-weight:600;padding:0;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pk-link:hover{text-decoration:underline}
.pk-actions{display:flex;gap:2px}
.pk-meta{font:11px/1.4 ui-monospace,Consolas,monospace;margin:2px 0 4px;overflow-wrap:anywhere}
.pk-comment{margin:0 0 6px;white-space:pre-wrap;overflow-wrap:anywhere}
.pk-item-foot{display:flex;flex-wrap:wrap;align-items:center;gap:4px}
.pk-chip{font-size:11px;padding:1px 8px;border-radius:999px;border:1px solid var(--pk-border)}
.pk-select{margin-left:auto!important;height:24px;border-radius:6px;border:1px solid var(--pk-border);background:var(--pk-bg);font-size:12px}
.pk-preview{margin:0;padding:10px;overflow:auto;white-space:pre-wrap;font:12px/1.5 ui-monospace,Consolas,monospace;
  background:var(--pk-surface);border-radius:8px;border:1px solid var(--pk-border)}
.pk-empty{margin:8px 0;color:var(--pk-muted)}

.pk-settings{width:340px}
.pk-h{margin:0;font-size:14px}
.pk-row{display:flex;align-items:center;justify-content:space-between;gap:10px}
.pk-accent{display:flex;align-items:center;gap:6px}
.pk-accent input[type=color]{width:32px;height:28px;padding:0;border:1px solid var(--pk-border);border-radius:6px;background:none;cursor:pointer}
.pk-input{width:90px;height:28px;padding:0 8px;border-radius:6px;border:1px solid var(--pk-border);background:var(--pk-surface);
  font-family:ui-monospace,Consolas,monospace}

.pk-hint{position:fixed;left:50%;transform:translateX(-50%);max-width:calc(100vw - 16px);padding:6px 12px;border-radius:999px;
  font-size:12px;text-align:center;background:var(--pk-bg);border:1px solid var(--pk-border);box-shadow:var(--pk-shadow)}
`;
