# 가상 자료 전용 사진·영상 송수신 화면

## 2026-10-10 기록 참고에서 현재 사진·영상 열기

기록 작성 화면의 `현재 원문 보기`에서 사진·영상을 직접 열도록 연결했다. 현재 파일을 열기 위해 기록 입력을 닫고 대화로 돌아갈 필요가 없다. 아래 이전 이력의 ‘현재 첨부는 개수만 안내’ 범위를 보완한 변경이다.

- `local-api/care-ui.js`: 현재 원문 조회가 확인한 메시지 ID·유형·판과 파일 메타데이터만 일시 보관한다. 준비 미디어 모드에서만 현재 첨부 버튼을 제공한다. 본문 없는 사진·영상 소식도 지원하며, 조회 결과를 기록 저장 요청이나 브라우저 저장소에 넣지 않는다.
- `local-api/media-viewer.js`: 현재 참고와 기록 당시 참고를 다른 열람 종류로 구분한다. 현재 메시지와 정확한 판·파일을 다운로드 전후에 다시 확인한 뒤 인증된 파일을 표시한다. 현재 파일은 현재 메시지 API, 당시 파일은 기존 고정 기록/피드백 API를 사용하며 서로 대체하지 않는다.
- `local-api/app.js`: 현재 첨부 오류를 해당 원문 영역에서 처리한다. 현재 파일의 변경·숨김·404만으로 독립적인 기록 초안을 지우지 않고 기록 권한을 다시 확인한다. 인증 종료는 기존 전체 정리를 따른다.
- 창 닫기·소스 교체·계정/방 전환은 요청을 취소하고 재생과 Blob URL을 해제한다. 자동 재생은 하지 않는다. 파일명은 이스케이프하며, 키보드로 닫으면 정확한 원래 버튼으로 초점을 돌린다.

서버·SQL·파일 검사/용량 한도·인증·키 보존·네트워크·공개 배포는 변경하지 않았다. 사진 1개와 영상 1개의 기존 120MiB 예약 한도를 유지해 새 합성 세션을 분리했다.

### 실제 검사에서 발견한 전환 오류

일반 대화 첨부를 열면 `care.suspend()`가 치료 기록의 읽기 상태와 목표를 비우는데, 첨부를 닫은 직후 ‘다음 기록에 참고’는 다음 폴링 전까지 이를 복원하지 않았다. 새 입력 창이 열리지 않고 `CONTEXT_LOADING`으로 종료되는 경로를 확인했다. 채팅의 기록 동작 처리기에 `viewer.suspend() → care.update(getContext()) → care.handleAction(...)`을 적용했다. 클릭 시점의 현재 계정·아이의 완결된 조회 결과만 다시 연결하며, 원문의 서버 권한 검사와 기존 초안 우선 복원은 그대로 유지한다. 공통 뷰어 종료에 자동으로 옛 입력을 띄우는 동작은 추가하지 않았다.

첫 일반 첨부 실행 `78a498fa-147a-432d-81b7-28310f387700`은 `PNG_UNSAVED_CURRENT_REFERENCE`에서 실패했다. 원문 오류나 비밀을 기록하지 않는 고정 세부 단계·도우미 파일 행/열 관측을 추가한 두 번째 `272a1a33-c642-435e-bad4-d5477f862087`은 `..._RECORD_FORM`, 당시 도우미 278행의 `careDialog.waitFor()`로 실패 위치를 좁혔다. 두 결과는 수정 전 실패 증거로 보존한다. 두 실행 모두 API·작업자 실제 종료 0, DB 종료·임시 키 폐기, 소유 브라우저/프로세스 및 검사 컨테이너/볼륨 부재를 확인했다.

### 최종 확인한 범위

| 검사 | 결과와 범위 |
| --- | --- |
| 전체 루트 순수시험 | 최종 전환 수정 후 1,362/1,362 통과, 실패·취소·건너뜀 0, 실제 종료 0. `test-results/current-reference-root-after-fix-20261010.tap`. 앞선 수정 전 1,357개 결과도 보존한다. 당시 초회 실패는 기존 C05 시험의 기대 목록에 새 검사 2개가 빠진 것이었으며 원래 검사 항목을 유지해 보완했다. |
| 최종 관련 순수시험 | care UI·원문·뷰어·준비/피드백/API 재시작 도우미 6파일, 195/195 통과, 실제 종료 0. `test-results/current-reference-focused-final-20261010.tap`. suspend 직후 실패 재현, 현재 조회 상태 복원, 숨김/삭제/타 방/권한 거절, 늦은 응답 및 미확정 고정 요청 보존 회귀를 포함한다. |
| 실제 E 피드백/참고 | `ef2e850b-aefd-4f6a-8496-efb26710d2aa`, 2026-10-10 KST 12:41:00~12:43:32, 11/11 통과·실제 종료 0. 새 로그인→E PostgreSQL→실제 검사/변환 작업자→HTTP 바이트→브라우저 해석/재생을 사용했다. |
| 수정 후 실제 E 일반 첨부/참고 | `b85d5c4e-720a-4281-84cc-5e5461b62fc9`, 2026-10-10 KST 12:47:42~12:50:04, care 8/8 및 PNG·MP4 흐름 통과·실제 종료 0. 일반 첨부창을 닫은 뒤 미저장 기록에 참고하고 현재 파일을 다시 여는 흐름을 완주했다. |
| 구문·공개 빌드 | 최종 전환 수정 후 `node scripts/check.mjs`, `node scripts/build.mjs`를 다시 실행해 실제 종료 0으로 통과했다. 공개 빌드의 src 33개가 원본과 일치하고 `dist/local-api`는 없다. 공개 배포는 실행하지 않았다. |

