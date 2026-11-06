# 대상자 MVP 및 과제 A 대행 검증 기록

검증일: 2026-10-16. 코드 변경과 검사는 `carebridge-recipient-work/workspace` 독립 사본에서 수행했다. 1–5절의 코드·메모리·브라우저 검사는 E 드라이브 자료를 사용하지 않았다. 6절의 후속 native 검사는 승인된 합성 복원 검증 범위에서 새 UUID의 E 시험 폴더만 사용했다. 실제 개인정보·원래 사용자 Chrome·운영 DB·기존 E 자료·방화벽·Windows 인증서 신뢰 저장소·외부 배포는 변경하지 않았다.

원본 평가 대상 524개 파일은 준비 기준과 SHA-256이 모두 같고 누락·변경은 0개였다. 집계 해시는 `11866b85ee1b475bd4401af58fec83ea66943ab8348715450305d0949a069bab`이다. 임시 검사 산출물을 원본 평가 결과로 옮기지 않았다.

## 1. 실제로 확인한 흐름

### 과제 A — AI가 수행한 별도 기능 확인

새 메모리 DB와 새 소유 Chrome 컨텍스트에서 다음 경로를 직접 실행했다.

홈 ‘하루’ 소식 → ‘놀이 참여 관찰’ 공유 카드 → ‘좋아하는 놀이 함께 고르기’ → ‘활동 경험 남기기’ → 저장 → 새로고침 → ‘활동 경험 수정’.

| 항목 | 입력·DB 저장·API 조회·새로고침 후 값 |
| --- | --- |
| 활동 날짜 | 2026-10-16 |
| 수행 상태 | 일부 했어요 (`partial`, 과제의 ‘조금 해봄’에 해당) |
| 아이 반응 | 가상 사례: 놀이를 직접 골랐어요. |
| 어려움 | 가상 사례: 오래 이어가기 어려웠어요. |

활동 경험은 한 번만 저장됐고 기존 치료 기록은 보존됐다. 임시 브라우저와 DB는 종료 확인했다. 원래 사용자 평가 세션은 사용하지 않았으며, 소요 시간·이동 수·만족도·이해도는 측정하지 않았다. 사용자 원래 세션의 과제 완료로 합치지 않는다.

증거: `test-results/local-p0-task-a-agent-9dea826d-af20-4b85-b386-65a55e14e93d/results.json`, `1440-A-reopened.png`.

### 독립 대상자 계정 — 390px / 1440px

관리자 초대 UI → 합성 전용 전달 채널 → 대상자 독립 수락 → 본인 표시 이름 → 관리자 명시 연결 → 텍스트 전송 → 보호자 수신 → 주 소통자 지정 → 새로고침 후 표시.

두 화면 폭에서 다음을 확인했다.

- 센터 가입만으로 대화가 열리지 않으며, 연결 후에도 이전 메시지는 조회되지 않는다.
- 대상자는 홈·대화·참여 정보만 표시된다. 임상·미디어 호출을 화면에서 하지 않으며 직접 HTTP 조회도 거부된다.
- 보호자 계정을 바꾸지 않고 새 대상자 텍스트를 기존 보호자가 수신한다.
- 주 소통자 변경 전후 회원·참여·읽음·기록 수신자 DB 상태가 같다.
- 새로고침 후 주 소통자와 권한 구분 안내가 유지된다.
- 가로 넘침 없이 입력·버튼에 접근한다. 브라우저 저장소에 자격증명을 보관하지 않는다.
- 콘솔 오류·예상하지 않은 요청이 없으며 임시 DB·자격증명·격리 폴더·브라우저를 정리했다.

증거: `test-results/care-recipient-22dac0db-35e4-434f-adea-808b6c5ad91d/results.json`. 스크린샷 16개 중 모바일 홈·대화·관리자 CTA 및 PC 관리자 화면을 직접 확인했다. 관계 인원 경계 보완 후 `test-results/care-recipient-8c9482ed-1b30-4e8a-a282-5a1e8fa1237a/results.json`으로 두 화면 폭 전체 흐름과 임시 자원 정리도 다시 통과했다. 이는 실제 iPhone/키보드나 실제 메일 전달 시험이 아니다.

## 2. 검증 중 발견하고 수정한 항목

