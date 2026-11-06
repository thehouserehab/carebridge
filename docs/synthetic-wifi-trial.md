# 개인 Wi-Fi 가상 자료 시험

2026-10-11. 사용자가 승인한 개인 Wi-Fi의 PC와 지정한 아이폰 한 대를 대상으로 하는 **임시 시험**이다. 실제 아동 자료, 공개 인터넷, 운영 배포, 공유기·DNS 변경은 포함하지 않는다. 기존 PC 전용 HTTP 실행기와 DPAPI 재개 모드는 변경하지 않는다.

## 2026-10-14 승인창 미표시 — 후속 진단 보완

사용자는 실행 `82845738-9a9a-4e8b-94c1-7fa202e1be3e`에서 **승인창을 보지 못했다**고 확인했다. 이전 실행에 새 진단을 소급 적용하지 않으며 실제 미표시 원인은 아직 미확정이다. 인증서에 표시한 날짜는 유효기한이지 만료 오류가 아니므로 CLI 표기를 `인증서 유효기한(UTC)`으로 바로잡았다. 실제 만료 여부 검사는 완화하지 않았다.

새 `lease.diagnostics`는 사전검사·준비 결과, 최초 실패 분류, 준비/전체 수명/정리 대기의 시간 초과, 일반 launcher의 spawn/exit/close 관측을 구분하는 동결된 스냅샷이다. launcher 시작은 UAC 표시나 관리자 helper 시작의 증거가 아니다. `declined`는 정확한 native 1223 결과 분류일 뿐 사람이 취소 버튼을 눌렀다는 증거가 아니다. 준비 전 실패는 앱·DB를 이미 실행하다 종료한 것처럼 표시하지 않는다.

`server/synthetic-wifi-diagnostic.mjs`는 허용된 상태 필드만 검사하여 시스템 임시 경로의 새 `carebridge-wifi-diagnostic-*` 폴더에 `diagnostic.json`을 독점 생성한다. 원시 오류·stdout/stderr·IP·계정·비밀번호·키를 저장하지 않는다. helper 제어 폴더와 stdout 계약을 건드리지 않고, 기존 파일을 인수하거나 덮어쓰지 않는다. 부분 저장 실패 산출물은 자동 삭제하지 않는다. Windows에서 POSIX mode 요청 자체를 별도 ACL 보장의 근거로 사용하지 않는다.

진단은 정리 미확인/확인 시 각각 최대 한 번 **최선 노력 방식**으로 저장하며 승인·준비·정리 성공 판정에는 쓰지 않는다. 독립 검토에서 진단 IO를 기다리면 Ctrl+C 정리 재시도가 막힐 수 있음을 발견해 저장 대기를 정리 경로에서 분리했다. 저장 지연·실패는 종료 안내나 재시도·소유권 유지 조건을 바꾸지 않는다. 성공 경로를 출력하기 전에 파일 flush/close를 확인하지만, 강제 종료나 IO 장애 때 기록의 존재를 보장하지 않는다.

관련 회귀는 다음 명령으로 수행한다. `CAREBRIDGE_TEST_POWERSHELL`은 번들 `pwsh.exe`의 정규 Windows 절대 경로다. 실제 PowerShell은 파서와 무해한 대역 함수만 실행하고, `Process.Start`·방화벽 명령은 대역으로 치환한다. 실제 UAC·방화벽·예약 작업·인증서 저장소·서버·DB·E 자료·배포는 이번 단계에서 실행하거나 변경하지 않았다.

```text
node --test --test-concurrency=1 tests/synthetic-wifi-cli.test.mjs server/tests/synthetic-wifi-diagnostic.test.mjs server/tests/synthetic-wifi-lease.test.mjs
```

첫 실행의 70/71에서 시험 자체의 중첩 `spawn` 대역이 다음 시험에 남는 격리 문제를 확인했다. 단일 대역의 명시 옵션으로 고쳐 71/71을 확인했고, 이후 진단 IO 지연 회귀를 추가했다. 최종 관련 3파일 회귀는 **75/75 통과, 실패·취소·건너뜀 0, 실제 종료 0, 31,419.95ms**다. 앞선 실행이나 agent의 개별 시험을 중복 합산하지 않았다. 독립 읽기 재검토에서 추가 차단 결함은 발견하지 못했다. 다음 실물 시도 전 네트워크·프로세스·인증서 수명·정리 상태를 새로 확인해야 한다. X01/P103과 사람 평가 X02, 전체 개편 완료는 아직 남아 있다.

## 2026-10-12 전용 관리자 읽기 검증 — 구현·회귀·실제 검사 통과

사용자가 **‘전용 관리자 읽기 검증 추가’**를 승인했다. 일반 토큰에서 관측한 접근 거부를 우회하기 위해 기존 ACL을 확대하는 대신, 이번 lease UUID의 정리 예약 작업 하나만 조회하는 별도 관찰자를 추가했다. 관리자 토큰 자체는 넓은 권한을 가지며 작업 하나로 OS 차원에서 제한된 토큰은 아니다. 범위 제한은 검토된 고정 명령, 정확한 이름/루트 경로 조회, 종료 코드와 프로세스 수명 검증에 의존한다.

- 새 `tests/synthetic-wifi-admin-task-observer.mjs`는 고정 Windows 기본 PowerShell에서 시스템 ScheduledTasks 모듈을 가져와 정확한 `Cleanup-<UUID>` 작업만 읽는다. 작업 등록·실행·삭제, 방화벽·ACL 변경, 파일 결과 채널, 작업 원문/XML 출력은 하지 않는다. 관리자 자식은 고정 열거형 종료 코드만 반환한다.
- 명시적인 `--verify-task-as-admin` 선두 옵션을 준 native probe에서만 새 승인 경로를 사용한다. 예외 작업 모드와 결합하지 못하며 기본 실행은 종전과 같다. 앱·DB·인증서·아이폰 연결은 이 probe의 범위 밖이다.
- 일반 권한의 활성 검사는 양 방화벽 저장소의 규칙·주소·프로그램·포트를 계속 비교한다. 별도 관찰 모드에서는 `taskVerified=false`, `taskCount=0`으로 보고하여 아직 하지 않은 작업 검증을 성공으로 표시하지 않는다. 관리자 관찰 성공과 lease의 활성 상태를 다시 확인한 뒤에만 `cleanupTaskVerified=true`가 된다.
- 공유 `tests/synthetic-wifi-task-shape.mjs`는 기존 독립 관찰자의 경로·설명·주체·실행 파일·트리거 종류 검사를 보존하고 정확한 작업 이름을 다시 검사한다. helper가 자체 검증하는 전체 명령 인수·반복 간격 등의 모든 조건을 새 관찰자가 독립 복제한 것은 아니다. 기존 helper의 더 엄격한 검사는 그대로다.
- 취소·기한 만료·lease 종료는 검증 결과를 거부할 뿐 종료 증거가 아니다. 기존 최대 180초를 연장하지 않으며 늦게 승인된 관찰자는 기한을 다시 확인한다. 기존 lease의 정상 제거와 정확한 after 부재 검사를 먼저 수행하고, 관리자 자식과 일반 launcher의 실제 종료도 별도로 확인한다. UAC 대기 프로세스를 강제로 종료해 늦게 시작할 자식을 방치하지 않는다.