최종 순수시험 명령:

```powershell
node --test --test-concurrency=1 --test-reporter=tap tests/local-care-ui.test.mjs tests/local-reference-source.test.mjs tests/local-media-viewer.test.mjs tests/native-prepared-media-browser-helper.test.mjs tests/native-feedback-attachments-browser-helper.test.mjs tests/native-api-restart-browser-helper.test.mjs
```

실제 E 피드백 시험은 검증된 `PLAYWRIGHT_MODULE`, `STUDY_CHROMIUM_EXECUTABLE` 설정 후 아래 명령으로 수행했다.

```powershell
node tests/windows-synthetic-session-check.mjs --feedback-attachments --base E:/CarebridgeBeta --powershell "C:/Users/USER\.cache\codex-runtimes\codex-primary-runtime\dependencies\native\powershell\pwsh.exe" --confirm-synthetic-e-drive
```

`test-results/synthetic-e-session-ef2e850b-aefd-4f6a-8496-efb26710d2aa.json`과 `test-results/native-feedback-attachments-ef2e850b-aefd-4f6a-8496-efb26710d2aa/results.json`에 결과를 보존했다. 미저장 F1 현재 사진과 저장된 F1 참고에서 현재 F2 영상을 각각 열었다. F1은 91바이트 PNG, F2는 2,439바이트 MP4이며 현재 메시지와 당시 참고의 파일 ID·크기·해시를 서로 구분해 확인했다. 320px 영상의 실제 재생 프레임, 1440px 사진 해석, 가로 넘침 없음, 키보드 복귀, 입력 DOM·값/당시 인용 불변, 조회 중 치료사 POST 없음과 인증 HTTP를 통한 저장본 불변을 확인했다. 이 변경의 저장본 검사는 직접 SQL 비교가 아니다.

최종 실행은 오류/예상 밖 요청 0, 소스 292개 시작·종료·현재 해시 일치(`5435746a771b895a6bb94d621df3e10a2fd9019721c90bcd23d6afde5d7f2981`)다. 브라우저·API·작업자의 실제 종료/스트림 닫힘, DB 종료, 임시 비밀 폐기와 해당 실행 소유 컨테이너/볼륨 부재를 확인했다. 합성 DB·미디어·진단 파일은 오프라인 증거로 남겼으며 기존 폴더나 실제 사용자 자료는 삭제하지 않았다.

### 전환 수정 후 일반 첨부 재검증

최종 전체 루트 검사와 일반 첨부 native 시험은 다음 명령으로 실행했다. 실제 E 실행은 새 합성 세션이며 이전 두 실패의 폴더나 키를 재사용하지 않았다.

```powershell
node --test --test-concurrency=1 --test-reporter=tap tests/*.test.mjs
node tests/windows-synthetic-session-check.mjs --base E:/CarebridgeBeta --powershell "C:/Users/USER\.cache\codex-runtimes\codex-primary-runtime\dependencies\native\powershell\pwsh.exe" --confirm-synthetic-e-drive
```

`test-results/synthetic-e-session-b85d5c4e-720a-4281-84cc-5e5461b62fc9.json`과 `test-results/native-prepared-b85d5c4e-720a-4281-84cc-5e5461b62fc9/results.json`에 결과를 보존했다. 가상 계정·loopback의 실제 검사 작업자와 API로 PNG/MP4 업로드→검사 승인→빈 본문 전송→수신 재열람을 확인했다. PNG 발신은 390px, 영상 발신은 1440px이며 치료사의 1440px 채팅 열람과 320px 현재 참고 열람을 포함한다. 모든 장면을 세 폭에서 각각 반복한 검사는 아니다.

