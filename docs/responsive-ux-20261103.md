# Carebridge 모바일·PC UI/UX 고도화 — 2026-11-03

## 결과와 적용 범위

현재 `local-api` 화면을 대상으로 소식 확인 → 대화 → 기록으로 이동하는 흐름을 정리했다. 모바일에서는 하단 메뉴와 한 열의 콘텐츠, PC에서는 상단 메뉴와 넓은 두 열의 홈을 사용한다. 기존 모바일 대화의 화면 높이 제한과 PC 읽기 영역 개선 위에 적용한 후속 작업이다. 공개 프로토타입 `src`나 운영 배포를 수정한 작업은 아니다.

평가자가 이전 PC 대화를 ‘편함’으로 평가한 사실과 모바일 입력창 밀림 피드백은 기존 문서에 보존했다. 이번 변경 후 사람의 만족도·작성 시간·이해도를 새로 측정한 것은 아니다.

## 화면 변경

| 영역 | 변경과 목적 |
| --- | --- |
| 공통 헤더 | 계정 설정·새로고침·로그아웃을 ‘내 계정’ 메뉴로 묶어 본문 앞의 반복 조작 영역을 줄였다. 펼침, Tab 이동, Escape 닫기와 초점 복귀를 지원한다. |
| 주요 메뉴 | 홈·대화·기록·아이 정보에 장식용 SVG 아이콘과 실제 텍스트를 함께 표시한다. 모바일에서는 고정 하단 메뉴, PC에서는 스크롤 중 유지되는 상단 메뉴를 사용한다. |
| 홈 | PC는 아이 소식을 왼쪽, 일정과 가정 활동/업무를 오른쪽에 배치한다. 모바일은 소식부터 순서대로 한 열로 보여 준다. ‘소식 보내기’ 경로를 유지하고 중복 안내를 줄였다. |
| 소식 목록 | 아이 이름의 첫 글자 표시와 이름·시간·미리보기의 구획으로 대화 대상을 빠르게 구분한다. 기존 정렬, 안 읽은 소식, 이동 대상과 읽음 처리는 유지한다. |
| 대화 | 받은 말풍선과 보낸 말풍선의 색·테두리·줄 간격을 정돈했다. 모바일 내부 스크롤과 입력창 접근, PC의 넓은 읽기 영역을 유지한다. |
| 치료 기록 | 기록 작성 버튼을 상단에 모으고 작성 중/저장된 기록을 구분한다. 데이터 조회 후에만 빈 상태와 다음 행동을 안내한다. 측정값 비교의 긴 설명은 ‘비교 기준과 안내’에서 펼친다. |
| 시각 체계 | 색·테두리·배경·모서리의 공통 CSS 변수를 도입하고 제목, 여백, 선택 상태를 통일했다. |

## 변경 파일과 유지한 동작

- `local-api/app.js`: 계정 메뉴 및 공통 메뉴 연결.
- `local-api/workspace-ui.js`: 메뉴 아이콘·마크업, 계정 메뉴 닫기/초점 처리, 소식 목록과 홈 배치.
- `local-api/styles.css`: 반응형 배치, 메뉴·말풍선·기록·계정 팝업 스타일.
- `local-api/care-ui.js`: 기록의 시각적 그룹과 빈 상태, 비교 안내의 접기/펼치기.
- `tests/local-care-ui.test.mjs`: 기록 그룹, 빈 상태, 같은 화면에서만 안내 열림 상태를 유지하는 검사.
- `tests/local-responsive-shell-browser-helpers.mjs`, `tests/local-product-browser.mjs`: 모바일/태블릿 경계와 PC에서 메뉴, 홈, 계정 메뉴를 실제 Chrome으로 검사.
- `tests/local-workspace-browser-helpers.mjs` 및 기존 브라우저 실행기 19개: 계정 버튼이 메뉴 안으로 이동한 동작에 맞춰 공유 조작 함수를 사용한다. 실제 클릭과 접근성 검사를 유지하며 숨은 버튼을 강제 실행하지 않는다. 대상 목록 (로컬 검증 산출물: `test-results/responsive-ux-20261103/account-test-migration.json`).
- `tests/local-self-profile-browser.mjs`: 메뉴 개수 검사에서 화면 루트의 `data-view`를 제외하고 실제 메뉴 버튼만 선택한다.

