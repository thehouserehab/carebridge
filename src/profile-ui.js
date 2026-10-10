import { escape as e, field } from "./ui.js";
import { profileToday } from "./profile-fields.js";
import { DEMO_CENTER } from "./config.js";

export function memberProfileEditor(member) {
  return `<p class="notice">${e(DEMO_CENTER.name)}에서 표시할 이름이에요. 이 브라우저의 가상 계정에만 반영되며 로그인·담당 관계·권한은 바뀌지 않아요.</p>
    <label class="field"><span>체험 표시 이름 <em>선택</em></span><input id="member-display-name" name="displayName" type="text" maxlength="30" value="${e(member.displayName ?? "")}" autocomplete="off" aria-describedby="member-name-help"></label>
    <p id="member-name-help" class="footnote">1~30자 · 비워서 저장하면 기본 표시로 돌아가요. 가상 이름만 입력하고 전화번호·이메일·건강정보는 넣지 마세요.</p>
    <p class="footnote">기본 표시: <strong>${e(member.defaultName)}</strong><br>이름을 바꿔도 이전 메시지의 작성자 ID와 공유본은 유지돼요. 이름은 본인 인증이 아니에요.</p>`;
}

export function childAgeLabel(child, detail = false) {
  if (child.age === null || child.age === undefined) return "연령 미입력";
  return `${child.age}세${detail ? child.ageAsOf ? ` · ${child.ageAsOf} 기준` : " · 기준일 미확인" : ""}`;
}
export function childProfileEditor(child = {}) {
  const legacy = Number.isInteger(child.age) && !Object.hasOwn(child, "ageAsOf");
  return `${field("가상 아동 이름", "name", child.name || "", { required: true, max: 30 })}
    <div class="form-grid"><label class="field"><span>연령 <em>선택</em></span><input name="age" type="number" min="0" max="26" step="1" value="${e(child.age ?? "")}" aria-describedby="child-age-help"></label>
    <label class="field"><span>연령 기준일 <em>연령 입력 시 필수</em></span><input name="ageAsOf" type="date" min="1900-01-01" max="${profileToday()}" value="${e(child.ageAsOf || "")}" aria-describedby="child-age-help"></label></div>
    <p id="child-age-help" class="footnote">0~26세 · 입력한 기준일의 연령이에요. 자동으로 증가시키지 않아요. 미입력으로 두려면 두 칸을 모두 비워 주세요.</p>
    ${legacy ? '<p class="notice">기존 연령은 기준일이 확인되지 않았어요. 이름만 수정하면 이전 값을 유지해요. 연령을 새로 확인하거나 바꾸면 기준일도 입력해 주세요.</p>' : ""}`;
}