기존 care 6개와 `currentReferencePhoto`·`currentReferenceVideo` 2개가 모두 통과했다. 첨부창 닫기→기록에 참고→현재 원문→현재 첨부 열기의 실제 흐름에서 인증 HTTP 바이트의 크기·해시, PNG 해석·MP4 시간/프레임 증가, 키보드 열기/닫기와 정확한 버튼으로 초점 복귀를 확인했다. 320px 현재 사진·영상 캡처를 직접 검토했다. 작성 입력 DOM·모든 이름 있는 필드 값·당시 인용이 유지되고 조회 중 해당 방의 치료사 POST가 증가하지 않았다. 취소 뒤 기록 목록의 ID·수정판·날짜·제목·상태·예약 ID 및 원래 메시지의 빈 본문·판·첨부가 전후 동일했다. **이 신규 일반 참고 구간은 임상 본문 전체나 DB 전체 불변을 재비교한 검사가 아니다.** 첨부 닫기와 다음 기록 열기 사이에 기록 목록의 기준 조회가 있으므로, 폴링 전 경합 자체의 재현·해결 근거는 별도 순수 회귀 검사와 함께 해석한다.

오류/예상 밖 요청 0, 소스 293개 시작·종료·현재 해시 일치(`868b0d9bae9b3b0492fee09ebd930b377f3407fe2af75b6072a76882337735af`)를 확인했다. 브라우저 종료, API·작업자 실제 종료 0 및 스트림 닫힘, 관측 시간초과 없음, DB 종료·임시 비밀 폐기도 확인했다. 실행 소유 PID 34588/19780 부재와 검사기/작업자/인코더 각각의 정확한 실행 라벨에 컨테이너·볼륨 0개를 별도 조회했다. 합성 DB·미디어·진단 증거는 오프라인으로 남기고 기존 사용자 자료는 삭제하지 않았다.

**남은 검증:** 수정 후 일반 첨부 native 미완료 항목은 해소했다. 이번은 새 세션 시험이며 같은 세션 재시작·전체 종료 후 재개를 다시 검증한 것으로 세지 않는다. 실물 아이폰 전달·단절·재접속, 사람의 사용 시간/이해도, 독립 백업과 실제 자료 운영은 여전히 미완료다. LAN 리스너·방화벽·Wi-Fi 분류·인증서 신뢰 설정은 변경하지 않았다.

## 2026-10-10 인용 답장에 사진·영상 연결

원 개편안의 ‘공유 기록에 보호자가 답변·첨부를 남긴다’는 흐름에서, 가정 활동이 없는 공유 기록에는 첨부를 포함한 인용 답장을 작성할 수 없었다. 별도 일반 메시지로만 파일을 보내던 경로를 기존 인증 메시지·업로드 API에 연결했다. 아래 이력의 당시 미연결 범위와 구분한다.

- `local-api/care-ui.js`: 공유 기록·일반 소식·활동 피드백에 대한 인용 답장에 사진·영상 선택을 추가했다. 글 없이 준비 완료된 첨부만 보낼 수 있고, 원문의 파일을 자동으로 재전송하지 않는다. 가정 활동 피드백 저장이나 치료 기록 자동 생성으로 대체하지 않는다.
- `local-api/media-ui.js`: 계정·센터·아이 방·답장 초안 ID로 선택 파일을 분리한다. 일반 작성창·기록·활동 경험의 파일을 빌려 쓰지 않는다. `reply`는 브라우저 내부 선택 공간일 뿐 새로운 서버 파일 용도나 권한이 아니다.
- 최초 전송 시 본문·원문 ID/당시 버전·첨부 ID·발신 요청 번호를 함께 고정한다. 결과 불명 시 파일 변경/취소를 막고 같은 요청만 확인하며, 서버 성공 확인 후 해당 초안의 확정 ID만 제거한다. 원문을 다시 읽을 수 없더라도 이전 발신의 영수증 확인은 유지한다.
- 공유 종료·원문 삭제를 확인하면 원문과 작성 본문을 화면에서 지운다. 아직 전송되지 않은 파일이 있으면 현재 방 권한을 다시 확인한 뒤 내용 없는 첨부 정리 화면에서 상태 조회·취소만 허용한다. 업로드 취소가 불명확하면 선택 파일과 번호를 보존한다.
- 서버 API·SQL·인증·담당 관계·파일 검사/준비·키 보존 정책은 변경하지 않았다. 기본 격리 모드에서는 첨부 답장을 활성화하지 않고 기존 글 답장을 유지한다. 공개 4173 프로토타입이나 배포에는 적용하지 않는다.

선택 파일은 목적별로 모든 방을 합해 최대 24개·100MB이며 기존 메시지/기록/활동 경험에 답장 선택 공간이 추가되었다. 네 소유자의 선택 파일 바이트 합산 상한은 **96개·400MB**다. 이는 File 메타데이터의 바이트 합계 제한이며 브라우저 실제 RAM 상한 보장이 아니다. 파일 선택은 메모리 전용으로 새로고침하면 사라진다. 독립 백업 없는 실제 자료 사용이나 장기 보존을 보장하지 않는다.

### 검증

`tests/local-reply-attachments.test.mjs`의 신규 24개는 준비 상태 대역을 사용하는 순수 검사다. 검사기나 실제 저장의 증거로 쓰지 않는다. 기존 파일을 포함한 집중 192개, 전체 로컬 순수 **1,274/1,274**(실패·취소·건너뜀 0, 실제 종료 0)가 통과했다. 전체 결과는 `test-results/reply-pure-20261010-8933a9be-3d3e-4fec-aa81-3ac658fe77a3.tap`, SHA-256 `209216e6294c2e0c22397d068acad98c0d797dcec8853d51425942e6ef6e7a0e`다.

