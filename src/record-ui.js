import { escape as e, field, select, button } from "./ui.js";
export function assessmentRow(a = {}, index = 0) {
  const prefix = `assessment-${index}-`;
  return `<fieldset class="assessment-row" data-assessment><legend>측정값 ${index + 1}</legend><div class="form-grid">${field("평가 도구", prefix + "tool", a.tool || "", { required: true, max: 100 })}${field("평가 항목", prefix + "item", a.item || "", { required: true, max: 100 })}${field("측정값", prefix + "value", a.value ?? "", { required: true, type: "number", step: "any" })}${field("단위", prefix + "unit", a.unit || "", { required: true, max: 100 })}</div>${field("측정 조건", prefix + "context", a.context || "", { required: true, max: 300, placeholder: "측면, 자세, 도움 수준 등" })}${button("이 측정값 제거", "remove-assessment", "", "text")}</fieldset>`;
}
export function recordEditor(r, goals, date, references = []) {
  const o = r.observation || {};
  const h = r.activity || {};
  return `${r.publicationId ? '<p class="notice">수정한 내용은 재공유 전까지 내부에만 저장됩니다. 기존 공유본과 답변은 유지돼요.</p>' : ""}${r.format === "legacy" ? '<p class="notice">기존 형식 기록입니다. 과거 자유 텍스트를 활동·반응으로 자동 분류하지 않았습니다.</p>' : ""}${references.map((m) => `<aside class="reference-note"><span class="tiny-label">참고한 대화 · 관찰 결과와 구분해 기록하세요</span><blockquote>${e(m.body)}</blockquote>${button("원문 보기", "view-reference", m.id, "text")}</aside>`).join("")}<div class="form-grid">${field("기록 날짜", "date", date, { type: "date", required: true })}${select(
    "연결할 목표",
    "goalId",
    goals.map((g) => [g.id, g.title]),
    r.goalId || goals[0].id,
  )}</div>${field("오늘 한 활동", "performed", r.performed || "", { type: "textarea", placeholder: "무엇을 어떻게 진행했나요?" })}${field("아이의 반응", "response", r.response || "", { type: "textarea", placeholder: "직접 관찰한 모습을 적어 주세요" })}${field("다음 계획", "nextPlan", r.nextPlan || "", { type: "textarea", hint: "치료사 내부용 · 보호자용 요약과 따로 저장됩니다." })}<details class="record-details" ${r.observation || r.assessments?.length ? "open" : ""}><summary>상세 관찰·측정값</summary>${select(
    "관찰 상태",
    "observation-status",
    [
      ["", "선택하지 않음"],
      ["observed", "관찰함"],
      ["not-observed", "미관찰"],
      ["not-applicable", "해당 없음"],
    ],
    o.status || "",
  )}<div class="form-grid">${[
    ["task", "수행 과제"],
    ["assistance", "도움의 종류"],
    ["amount", "도움의 정도"],
    ["repetitions", "횟수"],
    ["duration", "시간"],
    ["context", "관찰 조건"],
  ]
    .map(([k, label]) =>
      field(label, `observation-${k}`, o[k] || "", { max: 500 }),
    )
    .join(
      "",
    )}</div><p class="footnote">미입력은 0으로 처리하지 않습니다. 미관찰·해당 없음은 구분해 선택하세요.</p><div id="assessment-rows">${(r.assessments || []).map(assessmentRow).join("")}</div>${button("측정값 추가", "add-assessment", "", "soft")}<p class="footnote">자동 점수 산정이 아닌 직접 입력값입니다. 도구의 적합성과 사용 조건을 확인하세요.</p></details><details class="record-details" ${r.activity ? "open" : ""}><summary>가정 활동</summary><label class="toggle-row"><input type="checkbox" name="hasActivity" data-toggle="activity-fields" ${r.activity ? "checked" : ""}><span>목표에 연결된 가정 활동 추가</span></label><fieldset id="activity-fields" ${r.activity ? "" : "hidden disabled"}><legend>가정 활동</legend>${field("활동 이름", "activityTitle", h.title || "", { required: true, max: 100 })}${field("활동 안내", "instruction", h.instruction || "", { required: true, type: "textarea" })}${field("활동 빈도·시간", "frequency", h.frequency || "", { required: true, max: 100 })}${field("유의사항", "caution", h.caution || "", { type: "textarea", max: 500 })}</fieldset></details><details class="record-details" ${r.privateNote ? "open" : ""}><summary>치료사 내부 메모</summary>${field("내부 메모", "privateNote", r.privateNote || "", { type: "textarea", hint: "보호자와 센터 화면에 표시되지 않습니다." })}</details><details class="record-details" ${r.summary ? "open" : ""}><summary>공유 요약·제목</summary>${field("기록 제목", "title", r.title || "", { max: 100, placeholder: "비워 두면 날짜와 활동으로 제목을 제안해요" })}${field("보호자에게 전할 내용", "summary", r.summary || "", { type: "textarea", hint: "공유할 때 필수입니다. 치료사가 작성·확인한 요약만 전달돼요." })}</details>`;
}
export function parseRecordForm(form) {
  const values = Object.fromEntries(new FormData(form));
  const observation = Object.fromEntries(
    [
      "status",
      "task",
      "assistance",
      "amount",
      "repetitions",
      "duration",
      "context",
    ].map((k) => [k, values[`observation-${k}`] || ""]),
  );
  const assessments = [...form.querySelectorAll("[data-assessment]")].map(
    (row) =>
      Object.fromEntries(
        ["tool", "item", "value", "unit", "context"].map((k) => [
          k,
          row.querySelector(`[name$="-${k}"]`).value,
        ]),
      ),
  );
  return {
    ...values,
    observation: Object.values(observation).some(Boolean) ? observation : null,
    assessments,
    activity: values.hasActivity
      ? {
          title: values.activityTitle,
          instruction: values.instruction,
          frequency: values.frequency,
          caution: values.caution,
        }
      : null,
  };
}
export function recordDetail(r) {
  return `<dl class="record-facts">${[
    ["오늘 한 활동", r.performed],
    ["아이의 반응", r.response],
    ["다음 계획", r.nextPlan],
    ["내부 메모", r.privateNote],
  ]
    .filter(([, v]) => v)
    .map(([label, v]) => `<div><dt>${label}</dt><dd>${e(v)}</dd></div>`)
    .join(
      "",
    )}</dl>${r.format === "legacy" ? '<p class="footnote">기존 형식 기록 · 원문 보존</p>' : ""}${
    r.observation
      ? `<p>관찰 상태 · ${{ observed: "관찰함", "not-observed": "미관찰", "not-applicable": "해당 없음", "": "미선택" }[r.observation.status]}</p><dl class="record-facts">${[
          ["task", "과제"],
          ["assistance", "도움 종류"],
          ["amount", "도움 정도"],
          ["repetitions", "횟수"],
          ["duration", "시간"],
          ["context", "조건"],
        ]
          .filter(([k]) => r.observation[k])
          .map(
            ([k, label]) =>
              `<div><dt>${label}</dt><dd>${e(r.observation[k])}</dd></div>`,
          )
          .join("")}</dl>`
      : ""
  }${(r.assessments || []).map((a) => `<p><strong>${e(a.tool)} · ${e(a.item)}</strong><br>${e(a.value)} ${e(a.unit)} · ${e(a.context)}</p>`).join("")}`;
}
