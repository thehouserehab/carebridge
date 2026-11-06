# 가상 E 세션의 정상 종료 후 재개

## 용도와 제한

새로 만드는 **가상 계정·가상 자료 전용** 세션을 같은 PC의 같은 Windows 계정에서 이어 쓰는 선택 기능이다. 기존 `dev:synthetic-e`의 일회성 모드와 종료 시 키 폐기는 바꾸지 않는다. 과거 시험 폴더의 인수, 실제 아동 자료, 외부 접속, 자동 실행 서비스, 배포는 허용하지 않는다.

이 기능은 백업이나 강제 종료·정전 복구가 아니다. 별도 독립 백업 매체가 준비되지 않았으므로 실제 자료 베타 사용 승인으로 간주하면 안 된다.

## 실행

저장소 루트의 **직접 사용하는 터미널(TTY)** 에서 실행한다. 아래 경로는 해당 PC의 준비된 E 저장소와 PowerShell 7 경로로 설정한다. `.env`나 명령 인자에 비밀번호를 넣지 않는다.

```powershell
# 새 가상 세션: 처음부터 재개 가능한 모드를 명시적으로 선택
npm run dev:synthetic-e -- --create-resumable --base E:/CarebridgeBeta --powershell '<pwsh.exe 절대경로>' --confirm-synthetic-e-drive

# 정상 종료 메시지에서 확인한 세션 ID로 재개
npm run dev:synthetic-e -- --resume-session '<세션 UUID>' --base E:/CarebridgeBeta --powershell '<같은 pwsh.exe 절대경로>' --confirm-synthetic-e-drive
```

- 처음 생성할 때만 가상 보호자·치료사 로그인 정보를 준비 완료 후 한 번 표시한다. 비밀번호를 저장 파일·보고서·로그로 출력하지 않는다.
- 재개할 때는 기존 계정으로 로그인한다. 비밀번호를 다시 보여 주거나 계정을 새로 만들지 않는다. 최초 표시한 로그인 정보를 잊으면 이 기능으로 복구할 수 없다.
- `r` + Enter는 실행 중인 세션의 API만 재시작한다. 전체 종료 후 재개와는 다르다.
- Ctrl+C로 종료한 뒤 **보존 확인 메시지까지 기다린다**. 종료가 확인되지 않았다는 메시지가 나오면 같은 터미널에서 안내된 재확인을 수행하고, 창을 강제로 닫거나 잠금 파일을 삭제하지 않는다.

## 저장과 재개 경계

| 항목 | 동작 |
| --- | --- |
| DB·파일 | 새 세션의 고유 UUID 폴더에 유지. 재개 시 같은 자료를 사용 |
| 서비스 연결 비밀번호 | 기존 runtime/worker 전용 CurrentUser DPAPI 저장소에 보존 |
| 부모 준비 검사 비밀·TLS | 별도 목적의 CurrentUser DPAPI vault에 보존. API·worker에 관리자 비밀을 전달하지 않음 |
| 실행 중 TLS 파일 | 실행에 필요한 최소 파일만 복원. DB 종료 확인 후 정확히 소유한 파일만 삭제 |
| 정상 종료 증거 | API·worker 실제 종료, DB clean shutdown, 평문 TLS 제거를 확인한 뒤 완료 영수증 기록, 마지막에 잠금 해제 |
| 재개 검사 | Windows 소유자·ACL, 경로/파일 식별, 설정 해시, 인증서 유효성, DB 시스템 ID, 스키마 이력 및 서비스 권한 확인 |
| 재개 중 제외 동작 | initdb, 마이그레이션, 권한 재설정, 시드 데이터·계정 재생성 없음 |

세션 vault의 평문 payload는 최대 8KiB이며 연결 비밀번호와 TLS 키를 명령 인자·환경변수에 싣지 않는다. 가상 사용자 로그인 비밀번호·초대/복구 토큰·관리자 계정 비밀번호는 vault에 넣지 않는다. JavaScript 문자열의 메모리 완전 삭제는 보장하지 않으며, Buffer는 사용 후 지우고 세션 종료 시 참조를 해제한다.

