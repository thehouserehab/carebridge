# Carebridge PC 검증 — 2026-10-24

## 범위와 판단

사용자의 “아이폰 실물 검증 이외 할 수 있는 작업 모두 진행” 요청에 따라 독립 작업 사본의 남은 PC 검증을 수행했다. 기존 E 자료는 재사용하지 않고 새 합성 DB·사진·영상만 사용했다. 실제 사람의 작성 시간·요약 이해도는 자동 기능 검사와 구분한다. 원본 통합·배포·실자료 운영은 이번 검증에 포함하지 않는다.

## AI 평가 후 수정 — 변경 없는 기록 닫기와 미리보기

저장된 기록을 조회만 하고 닫아도 `입력 이어쓰기` 상태가 남아 다른 기록의 미리보기 대신 원래 편집기가 열리던 문제를 수정했다. 정상적으로 조회한 정식 저장 기록의 최초 폼 값을 메모리에 한 번 보관하고, 닫을 때 값이 같으며 입력·첨부·요청 상태가 확실히 깨끗한 경우에만 편집 상태를 정리한다. 재표시할 때 비교 기준을 바꾸지 않는다. 신규/임시저장 초안, 변경값, 추가·삭제한 측정 행, 선택 첨부, 처리 중이거나 결과가 불확실한 요청, 오류·권한/문맥 재확인 상태는 계속 보존한다. 기존 기록 화면 제목은 `기록 수정`으로 정리했다.

| 변경 파일 | 내용 |
| --- | --- |
| `local-api/care-ui.js` | 최초 저장값 비교와 보수적인 닫기 조건, 기존 기록 제목 |
| `tests/local-share-review.test.mjs` | 무수정 닫기/Escape, 수정·초안·첨부·오류·방 전환 보존 회귀10개 |
| `tests/local-p0-study-browser.mjs` | 같은/다른 기록 미리보기 진입, 변경값과0/빈칸·새 초안 보존을 실제 UI와 저장 DTO로 검증 |
| 이 문서, `docs/communication-acceptance.md` | AI 평가와 수정 후 검증 근거 구분 |

단위 검사 명령은 `node --test tests/local-share-review.test.mjs tests/local-care-ui.test.mjs tests/local-record-sharing-preparation.test.mjs tests/local-record-writing.test.mjs tests/local-record-template.test.mjs tests/local-record-host-stability.test.mjs tests/local-record-layout.test.mjs`이며 **201/201 통과·exit0**다. 별도 읽기 검토에서도 차단사항이 없었다. 변경 코드3파일의 `node --check`, 추적 파일의 `git diff --check`, 미추적 파일을 포함한 변경5파일의 끝 공백 검사도 통과했다.

최종 `node tests/local-p0-study-browser.mjs --confirm-synthetic-local` 실행 `bfb71de9-f3b8-4a48-bbe5-4121b46809af`는 **390/1440px A/B/C 6조합 통과·exit0**다. B의 두 화면 폭에서 다음8조건을 확인했다: 무수정 닫기, 무수정 Escape, 같은 기록 직접 미리보기, 다른 기록 직접 미리보기, 변경 요약·측정 빈칸 보존, 원값·측정값0 복원 후 정리, 새 빈 초안 보존, 추가 쓰기 없음. 다른 기록의 미리보기를 눌러도 수정 중이면 원래 기록의 제목과 입력을 유지한다. 새 초안은 명시적인 입력 취소로만 정리했다. 이 단계에서 추가 저장·발행이 발생하지 않았고 최초 저장 DTO가 그대로임을 확인했다.

첫 실행 `f36194eb-d3b3-40d9-94aa-f3c39256a9cf`는 다른 기록 미리보기의 제목 선택자가 가정 활동 제목까지 함께 선택해 실패했다. 실패 캡처에서 올바른 미리보기 진입을 확인한 뒤 선택자를 `.care-share-preview > h3`로 좁혔다. 실패 결과는 보존했으며 그 실행도 문맥·브라우저·시험 DB 정리 true, 오류·예상 밖 요청0이다. 이후 최종 실행을 새로 수행했으며 실패 결과를 성공으로 교체하지 않았다.

최종 캡처 중390px의 clean-preview/other-preview/dirty-preserved와1440px clean-preview를 직접 검토했다. 모바일에서는 두 기록의 미리보기가 각각 올바른 제목·내용을 보여주고 수정 중 폼은 원래 기록으로 복원됐다. 캡처만으로 화면 밖 수정값 보존을 추정하지 않았으며 실제 폼 값과 DTO 단언을 근거로 삼았다. 320px·실물 iPhone 결과로 확대하지 않는다.

최종548파일의 시작·종료·재확인 소스 지문은 `c43c6bf14e5a6ab3575a065262600b49bec1623878688161e16fee556dc03746`로 같다. 이전 AI 평가의 소스와 비교하여 manifest 내 차이는 `local-api/care-ui.js`, `tests/local-p0-study-browser.mjs` 두 파일이다. 단위 검사 파일은 이 manifest에 포함하지 않는다. 원본 결과473,587바이트의 SHA-256은 `99d5a07e79ac0ed9023e2ca5614f25e82f2a1d35fa2d91fa38a2daa74fcfb8e8`이며 실제 사전 준비 판정true·판정 전후 원본 불변을 확인했다. 오류·예상 밖 요청0, humanMetricsCollected/humanTaskCompletion은 모두false다.