1. 역할별 메뉴의 불필요한 인라인 스타일이 기존 `style-src 'self'` CSP에 차단됨. 해당 스타일을 제거하고 기존 외부 flex CSS를 유지했다. CSP를 완화하지 않았다.
2. 한국어 시간 표시가 실행 환경의 Intl 데이터에 따라 PM으로 달라짐. 서울 시간대의 숫자 구성 요소에서 오전·오후를 일관되게 표시하도록 보완했다. 저장 시각은 변경하지 않았다.
3. 대상자 역할을 추가한 뒤 과거 VM/DOM 시험 fixture가 역할 함수와 새 버튼 선택자를 누락함. 실제 helper·명시적 역할·정확한 선택자 처리를 연결했으며 기존 검증 조건을 약화하지 않았다.
4. 복원 격리 시 활성 계정의 세대가 증가하여 정확한 복원도 오탐할 수 있음. 원본 예상 상태만 1 증가시켜 비교하고, 실제 복원본 세대나 주 소통자 스냅샷을 무시하지 않도록 수정했다.
5. 새로운 브라우저 검사 자체의 중복 제목 선택자와 빈 입력 상태의 비활성 전송 버튼 검사를 고쳤다. 앱 오류와 검사 코드 오류를 구분했다.
6. 대상자 1명을 위해 전체 관계 표시 한도를 늘리면 기존 보호자 한도도 넓어지는 문제가 전체 서버 시험에서 발견됐다. 역할별 한도(보호자 100·치료사 1·대상자 1)를 검사해 기존 과대 목록 거부를 유지했다. 허용된 102명은 모두 표시하고 잘라 내지 않는다.
7. 두 과거 DB 업그레이드 검사의 전체 행 비교에 새 세대 열의 기본값 0을 명시했다. native 복원 정책 검사에는 원본 runner에도 이미 존재하던 복원 상태 검사 분기를 정확히 반영했다. 해당 정적 기대값 수정은 native 실행 증거가 아니다.
8. 과거 014/021 스키마에서 최신 서비스를 호출하던 두 시험을 당시 SQL·트리거로 자료를 구축하도록 보완했다. 새 스키마를 미리 적용하거나 권한 검사에 우회 경로를 만들지 않았다.
9. 합성 PostgreSQL·복원·Linux decoder 검사 이미지의 정확한 COPY/허용목록에 새 공통 조회 모듈 `conversation-visibility.mjs`를 추가했다. Docker 실행이나 이미지 빌드는 하지 않았다.
10. 실제 native 역할 검사에서 기존 보호자 업로드 작업도 대상자용 계정/연결 표 권한을 요구하는 회귀가 드러났다. PostgreSQL은 OR 분기가 거짓이어도 참조 표의 권한을 검사한다. `Conversations.inRoomTransaction`은 방·참여자·소속·사용자 잠금을 유지하고, DB에서 확인한 역할이 대상자일 때만 연결·계정 조건을 별도 검사한 후 작업 콜백을 호출하도록 바꿨다. 작업자 권한·스키마·인증 경계는 넓히지 않았다. 새 제한-GRANT 시험에서 이전 조건의 `42501`과 수정 후 실제 대기열 인수를 함께 검증했다.

## 3. 검증 명령과 결과

명령은 독립 사본에서 실행했다. `node`는 번들 Node 실행 파일을 사용했고 브라우저 검사는 명시적 Playwright 모듈·Chrome 경로를 전달했다.

