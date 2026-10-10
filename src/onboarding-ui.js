import { escape as e, icon, badge } from "./ui.js";
import { MEMBER_ROLES, INVITE_STATUSES, DEMO_CENTER } from "./onboarding-demo.js";

export const accountButton = (label, action, id = "", style = "secondary", attributes = "") =>
  `<button type="button" class="button ${style}" data-onboarding="${action}" data-id="${e(id)}" ${attributes}>${label}</button>`;
const time = (date) => new Intl.DateTimeFormat("ko-KR", { month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(date));
const notice = `<p class="account-notice">화면 체험 중 · 메일은 발송되지 않으며 새로고침하면 초대 내역이 초기화돼요.</p>`;
const empty = (title, body) => `<div class="account-empty">${icon("child")}<h3>${title}</h3><p>${body}</p></div>`;

export function membersScreen(snapshot, tab = "members", filter = "all") {
  const pending = snapshot.invitations.filter((i) => i.status === "pending").length;
  const invitations = snapshot.invitations.filter((i) => filter === "all" || i.status === filter);
  return `<div class="account-workspace">
    <section class="account-intro"><div><p class="eyebrow">함께하는 사람들</p><h2>초대에서 시작되는 연결</h2><p>치료사와 보호자를 초대하고, 함께할 준비를 확인해요.</p></div>
      ${accountButton(`${icon("plus")} 구성원 초대`, "invite", "", "primary")}</section>
    ${notice}
    <section class="panel account-panel"><div class="account-tabs" aria-label="구성원 보기">
      ${accountButton(`구성원 <span>${snapshot.members.length}</span>`, "tab", "members", tab === "members" ? "active" : "text", `aria-pressed="${tab === "members"}"`)}
      ${accountButton(`초대 내역 <span>${pending}</span>`, "tab", "invitations", tab === "invitations" ? "active" : "text", `aria-pressed="${tab === "invitations"}"`)}
    </div>
    ${tab === "members" ? `<div class="account-roster">${snapshot.members.map((m) => `<article class="account-person"><span class="avatar ${m.role === "guardian" ? "green" : "blue"}">${e(m.name.slice(0, 1))}</span><div class="account-person-main"><h3>${e(m.name)}</h3><p>${e(m.email)}</p></div>${badge(MEMBER_ROLES[m.role])}${accountButton("권한 안내", "permissions", m.role, "text")}</article>`).join("")}</div><p class="account-footnote">가입 이후 아동별 담당 관계를 확인해야 기록과 대화를 열람할 수 있어요.</p>`
      : `<div class="account-filter"><label for="invitation-filter">초대 상태</label><select id="invitation-filter"><option value="all" ${filter === "all" ? "selected" : ""}>전체</option>${Object.entries(INVITE_STATUSES).map(([key, label]) => `<option value="${key}" ${filter === key ? "selected" : ""}>${label}</option>`).join("")}</select></div>
      ${invitations.length ? `<div class="account-roster">${invitations.map((i) => `<article class="account-person"><span class="avatar blue">${icon("message")}</span><div class="account-person-main"><h3>${e(i.email)}</h3><p>${MEMBER_ROLES[i.role]} · ${time(i.createdAt)} 작성</p><small>${i.status === "pending" ? `${time(i.expiresAt)}까지 수락 가능` : INVITE_STATUSES[i.status]}</small></div>${badge(INVITE_STATUSES[i.status], i.status === "accepted" ? "green" : "neutral")}<div class="account-row-actions">${i.status === "pending" ? `${accountButton("수락 화면", "accept", i.id, "text")}${accountButton("초대 취소", "revoke", i.id, "text")}` : ["expired", "revoked"].includes(i.status) ? accountButton("다시 초대", "reissue", i.id, "text") : ""}</div></article>`).join("")}</div>` : empty("아직 초대 내역이 없어요", "함께할 치료사와 보호자를 초대해 보세요.")}`}
    </section><div class="account-help"><div><h3>어떤 정보를 볼 수 있나요?</h3><p>센터 운영, 치료 기록, 보호자 공유 범위를 역할에 맞게 나눠요.</p></div>${accountButton("역할별 권한 보기", "permissions", "all", "text")}</div>
  </div>`;
}

export function inviteForm() {
  return `<p class="account-lead">함께할 분의 역할과 이메일을 확인해 주세요.</p>
    <fieldset class="account-role-picker"><legend>초대할 역할</legend>${["therapist", "guardian"].map((role, i) => `<label><input type="radio" name="role" value="${role}" ${i === 0 ? "checked" : ""}><span><strong>${MEMBER_ROLES[role]}</strong><small>${i === 0 ? "담당 아동의 기록과 보호자 소통" : "내 아이의 공유 기록과 가정 소식"}</small></span></label>`).join("")}</fieldset>
    <label class="field"><span>체험용 이메일</span><input name="email" type="email" required maxlength="254" autocomplete="off" placeholder="member@example.test" aria-describedby="demo-email-help"><small id="demo-email-help">실제 주소 대신 example.test 주소를 사용해 주세요.</small></label>
    <div class="account-summary"><span>${icon("clock")} 수락 가능 기간</span><strong>초대 생성 후 48시간</strong><p>수락 후 센터 소속이 생성돼요. 아동 연결은 따로 확인해요.</p></div>`;
}

export function inviteReady(invite) {
  return `<div class="account-result"><span class="account-result-icon">${icon("check")}</span><h3>초대 흐름을 준비했어요</h3><p><strong>${e(invite.email)}</strong><br>${MEMBER_ROLES[invite.role]} · ${time(invite.expiresAt)}까지</p></div><p class="account-notice">메일 발송 전 단계예요. 아래에서 받는 분의 화면을 체험할 수 있어요.</p>${accountButton("받는 분의 화면 보기", "accept", invite.id, "primary account-wide")}`;
}

export function acceptForm(invite) {
  if (invite.status !== "pending") return `<div class="account-result"><span class="account-result-icon">${icon("clock")}</span><h3>${invite.status === "accepted" ? "이미 수락한 초대예요" : "이 초대는 종료되었어요"}</h3><p>센터에 확인하거나 새 초대를 요청해 주세요.</p></div>`;
  return `<div class="account-summary"><strong>${e(DEMO_CENTER.name)}의 초대</strong><p>${e(invite.email)} · ${MEMBER_ROLES[invite.role]}</p></div>
    <div class="account-existing-entry"><p>이미 Carebridge 계정이 있나요?</p>${accountButton("기존 계정으로 연결", "accept-existing", invite.id, "text")}</div>
    <p class="account-lead">아이의 소식을 함께 이어갈 준비를 해요.</p>
    <label class="field"><span>체험 이름</span><input name="name" required maxlength="30" autocomplete="off" placeholder="예: 새 보호자"></label>
    <label class="field"><span>체험 비밀번호</span><span class="account-password"><input id="signup-password" name="password" type="password" required minlength="12" maxlength="128" autocomplete="new-password" aria-describedby="password-help">${accountButton("표시", "password", "signup-password", "text")}</span><small id="password-help">12~128자 · 실제 사용하는 비밀번호는 입력하지 마세요.</small></label>
    <label class="field"><span>비밀번호 확인</span><input name="confirmation" type="password" required minlength="12" maxlength="128" autocomplete="new-password"></label>
    <label class="account-check"><input type="checkbox" name="understood" required><span>화면 체험이며, 실제 계정이 생성되지 않는 것을 확인했어요.</span></label>`;
}

export function existingAcceptForm(invite, accounts) {
  if (invite.status !== "pending") return acceptForm(invite);
  return `<div class="account-summary"><span>연결할 센터</span><strong>${e(DEMO_CENTER.name)}</strong><p>초대받은 이메일: ${e(invite.email)}</p><p>이 센터에서의 역할: ${MEMBER_ROLES[invite.role]}</p></div>
    <p class="account-lead">기존 계정을 유지하고 이 센터 소속만 추가해요.</p>
    <div class="field"><label for="existing-account-id">로그인된 계정 체험</label><select id="existing-account-id" name="accountId" required aria-describedby="existing-account-help existing-account-selection"><option value="" selected disabled>체험 계정을 선택해 주세요</option>${accounts.map((a) => `<option value="${e(a.id)}">${e(a.name)} · ${e(a.email)}</option>`).join("")}</select><small id="existing-account-help">실제 로그인 전 화면이에요. 위 초대와 같은 이메일의 가상 계정을 선택해 주세요.</small><output id="existing-account-selection" for="existing-account-id" class="account-selected" aria-live="polite" aria-atomic="true" hidden></output></div>
    <p class="account-notice">비밀번호를 다시 만들지 않아요. 실제 연결에서는 로그인한 본인 계정을 서버가 확인해요. 계정을 선택하는 것만으로 로그인되지는 않아요.</p>
    <label class="account-check"><input type="checkbox" name="understood" required><span>${e(DEMO_CENTER.name)}에 ${MEMBER_ROLES[invite.role]}로 연결하는 화면 체험임을 확인했어요. 실제 소속이나 아동 열람 권한은 생성되지 않아요.</span></label>
    ${accountButton("새 계정 만들기로 돌아가기", "accept", invite.id, "text account-wide")}`;
}

export function existingAcceptedScreen(member) {
  return `<div class="account-result"><span class="account-result-icon">${icon("check")}</span><h3>기존 계정 연결을 확인했어요</h3><p>${e(member.name)} · ${e(member.email)}<br>${e(DEMO_CENTER.name)} · ${MEMBER_ROLES[member.role]}</p></div><p class="account-notice">시연용 소속만 반영됐어요. 기존 계정·비밀번호는 변경하지 않으며, 아동별 대화와 기록은 별도 담당 관계 확인 후 열람해요.</p>${accountButton("닫기", "close", "", "primary account-wide")}`;
}

export function acceptedScreen(member) {
  return `<div class="account-result"><span class="account-result-icon">${icon("check")}</span><h3>${e(member.name)}님, 준비되었어요</h3><p>${MEMBER_ROLES[member.role]}로 참여하는 흐름을 확인했어요.<br>센터가 아이와의 관계를 확인하면 소통을 시작할 수 있어요.</p></div><p class="account-notice">시연용 구성원 목록에만 반영됐어요. 비밀번호는 저장하지 않았어요.</p>${accountButton("로그인 화면 보기", "login", "", "primary account-wide")}`;
}

export function loginForm() {
  return `<p class="account-lead">센터에서 가정까지, 아이의 소식을 이어가요.</p><label class="field"><span>이메일</span><input name="email" type="email" required maxlength="254" autocomplete="off" placeholder="member@example.test"></label><label class="field"><span>체험 비밀번호</span><span class="account-password"><input id="login-password" name="password" type="password" required maxlength="128" autocomplete="off">${accountButton("표시", "password", "login-password", "text")}</span></label><div class="account-login-links">${accountButton("초대를 받으셨나요?", "invite-help", "", "text")}${accountButton("비밀번호를 잊으셨나요?", "recovery", "", "text")}</div><p class="account-notice">로그인 연결 전 화면이에요. 입력값은 저장하거나 전송하지 않아요.</p>`;
}

export function recoveryRequestForm() {
  return `<p class="account-lead">비밀번호 재설정의 입력 흐름을 체험해요.</p>
    <label class="field"><span>체험용 이메일</span><input name="email" type="email" required maxlength="254" autocomplete="off" placeholder="member@example.test" aria-describedby="recovery-email-help"><small id="recovery-email-help">실제 주소는 입력하지 마세요. example.test 주소를 사용해 주세요.</small></label>
    <p class="account-notice">입력은 저장하거나 전송하지 않으며, 복구 메일도 발송하지 않아요.</p>`;
}

export function recoveryRequestedScreen() {
  return `<div class="account-result"><span class="account-result-icon">${icon("message")}</span><p>등록된 계정이라면 복구 안내를 받을 수 있어요.<br>계정의 존재 여부는 이 화면에서 표시하지 않아요.</p></div>
    <p class="account-notice">지금은 화면 체험이에요. 이메일을 저장하거나 전송하지 않았고, 메일도 보내지 않았어요.</p>
    ${accountButton("재설정 화면 체험", "recovery-reset", "", "primary account-wide")}
    ${accountButton("로그인으로 돌아가기", "login", "", "secondary account-wide")}`;
}

export function recoveryResetForm() {
  return `<p class="account-lead">새 비밀번호를 두 번 입력하는 흐름을 확인해요.</p>
    <p class="account-notice">실제 사용하는 비밀번호는 입력하지 마세요. 입력은 저장하거나 전송하지 않아요.</p>
    <div class="field"><label for="recovery-password">새 체험 비밀번호</label><span class="account-password"><input id="recovery-password" name="password" type="password" required minlength="12" maxlength="128" autocomplete="off" aria-describedby="recovery-password-help">${accountButton("표시", "password", "recovery-password", "text", 'aria-label="새 체험 비밀번호 표시" aria-controls="recovery-password" aria-pressed="false"')}</span><small id="recovery-password-help">12~128자의 체험용 문구를 입력해 주세요.</small></div>
    <div class="field"><label for="recovery-confirmation">체험 비밀번호 확인</label><span class="account-password"><input id="recovery-confirmation" name="confirmation" type="password" required minlength="12" maxlength="128" autocomplete="off">${accountButton("표시", "password", "recovery-confirmation", "text", 'aria-label="체험 비밀번호 확인 표시" aria-controls="recovery-confirmation" aria-pressed="false"')}</span></div>
    <label class="account-check"><input type="checkbox" name="understood" required><span>실제 변경 없는 체험임을 확인했어요.</span></label>
    <details class="account-summary account-recovery-help"><summary>만료 안내 체험</summary><p>원하면 만료된 링크의 안내 화면도 직접 확인할 수 있어요.</p>${accountButton("만료 안내 보기", "recovery-unavailable", "", "text account-wide")}</details>`;
}

export function recoveryUnavailableScreen() {
  return `<div class="account-result"><span class="account-result-icon">${icon("clock")}</span><p>이 안내로는 재설정을 계속할 수 없어요.<br>링크가 만료되었거나 이미 사용되었을 수 있어요.</p></div>
    <p class="account-notice">만료 안내 체험 화면이에요. 실제 링크나 계정을 검사하지 않아요.</p>
    ${accountButton("새 안내 요청 체험", "recovery", "", "primary account-wide")}
    ${accountButton("로그인으로 돌아가기", "login", "", "secondary account-wide")}`;
}

export function recoveryCompletedScreen() {
  return `<div class="account-result"><span class="account-result-icon">${icon("check")}</span><p>로그인 화면에서 체험을 이어갈 수 있어요.</p></div>
    <p class="account-notice">실제 비밀번호와 로그인 세션은 변경되지 않았어요. 입력한 비밀번호도 저장하거나 전송하지 않았어요.</p>
    ${accountButton("로그인으로 돌아가기", "login", "", "primary account-wide")}`;
}

export function permissionsScreen(role) {
  const rows = [
    ["센터 관리자", "구성원 초대 · 아동 등록 · 일정 관리", "치료 내용과 보호자의 대화는 열람하지 않아요."],
    ["치료사", "담당 아동의 기록 · 평가 · 보호자와 대화", "다른 치료사의 담당 아동은 자동으로 연결되지 않아요."],
    ["보호자", "연결된 내 아이의 공유 기록 · 가정 소식", "치료사의 내부 메모와 다른 아이의 기록은 볼 수 없어요."],
  ].filter(([label]) => role === "all" || label === MEMBER_ROLES[role]);
  return `<div class="account-permissions">${rows.map(([label, title, body]) => `<article><h3>${label}</h3><p>${title}</p><small>${body}</small></article>`).join("")}</div><p class="account-notice">현재 화면은 가상 역할 체험이에요. 실제 접근 권한은 서버 연결 단계에서 적용돼요.</p>`;
}