최종 문맥·브라우저·시험 DB 정리 true, 종료 대기 시간 초과false다. 19:19 KST에 소유 프로세스27296/18512와 사용 포트6개의 부재를 별도 확인했다. 원본 결과·캡처·`completion-audit.json`·`cleanup-audit.json`은 `test-results/local-p0-study-bfb71de9-f3b8-4a48-bbe5-4121b46809af/`에 보존했다. 이번 수정은 격리 Chrome·loopback HTTP·메모리 PGlite 검증이며 E 자료, 인증/권한/API, 방화벽·신뢰 저장소, 원본 통합·배포는 바꾸지 않았다. 앞서 완료한 실제 파일 첨부 검사를 이 변경 뒤 재실행했다고 주장하지 않는다. 사람 비교 평가·최신 iPhone 재접속·독립 백업과 운영 준비는 별도다.

## 별도 AI 직접 조작 평가의 검토

강철이 일반 Node 터미널의 기존 `scripts/local-p0-study.mjs`로 A/B/C를 순차 실행하고, IAB의 새 탭에서 정상 로그인·직접 클릭·입력한 평가를 완료했다. 이는 앞 절들의 자동 Playwright 검사와 다른 실행이다. Chrome 시크릿 창이나 실제 iPhone, 실제 보호자·치료사 연구로 기록하지 않는다. 원 보고서와 JPEG6개를 읽고 직접 확인했다.

- A: 가정 활동의 날짜·수행 상태·반응·어려움 저장 후 새로고침·재열기에서 같은 필드를 확인했다.
- B: 기본3항목과 측정값3분/0회 입력, 날짜·공유 요약 누락 복구, 저장·재열기와 수신자1명·공개 범위 미리보기를 확인했다. 실제 공유 전송은 하지 않았다.
- C: 390×900에서 공유 요약 처음부터 끝까지 읽기, 직접 스크롤로 답변 버튼 접근, 인용한 가상 답장 저장·새로고침 후 보존을 확인했다.

원 보고서: AI 직접 조작 평가 (개인 로컬 산출물·공개 대상 제외). SHA-256 `b6503240ac04ad58f7fad74934a9b179deffb2c3c6bbc090f9efa1bca65f4f12`. 같은 폴더의 `carebridge-ai-A-reopened-20261024.jpg`, B의 summary-required/zero-reopened/share-preview, C의 summary-initial/reply-reopened 캡처를 검토했다. 동작 순서·재열기는 평가 담당의 보고에 근거하며 캡처만으로 전체 실행을 독립 재현했다고 주장하지 않는다.

평가 당시548파일 지문은 `f0e1880d8145a4423115461f660a1227fa0cfd1af64cb3e9d01863e3cd39d315`다. 원 보고서는 A/B/C 각 실행기의 q+Enter 정상 종료·exit0, IAB 탭3개 닫기와 뷰포트 복원을 기록했다. 이 작업에서도19:03 KST에 해당 실행기 프로세스와 포트50622·62829·54093이 남아 있지 않음을 별도 조회했다. 임시 로그인 전달 파일 제거는 평가 담당의 보고이며 이 작업에서 해당 파일을 읽거나 삭제하지 않았다. 최초에 실패한 브라우저 도구 안의 Node 모듈 실행과 달리, 일반 터미널+정상 브라우저 로그인 경로로 실제 UI 평가가 가능했음을 확인했다.

새로운 작업 중단급 오류는 보고되지 않았으나, **저장 기록을 조회·닫기만 해도 이어쓰기 상태가 남아 미리보기 진입을 가로채는 UX 문제**는 당시 소스에서 재확인했다. 수정 전 `close()`는 view를 유지하고 `handleAction()`은 view 존재만으로 기존 폼을 복원했다. 변경 없는 정식 저장 기록만 정리하는 후속 수정과 보존 검증을 완료했으며 근거는 위 절에 구분했다. 원 AI 평가가 후속 수정까지 확인한 것은 아니다. 답변 버튼 두 종류의 안내 문구는 별도 개선 후보로 남긴다. 사람의 혼동 빈도·시간·이해도·개선율은 측정하지 않았다.

사람 평가·최신 iPhone 실물 재접속·실물 보조기기, 운영 배포·독립 백업은 여전히 별도다. 이번 직접 조작에는 파일 첨부·장시간 경합 검사가 포함되지 않으며 과거 별도 검사 근거와 합산하지 않는다.

## 공유 요약 최초 진입과 실제 스크롤 확인

앞서 남긴 C 캡처의 시점 공백을 보완했다. `tests/local-p0-study-browser.mjs`만 수정하여 390/1440px의 최초 진입·새로고침 후 재열기에서 **진입 직후 → 하단 인용 답장 trial 직후 → 실제 휠로 다시 읽기**를 구분했다. DOM/API의 정확한 요약·활동 내용, 보호자 비공개 경계와 임상 쓰기0건 검사는 유지했다. 제품 화면·API·권한·자료는 수정하지 않았다.

진입 직후에는 요약 첫 텍스트 영역이 대화 패널과 뷰포트의 교집합 안에 있고 중심점이 가려지지 않아야 한다. 이 확인을 실패하면 이후 스크롤로 통과 처리하지 않는다. trial 후에는 패널 안에서 정상 `mouse.wheel` 입력으로 이동하며 모든 텍스트 영역이 한 번 이상 온전히 표시됐는지 확인한다. 스크롤은 최대12회, 위치 변화 대기는 회당3초다. DOM `scrollTop`을 직접 바꾸거나 앱 상태를 주입하지 않는다. 카드 전체를 한 화면에 동시에 보여야 한다는 조건도 추가하지 않았다.

새 실행 `4fe880b2-a2d3-4f5a-828b-6b0d1d7fed06`은 **A/B/C × 390/1440px 6조합 통과·exit0**다. C의 최초/재열기 네 관측 모두 진입 시 요약 전체의 텍스트 영역이 보였고, trial 후 첫 영역이 가려졌다가 실제 휠로 전체 접근이 확인됐다.