`tests/windows-synthetic-session-check.mjs --reply-attachments`는 새 가상 E 세션에만 사용하는 별도 실행 모드다. 기존 준비 미디어 실행기를 재사용하고 `tests/native-reply-source-browser-helper.mjs`로 활동 없는 공유 기록과 일반 소식을 화면에서 준비한다. 사진 1개·영상 1개만 사용하며 기존 검사/예약 한도를 올리지 않는다. CLI 모드 상호 배제와 네 native 실행기의 소스 목록에 새 도우미가 포함되는 것도 검사했다. API 재시작 모드의 실제 재실행은 하지 않았다.

```powershell
# 검증된 로컬 Playwright/Chromium 경로를 환경 변수에 설정한 후, 프로젝트 루트에서 실행
node tests/windows-synthetic-session-check.mjs --reply-attachments --base E:/CarebridgeBeta --powershell "C:/Users/USER\.cache\codex-runtimes\codex-primary-runtime\dependencies\native\powershell\pwsh.exe" --confirm-synthetic-e-drive
```

최종 1회 실행 `33da6c31-08e7-49b8-ac57-0fc447f7d39e`는 2026-10-10 KST 03:35:34~03:41:17에 **실제 Node 종료 0**으로 통과했다. 새 로그인 → 실제 E PostgreSQL → ClamAV/FFmpeg 준비 → 독립 시험 브라우저 수신/열람을 사용했다. 성공이나 준비 완료를 가짜 HTTP 응답으로 대체하지 않았다.

| 확인 경계 | 실제 확인 내용 |
| --- | --- |
| 활동 없는 공유본 | 기본 기록 저장·비공개 항목 제외·명시적 수신자 확인 후 공유, 가정 활동 없이 인용 답장 가능 |
| 사진 답장, 보호자 390px | 준비 전 발신 차단, 닫기→다른 방→원래 방 재개 후 파일/원문 유지, 일반 작성창과 선택 분리 |
| 실제 응답 유실 | 첫 발신을 실제 커밋시킨 뒤 응답만 유실, 같은 본문·원문·첨부·발신 번호로 재시도하여 같은 메시지 ID 확인 |
| 영상 답장, 보호자 1440px | 일반 소식의 정확한 버전1을 인용하고 글 없이 준비된 영상만 발신 |
| 치료사 1440/320px | 새로고침 후 인용·파일 수신, 인증 content 바이트 크기/해시 관측, PNG decode·MP4 실제 프레임/시간 증가, 키보드 열기/닫기·포커스 복원 |
| 공유 종료, 보호자 390px | 공유 카드와 원문 인용은 숨기고 새 답장 버튼 제거, 이미 보낸 독립 답장·동일 첨부 유지 및 실제 재열람 |

보고서의 `care` **7/7**과 사진·영상 **2개 흐름**이 통과했다. 각 매체를 모든 화면 폭에서 반복한 전 조합 시험은 아니다. 오류/예상 밖 요청 0, PNG 11개이며 390px 사진 준비·철회 후 답장과 320px 영상 뷰어를 직접 확인했다. full-page 캡처의 고정 모달 위치 때문에 한 이미지에 모달 상단/하단이 모두 보이지 않을 수 있으며, 버튼 접근은 실제 UI 조작으로 별도 확인했다.

- 전체 실행 보고서: `test-results/synthetic-e-session-33da6c31-08e7-49b8-ac57-0fc447f7d39e.json`, SHA-256 `c4e98937f53f39c42beafd5da271b8449d37a38b00b5e580a593f130f1408b3b`.
- 브라우저 보고서: `test-results/native-prepared-33da6c31-08e7-49b8-ac57-0fc447f7d39e/results.json`, 내부 UUID `de050f2a-1bfc-4428-825a-8437e12ec1f0`, SHA-256 `5e29cd8bde1d59628330270c9aa598385ecf7b3155fabd53546fbd8dd4787789`.
- 로그: `test-results/native-reply-20261010-b030e8ff-ef53-4072-9a3a-5eff6bd62537.log`.
- 소스/실행 의존 파일 **285개**의 시작·종료·현재 지문 일치: `7cb4577f292ed6eedbdbd680c0297413c36cde5ab8b9f9594ba6088f81f8ece1`. 신규 답장 도우미와 실제 실행기까지 포함한다.
- API·작업자의 실제 exit0/close/stdio 종료, 작업자 drain·DB 닫힘, 브라우저 contexts/process 종료, 관측 시간 초과 없음. DB 세션 `51cb8798-9b43-4f5e-8919-9b7e76bdcd00`의 DB 정지·TLS/자격증명/공용 잠금 부재와 소유 Node6600/Chromium23956 부재를 독립 확인했다. ClamAV `66398e67-b877-47fa-8fc8-235ce665fee1`, decoder `b3704a59-7428-42eb-ba09-5052a0c85919`, encoder `683011c0-4a5c-42ba-9fe1-ed37b57b6863`의 정확한 label에서 남은 컨테이너·이미지·볼륨은 모두 0이다. 공유 Docker Desktop은 유지했고 가상 DB/미디어 진단 자료는 오프라인 보존했다.
- `node scripts/check.mjs`, `node scripts/build.mjs`와 `git diff --check` 통과. 공개 파일 35개 source/dist 해시는 전부 같고 `dist/local-api`는 없다. 공개 프로토타입의 별도 원6사례 3폭 회귀는 [현재 P0 검증](p0-device-matrix.md)에 기록했다. 서버 전체 순수 검사는 이번 UI 연결에서 재실행하지 않았다.

