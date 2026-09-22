const text = (v, name, max = 2000) => {
  const s = String(v ?? "").trim();
  if (s.length > max)
    throw new Error(`${name}은 ${max}자 이내로 입력해 주세요.`);
  return s;
};
export function recordFields(input, old, db, childId) {
  const status = input.status ?? "saved";
  if (!["draft", "saved"].includes(status))
    throw new Error("기록 상태를 확인해 주세요.");
  const assessments =
    input.assessments ?? (input.assessment ? [input.assessment] : []);
  if (!Array.isArray(assessments) || assessments.length > 20)
    throw new Error("측정값은 20개까지 추가할 수 있어요.");
  const normalized = assessments.map((a) => {
    const row = Object.fromEntries(
      ["tool", "item", "unit", "context"].map((k) => [
        k,
        text(a[k], "측정 항목", k === "context" ? 300 : 100),
      ]),
    );
    if (
      !Object.values(row).every(Boolean) ||
      String(a.value ?? "").trim() === "" ||
      !Number.isFinite(Number(a.value))
    )
      throw new Error(
        "측정값의 도구·항목·숫자·단위·조건을 모두 입력해 주세요.",
      );
    return { ...row, value: Number(a.value) };
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
      o.status !== "observed" &&
      Object.entries(observation).some(([k, v]) => k !== "status" && v)
    )
      throw new Error(
        "상세 관찰 내용을 적었다면 상태를 ‘관찰함’으로 선택해 주세요.",
      );
  }
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
    referenceMessageIds,
  };
}
export function validRecordFields(r, db) {
  try {
    const normalized = recordFields(r, r, db, r.childId);
    return (
      ["draft", "saved"].includes(r.status) &&
      ["legacy", "structured"].includes(r.format) &&
      typeof r.performed === "string" &&
      typeof r.response === "string" &&
      Array.isArray(r.assessments) &&
      Array.isArray(r.referenceMessageIds) &&
      normalized.assessments.every((a, i) =>
        Object.keys(a).every((k) => a[k] === r.assessments[i][k]),
      )
    );
  } catch {
    return false;
  }
}