| 폭 | 최초/재열기 진입 패널 scrollTop | trial 후 패널 scrollTop | 바깥 페이지 scrollY | 요약 전체 접근 |
| --- | --- | --- | --- | --- |
| 390px | 239 / 239 | 428 / 428 | 176 유지 | 두 경로 모두 실제 휠로 확인 |
| 1440px | 220 / 220 | 476 / 476 | 0 유지 | 두 경로 모두 실제 휠로 확인 |

이번 실행에서 앞부분 잘림은 하단 버튼의 trial 검사에 따라 대화 패널이 움직인 뒤 나타났다. 이를 최초 진입 결함으로 판정하지 않는다. 390px 최초/버튼 검사 후 및1440px 최초/다시 읽기 캡처를 직접 확인했다. 최초 화면·중간 위치·다시 읽기 증거는 `test-results/local-p0-study-4fe880b2-a2d3-4f5a-828b-6b0d1d7fed06/`에 보존했다. 가림 검사는 텍스트 영역 중심점 기준이며 모든 픽셀의 무가림이나 사람 이해도·실물 터치를 증명하지 않는다. 중간 실패 시 기하 상세는 helper 반환 전이라 결과에 남지 않을 수 있으나 캡처와 실패 단계는 남는다.

548파일의 시작/종료/재확인 지문은 `f0e1880d8145a4423115461f660a1227fa0cfd1af64cb3e9d01863e3cd39d315`로 같다. 직전 실행과 다른 소스는 검사 파일1개뿐이다. 결과471,806바이트의 SHA-256은 `1d895490cef0e05885421559e5fabc058be9959295afc8c3297b237a081a0d8e`이며 원본 그대로 현재 준비 판정 **true**를 확인했다. 오류·예상 밖 요청0, humanMetricsCollected/humanTaskCompletion=false다. 변경 파일 구문 검사와 독립 읽기 검토도 완료했다. 앞선 단위45/45는 한도 수정 당시 근거이며 이번 변경 후 다시 실행한 수치로 합산하지 않는다.

contextsClosed/browserStopped/sandboxesClosed=true, cleanupObservationTimedOut=false다. 종료 후 소유 프로세스2104·3980과 사용 포트59346·62337·62493·64201·64225·65399가 남아 있지 않음을 별도 조회했다. 이번 작업에서 유지 중인 합성 서버·시험 계정·평가 탭은 없다. 다른 AI가 직접 사용할 로그인 탭을 준비했다는 뜻은 아니며, 사람 평가·최신 iPhone 실물 검증은 여전히 별도다.

## 후속 준비 도구 수정 — 정상 결과 허용과 상한 유지

아래 진단에서 확인한 결과 파일 제한을 수정했다. `scripts/local-p0-study-preflight.mjs`의 상한만 256KiB에서 **1MiB(1,048,576바이트)**로 올렸다. 읽기 버퍼도 같은 상한+1바이트로 제한되며 최신 실행·당일·동일 소스·6조합·사람 지표 미수집·정리 완료·파일 정체성 검사는 유지했다. 제품 화면·API·인증·저장 정책은 변경하지 않았다.

`tests/local-p0-study-preflight.test.mjs`에 1,000개 파일의 정상 manifest로 256KiB를 넘는 보고서의 허용·원본 보존을 추가했다. 유효 JSON에 공백을 붙인 1MiB−1·정확히1MiB는 통과하고 1MiB+1은 파일을 열기 전에 거부하는지 확인했다. 기존 oversized 검사도 새 상한으로 갱신하여 JSON 오류 때문에 우연히 통과하지 않도록 했다.

- `node --test tests/local-p0-study-preflight.test.mjs tests/local-p0-study-cli.test.mjs tests/local-p0-study-fixture.test.mjs`: **45/45 통과**. 최신 실패·소스 불일치·종료 미확인의 거절도 포함한다.
- 수정한 두 JS 파일의 `node --check` 및 추적 파일의 `git diff --check`: 통과.
- 새 `local-p0-study-adea4c34-572e-4f6a-a7d5-8f17d5c0887e`: **390/1440px × A/B/C 6조합 통과·exit0**, 오류·예상 밖 요청0.
- 생성된 원본 `results.json` **442,768바이트**에 대해 현재 소스로 `hasLocalP0StudyPreflight()`를 호출한 결과 **true**. 호출 전후 내용과 수정시각도 같았다. 원본을 줄이거나 판정을 강제로 통과시키지 않았다.
- 548파일 시작/종료/재확인 지문: `dca4f4c06f14d6523f2e7600ff102d85081d536c8053a0275c2e16e122b06bad`. 결과 SHA-256: `4d71f0ed263558a87b16c6e9f2049e13df52671110bc84cecf87445821e52765`.
- contextsClosed/browserStopped/sandboxesClosed=true, cleanupObservationTimedOut=false. humanMetricsCollected/humanTaskCompletion=false. A/B는 UI 저장 확인, C는 준비된 공유본 읽기 확인이다.

독립 검토에서도 두 수정 파일의 추가 문제는 발견하지 못했다. 이 통과는 **당일·해당 소스의 준비 근거**이며 이후 소스 변경이나 날짜 변경에도 계속 유효하다는 뜻은 아니다. 실제 사람 평가와 iPhone 실물 검증은 여전히 미완료다.