| 명령/범위 | 결과 |
| --- | --- |
| `node --test --test-concurrency=1 tests/*.test.mjs` | 1,795개: 1,719 통과, 실패 0, 조건부 76 건너뜀. `test-results/recipient-unit-final-20261016.tap` |
| profiles / relationships / recovery-state-comparison / recovery-generation-comparison | 51/51 통과. 실제 023 트리거·SQL 표현식 및 bigint 경계 포함 |
| 제한된 runtime DB 권한 검사 | 3/3 통과. PGlite에 실제 GRANT/SET LOCAL ROLE을 적용. native 서비스 입장 검증은 아님 |
| 링크·주 소통자 / 조회 경계 / 실제 HTTP | 각각 22/22, 14/14, 6/6 통과 |
| 과제 A 새 소유 브라우저 | 입력·저장·DB/API·새로고침·기존 자료 보존 모두 통과 |
| 대상자 새 소유 브라우저 | 390px/1440px 두 흐름 통과, 임시 자원 정리 확인 |
| `npm run build` | 전체 JavaScript 구문 검사 및 정적 빌드 통과. 처음 잘못된 npm 실행 경로로 시작하지 못한 호출은 제외하고, 확인된 시스템 npm 경로로 실행 |
| `node --test --test-concurrency=1 server/tests/*.test.mjs` | 최초 전체 실행 1,836개: 1,781 통과, 11 실패, 조건부 44 건너뜀. `test-results/recipient-server-final-20261016.tap` |
| 실패 수정 후 관련 서버 시험 | 계정/센터/등록/운영/복원 정책/패키징 80/80 재통과 (`test-results/recipient-server-repairs-20261016.tap`). 과거 미디어/메모 이관 12/12·18/18, Windows 정책 13/13 개별 통과. 최초 실패 10개 해소 |
| 023 복원 계약 후속 | 새 비어 있지 않은 fixture·실행기 연결과 함께 검토 목록을 확장했다. 계약 10/10, 구조·패키징·관련 기존 검사 54/54, 새 helper 16/16 통과. 코드 검사 자체와 후속 실제 native 실행 증거는 구분한다. 아래 5·6절 참조 |
| 수정 후 서버 전체 재실행 | **1,860개: 1,816 통과, 실패 0, 조건부 44 건너뜀, exit0**. 372.84초. `test-results/recipient-server-023-final-20261016.tap`. 최초 11개 실패가 이 전체 실행에서 해소됨 |
| native에서 발견한 작업자 권한 회귀 수정 후 최종 전체 실행 | **1,870개: 1,826 통과, 실패 0, 조건부 44 건너뜀, exit0**. 389.31초. `test-results/recipient-server-worker-fix-20261016.tap`. 앞 행의 실행보다 나중이며 새 worker 회귀 9개·진단 연결 1개를 포함 |

처음 전체 unit 검사의 10개 실패와 CSP/선택자 오류를 수정한 뒤 위 결과를 얻었다. 이전 실패 보고서는 삭제하지 않았다. 반복 실행을 별개의 성공 표본으로 합산하지 않는다.

최초 서버 전체 실행과 각 수정 후 재검증은 구분한다. 마지막 전체 실행은 실패 0이지만, 건너뛴 44개를 통과로 합산하지 않는다. 순수 정적 정책 검사가 통과해도 OS 승인·DPAPI·Docker·native PostgreSQL이 동작했다고 주장하지 않는다. 별도 실제 native 증거는 6절에 한정한다.

## 4. 변경 범위 및 남은 사항

핵심 파일은 `server/migrations/023-care-recipient-links.sql`, `server/care-recipient-links.mjs`, `server/primary-communicators.mjs`, `server/conversation-visibility.mjs`, `server/local-participation-http.mjs`, `local-api/care-recipient-client.js`, `local-api/operations-recipient.js`다. 기존 인증·HTTP 조립·조회·미디어 경계·복원 비교·권한 목록과 역할별 UI를 연계했다. 기존 브라우저 검사에는 필요한 정확한 새 정적 자산과 조회 경로를 반영했다.

원본 평가 소스에는 아직 통합하지 않았다. 정적 `dist` 빌드는 기존 공개 프로토타입만 포함하며, 로컬 API가 빌드만으로 배포되는 것은 아니다. 새 합성 DB의 마이그레이션·지속 저장 재시작/복원은 6절 범위에서 확인했다. 기존 DB 이관·원본 통합·실물 iPhone 시험을 완료한 것은 아니다.

023 복원 fixture·실행기·검토 목록 보완은 5절과 같이 완료했다. 후속 합성 native 결과는 6절에 별도로 기록한다. 이 증거만으로 원본 반영이나 배포를 자동 진행하지 않는다.

대상자 선택 공유·사진/영상·과거 자료 공개는 의도적으로 보류했다. 실제 본인 확인·동의·잘못된 연결 정정 절차와 독립 백업이 마련되지 않았으므로 실제 아동 자료 베타는 열지 않는다. 원 개편안의 실제 사람 A/B/C 평가와 실물 기기 조건이 남아 있어 전체 완료로 표시하지 않는다.

## 5. 023 복원 검사 코드 보완 — 실제 native 실행과 구분

이번 후속 변경은 독립 사본의 시험 도구·계약·Docker 포함 목록·문서에 한정했다. 제품 서비스, 기존 마이그레이션, 운영 권한, UI는 이 단계에서 변경하지 않았다.

### 새 fixture와 역검증

