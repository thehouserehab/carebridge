export const escape = (value) =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
export const icons = {
  home: "M3 10 12 3l9 7v10H3Z M9 20v-7h6v7",
  child: "M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM4 21v-2a8 8 0 0 1 16 0v2",
  record: "M6 3h12v18H6Z M9 8h6M9 12h6M9 16h4",
  activity: "M4 5h16v14H4Z M8 12l3 3 5-6",
  calendar: "M4 6h16v15H4Z M8 3v6M16 3v6M4 11h16",
  arrow: "M5 12h14M13 6l6 6-6 6",
  plus: "M12 5v14M5 12h14",
  chevron: "m9 5 7 7-7 7",
  clock: "M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z",
  check: "m5 12 4 4L19 6",
  lock: "M6 10h12v11H6Z M8 10V6a4 4 0 0 1 8 0v4",
  close: "m6 6 12 12M6 18 18 6",
  target:
    "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM17 12a5 5 0 1 1-10 0 5 5 0 0 1 10 0ZM12 10v4",
  message: "M3 4h18v13H9l-6 4Z M7 9h10M7 13h6",
};
export const icon = (name) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${(
    icons[name] || icons.record
  )
    .split(" M")
    .map((p, i) => `<path d="${i ? "M" : ""}${p}"/>`)
    .join("")}</svg>`;
export const button = (
  label,
  action,
  id = "",
  style = "secondary",
  extra = "",
) =>
  `<button type="button" class="button ${style}" data-action="${action}" data-id="${escape(id)}" ${extra}>${label}</button>`;
export const badge = (label, type = "neutral") =>
  `<span class="badge ${type}">${escape(label)}</span>`;
export const dateLabel = (
  date,
  options = { month: "long", day: "numeric", weekday: "short" },
) =>
  new Intl.DateTimeFormat("ko-KR", options).format(
    new Date(`${String(date).slice(0, 10)}T12:00:00`),
  );
export const empty = (title, description, action = "") =>
  `<div class="empty">${icon("record")}<h3>${escape(title)}</h3><p>${escape(description)}</p>${action}</div>`;
export function field(label, name, value = "", options = {}) {
  const {
    type = "text",
    required = false,
    max = 2000,
    placeholder = "",
    hint = "",
    min,
    step,
  } = options;
  return `<label class="field"><span>${escape(label)}${required ? " <em>필수</em>" : ""}</span>${type === "textarea" ? `<textarea name="${name}" ${required ? "required" : ""} maxlength="${max}" placeholder="${escape(placeholder)}" rows="3">${escape(value)}</textarea>` : `<input name="${name}" type="${type}" value="${escape(value)}" ${required ? "required" : ""} ${min !== undefined ? `min="${min}"` : ""} ${step ? `step="${step}"` : ""} maxlength="${max}" placeholder="${escape(placeholder)}">`}${hint ? `<small>${escape(hint)}</small>` : ""}</label>`;
}
export function select(label, name, options, value) {
  return `<label class="field"><span>${escape(label)}</span><select name="${name}">${options.map(([v, t]) => `<option value="${escape(v)}" ${v === value ? "selected" : ""}>${escape(t)}</option>`).join("")}</select></label>`;
}