후속 AI 조작용 탭 준비 가능성도 확인했다. 연결된 Chrome은 있으나 로그인된 평가 탭은 없었다. 자격증명을 메시지·파일·URL로 옮기지 않고 같은 브라우저 도구 메모리에서 합성 fixture를 준비하려던 시도는 `tests/local-p0-study-browser.mjs` 가져오기 단계에서 `Module not found: @electric-sql/pglite`로 실패했다. 기존 `server/node_modules` 경로를 등록한 뒤에는 `process is not defined`가 발생했다. 별도 Node REPL의 읽기 확인에서도 `typeof process`는 undefined였다. 이는 UI 접근 거절이 아니라 해당 도구 실행 환경에서 애플리케이션의 Node 모듈을 실행하지 못한 것이다. `fixtureCreated=false`, `expiryTimerCreated=false`를 확인했으며 이 시도에서는 서버·계정·탭을 만들지 않았다. TTY 전용 사람 평가 실행기를 우회하거나 인증정보 전달용 경로를 추가하지 않았다. 따라서 **사전검사 판정 수정 완료**와 **다른 AI가 즉시 조작할 로그인된 탭 준비 완료**는 구분한다. 후속 정상 경로는 기존 일반 터미널의 실행기로 새 합성 세션을 준비하고, 사용자가 정상 로그인한 Chrome 탭을 AI가 이어서 조작하는 것이다.

## 후속 AI 모의 평가 — 준비 판정의 용량 제한 발견

이 절은 수정 전 진단 이력이다. 당시 제안한 상한 보완의 적용·검증 결과는 바로 위 절을 따른다.

‘강철’의 참여는 AI 모의 역할이라는 전달에 따라 실제 보호자·치료사 참여나 사람의 시간·이동 수·이해도 측정으로 기록하지 않는다. 대화형 사람 평가 서버·계정 표시 터미널은 열지 않았다.

새 자동 사전검사 `de2f5c67-5e4b-4bb4-9e08-6e1fc511926c`는 390/1440px의 A/B/C **6조합 통과·exit0**, 오류·예상 밖 요청0이다. A/B의 UI 저장·실제 조회·새로고침·재열기와 C의 공유본 읽기를 확인했다. C는 `uiWriteVerified=false`, `preparedReadingOnly=true`이며 사람 이해도 성공이 아니다. 548파일의 시작/종료/재확인 소스 지문은 `2fe279a28d01e42e8080e88ab4c9b92a895086726539e17aa4af7305d9d1cd32`로 같다. contextsClosed/browserStopped/sandboxesClosed는 모두 true, cleanupObservationTimedOut=false다.

그러나 `hasLocalP0StudyPreflight()`의 실제 판정은 **false**다. `scripts/local-p0-study-preflight.mjs:11,104`의 최대 파일 크기는 256KiB(262,144바이트)인데 이 실행의 `results.json`은 **442,768바이트**여서 JSON 내용을 검증하기 전에 거부한다. 같은 내용을 메모리에서 공백 없이 직렬화해도263,836바이트로 상한보다 크다. 원본 결과 파일을 축소·교체하지 않았고 판정을 우회하거나 성공으로 덮어쓰지 않았다. 따라서 자동 검사 통과와 대화형 준비 가능은 구분해야 한다.

최소 후속 조치는 생산되는 정상 결과를 수용할 유한한 상한(예:1MiB)을 정하고, 현재 크기의 정상 보고서 허용 및 상한 초과 거부 경계 검사를 함께 보완하는 것이다. 최신 실패·동일 소스·당일·6조합·종료 확인·파일 정체성 검사는 그대로 유지해야 한다. 이 조치는 **제안이며 아직 코드에 적용하지 않았다**. 적용 시 바뀐 소스에 대한 새 자동 사전검사와 실제 준비 판정까지 필요하다. 이번 후속은 AI 검사·읽기 진단·문서 기록만 수행했다.

`390-C-shared-summary.png`, `1440-C-shared-summary.png`에서는 요약 앞부분이 표시 영역 위에 있다. 다만 검사 순서는 홈 진입→정확한 요약의 DOM/API 대조→카드 하단 ‘인용 답장’의 `click({trial:true})`→캡처다. trial 동작도 필요한 스크롤을 수행하므로, 이 이미지를 최초 진입 위치의 실패로 판정할 수 없다. trial 전 캡처·전후 스크롤 값과 사용자가 위로 스크롤해 전체 요약을 읽는 동작은 이번 실행에서 확인하지 않았다. 코드 읽기와 캡처를 독립 검토했으며 제품 결함이나 그 원인으로 확정하지 않았다.

원본 결과와 캡처는 `test-results/local-p0-study-de2f5c67-5e4b-4bb4-9e08-6e1fc511926c/`에 보존했다. 결과 SHA-256은 `63be651ecd2689464c5d4ad2a11a792df8797d0abaf5b8c37d901f1f58447182`다. 다른 관리 스레드의 별도 실행은 이 결과에 합산하지 않는다. 실제 사람 평가와 iPhone 실물 검증은 미완료로 유지한다.

## 완료 감사 후 보완 — 홈에서 전체 일정으로 이동

원안 §2의 “홈과 아이 정보에서 전체 일정 목록으로 접근”을 다시 대조하여 홈의 직접 진입 버튼 누락을 수정했다. 홈의 **전체 일정**은 현재 선택한 아이를 유지하고, 선택 전에는 첫 허용 아이의 기존 월별 일정으로 이동한다. 제목에 아이 이름을 표시하고 초점·스크롤을 이동한다. 다른 메뉴나 아이를 고른 뒤 도착한 응답은 이 이동을 되살리지 않는다. 신규 메뉴·API·권한·저장 정책은 추가하지 않았다.

첫 브라우저 `392dfdba-c06e-495c-9585-86e5c15da2cd`는 3폭 각각22개 기능 경계를 통과했으나, 직접 확인한 320px 캡처에서 일정 버튼 그룹이 카드 오른쪽을 벗어나는 기존 배치 문제를 발견했다. 페이지 전체 가로 넘침만으로는 이 문제를 잡지 못했다. 일정 헤더의 버튼 그룹에 부모 폭 제한과 축소·줄바꿈을 적용하고, 버튼이 카드의 좌우 여백 안에 놓이는지 검사했다. 첫 기능 통과를 시각 검수 완료로 표현하지 않는다.

