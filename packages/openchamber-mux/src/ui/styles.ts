export function injectStyle(id: string, css: string): void {
  if (document.querySelector(`style[data-mux-style="${id}"]`)) return
  const style = document.createElement("style")
  style.dataset.muxStyle = id
  style.textContent = css
  document.head.append(style)
}

/** 共享基础样式：完全基于 OpenChamber 宿主主题变量，确保明暗主题与工作状态侧栏融为一体。 */
export const MUX_SHARED_CSS = `
:root {
  color-scheme: light dark;
}

html, body {
  margin: 0;
  padding: 0;
  background: transparent;
  color: var(--oc-fg, var(--surface-foreground, inherit));
  font-family: var(--oc-font, var(--font-sans, sans-serif));
  font-size: 0.875rem;
  line-height: 1.45;
  overflow-x: hidden;
}

*, *::before, *::after {
  box-sizing: border-box;
}

[hidden] {
  display: none !important;
}

.mux-mono {
  font-family: var(--oc-mono, var(--font-mono, monospace));
}

.mux-num {
  font-variant-numeric: tabular-nums;
}

.mux-dot {
  position: relative;
  display: inline-block;
  width: 7px;
  height: 7px;
  border-radius: 9999px;
  flex: 0 0 auto;
  background: var(--oc-muted, #888);
}

.mux-dot[data-status="running"] {
  background: var(--oc-info, #3b82f6);
}

.mux-dot[data-status="running"]::after {
  content: "";
  position: absolute;
  inset: -3px;
  border-radius: 9999px;
  border: 1.5px solid var(--oc-info, #3b82f6);
  opacity: 0.55;
  animation: mux-pulse 1.8s cubic-bezier(0.22, 1, 0.36, 1) infinite;
}

.mux-dot[data-status="succeeded"] {
  background: var(--oc-success, #22c55e);
}

.mux-dot[data-status="failed"] {
  background: var(--oc-error, #ef4444);
}

.mux-dot[data-status="stopped"] {
  background: var(--oc-warning, #f59e0b);
}

.mux-dot[data-status="gone"] {
  background: color-mix(in srgb, var(--oc-muted, #888) 60%, transparent);
}

@keyframes mux-pulse {
  0% { transform: scale(0.85); opacity: 0.7; }
  70% { transform: scale(1.65); opacity: 0; }
  100% { transform: scale(1.65); opacity: 0; }
}

.mux-pill {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 6px;
  border-radius: 9999px;
  font-size: 0.6875rem;
  font-weight: 500;
  line-height: 1.4;
  white-space: nowrap;
  background: color-mix(in srgb, var(--oc-fg, currentColor) 7%, transparent);
  color: var(--oc-muted, inherit);
}

.mux-pill[data-tone="info"] {
  color: var(--oc-info-text, var(--oc-info, inherit));
  background: color-mix(in srgb, var(--oc-info, #3b82f6) 14%, transparent);
}

.mux-pill[data-tone="success"] {
  color: var(--oc-success-text, var(--oc-success, inherit));
  background: color-mix(in srgb, var(--oc-success, #22c55e) 14%, transparent);
}

.mux-pill[data-tone="warning"] {
  color: var(--oc-warning-text, var(--oc-warning, inherit));
  background: color-mix(in srgb, var(--oc-warning, #f59e0b) 14%, transparent);
}

.mux-pill[data-tone="error"] {
  color: var(--oc-error-text, var(--oc-error, inherit));
  background: color-mix(in srgb, var(--oc-error, #ef4444) 15%, transparent);
}

.mux-pill[data-tone="primary"] {
  color: var(--oc-primary-text, var(--oc-primary, inherit));
  background: color-mix(in srgb, var(--oc-primary, #3b82f6) 14%, transparent);
}

.mux-segmented {
  display: inline-flex;
  align-items: center;
  padding: 2px;
  border-radius: calc(var(--oc-radius, 9px) - 1px);
  background: color-mix(in srgb, var(--oc-fg, currentColor) 5%, transparent);
  border: 1px solid color-mix(in srgb, var(--oc-border, currentColor) 55%, transparent);
  gap: 2px;
}

.mux-seg-btn {
  appearance: none;
  border: 0;
  background: transparent;
  color: var(--oc-muted, inherit);
  font: inherit;
  font-size: 0.75rem;
  font-weight: 500;
  padding: 3px 9px;
  border-radius: calc(var(--oc-radius, 9px) - 3px);
  cursor: pointer;
  white-space: nowrap;
  transition: background 140ms ease, color 140ms ease, box-shadow 140ms ease;
}

.mux-seg-btn:hover {
  color: var(--oc-fg, inherit);
}

.mux-seg-btn[aria-pressed="true"] {
  background: var(--oc-elevated, var(--oc-bg, transparent));
  color: var(--oc-elevated-fg, var(--oc-fg, inherit));
  box-shadow: 0 1px 2px rgb(0 0 0 / 0.12);
}

/* 终端日志视口 */
.mux-log-box {
  position: relative;
  display: flex;
  flex-direction: column;
  min-height: 180px;
  flex: 1 1 auto;
  border-radius: calc(var(--oc-radius, 9px) - 2px);
  border: 1px solid color-mix(in srgb, var(--oc-border, currentColor) 65%, transparent);
  background: color-mix(in srgb, var(--oc-fg, #000) 4%, var(--oc-elevated, var(--oc-bg, transparent)));
  overflow: hidden;
}

:root[data-oc-theme="dark"] .mux-log-box {
  background: color-mix(in srgb, #000 32%, var(--oc-bg, #111));
}

.mux-log-box--compact {
  min-height: 92px;
  max-height: 148px;
}

.mux-log-box[data-error="true"] {
  border-color: color-mix(in srgb, var(--oc-error, #ef4444) 40%, transparent);
}

.mux-log-scroll {
  flex: 1 1 auto;
  overflow: auto;
  padding: 8px 10px;
  min-height: 0;
}

.mux-log-pre {
  margin: 0;
  font-family: var(--oc-mono, var(--font-mono, monospace));
  font-size: 0.75rem;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
  overflow-wrap: anywhere;
  color: var(--oc-fg, inherit);
  user-select: text;
}

.mux-log-empty {
  padding: 10px 2px;
  font-size: 0.75rem;
  color: var(--oc-muted, inherit);
  text-align: center;
}

.mux-log-jump {
  position: absolute;
  right: 10px;
  bottom: 8px;
  appearance: none;
  border: 1px solid color-mix(in srgb, var(--oc-border, currentColor) 80%, transparent);
  background: var(--oc-elevated, var(--oc-bg, #222));
  color: var(--oc-primary-text, var(--oc-fg, inherit));
  font: inherit;
  font-size: 0.7rem;
  font-weight: 500;
  padding: 3px 9px;
  border-radius: 9999px;
  cursor: pointer;
  box-shadow: 0 2px 8px rgb(0 0 0 / 0.18);
  transition: transform 120ms ease, background 120ms ease;
}

.mux-log-jump:hover {
  transform: translateY(-1px);
  background: var(--oc-hover, var(--oc-elevated, #333));
}
`
