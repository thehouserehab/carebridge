const text = (v, name, max = 2000) => {
  const s = String(v ?? "").trim();
  if (s.length > max)
    throw new Error(`${name}은 ${max}자 이내로 입력해 주세요.`);
  return s;
};
// Pure content rules shared by the local UI and the server record service.
// Relationship/reference authorization stays with each storage boundary.
export function isCompleteAssessment(row) {
  return row != null && Number.isFinite(row.value) &&
    ["tool", "item", "unit", "context"].every(
      (key) => typeof row[key] === "string" && row[key].trim() !== "",
    );
}
export function recordActivity(input, status) {
  if (input == null) return null;
  const activity = Object.fromEntries(
    ["title", "instruction", "frequency", "caution"].map((key) => [
      key, text(input[key], "가정 활동", key === "instruction" ? 2000 : key === "caution" ? 500 : 100),
    ]),
  );
  if (status !== "draft" && ["title", "instruction", "frequency"].some((key) => !activity[key]))
    throw new Error("가정 활동의 이름·안내·빈도를 모두 입력해 주세요.");
  return activity;
}
export function recordDetails(input, old) {
  const status = input.status ?? "saved";
  if (!["draft", "saved"].includes(status))
    throw new Error("기록 상태를 확인해 주세요.");
  const assessments =
    input.assessments ?? (input.assessment ? [input.assessment] : []);
  if (!Array.isArray(assessments) || assessments.length > 20)
    throw new Error("측정값은 20개까지 추가할 수 있어요.");
  const normalized = assessments.map((a) => {
    if (!a || typeof a !== "object" || Array.isArray(a))
      throw new Error("측정 항목을 확인해 주세요.");
    const row = Object.fromEntries(
      ["tool", "item", "unit", "context"].map((k) => [
        k,
        text(a[k], "측정 항목", k === "context" ? 300 : 100),
      ]),
    );
    const missing = a.value == null || (typeof a.value === "string" && !a.value.trim());
    const value = missing ? null : Number(a.value);
    if ((!missing && (!["number", "string"].includes(typeof a.value) || !Number.isFinite(value))) ||
        (status !== "draft" && (!Object.values(row).every(Boolean) || missing)))
      throw new Error(
        "측정값의 도구·항목·숫자·단위·조건을 모두 입력해 주세요.",
      );
    return { ...row, value };
  });
  let observation = null;
  if (input.observation) {
    const o = input.observation;
    if (!["observed", "not-observed", "not-applicable", ""].includes(o.status))
      throw new Error("관찰 상태를 확인해 주세요.");
    observation = { status: o.status };
    for (const k of [
      "task",
      "assistance",
      "amount",
      "repetitions",
      "duration",
      "context",
    ])
      observation[k] = text(o[k], "상세 관찰", 500);
    if (
      o.status !== "observed" && !(status === "draft" && o.status === "") &&
      Object.entries(observation).some(([k, v]) => k !== "status" && v)
    )
      throw new Error(
        "상세 관찰 내용을 적었다면 상태를 ‘관찰함’으로 선택해 주세요.",
      );
  }
  return {
    format:
      input.format === "legacy" || old?.format === "legacy"
        ? "legacy"
        : "structured",
    status,
    performed: text(input.performed, "오늘 한 활동"),
    response: text(input.response, "아이의 반응"),
    observation,
    assessments: normalized,
    assessment: null,
  };
}
export function recordFields(input, old, db, childId) {
  const details = recordDetails(input, old);
  const referenceMessageIds = [
    ...new Set(input.referenceMessageIds ?? old?.referenceMessageIds ?? []),
  ];
  if (
    referenceMessageIds.length > 20 ||
    !referenceMessageIds.every((id) =>
      db.messages.some((m) => m.id === id && m.childId === childId),
    )
  )
    throw new Error("참고할 대화 연결을 확인해 주세요.");
  return {
    ...details,
    referenceMessageIds,
  };
}
export function hasRecordContent(record) {
  return (
    ["summary", "privateNote", "performed", "response", "nextPlan"].some(
      (key) => typeof record[key] === "string" && record[key].trim(),
    ) ||
    (record.assessments ?? []).some(isCompleteAssessment) ||
    (record.observation?.status === "observed" &&
      Object.entries(record.observation).some(
        ([key, value]) => key !== "status" && typeof value === "string" && value.trim(),
      ))
  );
}
export function validRecordFields(r, db) {
  try {
    // Schema-2 measurements allowed blank/untrimmed metadata. The migration
    // retains the original singular row beside its exact clinical-field copy.
    // Only that unchanged historical row bypasses new-entry normalization;
    // recordDetails still validates every edited/new measurement on writes.
    const original = r.assessment;
    const preservedLegacyAssessment = r.format === "legacy" && original &&
      Number.isFinite(original.value) &&
      ["tool", "item", "unit", "context"].every((key) => typeof original[key] === "string") &&
      Array.isArray(r.assessments) && r.assessments.length === 1 &&
      r.assessments[0] && !Array.isArray(r.assessments[0]) &&
      ["tool", "item", "value", "unit", "context"].every((key) => r.assessments[0][key] === original[key]);
    if (r.format === "legacy" && original !== null && !preservedLegacyAssessment) return false;
    const readable = preservedLegacyAssessment ? { ...r, assessments: [] } : r;
    const normalized = recordFields(readable, r, db, r.childId);
    // Read historical free-text activities without new normalization rules.
    // Newly saved content still passes recordActivity at the write boundary.
    const activity = r.format === "legacy" ? null : recordActivity(r.activity, r.status);
    return (
      ["draft", "saved"].includes(r.status) &&
      ["legacy", "structured"].includes(r.format) &&
      typeof r.performed === "string" &&
      typeof r.response === "string" &&
      Array.isArray(r.assessments) &&
      Array.isArray(r.referenceMessageIds) &&
      (activity === null || Object.keys(activity).every((key) => activity[key] === r.activity[key])) &&
      normalized.assessments.every((a, i) =>
        Object.keys(a).every((k) => a[k] === r.assessments[i][k]),
      )
    );
  } catch {
    return false;
  }
}