최종 `bd9d7c40-8c27-4079-b5c9-bbec3a283f49`는 **320·390·1440px 각각22경계 통과·exit0**다. 추가한 일정 경계5개와 기존 홈/대화/기록 경계17개를 포함한다.

- 치료사·보호자의 최초 진입, 선택한 두 번째 아이의 빈 일정, 다음 달 실제 조회→홈 왕복→원래 월 실제 조회를 확인했다.
- 일정 제목의 초점·화면 내 가시성·4메뉴 유지, 카드 안 버튼 배치·높이43.5px 이상을 확인했다. 320px는 Enter로 버튼을 실행했다.
- 일정 이동 전후 읽음 POST 수와 DB 읽음 상태가 같았다. 대화 DOM도 열리지 않았다.
- 치료사 진입 중 실제 200 응답을 지연한 뒤 홈으로 이동하면, 원 응답 도착 후에도 홈과 초점이 유지됐다. 이 지연 경합의 역할 범위는 치료사다.
- 최종 `320-therapist-schedule-first-child.png`를 직접 확인해 버튼이 카드 안에서 두 줄로 표시되는 것을 확인했다. 다른 폭의 일정·빈 상태 캡처도 1차 실행에서 확인했다.

| 추가 변경 파일 | 목적 |
| --- | --- |
| `local-api/workspace-ui.js` | 홈 전체 일정 버튼과 아이 이름이 있는 일정 제목 |
| `local-api/app.js` | 기존 허용 아이 선택을 재사용하는 일정 이동·늦은 초점 이동 차단 |
| `local-api/styles.css` | 좁은 카드 안에서 일정 버튼 그룹 줄바꿈 |
| `tests/local-product-browser.mjs` | 역할별 직접 진입·월·읽음·초점·카드 경계 및 취소 경합 검사 |
| `tests/local-product-ui.test.mjs` | 바뀐 일정 안내 문구 반영 |
| `docs/communication-acceptance.md`, 이 문서 | 최종 결과와 별도 미완료 범위 정리 |

`node --test tests/local-product-ui.test.mjs tests/local-workspace-browser-helpers.test.mjs tests/local-product-fixture.test.mjs` **53/53**, `node tests/local-product-browser.mjs --confirm-synthetic-local` 최종 통과, 변경 JS4파일의 `node --check`와 추적 파일의 `git diff --check`도 통과했다. 브라우저는 격리 Chrome·실제 loopback HTTP·메모리 전용 PGlite를 사용했다. 이번 일정 보완에는 E 자료·Docker·방화벽·인증서 변경이 없다.

최종 시작/종료/감사 시점285파일의 소스 지문은 `81f574cd04e9f62de295540015b8b888c078d2f4a6dc69c0d9d7688f50530d6e`로 같고 오류·예상 밖 요청0이다. 결과 SHA-256은 `f4d6ede925db2597684e1827645f473855674391bc5a538e93240d993c82f74d`다. 결과·캡처·`completion-audit.json`은 `test-results/local-product-bd9d7c40-8c27-4079-b5c9-bbec3a283f49/`에 있다.

브라우저/문맥/시험 DB 종료가 모두 확인됐다. 생성시각을 포함한 부모 프로세스 연결로 식별한 관측 프로세스10개와 포트64601·58412·64161·54843은 종료 후 없었다. 단순 부모 PID 조회에는 재사용된 PID의 오래된 Windows 프로세스가 섞여 있어 `live-ownership-validated.json`에서 제외했다. 다른 프로세스에 종료·정리 작업을 수행하지 않았다. 첫 실행도 소유 자원 종료를 확인했다.

아래 첨부·복원 근거는 **이 일정 보완 전 실행 시점**의 기록이다. 그 뒤 제품3파일과 브라우저 검사1파일 등이 바뀌었으므로 모든 이전 manifest가 현재 파일과 같거나 첨부·복원을 다시 실행했다고 주장하지 않는다. 일정 변경은 위 관련 회귀로 검증했다. 사람 평가의 시간·이동 수·요약 이해도는 미수집이며, 기존 비교 도구의 `src/` 화면과 최신 `local-api/` 자동 결과를 동일한 사람 비교 실험으로 합산하지 않는다.

## 기록의 선택 첨부 공유

`6fba2fa5-d258-4023-a680-326e26963b44`는 새 E 세션에서 **11/11 통과·exit0**다. 기록의 사진·영상 기본 비공개, 실제 검사 처리, 저장 응답 유실 뒤 동일 요청 재시도, 영상만 명시 선택한 미리보기·수신자 확인·공유, 보호자 수신·재생, 새로고침 후 선택 보존을 검증했다. 내부 수행·반응·계획·메모와 비공개 사진은 보호자 응답에 없고 파일 URL도 거절됐다. 미리보기의 재생은 저장·공유 요청을 발생시키지 않았다.

실제 콘텐츠 5건은 정확한 기록·버전·파일·메시지에 연결된다. PNG 91바이트 2건, MP4 2,439바이트 3건의 각 해시가 일치했다. 영상은 재생 시작·프레임 디코딩을 확인한 것이며 전체 재생 길이나 실물 기기 성능 시험은 아니다. 캡처 `320-private-record-selection.png`, `390-publication-reload.png`를 직접 확인했다.