DPAPI는 위 **키·연결 비밀**을 보호한다. DB·첨부 전체를 암호화하는 기능은 아니며, 이 데이터는 기존 E 저장소 ACL로 접근을 제한한다. 따라서 이것만으로 실제 민감자료의 암호화·백업·운영 요건이 충족된다고 볼 수 없다.

## 거부되는 상황

- 예전 일회성 폴더, 누락·변조된 전용 영수증, 다른 PC/Windows 계정 또는 경로로 복사한 키
- 남아 있는 실행 잠금/PID, 비정상 종료 DB, 이미 실행 중인 세션
- 설정·DB 식별자·스키마 이력 변경, 권한 불일치, 링크/하드링크 및 예상하지 않은 경로
- 만료·불일치 TLS 인증서. 현재 가상 인증서는 **처음 발급한 시점부터 2일** 동안 유효하다. 재개 시 갱신하지 않는다.
- 저장된 DB 포트의 충돌. 다른 서버에 연결하거나 다른 DB로 대체하지 않는다.

재개가 시작되면 이전 정상 종료 영수증을 먼저 소비한다. 이후 준비 도중 실패하면 재개 가능 상태를 자동으로 복구하지 않는다. 불확실한 잠금/파일을 수동 삭제하거나 예전 폴더를 임의 채택하는 우회는 지원하지 않는다.

인증서가 만료되어도 가상 자료와 암호화된 키를 자동 삭제하지 않는다. 만료된 세션을 계속 사용하기 위한 인증서 교체와 불필요한 보존 세션의 안전한 폐기는 별도 작업이다.

## 검증

`npm run test:synthetic-e:resume -- --base ... --powershell ... --confirm-synthetic-e-drive`는 새 전용 가상 세션을 만든다. 독립 Node 프로세스 A에서 브라우저로 자료를 작성하고 전체 종료·파이프 종료를 확인한 다음, 새 프로세스 B가 **세션 ID와 기본 경로만으로** 디스크의 보호된 자격정보를 읽는다. 새 Chromium에서 기존 계정 로그인, 메시지·인용·기록·피드백·PNG/MP4 해시·읽음 분리·철회 권한·비공개 반영 메모·멱등 처리 영수증을 재검증한다.

시험 조정자는 로그인 자격정보와 비교 체크포인트를 메모리에만 유지하며, DB 연결 설정·복호화 키는 두 프로세스 사이에 전달하지 않는다. 결과 보고서에는 비밀번호를 기록하지 않는다. 새 시험의 보존 폴더는 남기며 기존 시험 자료를 삭제하지 않는다.

별도 물리 기기 접속, Windows 계정 이동, 실제 사용자 사용성, 정전 복구, 인증서 갱신, 독립 백업 검증은 별도 작업이다.

## 변경 영역

- `server/windows-synthetic-storage.mjs`, `server/windows-synthetic-session.mjs`: 일회성/보존 생성/재개를 분리하고 기존 자료의 읽기 검증 후 재사용한다.
- `server/windows-synthetic-session-vault*.mjs`, `scripts/windows-synthetic-session-vault-provider.ps1`: 별도 목적의 Windows 계정 보호 저장소를 추가한다. 기존 복구키·서비스 비밀번호 저장소를 다른 용도로 전용하지 않는다.
- `server/synthetic-session-retention.mjs`, `scripts/check-synthetic-session-storage.ps1`: 한정된 파일 목록·해시·영수증·ACL·TLS·스키마를 검증한다.
- `server/windows-synthetic-postgres-runtime.mjs`: 승인된 보존 클러스터만 등록하며, 오프라인 정상 종료 상태와 동일 DB 식별자·포트를 확인한다.
- `server/synthetic-session-lifetime.mjs`, `server/synthetic-secret-cleanup.mjs`: 실제 종료와 평문 키 정리 이후에만 재개 완료 상태를 발급한다.
- `scripts/synthetic-e-api.mjs`, `server/synthetic-e-session-options.mjs`: 명시적 명령 옵션과 모드별 종료 안내를 추가한다.
- `tests/windows-synthetic-resume-check.mjs`, `tests/synthetic-resume-process.mjs`, 관련 순수 시험·브라우저 보조 모듈: 별도 프로세스/브라우저의 연속성 및 실패 경계를 검사한다.

