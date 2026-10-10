import { OnboardingDemo, RecoveryPreview, demoEmail } from "./onboarding-demo.js";
import { escape as e, icon } from "./ui.js";
import { accountButton, membersScreen, inviteForm, inviteReady, acceptForm, acceptedScreen, existingAcceptForm, existingAcceptedScreen, loginForm, permissionsScreen,
  recoveryRequestForm, recoveryRequestedScreen, recoveryResetForm, recoveryUnavailableScreen, recoveryCompletedScreen } from "./onboarding-ui.js";

export class OnboardingController {
  constructor({ getActor, render, flash, busy, getMemberName = () => null }) {
    this.getActor = getActor;
    this.render = render;
    this.flash = flash;
    this.busy = busy;
    this.getMemberName = getMemberName;
    this.demo = new OnboardingDemo();
    this.recovery = new RecoveryPreview();
    this.tab = "members";
    this.filter = "all";
    this.dialog = document.createElement("dialog");
    this.dialog.id = "account-dialog";
    this.dialog.className = "account-dialog";
    this.dialog.setAttribute("aria-labelledby", "account-dialog-title");
    document.body.append(this.dialog);
    document.addEventListener("click", (event) => this.click(event));
    document.addEventListener("change", (event) => {
      if (event.target.matches('#account-dialog select[name="accountId"]')) {
        const account = this.demo.existingAccounts().find((a) => a.id === event.target.value);
        const selected = this.dialog.querySelector("#existing-account-selection");
        if (selected) {
          selected.textContent = account ? `${account.name} · ${account.email}` : "";
          selected.hidden = !account;
        }
        return;
      }
      if (event.target.id !== "invitation-filter") return;
      this.filter = event.target.value;
      this.render();
      document.getElementById("invitation-filter")?.focus();
    });
    this.dialog.addEventListener("submit", (event) => this.submit(event));
    this.dialog.addEventListener("cancel", () => {
      this.clearPasswords();
      this.recovery.leave();
    });
    this.dialog.addEventListener("close", () => {
      if (this.dialog.open) return; // A delayed close event must not clear a newly opened screen.
      this.clearPasswords();
      this.recovery.leave();
      this.dialog.replaceChildren(); // discard password DOM on every exit
      if (this.returnFocus?.isConnected) this.returnFocus.focus();
      else document.getElementById("main")?.focus({ preventScroll: true });
    });
  }
  clearPasswords() {
    // Include revealed type=text inputs too; clearing by type alone leaks
    // their value into a detached DOM reference after a screen transition.
    for (const input of this.dialog.querySelectorAll('input[name="password"], input[name="confirmation"]'))
      input.value = "";
  }
  screen() {
    const snapshot = this.demo.snapshot(this.getActor());
    snapshot.members = snapshot.members.map((member) => ({ ...member, name: this.getMemberName(member.id) ?? member.name }));
    return membersScreen(snapshot, this.tab, this.filter);
  }
  open(title, body, action = "", id = "", submitLabel = "") {
    this.clearPasswords();
    if (!action.startsWith("recovery-")) this.recovery.leave();
    if (!this.dialog.open) this.returnFocus = document.activeElement;
    this.dialog.innerHTML = `<form id="account-form" data-intent="${action}" data-id="${e(id)}" novalidate><header class="dialog-header"><div><p class="eyebrow">Carebridge · 화면 체험</p><h2 id="account-dialog-title" tabindex="-1">${title}</h2></div><button type="button" class="button icon-button" data-onboarding="close" aria-label="계정 화면 닫기">${icon("close")}</button></header><div class="dialog-body">${body}<p id="account-error" class="form-error" role="alert" tabindex="-1" hidden></p></div>${submitLabel ? `<footer class="dialog-footer">${accountButton("취소", "close")}<button class="button primary" type="submit">${submitLabel}</button></footer>` : ""}</form>`;
    if (!this.dialog.open) this.dialog.showModal();
    this.dialog.querySelector("h2").focus();
  }
  error(message) {
    const error = this.dialog.querySelector("#account-error");
    if (!error) { this.flash(message); return; }
    error.textContent = message;
    error.hidden = false;
    error.focus();
  }
  refresh() {
    this.tab = "invitations";
    this.filter = "all";
    this.render();
  }
  click(event) {
    const target = event.target.closest("button[data-onboarding]");
    if (!target) return;
    event.preventDefault();
    if (this.busy?.()) { this.flash("저장·첨부 확인이 끝난 뒤 다시 시도해 주세요."); return; }
    const action = target.dataset.onboarding;
    const id = target.dataset.id;
    try {
      if (action === "close") { this.clearPasswords(); this.recovery.leave(); this.dialog.close(); return; }
      if (action === "tab") {
        this.tab = id;
        this.render();
        document.querySelector(`[data-onboarding="tab"][data-id="${id}"]`)?.focus();
        return;
      }
      if (action === "password") {
        const input = this.dialog.querySelector(`#${id}`);
        const show = input.type === "password";
        input.type = show ? "text" : "password";
        target.textContent = show ? "숨김" : "표시";
        target.setAttribute("aria-pressed", String(show));
        return;
      }
      if (action === "login") { this.open("다시 만나 반가워요", loginForm(), "login", "", "로그인 화면 확인"); return; }
      if (action === "permissions") { this.open("역할별로 연결되는 정보", permissionsScreen(id)); return; }
      if (action === "invite-help") {
        this.open("센터의 초대를 확인해 주세요", `<p class="account-lead">센터가 보내준 초대에서 역할을 확인하고 비밀번호를 설정해요.</p><p>지금은 센터 화면의 구성원 메뉴에서 초대를 만들고 ‘수락 화면’을 눌러 체험할 수 있어요.</p>${accountButton("로그인으로 돌아가기", "login", "", "primary account-wide")}`);
        return;
      }
      if (action === "recovery") {
        this.recovery.begin();
        this.open("비밀번호 찾기", recoveryRequestForm(), "recovery-request", "", "안내 확인 · 체험");
        return;
      }
      if (action === "recovery-reset") {
        if (this.recovery.openReset())
          this.open("새 비밀번호 설정", recoveryResetForm(), "recovery-reset", "", "입력 확인 · 체험");
        else this.openRecoveryUnavailable();
        return;
      }
      if (action === "recovery-unavailable") {
        this.recovery.unavailable();
        this.openRecoveryUnavailable();
        return;
      }
      // The rehearsal is only reachable from the center's membership workspace.
      this.demo.manager(this.getActor());
      if (action === "invite") { this.open("함께할 분을 초대해요", inviteForm(), "invite", "", "초대 만들기 · 체험"); return; }
      if (action === "accept") {
        const invite = this.demo.invitation(id);
        this.open("함께 이어갈 첫걸음", acceptForm(invite), "accept", id, invite.status === "pending" ? "초대 수락 체험" : "");
        return;
      }
      if (action === "accept-existing") {
        const invite = this.demo.invitation(id);
        // Replacing the form discards any new-password input on branch changes.
        this.open("기존 계정으로 연결", existingAcceptForm(invite, this.demo.existingAccounts()), "accept-existing", id,
          invite.status === "pending" ? "센터 연결 체험" : "");
        const form = this.dialog.querySelector("#account-form");
        form.dataset.centerId = invite.centerId;
        form.dataset.role = invite.role;
        return;
      }
      if (action === "revoke") {
        const invite = this.demo.invitation(id);
        this.open("이 초대를 취소할까요?", `<p class="account-lead">${e(invite.email)}</p><p>취소하면 이 초대로 수락할 수 없어요. 필요하면 다시 초대할 수 있어요.</p>`, "revoke", id, "초대 취소하기");
        return;
      }
      if (action === "reissue") {
        const invite = this.demo.reissue(this.getActor(), id);
        this.refresh();
        this.open("새 초대를 준비했어요", inviteReady(invite));
      }
    } catch (error) { this.dialog.open ? this.error(error.message) : this.flash(error.message); }
  }
  openRecoveryUnavailable() {
    this.open("다시 복구 안내를 요청해 주세요", recoveryUnavailableScreen(), "recovery-unavailable");
  }
  submit(event) {
    event.preventDefault();
    const form = event.target;
    if (form !== this.dialog.querySelector("#account-form") || !this.dialog.open) return;
    const action = form.dataset.intent;
    // A stale form must discard its secrets even when native field validity
    // would otherwise stop submission before reaching the preview model.
    if (action === "recovery-reset" && !this.recovery.live("reset")) {
      this.recovery.unavailable();
      this.openRecoveryUnavailable();
      return;
    }
    if (!form.reportValidity()) return;
    try {
      if (action === "recovery-request") {
        this.recovery.request(form.elements.email.value);
        form.reset();
        this.open("복구 안내를 확인해 주세요", recoveryRequestedScreen(), "recovery-requested");
        return;
      }
      if (action === "recovery-reset") {
        const completed = this.recovery.complete({
          password: form.elements.password.value,
          confirmation: form.elements.confirmation.value,
          understood: form.elements.understood.checked,
        });
        if (completed) this.open("입력 흐름을 확인했어요", recoveryCompletedScreen(), "recovery-completed");
        else this.openRecoveryUnavailable();
        return;
      }
      if (action === "login") {
        demoEmail(form.elements.email.value);
        form.elements.password.value = "";
        this.error("화면 확인을 마쳤어요. 실제 로그인은 서버 연결 후 이용할 수 있어요.");
        return;
      }
      this.demo.manager(this.getActor());
      if (action === "invite") {
        const invite = this.demo.create(this.getActor(), { email: form.elements.email.value, role: form.elements.role.value });
        this.refresh();
        this.open("초대가 준비되었어요", inviteReady(invite));
      }
      if (action === "accept") {
        const member = this.demo.accept(form.dataset.id, {
          name: form.elements.name.value,
          password: form.elements.password.value,
          confirmation: form.elements.confirmation.value,
          understood: form.elements.understood.checked,
        });
        form.reset();
        this.refresh();
        this.open("참여 흐름을 확인했어요", acceptedScreen(member));
      }
      if (action === "accept-existing") {
        const member = this.demo.acceptExisting(form.dataset.id, {
          accountId: form.elements.accountId.value,
          centerId: form.dataset.centerId,
          role: form.dataset.role,
          understood: form.elements.understood.checked,
        });
        form.reset();
        this.refresh();
        this.open("연결 흐름을 확인했어요", existingAcceptedScreen(member));
      }
      if (action === "revoke") {
        this.demo.revoke(this.getActor(), form.dataset.id);
        this.refresh();
        this.dialog.close();
        this.flash("체험용 초대를 취소했어요.");
      }
    } catch (error) { this.error(error.message); }
  }
}