실행 시작/종료의 319파일 manifest는 `2a32daf5c7b3baf4482bd62f442f861e4ef337d6f7e3875f3c5655ff3ef2d0b4`로 같다. 독립 감사 당시 현재 파일 차이도 0이었다. 이후 일반 답장 시험기에 긴 이력 검사를 연결했으므로, 이 실행의 전체 검사 코드가 이후 작업과 모두 동일하다고 표현하지 않는다. 제품 파일은 변경하지 않았다.

세션은 stopped·failed=false, API/worker 정상 종료·stdio/close 확인, 임시 키/잠금 제거가 완료됐다. 관측 PID 9200·10652·7316·24588·16264와 해당 PID listener는 OS에서도 없었다. 실행 중 포트 번호 기록이 없어 이전 특정 포트를 독립 재조회한 증거는 없다. storage `b9ab639a-7f72-4ca7-9a46-6adc0eb883da`의 합성 DB·매체 4파일은 보존하고 TLS·credential·postmaster.pid·공통 잠금은 제거됐다. 정확한 AV/decoder/encoder label 자원의 컨테이너·이미지·볼륨은 모두 0이었다.

## 현재 PC 화면의 A/B/C 과제 경로

첫 실행 `62739230-b6a5-4f52-83cb-2df2fcd403c0`는 390px A를 통과한 뒤 B의 키보드 초점 검사에서 멈췄다. 과거 검사 순서 draft→saved가 현재 화면의 draft→discard→saved→prepare-share와 맞지 않았다. 최초 결과에는 당시 활성 요소가 기록되지 않았으므로 특정 버튼에 초점이 있었다고 추정하지 않는다.

제품 화면은 그대로 두고 테스트 2파일만 보완했다.

- `tests/local-record-action-browser-helpers.mjs`: 현재 보조/주 행동의 배치대로 네 버튼의 정방향·역방향 Tab 접근을 모두 검증한다. 버튼 가시성·가림·폼 소유·크기, 날짜/요약 검증, 저장 중 비활성 기준은 유지한다. 실패 시 고정 단계명과 기하 정보만 보존한다.
- `tests/local-p0-study-browser.mjs`: 위 실패 단계/기하 정보를 안전한 결과에 연결한다. 입력 내용·계정·비밀번호는 추가하지 않는다.

보완 후 `3c186b18-df5f-41df-8b6b-1b1572b20d47`은 **6/6 통과·exit0**다. 390/1440px에서 A 활동 답변·B 기록 작성의 UI 저장→API 조회→새로고침·재열기 및 보호자 비공개 경계를 확인했다. C는 공유 요약의 열람·재조회이며 작성이나 사람 이해도 검사가 아니다.

390·320×640·844×390·1440px에서 draft→discard→saved→prepare-share→saved→discard→draft→마지막 입력의 초점을 관측했다. 버튼은 높이 43.5px 이상이며 가시성·가림 없음·폼 소유와 가로 넘침 없음이 확인됐다. 낮은 높이에서는 스크롤 후 접근을 확인하며 모든 버튼이 항상 고정된다는 뜻은 아니다. 대표 320/844×390/1440 캡처도 직접 검수했다.

548파일 source/finalSource/current는 모두 `1a78479371102f5d416c1e8911c018008e951fb1ae8fc1e3846bdb45a0623cf5`로 일치했다. 오류·예상 밖 요청·종료 관측 timeout은 0이다. PID 18440·26392 및 포트 56887·49669·54684·51881·57709·64643은 종료 후 없었다. 실패 실행도 소유 브라우저·메모리 DB·서버 정리를 완료했다.

## 일반 답장 첨부와 긴 이력

`1e48402a-d3ca-494c-87f3-3fc64a509ddb`는 **exit0·기존 파일 2종/답장 7조건/긴 이력 5조건 통과**다. 공유 카드·일반 메시지에 파일로 답하기, 미전송 파일의 대화방 격리, 실제 저장 뒤 응답 유실·동일 요청 재시도, 공유 철회 후 독립 답장·첨부 보존을 확인했다.

신규 `tests/native-history-media-browser-helper.mjs`와 해당 단위 검사는 기존 실제 PNG/MP4를 이용해 이력용 메시지 105개와 화면 폭별 지연 전송 3건을 UI로 전송한다. 최신 100개 경계의 첨부 고정, 과거 창의 새 다운로드·디코딩, 실제 201 응답 지연 후 첨부 화면·읽던 창·초점 보존을 검사했다. 기존 `native-prepared-media-browser-helper.mjs`의 답장/철회 검증 뒤에 연결하며 원래 검사 기준을 유지했다.

최신 100개 창에서 사진을 보는 동안 새 메시지가 도착해도 기존 창과 사진이 유지됐다. 명시적 최신 이동 뒤 새 메시지 행이 대화 목록에 나타났다. 320/390/1440px 각각에서 이전 소식의 사진·영상을 새로 다운로드해 정확한 파일 해시와 디코딩·재생을 확인했다. 과거 창에서 실제 전송을 commit하고 201 응답을 보류한 사이 첨부를 연 뒤, 응답 전달·다음 실제 조회·뷰어 닫기 후에도 이전 창·초점이 유지됐다. 최신 이동 후 정확한 새 메시지가 한 번 조회됐다.

긴 이력의 새 콘텐츠 관측 10건, 관측 지점의 DOM 최대 100행, 3개 지연 응답 모두 제한 만료 없이 전달됐다. 모든 프레임의 DOM 상한이나 전체 영상 재생을 검증한 것은 아니다. 대표 `320-history-viewer-after-delayed-send.png`, `1440-history-latest-boundary-pinned.png`를 직접 확인했다. 작은 회색 이미지는 합성 PNG이며 HTML처럼 생긴 파일명은 이스케이프 시험 문자열이다.