검증 스킬의 UI→인증 API→저장→수신 화면 순서로 확인했고, 순수 대역·공개 프로토타입·실제 E 시험의 결과를 구분했다. 실행 전 독립 읽기 검토에서 시험의 ‘아직 disabled인 재시도 버튼’과 ‘방 전환 뒤 접힌 일반 메시지 메뉴’ 경합을 수정했다. 검사/권한 정책이나 서버 성공 조건은 완화하지 않았다.

실제 아동 자료·외부 접속·Git 푸시·배포는 보류한다. 사람의 사용성 평가·실물 기기 간 접속·완전 종료 후 동일 E 세션 재개도 이번 변경의 완료 주장에 포함하지 않는다.

후속으로 [직접 사용하는 가상 E 세션](synthetic-e-session.md)을 추가했다. 아래 표는 준비 첨부 화면을 처음 연결한 당시 범위이며, 신규 `dev:synthetic-e`의 실행·종료·형식 제한·검증은 후속 문서를 따른다. 실제 자료/외부 접속 보류는 유지한다.

후속 안정성 관측과 최신 회귀는 [Windows 작업자 단계 관측](windows-worker-stage-observation.md)을 따른다. 아래 구현/실패/성공은 준비 첨부 화면 단계 당시 증거로 보존하며, 이후 재검증 성공도 이전 간헐 종료의 해결을 뜻하지 않는다.

작성 2026-10-09. 사용자가 승인한 **가상 계정·자료로 로컬 API 연결**의 후속 단계다. 실제 아동 자료, 외부 접속, 공개 배포나 운영 전환은 승인·활성화하지 않았다.

## 적용 범위

| 실행 | 저장·화면 | 이번 변경의 적용 |
| --- | --- | --- |
| 기존 `npm run dev`, 기본 4173 | 브라우저 저장형 프로토타입 | 변경하지 않음 |
| `npm run dev:local-api`, 기본 4180 | 메모리 DB·임시 격리 업로드 | 기본 상태 유지; 검사·첨부 전송·열람을 자동 활성화하지 않음 |
| `test:native-worker:e-drive` | 새 합성 E PostgreSQL·runtime API·별도 실제 검사 작업자 | 명시적 `prepared` 화면에서 독립 시험 브라우저의 사진·영상 송수신 검증 |

마지막 행은 종료 후 서버를 남기지 않는 **자동 검증 실행기**다. 사용자가 장기간 접속하는 E 드라이브 서비스나 기존 4173 앱의 서버 전환 완료가 아니다. Windows API 서비스의 기본 화면 모드는 계속 `api-only`다.

## 사용자 흐름과 안전 규칙

1. 현재 아동 대화에서 가상 사진·영상 선택 → 비공개 업로드 → 실제 검사·처리 상태 확인.
2. 모든 선택 파일이 준비 완료일 때만 발신한다. 본문 없는 첨부만 보내기도 가능하다. ID 목록과 메시지는 서버 트랜잭션으로 함께 연결하며 업로드만으로 상대에게 공유하지 않는다.
3. 발신 중에는 파일 변경·취소를 잠근다. 응답이 유실되면 같은 본문·첨부 ID·요청 번호를 재사용하고, 성공 응답 후에만 그 대화의 해당 선택 파일 참조를 제거한다. 처음부터 저장되지 않은 확정 거부만 잠금을 풀며 이전에 결과 불명이 있었던 요청은 계속 같은 번호로 확인한다.
4. 수신자는 메시지의 첨부 버튼으로 연다. 현재 메시지 권한 확인 → 인증된 후보 파일 읽기 → 메시지 권한·파일 정보 재확인 이후에만 Blob URL을 만든다. 원본 격리 파일이나 임의 외부 URL로 대체하지 않는다.
5. 닫기·대화/화면 변경·로그아웃·연결 재확인·권한 종료 시 요청을 중단하고 재생 중지, 미디어 요소 제거, Object URL 해제를 수행한다. 닫기 후 현재 남아 있는 정확한 첨부 버튼으로 키보드 포커스를 복원한다. 삭제·숨김·파일 정보 변경이 조회되면 열린 뷰어도 제거한다.
6. 영상은 자동 재생하지 않는다. 파일명은 HTML이 아닌 텍스트로 표시하고 긴 이름은 줄바꿈한다. 선택 상태와 자격증명을 localStorage/sessionStorage에 저장하지 않는다.
7. 만료 표시와 첨부 발신·업로드 판단에 같은 기준을 사용한다. 서버가 아직 `expired:false`를 반환했어도 표시된 만료 시각이 지나면 준비 완료 문구를 제거하고 상태 확인·취소를 안내한다. 최종 권한·만료 판단은 서버가 다시 한다.