프런트엔드 제품 화면, 인증/권한 규칙, 메시지·기록 저장 규칙, 기존 공개 배포는 변경하지 않았다.

## 2026-10-10 검증 결과

실제 실행 `522347e7-86eb-4af8-ad64-55f1a739153a`는 **통과**, Node/명령 종료코드 **0**이다. 새 저장 세션 `1d2fc456-baa4-4c3e-a3df-76813d8dd086`에서 Node A(PID 27548)가 작성 후 전체 종료했고, 다른 Node B(PID 16520)가 보호된 디스크 상태로 재개했다. 두 프로세스 모두 실제 종료·stdio 종료·정상 종료코드 0을 확인했다.

- 종료/키 보존/동일 세션/자격정보 재발급 없음/두 번째 정상 종료의 상위 6개 확인이 모두 통과했다.
- 생성 브라우저 11개, 재개 브라우저 11개 확인이 모두 통과했다. 실제 PNG/MP4의 해시·디코딩/재생, 고정된 이전 첨부와 최신 첨부, 메시지·인용·기록·피드백, 읽음 분리, 철회 권한, 비공개 메모 및 중복 요청의 DB 영수증을 확인했다.
- 브라우저 오류·예상 밖 요청은 각각 0, 브라우저·컨텍스트 모두 종료했고 정리 관측 만료도 없었다.
- 두 브라우저의 소스 전후 및 현재 292개 파일은 SHA-256 `477ad8c9f965ffb69dff2fe77d59a09a2766ce2141259f93b8b146218ce81b25`로 일치했다.
- 종료 후 실행 잠금, 평문 TLS 폴더, PostgreSQL PID 파일의 부재를 별도로 확인했다. 관련 Node·Chromium 종료와 Carebridge 시험 컨테이너 부재도 확인했다. E의 해당 새 가상 DB·첨부·암호화 키·정상 종료 영수증은 의도적으로 보존했다.

주 증거는 `test-results/synthetic-resume-522347e7-86eb-4af8-ad64-55f1a739153a.json`이며 SHA-256은 `91079dc5366e814f885acdc73c93bd84d61efe76644af7d2e688e4e5ee21b4d7`이다. 생성/재개 브라우저의 별도 `results.json`, 스크린샷, 수명 증거는 같은 실행 ID의 `native-feedback-attachments-*`, `native-session-resume-*` 폴더에 있다. 시험 로그인 비밀번호와 메모리 비교 체크포인트는 증거에 저장하지 않고 폐기했다.

순수 검증과 빌드:

| 명령/범위 | 결과 | 증거 |
| --- | --- | --- |
| `node --test tests/*.test.mjs` | 1,289/1,289, 종료 0 | `test-results/resume-root-final-20261010.tap` |
| 세션 수명·재시작·키 정리·PG 재개·vault 관련 서버 시험 | 133/133, 종료 0 | `test-results/resume-server-regression-20261010.tap` |
| 보존 파일·키 정책·작업자·검사환경 관련 서버 시험 | 68/68, 종료 0 | `test-results/resume-custody-verified-20261010.tap` |
| `node scripts/check.mjs` / `node scripts/build.mjs` | 모두 종료 0 | 실행 출력 확인 |
| 공개 원본/빌드 비교 | 35개 일치, `dist/local-api` 없음 | 파일 SHA-256 대조 |

모든 최종 순수 시험의 실패·취소·건너뜀은 0이다. 보존 파일 시험 작성 중 테스트 변수 누락으로 한 번 실패한 증거(`resume-custody-final-20261010.tap`)는 지우지 않았고, 테스트 변수를 수정한 뒤 위 최종 68개를 통과했다. 이는 제품 또는 네이티브 재개 시험의 실패가 아니다.

다음 권장 작업은 사용자가 직접 새 보존 세션을 생성해 두 계정으로 종료·재개를 체험하는 것이다. 인증서 수명 연장/갱신, 정전 복구 또는 실제 자료 운영은 해당 요구사항과 백업 준비를 먼저 확정한 뒤 별도로 구현해야 한다.