- `server/recovery-recipient-native-check.mjs`: 독립 합성 센터·관리자·보호자·대상자를 만든 뒤 실제 연결/해제/재연결 서비스와 주 소통자 저장 서비스를 호출한다. 새 표는 연결 1행·현재 지정 1행·과거 요청 2행이며, 사용자/소속/참여 세대는 각각 2인 상태를 포함한다. 로그인 불가능한 합성 계정 행만 필요하며, 비밀번호·토큰·실제 계정 생성은 하지 않는다.
- 정상 검증은 링크·주 소통자·세대·시각·요청 해시·이력 시작점과 옛 요청 재전송 후 현재 상태의 불변성을 확인한다. 모든 검사 종료 경로에서 전체 DB fingerprint가 검사 전과 같은지 확인한다.
- 정상 SQL 대조군 6개는 실제 실행 성공 후 강제 롤백한다. 주 소통자 해제, 새 요청 행 INSERT, 새 표 각각 TRUNCATE를 포함한다. 링크는 불변 신원을 보존하는 `INSERT ... ON CONFLICT DO NOTHING`으로 BEFORE INSERT 경로를 확인하며 새 링크 1행을 추가했다는 증거로 주장하지 않는다.
- 격리 검증은 사용자만 비활성화·세대 1 증가, 소속/참여 세대와 지정 당시 스냅샷·연결·영수증 보존을 요구한다. 정상 대조군과 같은 SQL은 정확한 `23514 / restored service remains quarantined` 오류여야 한다. 다른 제약 오류나 권한 오류는 성공으로 인정하지 않으며, 뜻밖에 쓰기가 성공해도 롤백하고 검사는 실패한다.

### 실행기 연결

- `server/recovery-native-contract.mjs`와 해당 시험: 023 파일명·체크섬 검토 목록, 새 세 표의 정확한 비어 있지 않은 건수, 같은 건수의 내용 변경 감지.
- `server/recovery-native-test.mjs`: Linux dump 전 seed, 복원 후 서비스 재시도, 격리·재접속 검사. 격리 직전 실제 활성 사용자 6명과 receipt를 비교하고 기존 세션 2·초대 1 기대값을 유지한다.
- `server/windows-postgres-check.mjs`: 원본·원본 재시작·복원·복원 재시작에서 검증한다. `recipientChecks`는 실제 검증 성공 뒤에만 true가 되고 최종 성공 조건에도 포함된다. 대상자 helper 서비스 호출은 owner 연결을 사용하므로, 그것만으로 제한된 runtime 계정의 native 서비스 권한을 검증했다고 주장하지 않는다.
- `server/recovery-state-native-check.mjs`: 기존 65개 데이터 표 비교 단계 안에서 대상자 격리를 검증한다. 기존 022 검증이나 시나리오 수를 제거하지 않았다.
- `server/recovery-test.Dockerfile`·`.dockerignore`, `server/tests/native-recovery-wiring.test.mjs`: 새 helper와 정확한 상대 import 의존성만 포함하고 정적으로 검증한다. Docker 이미지를 빌드하거나 실행한 증거는 아니다.

### 실행 결과와 한계

`node --test --test-concurrency=1 server/tests/recovery-recipient-native-check.test.mjs`는 **16/16** 통과했다. 새 메모리 PGlite에서 실제 migration·서비스·정상 SQL 롤백을 실행한다. 격리 게이트 관찰과 SQL 거부 결과는 명시적인 **contract double(정해진 시험 응답)** 이므로, 이 부분은 검사 코드가 거짓 성공을 거부하는지에 대한 증거이지 실제 격리 트리거 실행 증거가 아니다. 사용자·소속·참여 세대 변조는 서로 독립된 fixture에서 검사했다.

구조/계약/기존 비공개 메모/패키징/정책 관련 6개 시험 파일은 **54/54** 통과했다. `npm run build`의 전체 JavaScript 구문 검사와 정적 빌드도 통과했다. 검사 횟수와 중첩된 개수를 독립 시나리오로 합산하지 않는다.

5절까지의 검사 코드를 고정한 뒤 서버 전체를 한 번 실행했고 **1,816 통과·실패 0·건너뜀 44, exit0**을 확인했다. 이후 native에서 발견한 권한 회귀 수정본의 전체 실행은 6절 말미와 구분한다. 사용한 명령은 다음과 같다. `node`는 번들 Node 실행 파일이며 `npm`은 확인된 시스템 npm이다.

```text
node --test --test-concurrency=1 server/tests/recovery-recipient-native-check.test.mjs
node --test server/tests/native-recovery-wiring.test.mjs server/tests/recovery-native-contract.test.mjs server/tests/recovery-review-native-check.test.mjs server/tests/message-projection-packaging.test.mjs server/tests/auth-password-recovery-native-policy.test.mjs server/tests/windows-native-worker-test-policy.test.mjs
node --test --test-concurrency=1 --test-reporter=tap --test-reporter-destination=test-results/recipient-server-023-final-20261016.tap server/tests/*.test.mjs
npm run build
git diff --check
```