321파일 source/sourceAfter/current는 `58252e613a3adf9b1003e39e8f6a86878a2f169cae254b54ae35ec5b17e06533`로 일치했고 오류·예상 밖 요청은 0이다. 전체 콘텐츠 관측 12건(PNG 8·MP4 4)에 위 긴 이력 10건이 포함되므로 합산하지 않는다.

소유 Chrome/컨텍스트와 세션 종료를 확인했고 독립 감사에서 관측한 원 소유 프로세스 44개·포트 63905/54370/54353/49677 listener는 모두 없었다. PID 숫자 2개는 다른 이름·생성시각의 새 프로세스로 재사용돼 잔존으로 오판하지 않았다. 이번 정확한 AV/decoder/encoder label 자원·TLS·credential·postmaster.pid·공통 잠금은 없고 합성 DB·매체 4파일은 보존됐다. API/worker exit0·실제 종료·stdio 종료와 timeout 없음도 확인했다.

응답 지연은 실제 서버 commit 후 원 응답을 그대로 전달한다. 준비 대기는 최대 15초, 응답 보류는 최대 7초이며 만료 시 실패한다. finally에서 응답을 해제하고 라우트를 제거한다. 앱 상태·DB·권한·검사 결과를 주입하지 않는다. 새 helper는 시작 이후 실제 요청만 관측하고 파일 ID·MIME·크기·SHA-256을 다시 대조한다. 독립 코드 리뷰를 거쳤다.

## 보존·복원

기존 형식 기록/복수 평가/공유/피드백 이력 회귀 **40/40**, 복원·격리·권한 사전 회귀 **125/125**가 통과했다. 이 단위 검사를 실제 백업·복원 성공으로 계산하지 않는다.

새 native 복원 `4e866a09-9cff-4e90-8be7-317bbaaefebf`는 **78개 시나리오 통과·exit0**, 비공개 검토·공유 대상 보존의 reviewChecks/recipientChecks 각각 6개 true다. 현재 001–023 migration을 포함하며, 실행 전후 503파일의 소스 manifest는 `45ba973b3aa5d64a0b631a850ea5dc1dc5aafc0a3f9bca2fa199cf935671d2c7`로 일치한다. 이는 코드 지문의 불변성이고 시험 원본 데이터가 전혀 수정되지 않았다는 뜻은 아니다.

- 실제 ClamAV·FFmpeg로 처리한 합성 PNG/MP4의 원본·처리본을 원장 ID·크기·해시에 연결해 백업/복원했다. 파일 10개와 삭제 표식 17개, 총 27개를 검사했다. 앞선 브라우저 세션의 동일 DB를 복원한 시험은 아니다.
- 같은 cluster의 복원본은 격리하고 계정·세션·초대·재설정 상태와 쓰기 거절을 확인했다. 같은 역할이 원본/복원 DB를 함께 소유한 상태의 서비스 진입도 거절됐다. 비공개 검토·과거 영수증·공유 대상 연결은 보존했다.
- 변조·누락 파일, 삭제 표식·알 수 없는 파일, 약화된 제약과 백업 이후의 원본 변경을 탐지했다. 실제 다른 연결의 동시 쓰기가 잠금으로 차단되는지도 확인했다.
- 별도 PostgreSQL cluster에 전체 DB·파일을 복원하고 역할별 객체/열/함수/기본 권한 및 독립 재시작 후 보존을 확인했다. DB 연결 권한은 독립 비밀번호로 명시 재적용하며 서비스 자동 전환은 하지 않았다.

결과의 sourceStopped/restoredStopped/tlsFixtureCleanup/credentialService.cleanup, 두 작업자 계통의 allChildrenTerminal 및 native fixtureCleanup이 모두 true다. 합성 DB·매체·dump/bundle은 오프라인 진단 자료로 보존하며 bundle key는 폐기한다. 의도적인 IPC 단절 역검증의 작업자 2개는 예상대로 exit1이며 검사기가 이를 명시 검증한다. 모든 자식 프로세스가 exit0였다는 의미가 아니다.

독립 감사에서 source/state/restored 매체 폴더가 각각 27파일·6,475바이트이고 파일명·크기·전체 SHA-256이 완전히 같았다. PNG/MP4의 원본·처리본 네 파일도 각 폴더에서 결과 원장의 해시/크기와 일치했다. 503파일 현재 소스 재대조 차이와 결과의 비밀 키 필드·개인키 표식은 0이다. DB를 다시 가동해 원본 내용을 재조회한 감사는 아니다.

실행 중 두 번 관측한 고유 프로세스 29개(PID+생성시각)와 포트 56085/56108/64618의 listener는 종료 후 없었다. 해당 실행의 TLS·DPAPI·source/restored postmaster.pid·공통 잠금과 정확한 AV/decoder/encoder label별 컨테이너·이미지·볼륨도 없었다. 기존 E 자료와 과거 실패 세션은 정리 대상으로 삼지 않았다.

같은 E 드라이브 복원은 별도 매체 백업·디스크 고장·정전 복구가 아니다. 파일 쓰기 프로세스 전체 정지는 검증되지 않았고 `filesystemWriterQuiescenceVerified=false`, `serviceReleaseAllowed=false`를 유지한다. 격리한 복원본과 별도 cluster의 권한 보존 시험은 서로 다른 대상이다.

과거 실패 `47669740-1bb9-4b27-9887-263d767c78d1`의 TLS 폴더를 읽기 전용으로 확인했다. receipt와 일치하는 5파일(인증서 2·개인키 2·receipt 1)이 2026-10-24에도 남아 있다. 당시 자동 승인 검토에서 정리가 차단된 이력이 있으며 이번 실행의 소유 자원이 아니므로 삭제하지 않았다. 원문 키는 읽지 않았고 해당 source/restored postmaster.pid·연결 프로세스는 없었다. 새 실행의 정리 성공으로 이 과거 미정리 항목을 덮어쓰지 않는다.