`data-media-mode`는 표시용 힌트일 뿐 권한이 아니다. 서버가 고정 HTML 마커를 바꾸고 실제 `MediaAccess`를 제공한 경우에만 준비 화면을 구성한다. 쿼리·요청 헤더·브라우저 입력으로 서버 모드를 바꾸지 않는다. 고정 정적 자산 13개만 제공하며 준비 화면에만 이미지/영상 Blob CSP를 허용한다. 기본 격리 CSP와 루프백·Host/Origin·현재 계정 일치·담당 관계 확인은 유지한다.

## 변경 파일

| 영역 | 파일 | 목적 |
| --- | --- | --- |
| 화면 조합 | `local-api/app.js`, `index.html`, `styles.css`, `care-ui.js` | 명시적 준비 모드, 첨부만 발신, 버튼·뷰어와 반응형 레이아웃 |
| 파일 선택 | `local-api/media-ui.js` | 준비 상태 캡처, 방/계정별 소유권, 발신 잠금·확인·만료 안내 |
| 발신 초안 | `local-api/client.js` | 첨부를 포함한 고정 재시도와 명시적 저장 거부 판별 |
| 열람 | `local-api/media-viewer.js` | 권한 재확인·제한 Blob 표시·중단/해제·키보드 복원 |
| 서버 모드 | `server/local-api-listener.mjs`, `windows-local-api-service.mjs`, `windows-native-api-test-{policy,parent,control}.mjs` | 준비 화면 설정 검증·고정 자산·제한 CSP·IPC 전달 |
| 실제 통합 | `server/windows-native-worker-check.mjs`, `database-credential-service-native-check.mjs`, `windows-postgres-check.mjs` | 새 가상 센터와 실제 검사 작업자·브라우저·E 후보 바이트 결합 |
| 회귀 | `tests/local-*.test.mjs`, `tests/local-*-browser.mjs`, 관련 `server/tests` | 기본 격리 모드 및 입력·권한·수명 규칙 보존 |
| 새 브라우저 시험 | `tests/native-prepared-media-browser-helper.mjs` | 독립 로그인·실제 업로드/검사/송수신/재생, 응답 유실, 소스 지문·종료 증거 |

SQL 스키마, DB 역할 권한, 공개 정적 프로토타입과 배포 설정은 이번 단계에서 변경하지 않았다. 기록/가정 피드백 첨부 추가·교체·선택 공유는 아직 연결하지 않았다.

## 검증 방법

루트 단위 시험과 서버 시험은 각각 프로젝트 루트, `server` 폴더에서 실행한다. 과거 병렬 Node 비정상 종료가 미확정이므로 서버 전체 회귀는 직렬로 실행했다.

```powershell
node --test --test-concurrency=1 tests/*.test.mjs
node scripts/check.mjs
node scripts/build.mjs
# server 폴더:
node --test --test-concurrency=1 tests/*.test.mjs
```

브라우저 시험은 확인된 로컬 Playwright 모듈과 Chromium 실행 파일을 `PLAYWRIGHT_MODULE`, `STUDY_CHROMIUM_EXECUTABLE`에 지정한다. 기존 사용자 프로필·열린 탭은 사용하지 않는다.

```powershell
node tests/local-media-browser.mjs --confirm-synthetic-local
node tests/local-product-browser.mjs --confirm-synthetic-local
node tests/local-care-browser.mjs --confirm-synthetic-local
node tests/local-message-browser.mjs --confirm-synthetic-local
node tests/local-api-browser.mjs --confirm-synthetic-local
node server/windows-postgres-check.mjs --verify-native-media --base E:/CarebridgeBeta --powershell '<검증된 pwsh.exe 절대경로>' --confirm-synthetic-e-drive
```

native 실행에는 기존 검증된 PostgreSQL·PowerShell 런타임 및 Docker Linux 엔진/이미지가 필요하다. 임의 서버나 운영 자료를 지정하지 않는다. 백신 정의 갱신 등 시험 준비에서 네트워크를 사용할 수 있으므로 완전 오프라인 시험으로 표현하지 않는다.

## 이번 실행 결과

아래 검사는 실제 실행했다. 집중 시험은 전체 시험과 겹치므로 합산하지 않는다.