마지막 공백 검사는 Git 추적 파일 범위이며 새 미추적 파일 전체의 검사라고 확대하지 않는다. 새 helper/시험/실행기에는 별도 `node --check`를 실행했다. 새 시험 파일을 추가했으므로 최초 전체 실행 1,836개와 최종 1,860개의 분모가 다르다.

5절의 코드 검사 완료 시점에는 새 023 native 백업·복원·격리·지속 저장 재시작은 미실행이었다. 기존 022 결과를 새 기능의 증거로 재사용하지 않았다. 이후 수행한 실제 검사는 아래 6절과 구분한다. 새 native 검사도 기존 writer가 모두 중지된 합성 환경을 전제로 하며 온라인 원자성·독립 백업·실제 자료 서비스 전환을 보증하지 않는다. `serviceReleaseAllowed=false`를 유지한다.

## 6. 후속 실제 Windows PostgreSQL 검증

사용자의 기존 ‘새 가상 자료로 복원 검증’ 요청 범위에서 수행했다. Docker 엔진은 꺼져 있어 재시작하지 않았다. 설치된 PostgreSQL 18.6-5의 고정 체크섬·런타임 파일·E 보호 경로를 기존 실행기의 `VerifyOnly`로 검증했다. E 기본 하위 폴더는 이미 존재했다. 준비 과정의 배타적 잠금 파일은 일시 생성 후 닫을 때 제거된다. 기존 데이터나 ACL을 수리·덮어쓰지 않았다.

### 복원·격리 — 27/27, exit0

```text
node server/windows-postgres-check.mjs --verify-recovery-state --base E:/CarebridgeBeta --powershell <기존 번들 pwsh.exe 절대 경로> --confirm-synthetic-e-drive
```

- 실행 ID: `31c2c65e-0599-44bf-adb0-538de49edb13`, 결과 시각 `2026-10-16T12:55:51.259Z`.
- 증거: `test-results/recovery-state-31c2c65e-0599-44bf-adb0-538de49edb13-results.json`. UUID 결과를 보존하며 최신 요약 `recovery-state-results.json`도 갱신됐다.
- `passed=true`, `failure=null`, `scenarioCount=27`. `recipientChecks`의 seed·원본 재시작·동일 클러스터 복원·격리·별도 클러스터 복원·재시작 6개 모두 true다.
- 실제 `pg_dump`/`pg_restore`, 001–023 이력 및 65개 데이터 표, PNG·삭제 방지 표식의 일치와 의도적인 변조 거부를 확인했다. 대상자 연결·지정·요청 영수증·세대 및 재시도의 불변성을 확인했고, 실제 격리 트리거가 정상 대조군 SQL의 쓰기를 거부했다. 5절의 시험 응답 대체물만으로 얻은 결과가 아니다.
- 격리 대상은 같은 클러스터에 만든 별도 복원 DB다. 뒤이어 검증한 별도 클러스터 복원본까지 격리됐다고 주장하지 않는다. source의 백업 후 변경은 불일치 감지용 합성 사례다.
- `sourceStopped=true`, `restoredStopped=true`. 명령 종료 뒤 두 `postmaster.pid` 부재와 PostgreSQL/pg_ctl 프로세스 부재도 확인했다. 새 시험 폴더 `E:/CarebridgeBeta\private\checks\postgres-check-31c2c65e-0599-44bf-adb0-538de49edb13`의 가상 DB·파일·번들은 오프라인 진단 자료로 남겼다. 초기 암호 파일은 남지 않았고 TLS/DPAPI 자격증명은 이 모드에서 생성하지 않았다.

이 실행은 owner 연결을 사용한다. `roleCheck=false`, `sourceManifest=null`이므로 역할 분리·전체 소스 고정·TLS·DPAPI·native 미디어 엔진·브라우저 또는 실물 기기 검증으로 확대하지 않는다. `serviceReleaseAllowed=false`, `filesystemWriterQuiescenceVerified=false`이며 같은 디스크의 합성 복원은 독립 백업이 아니다.

### 권한 검사 실패·수정과 새 실행 — 48/48, exit0