## 검증 명령과 증거

이번 변경은 다음 검사 코드 5파일과 문서 3파일이다. 제품 UI/API·SQL·인증·저장 정책을 변경하지 않았다.

| 변경 파일 | 목적 |
| --- | --- |
| `tests/local-record-action-browser-helpers.mjs` | 네 버튼의 현재 키보드 순서와 실패 기하 관측 |
| `tests/local-p0-study-browser.mjs` | 키보드 검사의 안전한 실패 단계/기하 기록 |
| `tests/native-history-media-browser-helper.mjs` | 실제 첨부와 긴 대화·지연 전송의 결합 검증 추가 |
| `tests/native-history-media-browser-helper.test.mjs` | 잘못된 메시지·커서·파일 증거 거부 회귀 추가 |
| `tests/native-prepared-media-browser-helper.mjs` | 기존 답장 검사 뒤 새 경로 연결·소스 지문 포함 |
| `docs/communication-acceptance.md` | 최신 PC 완료 근거와 남은 항목 갱신 |
| `docs/recovery-native-verification.md` | 최신 복원 근거 연결·과거 미정리 항목 구분 |
| `docs/pc-verification-20261024.md` | 이번 변경·실패·검증·정리·한계 통합 기록 |

번들 Node/Playwright와 설치된 Chrome을 사용한다. Docker는 중단 상태를 확인해 정상 시작했으며 이후 재시작·초기화·재설치를 하지 않았다. E Healthy와 약 228GB 여유, 고정 PostgreSQL runtime·FFmpeg 공개 입력의 SHA-256·로컬 Docker builder를 확인했다. 환경변수는 시험 실행기 경로에 한정했다.

```text
node --test tests/native-record-attachments-browser-helper.test.mjs tests/native-prepared-media-browser-helper.test.mjs tests/native-upload-status-observation.test.mjs tests/local-reply-attachments.test.mjs tests/local-workspace-browser-helpers.test.mjs
node --test tests/local-record-layout.test.mjs tests/local-p0-study-preflight.test.mjs tests/local-p0-study-cli.test.mjs
node --test tests/native-history-media-browser-helper.test.mjs tests/native-prepared-media-browser-helper.test.mjs tests/local-history-window.test.mjs tests/local-reply-attachments.test.mjs
node tests/local-p0-study-browser.mjs --confirm-synthetic-local
node tests/windows-synthetic-session-check.mjs --record-attachments --base E:/CarebridgeBeta --powershell <bundled-pwsh> --confirm-synthetic-e-drive
node tests/windows-synthetic-session-check.mjs --reply-attachments --base E:/CarebridgeBeta --powershell <bundled-pwsh> --confirm-synthetic-e-drive
node server/windows-postgres-check.mjs --verify-native-recovery --base E:/CarebridgeBeta --powershell <bundled-pwsh> --confirm-synthetic-e-drive
node scripts/check.mjs
git diff --check
```

각 관련 단위는 75/75·52/52·50/50, 구문 검사는 통과했다. 서로 중복되는 단위를 단일 총계로 합산하지 않는다. `git diff --check`는 추적된 변경만 대상으로 하므로 신규 파일까지 모두 검증했다는 뜻은 아니다.

| `test-results/` 결과 | SHA-256 |
| --- | --- |
| `synthetic-e-session-6fba2fa5-d258-4023-a680-326e26963b44.json` | `b4ba02c46fb09c5c4c14f073a4fd5702e7fe26b21ffb001c50a7d05e091466e0` |
| `native-record-attachments-6fba2fa5-d258-4023-a680-326e26963b44/results.json` | `0048a628509bf4f3e0a2e4615dbaa7b6263efeb4a519b048ee54bfc380bbe624` |
| `local-p0-study-3c186b18-df5f-41df-8b6b-1b1572b20d47/results.json` | `d7d216bb0928fab0ed17c3f42997c26b96447cb81d3e8032d607014e025bbfff` |
| `synthetic-e-session-1e48402a-d3ca-494c-87f3-3fc64a509ddb.json` | `44519f580717a81199b991a2b24cade10dc573aebd208cdcfd63e96cd6bc6b7d` |
| `native-prepared-1e48402a-d3ca-494c-87f3-3fc64a509ddb/results.json` | `93fa9422140305e146921d0b2df77dd56605ac7fe9a7f38e7eafdf36ccc73494` |
| `native-recovery-4e866a09-9cff-4e90-8be7-317bbaaefebf-results.json` | `6dd4d2c9aac5fa131af47aace6ac8922d9259f4f7423a53bfe69e1d319953b42` |
| `preservation-audit-tap-92302839-1f6b-4449-87cb-80ef0dcd508a.tap` | `d35a459ac88cc940156f7f6429e9e0b5764d2dfdf2bc0c43b106b8d74355eec5` |
| `recovery-preflight-audit-389cfd7e-552b-446a-9f48-bfb623b48655.tap` | `7b51f5bd57a51ef12f4485ccb45004d21ef51887c54b8edbe9705c70f3a7f949` |

## 별도 남는 범위

실물 iPhone의 최신 재접속·키보드·파일 선택·VoiceOver, 실제 사람의 시간·이동 수·요약 이해도는 미실행이다. AI 검사 시간으로 대체하지 않는다. 독립 백업 매체·운영 복구 책임·실제 자료 운영·원본 통합·배포도 이번 PC 검사 성공만으로 승인되지 않는다. P2 알림·검색은 사용성에서 필요성이 확인된 뒤 추가하는 조건부 범위다.