백엔드 API, 인증·권한, 저장·공유 정책, 데이터 모델은 변경하지 않았다. 비교 안내의 열림 상태는 동일 화면을 갱신할 때만 보존한다. 방·권한 변경이나 화면 해제 후 과거 상태를 복원하지 않는다. 기존 작업 트리의 다른 변경은 보존했고 Git 커밋·푸시·배포는 수행하지 않았다.

## 실행한 검증

모든 브라우저 검사는 별도 Chrome 프로세스와 합성 메모리 DB로 수행했다. 실제 사용자 자료, E 드라이브 DB, 방화벽, 인증서 저장소, 사용자 Chrome 프로필은 사용하지 않았다.

| 검사 | 최종 결과와 근거 |
| --- | --- |
| 관련 단위 검사 | **236/236 통과**, 실패·건너뜀 0. 로그 (로컬 검증 산출물: `test-results/responsive-ux-20261103/unit-final.txt`) |
| 제품 화면·동작 | **320/390/1440px 3폭 통과**, 각 22개 기본 동작 경계와 추가 PC·모바일 대화 검사. 보호자/치료사 각각 320/700/701/768/1024px에서 홈·기록·아이 정보, 메뉴 위치, 44px 이상 주요 메뉴/계정 버튼, 가로 넘침, 키보드 계정 메뉴를 추가 검사. a401fee2 결과 (로컬 검증 산출물: `test-results/local-product-a401fee2-065f-4cab-971f-e1b5bd8546cb/results.json`) |
| 가정 활동·치료 기록·공유 요약 | **390/1440px × A/B/C 6조합 통과**. 실제 UI 저장·재조회·공유 흐름의 자동 검사이며 사람의 수행 점수가 아니다. aa3d3f8d 결과 (로컬 검증 산출물: `test-results/local-p0-study-aa3d3f8d-8a32-4324-8177-6a93c5ea79ad/results.json`) |
| 지연·재조회·복구 | **7시나리오 통과**. 실제 1.2초 지연을 둔 홈·대화·기록 관측에서 정보/입력 누락 0프레임, 선택·초점·초안 유지. 타임아웃/오프라인 시에는 기존 권한 확인 정책에 따라 숨기고 재확인 후 복원한다. 7de4f787 결과 (로컬 검증 산출물: `test-results/local-slow-refresh-7de4f787-1d2d-48cf-add7-e45baccbb3a6/results.json`) |
| 계정 설정 | **390/768/1440px × 26경계 통과**. 메뉴 진입, 설정 저장, 이름 전파, 충돌 처리, 화면 복귀 초점과 권한 분리 포함. 760bda50 결과 (로컬 검증 산출물: `test-results/local-self-profile-760bda50-eab5-4cf6-8fe5-fd820f397d1a/results.json`) |
| 긴 대화 이력 | **320/390/1440px 통과**. 합성 메시지 2,107개에서 화면 메시지 최대 100개, 읽기 위치·이동·입력 접근 확인. 0fa8c245 결과 (로컬 검증 산출물: `test-results/local-history-window-0fa8c245-a74f-495b-a4bc-b0ea0dabd4b4/results.json`) |

관련 단위 명령:

```powershell
node --test tests/local-chat-layout.test.mjs tests/local-product-ui.test.mjs tests/local-home-news-layout.test.mjs tests/local-care-ui.test.mjs tests/local-record-comparison-ui.test.mjs tests/local-history-window.test.mjs tests/local-news-stability.test.mjs tests/local-workspace-browser-helpers.test.mjs
```