첫 역할 검사 `c2dd154d-ef72-4a39-b1c3-d2d8ccfa8c0d`는 13개 검사 이후 `credential-service / rolePhase 4012`에서 실패했다. 종료 결과는 `sourceStopped=true`이며 복원 클러스터는 아직 생성되지 않았다(`restoredStopped=false`는 이 경우 미생성). 실패 결과와 진단 자료를 보존한다. 당시 결과만으로 대기 시간 초과와 작업자 조기 실패를 구별할 수 없었으므로, 시험 도구에 이미 존재하는 제한된 단계 관찰을 연결했다. 고정 단계·상태·횟수만 전달하고 원문 오류·SQL·키·파일 내용을 노출하지 않는다. 제한 시간이나 성공 조건은 바꾸지 않았다.

`server/tests/care-recipient-worker-privileges.test.mjs`의 **9/9**는 실제 PGlite에 정책 7의 작업자·앱 GRANT를 적용한다. 이전 혼합 OR 조건의 `42501`을 재현하고, 수정된 보호자/치료사 방 접근·수신→격리→검사 작업 인수, 계정/연결 조회와 역할/세대 변경 거부, 비활성·연결 해제·역할 위조·대상자 첨부 차단을 확인했다. byte 저장소는 메모리 대역이므로 native 파일 처리 증거는 아니다. 관련 기존 대상자/HTTP/복원 5개 파일은 **61/61**, 단계 진단/프로세스 2개 파일은 **32/32** 통과했다.

```text
node server/windows-postgres-check.mjs --verify-role-privileges --base E:/CarebridgeBeta --powershell <기존 번들 pwsh.exe 절대 경로> --confirm-synthetic-e-drive
```

수정 후 새 실행 ID는 `684c52a9-90e1-43e7-99d7-cdd568b27e85`, 결과 시각은 `2026-10-16T13:06:07.151Z`다. 증거는 `test-results/database-privileges-684c52a9-90e1-43e7-99d7-cdd568b27e85-results.json`이며 기존 결과 파일을 덮어쓰지 않았다.

- `passed=true`, `scenarioCount=48`, `failure=null`, `sourceUnchanged=true`.
- 정책 7의 실제 표·열·함수·기본 권한, 4개 서비스 역할의 접속 경계, 현재 Windows 계정의 DPAPI 암호화, TLS 인증서·IP 확인 및 잘못된 목적/대상/권한 거부를 확인했다.
- 실패했던 작업자 진행·중단·회수, 제한된 작업자의 처리와 앱의 첨부 연결·조회, 인증 표/임상 내용/역할 변경 거부, 동시 메시지·계정 복구 사례를 통과했다.
- 백업 역할의 실제 dump와 복원 후 역할 보존·재시작을 통과했다. 022 `reviewChecks` 4개와 023 `recipientChecks` 4개 모두 true다. 대상자 복원 helper 자체는 owner 연결이므로 대상자의 모든 서비스 동작을 native runtime으로 실행했다는 뜻은 아니다.
- `sourceStopped/restoredStopped=true`, 작업자 자식 2개 `allChildrenTerminal=true`, 두 프로세스 모두 `stdioClosed=true`. 부모 채널 끊김 시험의 자식은 의도된 exit1이며 정상 종료 시험은 exit0다.
- 이번 성공 실행의 자격증명 8개 `cleanup=true`, `tlsFixtureCleanup=true`. 종료 뒤 실제 `tls`·`credential-check-684c52a9-90e1-43e7-99d7-cdd568b27e85` 폴더와 두 PID 파일 부재도 확인했다. 가상 DB·매체·암호화 번들은 오프라인으로 남겼다.

이 모드는 합성 scanner/decoder 프로토콜 대역을 사용하며 ClamAV/FFmpeg 실제 엔진·브라우저·iPhone·운영 계정·Windows 서비스 계정 검증이 아니다. 복원 격리 활성화는 이 48개 검사에 포함되지 않는다. 실패 실행의 보호된 `tls` 폴더와 `credential-check-c2dd154d-ef72-4a39-b1c3-d2d8ccfa8c0d` 폴더에는 합성 TLS 파일·DPAPI 자격증명 8개가 보존돼 있다. 실제 자격증명이 아니며 해당 DB는 중지됐고, 진단 보존 요청에 따라 이 실패 자료는 삭제하지 않았다.

### 최종 권한 수정본의 복원 재검증과 종료 상태