Windows 기본 PowerShell을 직접 선택하여 PowerShell 7의 호환성 세션이 만드는 별도 프로세스·임시 프록시 모듈을 이 관찰 경로에 추가하지 않았다. [Microsoft 호환성 모드 설명](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_windows_powershell_compatibility?view=powershell-7.6)을 참고했다. 실제 프로세스 시작과 종료/입출력 닫힘은 구분한다. [Node.js 자식 프로세스 문서](https://nodejs.org/api/child_process.html#event-close)에 따라 시작하지 못한 확정 경로와 이미 시작했거나 결과가 불명확한 경로도 나눈다.

새 회귀는 실제 UAC 없이 관리형 대역과 고정 문자열/AST 검사로 수행했다. 관리자 전용 첫 실행에서 `HasExited` getter의 예외가 null로 바뀌는 한 경우를 발견해 명시적인 bool 검사와 sticky 실패로 보완했다. 프로세스가 확실히 시작하지 않은 경로와 불명확한 종료를 구분하여 전자는 실패 결과와 종료 확인을 함께 반환하고, 후자는 종료 성공으로 인정하지 않는다. 일반 관찰·통합 63/63과 관리자 전용 47/47을 각각 확인한 뒤 아래 **최종 관련 6파일 회귀 177/177**, 실패·취소·건너뜀 0, 실제 종료 0(222,615ms)을 확인했다. 앞선 개별 실행과 내부 mock 70개를 합산하지 않는다.

```text
CAREBRIDGE_TEST_POWERSHELL=<bundled pwsh의 정규 Windows 절대 경로>
CAREBRIDGE_TEST_NATIVE_CANCELLED_LEASE=1
CAREBRIDGE_TEST_IN_MEMORY_TASK_TRIGGER=1
node --test --test-concurrency=1 tests/synthetic-wifi-admin-task-observer.test.mjs tests/synthetic-wifi-lease-observer.test.mjs tests/synthetic-wifi-cli.test.mjs server/tests/synthetic-wifi-lease.test.mjs server/tests/synthetic-wifi-firewall-lease.test.mjs server/tests/synthetic-wifi-firewall-exception.test.mjs
```

수정 JavaScript 5파일의 `node --check`, 관리자/launcher 고정 문자열의 실제 Windows PowerShell 5.1 AST 구문 검사, `git diff --check` 및 미추적 7파일 공백/충돌 검사도 통과했다. 독립 읽기 검토에서 추가 P0/P1 결함은 발견하지 못했다. 코드/회귀 변경 파일은 위 관리자 모듈과 그 `.test.mjs`, `tests/synthetic-wifi-task-shape.mjs`, `tests/windows-synthetic-wifi-lease-check.mjs`, `tests/synthetic-wifi-lease-observer.test.mjs`이며 문서는 이 파일과 `docs/communication-acceptance.md`다. 앱·DB·기존 lease helper·인증/세션·UI는 변경하지 않았다.

이후 같은 승인 네트워크의 사전검사와 전용 Node의 유효 서명/기존 SHA-256을 재확인하고, 명시 옵션을 준 **실제 방화벽 전용 probe 한 번**을 실행했다. 사용자가 규칙 생성용 첫 승인창과 작업 조회용 두 번째 승인창에서 각각 '예'를 눌렀다고 확인했다. 보고서 `test-results/synthetic-wifi-lease-17fe5f51-bca1-484f-a5d0-7d223b3434d6.json`은 14:11:24~14:12:56 UTC에 **`passed=true`**, 모든 checks 참, `failure=null`, 정리 재시도 0, 실제 종료 0으로 끝났다. 일반 활성 snapshot의 `taskVerified=false`는 의도된 분리이며 별도 `adminTask.verified=true`가 작업 검증 근거다. `closeConfirmed`, `ownedObjectsAbsent`, 일반/관리자 observer 종료 확인도 각각 참이다.

상태 영수증 `removed`를 확인했고 14:13:48 UTC 별도 읽기 조회에서 이번 UUID의 양 저장소 규칙·작업 열거·관찰한 부모 프로세스·전용 Node·승인 프로세스·8443 리스너는 모두 0, Public 분류는 유지됐다. 작업 부재의 주 근거는 빈 열거가 아니라 native after 검사의 정확한 COM `not-found`이며 관리자 자식 종료의 근거는 고정 핸들과 launcher close를 확인한 관찰자 계약이다. 기존 두 실패 보고서의 SHA-256도 보존됐다. 이번 성공 보고서의 SHA-256은 `94691c59219817f2224d26bdfdbf318b72e5d7cbd06dccdbf1ed8847409b02a6`이다.

이 결과는 지정된 임시 방화벽/예약 작업 검증 경계의 성공이다. `vercel:verification`에 따라 실제 확인 범위를 분리하며 **PC↔아이폰 전달·첨부·단절/재접속 성공으로 확대하지 않는다**. 이번 probe는 앱·DB·인증서를 실행하지 않았다. 다음 단계는 아이폰의 시험용 HTTPS 신뢰 설정과 가상 자료 완주다. 실제 자료·공개 접속·운영 배포·독립 백업 부재에 따른 보류는 유지하며 P103과 전체 개편은 아직 미완료다.

## 2026-10-12 정확한 조회 실제 검증 — 접근 거부 확인, 정리 완료

원 개편안을 다시 읽고 P103의 실제 PC↔아이폰 전달·첨부·재접속을 위한 선행 방화벽 경계를 확인했다. 이전 단계는 조회 보완·113개 회귀 통과 및 정리된 작업의 정확한 부재 확인으로 진전이 있었지만, 실행 중 작업의 독립 조회는 미완료였다. 현재 PC 주소/물리 Wi-Fi·Public 방화벽·전용 Node의 유효 서명과 기존 해시·이전 프로세스/8443 리스너 부재를 재확인했다. 실제 주소는 런타임 인자에만 사용한다.

첫 실행 `test-results/synthetic-wifi-lease-a6f2778a-2e51-4000-8799-29b867e98550.json`은 운영자가 전달한 PowerShell 경로에 `/`가 들어 있어 엄격한 Windows 경로 검사에서 거부됐다. 후속 읽기 전용 호출의 `reason=executable`과 소스의 경로 규약을 확인했다. `leaseCreated=false`, `ready=false`, `closeConfirmed=false`, 실제 종료 1이며 새 임시 자원이나 승인창 생성의 증거가 없다. 이 실패를 승인 취소나 정상 활성화/정리로 해석하지 않는다. 제품의 경로 검증은 완화하지 않고 호출 인자만 정규 Windows 형식으로 바로잡았다. 수정 인자의 `inspectSyntheticWifiLease`는 실제 종료 0으로 사전검사를 통과했다.

이후 새 실행에서 사용자가 Windows 승인창의 '예'를 확인했다. 자동 보고서 `test-results/synthetic-wifi-lease-7e0b5883-e0e8-4343-80e9-f2d36c177f63.json`은 13:35:00~13:36:22 UTC에 **`ACTIVE / task-access-denied`**로 종료했다. 일반 권한의 정확한 작업 조회 경로에서 접근 거부가 관측된 것이며, 예약 작업 자체가 없다는 뜻은 아니다. `ready=true`, 정상 `lease.close()`·정확한 작업/규칙 부재·관찰 프로세스 종료는 확인됐고 정리 재시도 0, `passed=false`, 실제 종료 1이다. `activeRulesVerified`·`cleanupTaskVerified`는 완전한 독립 검사 성공 전까지 거짓으로 유지한다.

13:36:49 UTC 이후 별도 읽기 확인에서 전용 Node·승인 프로세스·이번 UUID의 양 저장소 규칙·작업 열거·8443 리스너는 모두 0이고 Public 분류도 유지됐다. 상태 영수증은 `removed`다. 작업 부재는 빈 열거만이 아니라 새 관찰자의 정확한 조회를 포함한 after 검사로도 확인됐다. 원래 실패 보고서와 제어 폴더는 보존했고 앱·DB·인증서·실물 아이폰은 실행하지 않았다.

기존 helper가 관리자 권한으로 수행하는 자체 검증과 별도 일반 권한 관찰자의 독립 검증을 구분한다. 후자를 생략하거나 ACL을 넓혀 통과시키지 않는다. 다음 권고안은 **별도 관리자 읽기 전용 관찰자**이며, 새 권한 사용에 관한 사용자 결정을 요청했다. 관리자 토큰 자체가 작업 하나로 제한되는 것은 아니므로, 구현 계약은 고정 코드·이번 UUID의 정확한 작업 하나·기존 필드/동작/트리거의 동등 비교·작업 등록/실행/삭제/ACL 변경 금지·원문/XML 미출력·실제 관찰자 종료 확인으로 제한해야 한다. 앱·DB는 일반 권한으로 유지한다. 승인 전에는 이 범위 문서화까지만 진행하며 새 관찰자 구현·UAC·실행은 하지 않는다.

이번 단계는 제품 코드를 바꾸지 않았다. 위 사전검사와 실제 probe 결과를 새 증거로 기록하며, 이전 113/113 회귀를 이번에 다시 실행한 것으로 계산하지 않는다. `vercel:verification`의 첫 실패 경계 원칙에 따라 P103과 전체 개편은 계속 미완료이고, 실제 자료·공개 접속·운영 배포는 보류한다.

## 2026-10-12 후속 실제 진단 — 일반 권한 예약 작업 조회 경계

현재 승인된 네트워크·전용 Node 서명/해시·이전 자원 부재를 확인한 뒤 제한 진단 probe를 실행했다. 사용자가 새 승인창에서 '예'를 눌렀다고 확인했다. 자동 보고서 `test-results/synthetic-wifi-lease-9c3ded20-f2fd-4f29-804c-a21d4e770d30.json`은 `ACTIVE / task-shape`에서 실패했다. 검증 기준을 유지한 채 해당 단계를 `task-count`와 `task-fields`로 나누고 정상/실패 관찰자 회귀 **16/16 통과**, 실패·취소·건너뜀 0, 실제 종료 0을 확인했다.

분리된 진단의 두 번째 실제 실행도 새 사용자 승인을 받았다. 자동 보고서 `test-results/synthetic-wifi-lease-60c6a8f2-c2c0-4eea-a08f-387cf61aef60.json`은 **`ACTIVE / task-count` 실패**다. 일반 권한 열거 결과가 정확히 한 개가 아니어서 작업 필드 비교에 진입하지 못했다는 뜻이며, 이 단계명만으로 0개와 여러 개 또는 접근 권한 문제를 확정하지 않는다. 두 실행 모두 `ready`, `closeConfirmed`, `ownedObjectsAbsent`, `observerExitsConfirmed`는 참, 정리 재시도 0, `passed=false`, 실제 종료 1이다. 방화벽 비교 분기 이후에 실패했지만 집계 성공 플래그는 끝까지 통과해야만 참이므로 기존 보고서를 바꾸지 않는다.

13:07:59 UTC 별도 읽기 관찰은 이미 `removed` 영수증을 보아 COM 작업 조회를 시작하지 않았다. 이를 접근 거부나 조회 성공으로 해석하지 않는다. 13:08:25 UTC 최종 읽기 확인에서 전용 Node·승인 프로세스·정확한 UUID 규칙(양 저장소)·루트 작업·8443 리스너는 0이고 Public 분류는 유지됐다. 실제 정상 정리의 주 근거는 도우미의 `removed`와 확인된 `lease.close()`이며, 아래의 목록 조회 한계를 외부 부재 관측에도 적용한다. 앱·DB·인증서·아이폰은 실행하지 않았다.

[Microsoft 작업 열거 규약](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-tsch/b1631854-cb8b-4b47-b5d1-550d3afd7507)은 호출자에게 읽기/쓰기 권한이 없는 작업을 목록에서 제외한다. 따라서 일반 토큰의 빈 목록만으로 부재를 확정할 수 없다. [정확한 작업 정의 조회 규약](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-tsch/528539ab-2678-4184-9573-cd624916ef9a)은 부재와 접근 거부를 구분한다. 이 근거를 따라 `tests/windows-synthetic-wifi-lease-check.mjs`에 정확한 로컬 작업 이름의 읽기 전용 COM 조회를 추가했다. 목록이 0개인 활성 단계는 읽기 가능 여부와 무관하게 계속 실패하며, 정리 뒤에는 정확한 조회에서 부재가 확인되어야 통과한다. 조회 권한 확대·ACL 변경·검사 생략·추가 UAC는 하지 않았다. 접근 거부가 이번 실제 실패의 원인인지는 아직 미확정이다.

13:15:30 UTC 이후 정리된 두 번째 작업의 직접 조회에서 실제 런타임이 COM 오류를 `FileNotFoundException / 0x80070002`로 매핑하는 것을 관측했다. [Microsoft HRESULT 매핑 문서](https://learn.microsoft.com/en-us/dotnet/standard/native-interop/how-to-map-hresults-and-exceptions)에 맞춰, `GetTask` 단계의 실제 COM 예외 또는 정확한 .NET 매핑 타입과 코드가 함께 일치할 때만 부재를 인정한다. 연결·폴더·정의 읽기 오류, 일반 예외의 같은 코드/메시지는 부재로 인정하지 않는다. 해제 오류도 `unavailable`로 처리한다. 원문 오류·계정·작업 XML은 관찰 결과에 싣지 않는다.

13:20:03 UTC에는 제품 문자열에서 해당 조회 함수만 AST로 추출하여 일반 권한으로 **이미 정리된 두 번째 작업**을 다시 조회했고 `not-found`, 실제 종료 0을 확인했다. 이는 해당 시점의 정확한 작업 부재 증거이며, 실행 중 작업 조회 성공이나 최초 실패 원인 증거는 아니다. 전체 native probe나 앱·DB·인증서는 재실행하지 않았고 이전 실패 보고서를 소급 변경하지 않았다.

`tests/synthetic-wifi-lease-observer.test.mjs`는 실제 관찰 문자열과 관리형 서비스/폴더/작업 대역으로 COM 활성화 없이 부재·접근 거부·연결 실패·잘못된 오류 타입/코드·단계별 거부를 검사한다. 첫 집중 실행은 110개 중 109개 통과, 1개 실패였다. 무동작 재현에서 관리형 `Definition` getter의 원래 COM 오류가 PowerShell 속성 접근에서 남지 않고 null 방어의 일반 예외만 관측되어, 해당 기대값만 `task-query-unavailable`로 수정했다. 원래 오류를 추측하거나 제품의 실패 판정을 완화하지 않았다.

독립 검토에서 확인한 해제 분기 검증 공백도 보완했다. 동일 함수 AST의 Marshal 호출 두 개만 메모리에서 관리형 대역으로 바꾸어, 읽기 성공/부재 뒤 해제 실패가 `unavailable`로 전환되고 나머지 해제를 계속 시도하는지 및 정상 해제 대조까지 세 경우를 검사한다. source hash·AST·정확한 치환 개수·실제 Marshal 잔류 거부를 적용하며 제품 파일을 수정하지 않는다. 이 검사는 finally의 제어 흐름 증거이지 실제 COM 런타임의 해제 실패를 발생시킨 시험은 아니다.

최종 검증은 명시적인 PowerShell과 `CAREBRIDGE_TEST_NATIVE_CANCELLED_LEASE=1`, `CAREBRIDGE_TEST_IN_MEMORY_TASK_TRIGGER=1`을 지정한 아래 집중 명령으로 **113/113 통과**, 실패·취소·건너뜀 0, 실제 종료 0(165,391ms)을 확인했다. 앞선 16개·82개·실패 실행 110개와 합산하지 않는다. 두 JavaScript의 `node --check`, PowerShell/C# 구문 확인, `git diff --check`와 미추적 변경 파일의 공백/충돌 검사, 독립 읽기 검토도 통과했다. 이 범위의 회귀 결과는 전체 앱 재검증이나 실제 활성 작업의 독립 조회 성공을 뜻하지 않는다.

```text
node --test --test-concurrency=1 tests/synthetic-wifi-lease-observer.test.mjs tests/synthetic-wifi-cli.test.mjs server/tests/synthetic-wifi-lease.test.mjs server/tests/synthetic-wifi-firewall-lease.test.mjs server/tests/synthetic-wifi-firewall-exception.test.mjs
```

변경 파일은 관찰자·해당 회귀 검사와 이 문서·`docs/communication-acceptance.md`다. 기존 실제 실패 보고서 두 개의 SHA-256이 유지됨을 재확인했다. 다음 단계는 보완된 관찰자로 승인된 좁은 방화벽 probe의 활성 작업 조회 경계를 확인하는 것이다. `vercel:verification`의 첫 실패 경계 원칙에 따라 이번에는 추가 승인창·앱·DB·인증서·실물 아이폰 시험을 시작하지 않았다. P103과 전체 목표는 미완료이며 실제 자료·공개 접속·배포는 계속 보류한다.

## 2026-10-12 예약 작업 기본값 수정 — 실제 활성화·lease 정리 확인, 독립 관찰 실패

사용자가 현재 개인 Wi-Fi의 아이폰 주소를 다시 확인하고 Windows 승인창에서 '예'를 눌렀다. 첫 실행의 제한 진단은 `phase=task-verify`, `cleanup=task-verify`, `flags=19`, `line=364`였다. 작업 트리거 검증 분기에서 실패했으나 당시 등록된 작업의 실제 형태는 관측하지 못했다. 정상 `lease.close()`는 확인되지 않았고, 같은 소유 실행 세션의 Ctrl+C 후 종료 1과 자원 부재를 관측했다. 운영자 기록 `test-results/synthetic-wifi-lease-aborted-7d176a4c-720b-4028-b9d5-b667fa2cdc09.json`은 계속 실패다. 이 외부 부재 관측으로 정상 정리를 대체하지 않는다.

현재 Windows의 비관리자 메모리 객체 생성에서 `New-ScheduledTaskTrigger`가 `StopAtDurationEnd=true`를 반환하는 것을 재현했다. 제품은 false를 요구하므로 `New-CleanupTimeTrigger`에서 등록 **전** false를 명시했다. 기존 검증 조건·방화벽 범위·종료 영수증은 유지한다. [Microsoft 반복 기간 문서](https://learn.microsoft.com/en-us/windows/win32/taskschd/repetitionpattern-duration)와 [종료 플래그 문서](https://learn.microsoft.com/en-us/windows/win32/taskschd/repetitionpattern-stopatdurationend)의 의미에 맞춘 명시적 설정이며, 원래 실패 작업의 모든 필드를 관측했다는 뜻은 아니다.

명시적인 PowerShell과 `CAREBRIDGE_TEST_NATIVE_CANCELLED_LEASE=1`, `CAREBRIDGE_TEST_IN_MEMORY_TASK_TRIGGER=1`에서 아래 집중 명령은 **67/67 통과**, 실패·취소·건너뜀 0, 실제 종료 0이다. 새 메모리 CIM factory/검증 함수 시험은 정상 설정과 6가지 변조 거부를 확인하고 OS 정책·UAC는 호출하지 않았다. JavaScript 문법·PowerShell 파싱·변경 파일 공백/충돌 검사와 독립 읽기 검토도 통과했다.

```text
node --test --test-concurrency=1 tests/synthetic-wifi-cli.test.mjs server/tests/synthetic-wifi-lease.test.mjs server/tests/synthetic-wifi-firewall-lease.test.mjs server/tests/synthetic-wifi-firewall-exception.test.mjs
```

수정본은 사용자의 새 승인 후 **실제 `ready`/활성 단계와 정상 `closeConfirmed`**에 도달했다. 그러나 독립 비관리자 관찰자의 `ACTIVE` 검사에서 실패해 자동 보고서 `test-results/synthetic-wifi-lease-a0649e4f-c6cf-4e2b-adc1-69ea10a9f6e7.json`은 **`passed: false`**다. `activeRulesVerified`·`cleanupTaskVerified`는 거짓, `closeConfirmed`·`ownedObjectsAbsent`·`observerExitsConfirmed`는 참이며 정리 재시도 0, 실제 종료 1이다. 도우미의 엄격한 검증 통과와 독립 관찰자의 완전한 검증을 구분한다.

2026-10-12 12:49:13 UTC 별도 읽기 확인에서 전용 Node·승인 프로세스·해당 UUID의 양 저장소 규칙·루트 예약 작업·8443 리스너는 모두 0이고 Public 분류가 유지됐다. 상태 영수증은 `removed`이며 실패 진단 파일은 없다. 이전 실행의 실패 자료도 보존했다. 당시 관찰자가 오류를 포괄적으로 숨겨 최초 실패 조건은 아직 특정할 수 없다. 승인창을 추가 반복하지 않았다. `vercel:verification`의 첫 실패 경계 원칙에 따라 API·DB·인증서·아이폰 시험은 시작하지 않으며 P103과 전체 목표는 미완료다.

`tests/windows-synthetic-wifi-lease-check.mjs`의 관찰자에 고정 단계명만 추가했다. 종료 1·정상 관찰 프로세스 종료·stderr 없음 및 정확히 `schema`, `ok`, `phase`인 실패 스키마를 통과한 경우에만 고정 열거값을 `report.failure.observerPhase`로 남긴다. 성공 및 정상 정리 조건은 변경하지 않고 오류 원문·경로·IP·작업 XML·계정도 출력하지 않는다. 기존 실제 실패 보고서를 소급 수정하지 않았다.

새 `tests/synthetic-wifi-lease-observer.test.mjs`는 실제 관찰 PowerShell 문자열을 비관리자·합성 provider로 검사한다. source hash·AST 허용 명령·mock 바인딩을 먼저 확인하며 실제 OS provider나 UAC는 호출하지 않는다. 정상 활성/부재와 조회 실패·빈 작업·스냅샷 실패·필드 불일치 등 14가지 경우와 잘못된 진단 거부를 확인한다. 독립 검토에서 발견한 시험 허용 목록의 `Set-StrictMode` 누락을 고쳤다. 앞 명령에 이 파일을 추가한 최종 5개 파일 회귀는 **82/82 통과**, 실패·취소·건너뜀 0, 실제 종료 0이다. JavaScript 문법 및 변경 파일 공백/충돌 검사도 통과했다. 67개와 82개를 합산하지 않는다. 이 mock 결과는 원래 실제 관찰 실패 원인이나 수정 진단의 실제 관리자 시험 결과를 대신하지 않는다. 다음 단계는 보완된 관찰자로 좁은 실제 probe를 한 번 검증하고 최초 실패 단계를 확인하는 것이다.

## 2026-10-12 제한 진단 추가 후 재검사 — 승인 단계 미통과, 정상 정리 확인

현재 승인된 네트워크의 읽기 전용 사전검사, 전용 Node의 서명·해시, 이전 실행의 정확한 임시 규칙/작업·8443 리스너 부재를 재확인하고 기본 좁은 방화벽 전용 probe를 한 번 실행했다. 예외 모드와 기존 방화벽 변경은 사용하지 않았다. 새 Windows 승인 프로세스를 실제 관측했지만 이 실행에 대한 사용자의 창 표시/선택 응답은 아직 없으므로 사용자가 취소했다고 해석하지 않는다.

자동 보고서 `test-results/synthetic-wifi-lease-c2bd1421-eea3-4072-bf6d-93d2ed6f510a.json`은 **`passed: false`**, `WAITING_APPROVAL` 단계 실패다. `ready`, `activeRulesVerified`, `cleanupTaskVerified`는 모두 거짓이며 실제 방화벽 활성화는 미검증이다. 반면 `closeConfirmed`, `ownedObjectsAbsent`, `observerExitsConfirmed`는 참이고 `cleanupRetries`는 0이다. 2026-10-12 08:54:37 UTC에 보고서를 작성하고 실제 종료 코드 1로 끝났다. 성공한 방화벽 수명 시험과 승인 단계 실패 후 정상 정리를 구분한다.

새 제어 폴더에는 `stop`만 있고 `status.json`/`failure.json`은 없다. 이것만으로 이전 관리자 실행의 실패 원인을 설명하거나 진단 코드 결함으로 단정하지 않는다. 08:55:02 UTC의 별도 읽기 확인에서 소유 probe 프로세스는 없고 정확한 새 UUID 규칙(양 저장소)·예약 작업·8443 리스너는 모두 0이었다. Ctrl+C나 강제 종료 없이 종료됐으며 새 폴더/실패 보고서는 보존했다. 앱·DB·인증서·아이폰 시험은 시작하지 않았다.

추가 UAC는 반복하지 않는다. 사용자가 이번 승인창 표시와 선택 결과를 알려주면 다음 실제 검사의 시작 시점을 맞춘다. 아래 66/66은 진단 추가 시점의 회귀 증거이며 이번 turn에서 재실행한 테스트나 방화벽 성공 결과가 아니다. 이번에는 제품 코드를 변경하지 않고 실행 증거와 완료표만 갱신했다. P103과 전체 목표는 미완료다.

## 2026-10-12 수정본 실제 실행 — 실패 영수증 확인 및 제한된 진단 보완

목표 재개 후 PC의 네트워크가 달라져 기존 구성의 읽기 전용 사전검사가 `network`로 거부됐다. 사용자가 현재 연결의 신뢰 가능한 개인 Wi-Fi 여부와 같은 네트워크의 아이폰 IPv4를 다시 확인했다. 주소는 런타임 인자로만 사용하고 소스나 이 문서에 고정하지 않았다. 새 구성의 사전검사 통과 후 기본 좁은 규칙 모드의 방화벽 전용 probe를 한 번 실행했고, 사용자가 새 Windows 승인창에서 '예'를 눌렀다고 확인했다.

이전과 달리 새 제어 폴더에 `{"stage":"failed"}` 상태 영수증이 생성됐다. 따라서 상태 파일 초기화 경계는 지났지만 `ACTIVE`/`removed`와 정상 `lease.close()`는 확인되지 않았다. `failed`는 최종 규칙·예약 작업 정리 확인이 모두 충족되지 않았다는 뜻이며, 관리자 확인·규칙 검증·예약 작업 검증 중 어느 분기인지는 현재 영수증으로 구분되지 않는다. 활성화 미관측을 규칙이 한 번도 생성되지 않았다는 증거로 해석하지 않는다.

같은 소유자의 정리 재확인 중 도우미·승인 프로세스와 정확한 UUID의 규칙(양 저장소)·예약 작업·8443 리스너 부재를 확인했다. 같은 실행 세션에 Ctrl+C를 보낸 뒤 실제 종료 1과 진단 프로세스 부재를 확인했다. 2026-10-12 08:29:25 UTC의 재확인에서는 해당 자원이 모두 0이고 Public 분류·취소 표시·실패 영수증이 보존됐다. Win32 강제 종료나 파일/기존 규칙 삭제는 하지 않았다. 자동 성공 보고서는 생성되지 않았으며 운영자 실패 기록은 `test-results/synthetic-wifi-lease-aborted-037e9c91-60a2-41eb-a744-710678e263e5.json`이다.

추가 UAC를 반복하지 않고 `scripts/synthetic-wifi-firewall-lease.ps1`에 제한된 실패 진단을 추가했다. 이미 검증·고정된 상태 파일 핸들이 있는 실패 경로에서만 `failure.json`을 새로 배타 생성한다. UTF-8 최대 256바이트, 정확히 `schema`, `phase`, `cleanup`, `flags`, `line`만 기록한다. 단계는 고정 열거값이고, 오류 원문·스택·경로·IP·계정·PID·비밀·시각은 기록하지 않는다. `line`은 최초 본문 오류의 숫자 행을 우선하며 본문 오류가 없으면 최초 정리 오류의 행을 사용한다. 범위는 0..99999, 0은 미확인이다. 파일명을 기록하지 않으므로 어느 스크립트의 행인지는 이것만으로 확정하지 않는다.

`flags`는 6비트 관측값이다: 1=관리자 확인, 2=정리 작업 등록 **시도**, 4=규칙 생성 **시도**, 8=예외 복원 준비, 16=규칙 정리 확인, 32=작업 정리 확인. 시도/준비는 실제 생성·포트 변경 성공이 아니며 비트 0은 부재 증거가 아니다. 진단의 읽기·생성·쓰기·해제 오류는 기존 정리를 막거나 판정을 바꾸지 않는다. 기존 `status.json` 및 실제 프로세스 종료를 요구하는 `lease.close()` 조건은 유지한다. 진단은 정리 영수증이 아니며, 없거나 불완전한 파일만으로 실패 원인을 추정하지 않는다. 앞선 실패 실행에는 이 파일이 없으므로 정확한 원인은 여전히 미확정이다.

대응 검사 `server/tests/synthetic-wifi-firewall-lease.test.mjs`에 스키마/상한/최초 오류 위치, 메모리 대역의 덮어쓰기 거부 및 관측 실패 격리, 비관리자 `&`/`-File` 거부 경로의 실제 진단, 정상 사전 취소의 진단 미생성을 추가했다. 비관리자·소스 해시·AST 실행 순서를 먼저 확인하며 실제 방화벽/예약 작업 명령과 UAC는 실행하지 않는다. 메모리 대역은 실제 파일 시스템의 배타 생성 검증을 대체하지 않는다. 새 시험 소유 fixture만 실제 자식 종료 후 정리했고 이전 실패 증거는 보존했다.

명시적인 `CAREBRIDGE_TEST_POWERSHELL`과 `CAREBRIDGE_TEST_NATIVE_CANCELLED_LEASE=1`에서 `node --test --test-concurrency=1 tests/synthetic-wifi-cli.test.mjs server/tests/synthetic-wifi-lease.test.mjs server/tests/synthetic-wifi-firewall-lease.test.mjs server/tests/synthetic-wifi-firewall-exception.test.mjs`는 **66/66 통과**, 실패·취소·건너뜀 0, 실제 종료 0이었다. 대응 JavaScript의 `node --check`도 통과했다. 내부 mock 70개는 합산하지 않는다. 이 결과는 제한된 진단·취소·실행기 회귀이며 실제 관리자 방화벽 수명 성공이 아니다. 아래 62/62는 앞선 소스의 이력이다.

`vercel:verification`의 첫 실패 경계에서 멈추는 원칙에 따라 API·DB·인증서·아이폰 연결 시험은 시작하지 않았다. 다음 단계는 현재 네트워크와 잔여 자원을 재확인한 뒤 수정본의 좁은 방화벽 전용 probe 한 번에서 실제 활성화·정상 제거를 확인하거나 새 제한 진단으로 실패 지점을 좁히는 것이다. 그 경계 통과 전에는 실물 기기 시험으로 넘어가지 않는다.

## 2026-10-12 직접 실행 초기화 결함 수정 — 실제 방화벽 재검증 대기

일반 권한의 새 UUID 시험 폴더에 `stop`을 먼저 만든 뒤 실제 도우미를 실행하여, **호출 연산자 `&`는 통과하지만 `pwsh -File`은 실패**하는 차이를 재현했다. 임시 최소 진단에서 기존 도우미 346행의 `$args.Count`가 `VariableIsUndefined`로 실패함을 확인했다. `CmdletBinding` 고급 스크립트의 직접 실행에서는 이 자동변수가 정의되지 않으며, 기존 호출 래퍼에서는 상위 스코프의 변수가 문제를 가리고 있었다. 실패는 상태 파일 생성보다 앞선다.

`scripts/synthetic-wifi-firewall-lease.ps1`에서 불필요한 `$args.Count` 검사만 제거했다. `CmdletBinding`은 유지하며 미바인딩 인수는 PowerShell 바인더가 본문 진입 전에 거부한다. 방화벽 범위·관리자 검사·경로/프로세스 검증·정리 영수증 조건은 변경하지 않았다. 임시 진단 출력은 제거했다. 실제 승인 후 실행과 같은 직접 진입 경로의 결함을 수정했지만, 이전 승인 프로세스의 원래 예외를 직접 관측했다거나 수정본의 실제 방화벽 수명이 검증됐다는 뜻은 아니다.

`server/tests/synthetic-wifi-firewall-lease.test.mjs`에 안전 순서 검사와 opt-in native 회귀 4가지를 추가했다. `&` 및 `-File`은 실제 상태 파일 `{"stage":"removed"}`와 종료 0을 확인했고, 알 수 없는 이름/남는 위치 인수는 본문과 상태 파일 생성 전에 거부됐다. 새 일반 권한 프로세스·사전 취소·현재 소스 해시/AST 경계를 검사한다. `&` 경로의 OS 명령 차단 함수는 별도 `-File` 자식에 상속되지 않으며, 후자는 비관리자 토큰·사전 취소·검토된 관리자/OS 실행 순서에 의존한다. 임의 코드용 보안 샌드박스가 아니다. 실제 자식 종료 후 이번 fixture의 두 파일과 빈 폴더만 정리했으며 기존 실패 증거는 보존했다.

명시적인 `CAREBRIDGE_TEST_POWERSHELL`과 `CAREBRIDGE_TEST_NATIVE_CANCELLED_LEASE=1`에서 `node --test --test-concurrency=1 tests/synthetic-wifi-cli.test.mjs server/tests/synthetic-wifi-lease.test.mjs server/tests/synthetic-wifi-firewall-lease.test.mjs server/tests/synthetic-wifi-firewall-exception.test.mjs`는 **62/62 통과**, 실패·취소·건너뜀 0, 실제 종료 0이었다. 변경 JavaScript 3개 문법 검사와 독립 읽기 검토도 완료했다. 내부 mock 70개는 합산하지 않는다. `vercel:verification`의 실제 진입 경로 검증 기준에 따라 래퍼 검사와 실제 `-File` 결과, 관리자 방화벽/실물 기기 결과를 분리했다.

진단 중 새 UAC·방화벽·예약 작업·API·DB·인증서·아이폰 접속은 실행하지 않았다. 다음 단계는 수정본의 좁은 방화벽 전용 probe에서 실제 승인→활성→정상 정리를 확인하는 것이다. 그 이후에만 아이폰 가상 자료 시험으로 넘어간다. 기존 실패 보고서는 계속 `passed: false`다.

## 2026-10-12 앞선 재실행 — 사용자 승인 확인, 초기화 실패 기록

사용자가 직접 실행을 요청해 수정된 실행기로 방화벽 전용 probe를 한 번 실행했다. Windows 승인 프로세스를 관측했고 사용자가 **창이 나타나 '예'를 눌렀음**을 확인했다. 이번에는 승인창 미표시나 승인 대기로 실패를 설명하지 않는다. 다만 `WAITING_APPROVAL` 이후 `CLEANUP_UNCONFIRMED`가 발생했고, 새 UUID의 `status.json`과 `active`/`removed` 영수증은 남지 않았다. 도우미 초기화 성공과 정확한 실패 원인은 아직 확인되지 않았다.

PowerShell 자식·승인 프로세스가 종료된 뒤에도 원래 소유자의 정리는 확인되지 않았다. 같은 소유자의 취소/정리 재확인만 수행했으며 새 UAC나 lease를 만들지 않았다. 도우미·자식·승인 프로세스, 정확한 UUID의 양 저장소 규칙·예약 작업·8443 리스너가 없고 취소 표시가 남아 있음을 확인한 뒤, 생성 시각과 실행 경로를 동일 핸들에 고정한 **진단 Node만** 종료했다. 2026-10-12 05:39:30 UTC의 재확인에서도 이 자원들은 모두 없고 네트워크는 Public이었다. 제어 폴더와 취소 표시는 보존했다.

실행은 종료 코드 1이며 정상 lease 종료/실물 시험 통과가 아니다. 도구 출력과 사용자 응답에 근거한 실패 기록은 `test-results/synthetic-wifi-lease-aborted-fa2dceb4-b8c1-47a8-b541-015c3fc128d2.json`이다. API·DB·인증서·아이폰 시험은 실행하지 않았다. 추가 관리자 요청 없이 영수증 생성 전의 초기 경로 검사를 읽기 전용으로 진단한다. 이전 57/57 자동 검사는 이 실패를 대신하지 않는다.

## 2026-10-12 이전 단계 — 승인 취소 분류 수정

후속 사용자 확인: 이전 Windows 승인창은 **보이지 않았다**고 응답했다. 2026-10-11 15:28:50 UTC의 읽기 전용 조회에서 Appinfo 서비스는 Running, UAC와 보안 데스크톱은 켜져 있었고 검사 셸과 Explorer의 세션은 같았다. 이전 시험의 전용 프로세스·승인 프로세스·정확한 임시 규칙/작업·8443 리스너는 모두 0이었다. 전용 Node 복사본도 서명 Valid 및 기존 SHA-256 일치를 재확인했다. 이 정보만으로 창이 보이지 않은 원인을 확정하지 않는다.

자동 재요청 대신, 사용자가 직접 연 **일반 권한 PowerShell**에서 기존 `tests/windows-synthetic-wifi-lease-check.mjs`를 전용 Node와 승인된 현재 인자 12개로 실행하도록 안내한다. 관리자 PowerShell/Node를 사용하거나 예외 인자를 덧붙이지 않는다. 이는 같은 좁은 방화벽 생성·제거 검사이며 API·DB·인증서를 시작하지 않는다. 아직 수동 실행 결과는 없으며 `PASSED` 및 새 보고서의 실제 정상 정리를 확인하기 전에는 다음 단계로 넘어가지 않는다. `CLEANUP_UNCONFIRMED`가 나오면 창을 닫거나 재실행하지 않고 동일 소유자의 정리 상태를 확인한다. UAC 정책·네트워크 분류·기존 방화벽은 변경하지 않았다.

설치된 PowerShell 7.6.5의 `Start-Process`는 ShellExecute에서 받은 Win32 예외를 내부 예외 없는 메시지형 예외로 바꾼다. [해당 버전 공식 소스](https://github.com/PowerShell/PowerShell/blob/v7.6.5/src/Microsoft.PowerShell.Commands.Management/commands/management/Process.cs)의 `StartWithShellExecute`와 무동작 대역 재현으로, 기존 실행기가 명확한 Windows 취소 코드 1223을 잃을 수 있음을 확인했다. **이 코드 결함이 이전 두 실제 probe 실패의 원인이었다고 확정한 것은 아니다.** 당시 사용자의 승인창 표시·선택과 원래 오류 번호는 확인되지 않았다.

`server/synthetic-wifi-lease.mjs`의 실행 부분만 고정 인자의 `.NET Process.Start`로 바꿨다. `runas`와 숨김 창 설정을 유지하며, 시작 호출에서 실제 `Win32Exception(1223)`을 받은 경우에만 `declined`로 분류한다. 문자열에 1223이 있거나 같은 이름의 속성이 있다는 이유로 취소로 추정하지 않는다. 시작 이후 대기·종료 코드 읽기·핸들 해제 실패 및 예상 밖 helper 종료 코드는 `observation-failed`/253으로 처리한다. 기존 상태 영수증과 실제 launcher/stdio 종료를 요구하는 정리 조건은 그대로다.

`WaitForExit`는 전체 자손이 아닌 정확한 helper 프로세스를 기다린다. 현재 고정 helper와 연결 스크립트는 동기 작업만 수행한다는 조건으로 검토했다. 이후 비동기 자식/작업을 추가하면 이 대기·정리 경계를 다시 검토해야 한다.

`server/tests/synthetic-wifi-lease.test.mjs`에 실제 PowerShell로 실행하는 무동작 대역 15경우와 메시지형 예외 재현을 추가했다. 생성된 명령의 실제 `Process.Start` 한 곳만 대역으로 치환하고 실제 시작 경로가 남지 않았음을 먼저 검사한다. 설정·대기·종료 관측·해제 호출 순서도 검증한다. **UAC·helper·방화벽·API를 실제 실행한 검사가 아니다.**

최종 실행: 명시적인 `CAREBRIDGE_TEST_POWERSHELL`을 지정한 `node --test --test-concurrency=1 tests/synthetic-wifi-cli.test.mjs server/tests/synthetic-wifi-lease.test.mjs server/tests/synthetic-wifi-firewall-lease.test.mjs server/tests/synthetic-wifi-firewall-exception.test.mjs`는 **57/57 통과**, 실패·취소·건너뜀 0, 실제 종료 0이다. 내부 방화벽 mock 70개는 별도 합산하지 않는다. 두 변경 JavaScript 파일의 `node --check`도 통과했다. 아래 40/75개 및 전체 3,105개는 각각 당시 소스의 이전 증거이며 이번 전체 재검증으로 계산하지 않는다.

이번에는 새 UAC 요청·방화벽 변경·서버·인증서 설치를 하지 않았다. 2026-10-11 15:12:54 UTC의 읽기 전용 확인에서 이전 probe·전용 런타임·해당 임시 규칙/작업·8443 리스너·승인 프로세스는 모두 없었다. 다음 단계는 사용자가 승인창을 확인할 수 있는 상황에서 방화벽 전용 probe의 실제 시작과 정상 정리를 확인하는 것이다. 그 후에만 아이폰 가상 자료 시험으로 넘어간다.

## 2026-10-12 이전 준비 상태 — 실제 probe 실패 기록

사용자는 기존 TCP 차단 규칙의 8443 임시 예외 범위를 승인했다. 해당 선택 기능은 구현했지만, 이후 실제 조회에서 대상 원본 규칙이 `Block`이 아닌 `Allow`로 확인되었다. 변경 시점·주체는 확인되지 않았으며, 이 작업에서 기존 규칙을 변경하거나 `Allow`를 `Block`으로 전환하지 않았다. 예외 모드는 이 사전조건을 거부하며 실제 실행하지 않았다. 아래의 ‘미구현·미승인’ 내용은 이전 단계의 이력이다.

기존 규칙을 건드리지 않는 대안으로, 설치된 서명 유효 Node를 새 UUID의 전용 폴더에 복사했다. 원본/복사본 서명·해시 일치, 단일 일반 파일·경로·링크 여부·사용자/SYSTEM/Administrators ACL을 확인했다. 제한된 자식 환경에서 **기본 좁은 Allow 모드의 읽기 전용 사전검사**가 실제 종료 0으로 통과했다. 새 경로로 기존 차단 정책을 우회하지 않으며, 다른 충돌이 발견되면 중단한다.

코드 보완은 정확한 원본 선택·조건부 복원·나머지 주소/포트 차단 guard·독립 SYSTEM 복원 작업과 부모의 고정 만료 시간이다. 자기 Allow도 양 저장소에서 반복 검증하며, 정적 주소 외의 동적 원격 주소나 앱 ID 조건이 추가되면 거부한다. 예외 모드의 복원은 mock 검사만 통과했으며 실제 관리자 변경·정전 복구를 검증한 것이 아니다. 기본 모드의 동작 범위를 넓히지 않았다.

실제 방화벽 전용 probe를 두 차례 시도했으나 **통과하지 못했다**. 첫 검사는 안전 검토 보완을 위해 취소했고, 두 번째는 Windows 승인 프로세스가 관측됐지만 준비 제한 시간이 지나 취소되었다. 두 경우 모두 도우미의 `active`/`removed` 상태 파일이 없었고 정상 `lease.close()` 증거를 얻지 못했다. 승인창이 사용자에게 보였는지, 실제 승인됐는지 및 상태 파일이 없는 정확한 원인은 확인되지 않았다. 반복 승인 요청은 중단했다.

도우미·자식·승인 프로세스와 정확한 UUID의 규칙(양 저장소)·예약 작업·리스너가 없음을 오류 없는 조회로 확인한 뒤, 대기만 남은 진단 Node만 동일 프로세스 핸들의 생성 시각·실행 경로를 검증하여 종료했다. 도우미를 강제 종료하거나 기존 규칙을 삭제하지 않았다. 취소 표시와 제어 폴더는 보존했다. 종료 후 재확인 시 두 probe 프로세스·전용 런타임 프로세스·임시 규칙·작업·8443 리스너·승인 프로세스 모두 0, 네트워크는 `Public`이었다. 이 외부 확인을 정상 lease 종료나 실제 방화벽 수명 검사 성공으로 기록하지 않는다.

증거는 `test-results/synthetic-wifi-lease-aborted-96b0f675-11bb-495d-b795-fd973918829a.json`과 `test-results/synthetic-wifi-lease-aborted-750bdf6d-ea57-4a1e-8d38-bd5ca937690d.json`이다. 자동 성공 보고서가 아닌 도구 출력 기반의 운영자 실패 기록임을 표시했다. 마지막 부재 확인은 2026-10-11 15:09:10 UTC다. probe는 앱·DB·인증서·아이폰 연결을 시작하지 않았다.

취소 분류 수정 전 소스의 집중 검사 `node --test tests/synthetic-wifi-cli.test.mjs server/tests/synthetic-wifi-lease.test.mjs server/tests/synthetic-wifi-firewall-lease.test.mjs server/tests/synthetic-wifi-firewall-exception.test.mjs`는 명시적인 `CAREBRIDGE_TEST_POWERSHELL`로 **40/40**, 실패·취소·건너뜀 0, 실제 종료 0이었다. 내부 mock 70개는 별도 합산하지 않는다. 인증서·HTTPS·Wi-Fi 세션·native 자식 수명의 별도 6개 시험 파일도 **75/75**, 실제 종료 0이었다. 문법·정적 빌드·diff 검사가 통과했고 공개 빌드에는 `local-api`가 없다. 이전 전체 3,105개 결과는 이 준비 변경 이전 증거다.

추가 파일은 `server/synthetic-wifi-exception-policy.mjs`, `scripts/synthetic-wifi-firewall-exception.ps1`, 해당 검사와 `tests/windows-synthetic-wifi-lease-check.mjs`다. 실행기·lease·기존 방화벽 정책 및 대응 검사를 보완했다. probe는 정리 불확실 시 같은 소유자만 30초마다 재확인하며 새 lease/UAC를 만들지 않는다. 현재 두 probe는 종료된 상태다.

다음 단계는 사용자가 실제 Windows 승인창을 확인할 수 있을 때 승인→도우미 시작→정상 정리를 진단하는 것이다. 이 경계가 통과하기 전에는 앱 서버와 아이폰 시험으로 넘어가지 않는다. 인증서 신뢰 설치·실물 전달·사진/영상·단절/재접속·독립 백업·실제 자료 베타는 여전히 미완료다.

## 경계와 수명

- 일반 권한 Node/DB/작업자를 사용한다. 관리자 권한은 고정 방화벽 도우미에만 요청한다.
- PC의 명시적인 사설 IPv4와 TCP 8443에만 HTTPS를 바인딩한다. 앱도 실제 TLS 연결의 상대 주소를 검사한다. 역할·담당 관계·세션·CSRF 검사는 그대로 유지한다.
- 현재 Wi-Fi의 Public 분류를 바꾸지 않는다. 방화벽은 실행 파일·인터페이스·PC 주소·아이폰 주소·포트에 모두 제한한다. 기존 적용 가능 Allow/Block 규칙이 있거나 해석이 불확실하면 중단하고, 다른 규칙을 수정하지 않는다.
- 임시 규칙은 최대 2시간이다. 도우미는 실행기 프로세스와 네트워크 상태를 감시한다. 규칙 생성 전에 등록한 독립 정리 작업이 기한·Windows 시작 시 같은 UUID의 규칙만 정리한다. 정상 종료에서는 규칙 부재를 확인한 후 정리 작업도 제거한다. 정리 실패를 성공으로 표시하지 않는다.
- 웹 인증서는 DB용 인증서와 분리한다. 루트 개인키는 서명 후 폐기하고, 웹 개인키는 메모리·전용 자식 stdin 파이프로만 전달한다. 공개 `.cer` 파일에 개인키는 없다. OS 신뢰 저장소는 자동으로 변경하지 않는다.
- API만 재시작할 때에는 같은 주소·인증서·E 가상 자료를 사용한다. **전체 Wi-Fi 시험 종료 뒤 재개는 지원하지 않는다.** 이전의 PC 전용 재개 기능과 구분한다. 문자열·런타임 내부 메모리의 완전 영점화를 보장하지 않는다.

## 실행

명시적으로 승인받은 현재 주소와 Wi-Fi 인터페이스 번호를 사용한다. 주소를 소스에 고정하거나 자동으로 새 기기로 확대하지 않는다. PostgreSQL·PowerShell·Docker 검사 환경이 먼저 준비되어 있어야 한다.

```powershell
npm run dev:synthetic-wifi -- --host <PC IPv4> --peer <아이폰 IPv4> --interface-index <Wi-Fi 번호> --confirm-private-wifi --base <E 기본 경로> --powershell <pwsh.exe 절대경로> --confirm-synthetic-e-drive
```

직접 사용하는 터미널에서만 실행한다. 가상 계정은 준비 후 해당 터미널에 한 번 표시하며 파일·URL·일반 보고서에는 저장하지 않는다. 출력 리디렉션을 사용하지 않는다. 터미널에서 `r`+Enter는 API만 재시작, `q`+Enter 또는 Ctrl+C는 종료다. 종료 불확실 안내가 나오면 창을 닫지 말고 Ctrl+C로 같은 정리를 재확인한다.

기본 Node 실행 파일에 이미 광범위한 인바운드 허용 규칙이 있으면 준비 단계에서 거부한다. 기존 규칙을 자동 수정하지 않는다. 별도로 설치·검증된 Node 24 실행 파일의 **절대 경로**로 이 스크립트를 직접 실행하면, 그 실행 파일과 모든 자식이 같은 `process.execPath`를 사용한다. 새 경로의 방화벽 충돌 검사를 반드시 다시 통과해야 한다. 프로그램 방화벽 조건은 이름만이 아니라 전체 실행 경로에 적용된다. [Microsoft 프로그램 조건](https://learn.microsoft.com/en-us/powershell/module/netsecurity/new-netfirewallrule?view=windowsserver2025-ps#-program)

## 아이폰 수동 인증서 설치

1. 실행기가 출력한 공개 인증서 파일만 아이폰에 옮긴다. 별도 개인키나 비밀번호를 옮기지 않는다.
2. 발급된 Carebridge 시험 인증서인지 이름과 SHA-256 지문을 확인하고 설치한다. 출처가 다른 프로파일이나 기기 관리 등록은 설치하지 않는다.
3. 설정 → 일반 → 정보 → 인증서 신뢰 설정에서 이번 시험 루트의 신뢰를 켠다. 수동 프로파일 설치만으로 SSL 신뢰가 자동 활성화되지는 않는다. [Apple 인증서 신뢰 안내](https://support.apple.com/en-us/102390)
4. 같은 개인 Wi-Fi에서 출력된 HTTPS 주소를 Safari로 연다. 인증서 경고를 무시하여 접속하지 않는다. Windows 일반 브라우저도 별도의 수동 신뢰 설정 없이는 경고가 날 수 있다. 자동 검증은 요청별 공개 CA를 사용하며 Windows 신뢰를 바꾸지 않는다.
5. 시험 종료 뒤 설정 → 일반 → VPN 및 기기 관리에서 **이번에 설치한 Carebridge 시험 프로파일만** 삭제한다. [Apple 프로파일 삭제 안내](https://support.apple.com/guide/personal-safety/review-and-delete-configuration-profiles-ips327569a75/web)

## 검증 범위

순수 계약·수명 검사, 실제 메모리 인증서/루프백 TLS 검사, 실제 E 서버의 인증 HTTPS 왕복, 실물 아이폰 시험을 구분한다. 앞 단계가 통과했다고 실물 기기의 전달·사진/영상 재생·Wi-Fi 재접속이 검증된 것은 아니다.

실물 확인 항목: 두 역할 로그인 → PC 발신/아이폰 수신 → 아이폰 가상 사진·영상 발신/PC 열람 → Wi-Fi 끊기/재접속 후 저장된 메시지 확인 → API 재시작 후 다시 로그인 → 종료 후 접속 불가와 시험 프로파일 삭제.

단절 시험은 **안정적인 개인 공유기 Wi-Fi에서 PC 연결을 유지하고 아이폰 클라이언트만 끊었다가 연결**한다. 아이폰이 PC에 핫스팟을 제공하는 상태에서 핫스팟을 끄면 PC의 승인 네트워크 경계도 사라지므로 실행기의 전체 종료가 예상 동작이다. 이를 API 재시작 결함으로 판단하거나 경계 감시를 완화하지 않는다. 클라이언트 재접속 시험과 API 재시작 시험은 나누어 기록하고, 재연결 후 주소가 달라졌다면 기존 허용 주소를 임의로 확대하지 않는다.

독립 백업이 없으므로 실제 자료 베타는 계속 금지한다. 메일 발송·실제 계정 온보딩·외부 배포·사람 대상 사용성 비교는 이번 시험으로 완료 처리하지 않는다.

### 2026-10-11 실제 E 서버 사전 검증

`tests/windows-synthetic-wifi-check.mjs`에 실행기와 같은 12개 인자를 전달해 실행했다. 방화벽/UAC/OS 신뢰를 바꾸지 않고, PC 자신의 주소로 요청별 CA 검증을 적용했다. 실행 `f1c58495-21b4-4669-861e-a1ad96dad99b`의 **13개 항목이 모두 참**, 실제 명령 종료 0이다.

HTTPS 인증서·준비 화면·미인증 401·치료사/보호자 로그인과 Secure 쿠키·실제 메시지 전달·동일 발신 재시도·종전 API 실제 종료·같은 주소 재시작·빈/종전 쿠키 거절·새 로그인·DB 메시지 보존을 확인했다. API·worker·세션 종료, 임시 비밀 폐기와 원본 웹 키 버퍼 정리도 모두 확인했다. 이후 8443 리스너와 시험 컨테이너가 없음을 별도 조회했다. 사진·영상 재생이나 실물 아이폰 성공으로 계산하지 않는다.

증거: `test-results/synthetic-wifi-native-f1c58495-21b4-4669-861e-a1ad96dad99b.json`, SHA-256 `5eb913c1de5bad832ca87da3cedcab7d34ee4d4e911f927bd314998aa36c3c45`. 보고서에는 실제 주소·계정·메시지·쿠키·개인키가 없다.

기본 실행 파일의 기존 Public 전체 허용 규칙이 확인되어, 서명 유효성을 확인한 별도 설치 Node 24.19.0에서 같은 실제 검증을 다시 실행했다. `38cfc6ba-7a0e-4d3c-b73a-e0bbcf610dbc`도 **13/13**, 종료 0과 동일한 정리 증거가 모두 통과했다. 파일 `test-results/synthetic-wifi-native-38cfc6ba-7a0e-4d3c-b73a-e0bbcf610dbc.json`의 SHA-256은 `72d878bfacb9a57e5599188a8ae77ee67e0b76b24fe734aef7b4af538a23247f`다. 서로 다른 시험을 합쳐 실물 두 기기 성공으로 계산하지 않는다. 기존 광범위한 Node 규칙은 수정하지 않았다.

### 이전 단계 이력 — 활성화 차단과 승인 대기

별도 실행 파일에 대해서도 최종 읽기 전용 사전검사에서 기존 **Public / TCP / 모든 포트 / 모든 원격 주소 Block** 규칙을 확인했다. 별도 UDP 차단도 있으나 이번 TCP 시험과 무관하며 변경 대상으로 삼지 않는다. 새 Allow 규칙은 기존 Block을 이길 수 없으므로 UAC·시험 규칙·예약 정리 작업을 실제로 활성화하지 않았다. 시험 리스너·Carebridge 규칙·Carebridge 정리 작업은 각각 0이며 네트워크는 Public을 유지한다. Docker 엔진은 기존 로컬 검사 용도로 시작했다.

다음 제안은 **현재 미구현·미승인**이다: 기존 TCP 차단에서 8443만 시험 중 임시 예외로 만들고 다른 포트 차단은 유지한다. 정확한 시험 Allow는 여전히 지정 아이폰만 허용한다. 기존 규칙의 원본 조건·소유권·정리/복원 실패 대응을 별도로 구현·검증한 뒤 적용해야 하며, 현재 lease는 기존 규칙 변경을 자동으로 허용하지 않는다. 실제 아이폰 연결·인증서 설치는 아직 완료하지 않았다.

집중 회귀 249개, 이후 방화벽 모듈 22개가 각각 통과했으며 서로 겹치는 항목을 합산하지 않는다. 구문 검사·정적 빌드·diff 검사가 통과했고 공개 빌드에는 `local-api`가 없다.

후속으로 서버·루트 회귀 명령 `node --test --test-concurrency=1 --test-reporter=tap --test-reporter-destination=test-results/synthetic-wifi-full-20261011-df8d0b71.tap 'server/tests/*.test.mjs' 'tests/*.test.mjs'`의 **실제 종료 코드 0**을 확인했다. 명시적인 기존 Node 24.19.0 및 `CAREBRIDGE_TEST_POWERSHELL` 경로를 사용했다. 결과는 **3,105/3,105 통과**, 실패·취소·건너뜀·TODO 0, 2개 suite, 소요 598,495.9129ms다. TAP 파일 SHA-256은 `f702a5be81aabef3d3348c059c634f0dc7ce0da86968e411659517efc31fd1a7`이다. 파일의 최종 기록 시각은 2026-10-11 10:58:59 UTC다. 이 회귀 통과는 실제 방화벽 변경·복원, 실물 아이폰 연결·미디어 재생·Wi-Fi 재접속을 검증한 것이 아니며, 해당 경계는 여전히 미완료다.

주요 변경 파일: `scripts/synthetic-wifi-api.mjs`(대화형 실행), `server/windows-synthetic-wifi-session.mjs`(E 세션 조합), `server/windows-local-api-service.mjs`와 `windows-native-api-test-{policy,parent,control}.mjs`, `windows-wifi-api-child.mjs`, `synthetic-wifi-network.mjs`(HTTPS/자식 수명), `synthetic-wifi-certificate.mjs`와 대응 PowerShell(별도 인증서), `synthetic-wifi-lease.mjs`와 두 방화벽 PowerShell(한정 규칙·검사·정리), 관련 단위 검사, `tests/windows-synthetic-wifi-check.mjs`(실제 E 사전 검증), `package.json`의 실행 명령과 이 문서/완료표다.