브라우저 명령(설치된 Playwright 모듈을 `PLAYWRIGHT_MODULE`, Chrome 실행 파일을 `STUDY_CHROMIUM_EXECUTABLE` 환경변수로 지정한 후):

```powershell
node tests/local-product-browser.mjs --confirm-synthetic-local
node tests/local-p0-study-browser.mjs --confirm-synthetic-local
node tests/local-slow-refresh-browser.mjs --confirm-synthetic-local
node tests/local-self-profile-browser.mjs --confirm-synthetic-local
node tests/local-history-window-browser.mjs --confirm-synthetic-local
```

계정 버튼을 이관한 브라우저 실행기들은 구문 검사를 통과했다. 실행기 19개 모두를 통합 실행했다는 의미는 아니며 실제 실행 범위는 위의 5종이다. 공개 `src`의 빌드는 현재 `local-api` 검증 근거로 사용하지 않았다.

최종 5회 실행에서 오류·예상 밖 요청 0, 시작/종료/현재 소스 일치, 실제 당일 사전 준비 판정 `true`를 확인했다. 소스 감사 (로컬 검증 산출물: `test-results/responsive-ux-20261103/final.json`)와 종료 확인 (로컬 검증 산출물: `test-results/responsive-ux-20261103/cleanup.json`)에 남겼다. 검사 소유 프로세스 10개와 결과에 기록된 포트 13개가 모두 종료됐다. 계정 검사에서는 별도 포트를 기록하지 않아 그 포트의 독립 조회를 주장하지 않으며, 해당 검사 자체의 서버/DB 정리 및 소유 프로세스 종료를 확인했다.

## 중간 실패와 수정

첫 제품 검사에서 닫힌 native `details`의 자식이 기하 정보로 측정되는 문제가 발견됐다. 닫힌 계정 패널을 명시적으로 `display:none` 처리한 뒤 최종 검사에서 숨김·키보드 접근을 다시 확인했다. 첫 계정 검사에서는 기존 메뉴 개수 선택자가 `#app[data-view]`까지 집계했다. 이를 실제 `button[data-view]`/`button[data-ops-view]`로 한정하고 기존 4개/3개 기대값은 유지했다. 중간 실패 실행 `1db33a5b…`, `a0338b2d…`는 삭제하거나 성공으로 덮어쓰지 않았다.

## 화면 확인과 남은 작업

- PC 홈 (로컬 검증 산출물: `test-results/local-product-a401fee2-065f-4cab-971f-e1b5bd8546cb/1440-guardian-home.png`)
- 모바일 홈 (로컬 검증 산출물: `test-results/local-product-a401fee2-065f-4cab-971f-e1b5bd8546cb/390-guardian-home.png`)
- 모바일 치료 기록 (로컬 검증 산출물: `test-results/local-product-a401fee2-065f-4cab-971f-e1b5bd8546cb/390-therapist-records.png`)
- 태블릿 경계의 홈 (로컬 검증 산출물: `test-results/local-product-a401fee2-065f-4cab-971f-e1b5bd8546cb/1440-guardian-shell-701x900-home.png`)
- 높이가 작은 모바일 대화 (로컬 검증 산출물: `test-results/local-product-a401fee2-065f-4cab-971f-e1b5bd8546cb/1440-guardian-mobile-chat-390x420-entry.png`)

위 캡처는 합성 자료의 자동 검사 화면이다. 다음 우선순위는 새 화면을 사용자가 직접 보고 홈에서 대화로 이동하는 편의, 치료 기록의 구분, 모바일 입력창 접근을 확인하는 것이다. 이어 같은 조건의 사람 평가와 아이폰 Safari의 실제 키보드·재접속을 검증한다. Chrome 화면 크기 변경은 실물 아이폰 검증을 대체하지 않는다. 실제 사진·영상의 변환/업로드 전체 통합 검사, 실자료 운영 준비와 공개 배포는 이번 범위 밖이다. 원 개편안 전체가 완료됐다고 표시하지 않는다.