첫 27개 통과 결과는 권한 수정 전 코드였으므로, 수정본에서 새 UUID로 동일 검사를 한 번 재실행했다. `2f55c08c-4bd5-4661-8215-e4d7f6be710b`는 `2026-10-16T13:07:32.538Z`에 **27/27, exit0**으로 완료됐다. 증거는 `test-results/recovery-state-2f55c08c-4bd5-4661-8215-e4d7f6be710b-results.json`이다. `passed=true`, `failure=null`, 023 `recipientChecks` 6개 true, 두 클러스터 종료 true, `serviceReleaseAllowed=false`다. 이 결과를 최종 수정본의 격리 증거로 사용하며 앞의 27개 결과와 독립 성공 표본처럼 합산하지 않는다.

후속 읽기 검사에서 이번 4개 실행의 source/restored PID 파일과 초기 암호 파일은 모두 없었고 PostgreSQL/pg_ctl 프로세스 수는 0, 준비 잠금 파일도 없었다. 실패 실행에는 restored 폴더 자체가 생성되지 않았다. 기존 E 자료와 이번 가상 DB·매체·진단 파일은 보존했다. 실패 실행의 합성 비밀 파일까지 제거됐다고 주장하지 않는다.

역할 검사 결과의 488개 소스 manifest를 현재 파일과 다시 SHA-256 비교했고 전부 일치했다. 집계 해시는 `400d2d4ded14a8158376b3b023f6f37a57e91a78ef80a5e1bd32e9e0dfe1a5f3`이다. manifest는 실행기가 선택한 코드·SQL·설정 범위이며 모든 문서·새 서버 단위시험 파일까지 포괄하는 증거는 아니다. 이 후속 단계에서 제품 변경은 `server/conversations.mjs`의 역할별 연결 검증 순서에 한정한다. UI·운영 권한·마이그레이션은 변경하지 않았다.

최종 수정본의 `node scripts/build.mjs`는 전체 JavaScript 구문 검사와 정적 빌드에 성공했다. 원본 평가 소스 통합·배포·실제 자료 사용·새 기능 개발은 하지 않았다. 현재 사용자 평가 세션의 사람 수행 결과나 최신 실물 iPhone 검증을 대신한 결과도 아니다.

이 후속 단계의 변경 파일은 다음과 같다. 이전 단계의 전체 대상자 구현 파일 목록과 구분한다.

| 파일 | 변경 이유 |
| --- | --- |
| `server/conversations.mjs` | 잠금 뒤 실제 대상자 역할에만 본인 연결 검사를 적용해 미디어 작업자의 최소 권한을 유지 |
| `server/windows-media-worker-native-check.mjs` | 실패 정리 전 고정 단계·상태 관찰을 확보 |
| `server/database-credential-service-native-check.mjs` | 제한된 작업자 관찰만 상위 시험으로 전달 |
| `server/windows-postgres-check.mjs` | 같은 관찰을 UUID 실패 결과에 보존 |
| `server/tests/windows-native-worker-test-policy.test.mjs` | 진단 연결과 기존 제한 시간·중단 성공 조건의 유지 검증 |
| `server/tests/care-recipient-worker-privileges.test.mjs` | 실제 제한 GRANT 하의 이전 SQL 오류·수정 흐름·거부 경계 회귀 9개 추가 |
| `docs/care-recipient-mvp.md`, 이 문서 | 코드 검사와 실제 native 실행, 이전 실패와 최신 수정본, 잔존 진단 자료를 구분 |

### 최종 전체 회귀 — 이전 실행과 분리

```text
node --test --test-concurrency=1 --test-reporter=tap --test-reporter-destination=test-results/recipient-server-worker-fix-20261016.tap server/tests/*.test.mjs
node scripts/build.mjs
git diff --check
```

마지막 서버 실행은 **tests 1,870 / suites 2 / pass 1,826 / fail 0 / skipped 44 / cancelled 0, exit0**, 389,310.8736ms다. 새 파일 생성 전에 결과 경로가 없는지 확인했고 과거 TAP 파일을 덮어쓰지 않았다. `recipient-server-023-final-20261016.tap`의 이전 1,816 통과 수를 최신 코드 결과로 재사용하지 않는다. 추가된 worker 회귀 9개와 진단 연결 1개가 이번 분모에 포함된다.

빌드·전체 구문 검사도 exit0이며 `git diff --check`는 추적 파일 범위에서 통과했다. 최종 종료 점검에서 PostgreSQL/pg_ctl 및 이번 native 실행기·작업자 프로세스는 0개, 준비 잠금은 없었다. 새 기능·새 실행·원본 통합·배포는 시작하지 않고 진단 기록을 보존했다. 사용량 조회는 주간 71% 사용/29% 잔여였다. 본 실행에 소요된 별도 토큰 수라는 의미는 아니다.