| 검사 | 결과 | 증거 |
| --- | --- | --- |
| 로컬 전체 단위 | **446/446 통과**, 실패·취소·건너뜀 0 | `test-results/prepared-ui-local-unit-release-20261009.xml` |
| 서버 전체 직렬 회귀 | **1,063/1,063 통과**, 실패·취소·건너뜀 0 | `test-results/prepared-ui-server-unit-20261009.xml`, 같은 이름 `.tap` |
| native E·API·실제 검사·브라우저 통합 | **55/55 통과**, 실제 Node 종료 코드 0 | `test-results/windows-native-worker-471bce2e-3bcb-4cc8-8baf-a20efe363fcf-results.json` |
| 준비 첨부 브라우저 | 사진·영상 **2/2 흐름 통과** | `test-results/native-prepared-471bce2e-3bcb-4cc8-8baf-a20efe363fcf/results.json` |
| 기본 화면 회귀 | 격리 업로드·4메뉴·기록/공유/피드백·메시지 변경·로그인/대화, 각 **320/390/1440px 통과** | 아래 실행 UUID별 `results.json` |
| 구문·정적 빌드 | **통과** | `node scripts/check.mjs`, `node scripts/build.mjs`; 이후 변경한 미디어 UI/브라우저 도우미는 별도 `node --check`도 통과 |

최종 native 실행은 `471bce2e-3bcb-4cc8-8baf-a20efe363fcf`이며 전체 로그는 `test-results/prepared-ui-native-serial-run-20261009.log`에 보존했다. 다른 검증 프로세스와 병행하지 않았다. 기존 6개 native HTTP/중단 경계를 유지하고, 새 가상 센터의 UI 검증을 7번째 경계로 추가했다. 검사 작업자 4개와 닫힌 디코더 작업 8개, 원본 보존·메타데이터 제거 후보·원본/후보의 실제 ClamAV 1.4.6 및 FFmpeg 9.0.2 증거, 브라우저 응답 바이트와 E 후보의 크기/해시 일치를 확인했다. `mediaAcceptanceReady:false`는 운영 승인 아님을 유지한다.

준비 첨부 브라우저 실행 UUID는 `0889f1d5-e98e-4b12-9ba9-2fcc6c94ffe9`, Chromium은 `149.0.7827.55`다. 보호자 사진 발신은 390px, 영상 발신은 1440px에서 수행했고 치료사는 1440px 및 320px에서 각각 열었다. 따라서 모든 종류/발신·수신을 모든 폭에서 반복한 완전 조합 시험은 아니다. 사진의 실제 decode와 영상의 재생 시간·디코딩된 프레임 증가, 첨부만 전송, 새로고침 뒤 수신, PNG의 실제 저장 응답 유실 후 동일 요청/메시지 ID 재시도, 파일명 이스케이프·키보드 포커스 복원을 확인했다. 오류와 예상 밖 요청은 0건이다. 첨부/뷰어 6개 화면 PNG를 직접 확인했으며 긴 파일명·닫기·영상 제어의 가로 넘침은 관측되지 않았다. 화면의 분홍 영역은 시험 계정 마스킹이다.

검증 시작/종료/현재의 코드 232개 SHA-256이 일치한다. 집합 지문은 `a37556869474fccbbb80df17012175d2162b275d26f30f715d7a91c899005689`다. API child 정상 종료 코드 0·close·파이프 닫힘, 작업자 4개의 실제 terminal(정상 3개 0 / 의도한 IPC 상실 1개 1), 브라우저 context/process 종료, 원본·복원 DB 정지, DPAPI 시험 자격증명·TLS·검사 fixture 정리를 확인했다. 종료 후 소유 Node/PostgreSQL/브라우저 PID와 정확한 검사 label의 Docker 컨테이너는 남지 않았다. Docker Desktop 자체는 종료하지 않았으며 합성 E DB/미디어 진단 자료는 오프라인 보존한다.

기본 화면 회귀 결과 폴더는 다음과 같다. 기본 모드에서는 실제 백신 승인·첨부 발신/열람이 제공되지 않음을 함께 확인한다.

- 격리 업로드: `test-results/local-media-2fc1edbd-5059-42fd-aa16-d3e8364ea0e6`
- 기록/공유/피드백: `test-results/local-care-0d740802-5618-4981-99ac-ec919e20e731`
- 메시지 변경/인용: `test-results/local-message-b2373122-473f-4593-88e0-3d5c796dd25a`
- 로그인/대화/읽음: `test-results/local-api-6c3ff010-44a9-4223-a243-a97050fa336b`
- 4메뉴/두 아동/일정: `test-results/local-product-323224ba-e075-4aa3-a922-aa22266755ce`

이전 4메뉴 실행 `9e0482a7-130b-4c7b-b121-d4b4f1927667`도 통과했지만, 이후 미디어 만료 문구를 수정했으므로 최신 증거는 위 재실행 결과로 구분한다.

다섯 최종 기본 브라우저 결과 모두 오류·예상 밖 요청 0, 소유 자원 정리·소유 영수증 완료, 현재 소스 지문 불일치 0을 재확인했다. 최종 `node scripts/build.mjs`는 전체 JavaScript 구문 검사와 함께 종료 코드 0으로 완료됐다. 공개 자산 35개의 소스/dist 해시는 같고 `dist/local-api`는 없다. 주요 변경 25파일의 UTF-8·후행 공백·충돌 표식 검사와 `git diff --check`도 통과했다. Git의 LF→CRLF 안내는 있었으며 관련 없는 기존 변경을 되돌리거나 커밋·배포하지 않았다.

### 첫 통합 실행 실패 보존

첫 실행 `eaa479a9-bc7b-44f6-b319-dc7944a7e87c`는 13개 경계 확인 후 `credential-service`/603 단계에서 실패했다. 첫 검사 작업자가 `3221226505` (`0xC0000409`)로 비정상 종료했고, 해당 시점 첫 업로드는 `running`, 나머지 3개는 `queued`였다. 브라우저 준비 첨부 시험에는 **도달하지 않았다**. JavaScript의 처리된 오류/정상 drain으로 바꾸어 기록하지 않는다.

API 자식은 실제 종료 코드 0·close·파이프 닫힘이 확인됐고, 작업자 프로세스 종료·원본 PostgreSQL 정지·검사 fixture 정리는 확인됐다. 복원 클러스터는 아직 생성 전이었고 TLS/E 진단 자료는 실패 보존 정책에 따라 남았다. 확인한 정확한 시험 label의 Docker 컨테이너는 잔존하지 않았다. 결과는 `test-results/windows-native-worker-eaa479a9-bc7b-44f6-b319-dc7944a7e87c-results.json`, 전체 출력은 `test-results/prepared-ui-native-run-20261009.log`에 보존한다.

실행 환경은 Windows `10.0.26200.0`, Node `24.15.0`, V8 `13.6.233.17-node.48`, libuv `1.51.0`이다. 05:11:56~05:16:59(KST)의 Windows Application 1000/1001 이벤트는 없었으나 이것만으로 원인을 배제할 수 없다. Node 프로젝트에 [Windows 26200의 Maglev 비정상 종료 유사 보고](https://github.com/nodejs/node/issues/62260)가 있지만 보고 버전은 Node 25.8이며, 이번 원인이 같다고 확정하지 않는다. 보안 설정·JIT 플래그·전역 Node 버전은 변경하지 않았다. 다른 브라우저 회귀와 병행됐던 첫 실행을 보존하고, 동일 소스의 단독 재검사로 범위를 좁힌다.

## 한계와 다음 순서

1. 독립 백업 매체가 없다. 실제 자료와 외부 접속은 계속 보류한다. 합성 E 사본은 독립 백업이나 운영 복구 보장이 아니다.
2. 두 브라우저는 같은 PC의 독립 쿠키 세션이다. 320·390·1440px 검사는 실물 휴대폰·독립 기기·실제 사람 검증이 아니다. 서버 조회 기반 수신을 푸시/실시간 소켓으로 표현하지 않는다.
3. 현재 새로고침하면 미전송 선택 파일과 초안이 사라진다. 시험 종료 후 상시 API/worker를 유지하지 않는다. 직접 조작 가능한 합성 E 실행기의 계정 표시·종료·재시작 정책은 다음 작업이다.
4. 기록·피드백 첨부 추가/교체·선택 공유·보존 당시 첨부 열람, 사용자용 초대·복구/관계 관리 API 연결도 남아 있다. 전체 개편안/P1 완료가 아니다.
5. 권한 변경을 푸시받지 않으며 다음 조회/재확인에서 반영한다. 이미 내려받은 바이트를 원격 회수할 수 없다. Blob 참조 해제는 보안 RAM 소거 보장이 아니다.
6. API/worker DB 역할 분리는 같은 Windows 계정의 DPAPI/Docker 권한까지 OS 수준에서 분리했다는 뜻이 아니다. 운영 계정·경로 지속 소유·정책적 보존/파기는 별도 준비가 필요하다.
7. 이번 첫 native 실행과 이전 native/병렬 Node 시험의 비정상 종료 원인은 아직 미확정이다. 단독 재실행 성공은 그 원인의 해결이나 운영 안정성을 증명하지 않는다. 과거 실패 기록은 [Windows 연결 기록](windows-local-api-connection.md)에 보존한다.

다음 우선순위는 **Windows 작업자 간헐 종료의 진단·안정성 확인 → 직접 조작 가능한 합성 E 실행기 → 기록/피드백 첨부와 나머지 API 흐름 → 실물 기기·사람 검증**이다. 이 순서와 별개로 실제 자료 전환에는 독립 백업·운영 보안/복구 준비가 필요하다.

백엔드·전체 흐름 검증 지침에 따라 기존 인증/도메인 규칙을 재사용하고, 대역 시험과 실제 엔진/브라우저 증거를 구분했다.