남은 검증은 새 사용자 평가 세션에서의 실제 사람 A/B 시간·이동 수·C 이해도, 최신 실물 iPhone 경로, 운영 전 독립 백업과 본인 확인·동의 절차다. Linux Docker/최신 실제 AV·decoder 통합은 이번 27/48개 결과로 대체하지 않는다. 현재 검증본은 독립 사본이며 개편안 전체 완료 또는 실제 자료 베타 승인으로 표시하지 않는다.

## 7. 최종 권한 수정 후 제한된 브라우저 재검증

6절의 권한 수정본에서 기존 `tests/care-recipient-browser.mjs`를 **한 번만** 실행했다. 동일 검사 실행 프로세스가 없음을 먼저 확인했다. 새 기능·시험 코드·제품 코드는 변경하지 않았고 전체 시험, native 검사, 빌드는 반복하지 않았다. 원본 사용자 평가 세션이나 기존 Chrome 프로필 대신 새 메모리 PGlite와 이 검사 소유 브라우저 문맥 3개를 사용했다.

```text
node tests/care-recipient-browser.mjs --confirm-synthetic-local
```

번들 Node와 기존 Playwright 모듈, `C:\Program Files\Google\Chrome\Application\chrome.exe`를 명시했다. 실제 브라우저 버전은 `155.0.8059.40`이다. 실행 ID는 `8bb1d96e-46e0-4ae0-bd4b-6093f89a64a8`, 완료 시각은 `2026-10-16T13:27:08.420Z`이며 **passed=true, failure=null, exit0**이다.

- 증거: `test-results/care-recipient-8bb1d96e-46e0-4ae0-bd4b-6093f89a64a8/results.json`, 같은 폴더의 `ownership.json` 및 스크린샷 16개. 이전 실행 결과는 보존했다.
- 시작·종료 소스 지문은 모두 `0daa296428895195727f774b6bbb2d097c5d22dd2b0d563f035b96806e6ab664`다. 검사 대상 288개 파일을 종료 후 다시 해시해 불일치 0개를 확인했다. 6절의 native manifest와는 수집 범위가 다르다.
- 390px에서 독립 초대·수락·표시 이름·명시 연결을 한 번 수행했다. 센터 가입만으로는 방이 열리지 않고 연결 이후에도 과거 메시지가 제공되지 않았다. 실제 메일 대신 합성 초대 전달 채널을 사용했다.
- 같은 계정·DB를 390px와 1440px에서 사용했다. 각 폭에서 대상자 텍스트를 보내고 보호자 화면 새로고침 후 수신을 확인했다. 주 소통자 지정·API 재조회·새로고침 후 표시도 확인했다.
- 주 소통자 변경 전후 소속·참여·읽음·기록 수신자 네 표의 상태가 같았다. 대상자 화면의 임상·첨부 기능 비노출과 인증된 읽기 HTTP 요청의 404 거부를 확인했다. 이는 모든 권한 표의 불변성이나 모든 쓰기 경로를 검사했다는 뜻은 아니다.
- 두 폭의 항목이 모두 통과했고 콘솔 오류·예상하지 않은 요청은 0개였다. 모바일 홈·주 소통자 재조회 대화, PC 관리자 CTA 스크린샷을 직접 확인했다. 주요 조작 요소의 접근 가능성과 가로 넘침 부재를 확인한 것이며 디자인 전체의 완성도 판정은 아니다.
- 임시 문맥·브라우저·서버·메모리 DB 종료, 검사 자격증명 참조 해제, 임시 격리 폴더 제거가 모두 true다. 소유 시험/브라우저 PID `17760`/`23184`의 부재도 별도로 확인했다. 기존 사용자 Chrome이나 실패 native 진단 자료는 정리하지 않았다.

이 실행은 대상자→보호자 텍스트와 권한 경계의 **독립 AI 기능 검증**이다. 양방향 실시간 소통, 실제 첨부 업로드·AV/decoder·작업자 처리, 지속 저장 재시작, 실물 iPhone·키보드, 실제 본인 확인·동의는 이 결과로 검증하지 않는다. 작업자 권한 수정의 실제 근거는 6절의 별도 native 결과다. 사람의 A/B 시간·이동 수·C 이해도는 여전히 미실행이며, 전체 목표는 사용자 평가 대기 상태를 유지한다. 원본 통합·배포·실제 자료 베타는 진행하지 않았다.
