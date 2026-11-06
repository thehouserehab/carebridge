# Carebridge PC 모바일 검수 및 GitHub 소스 게시 — 2026-11-06

## 요청과 게시 범위

사용자 요청에 따라 실제 아이폰 대신 PC Chrome 안에서 모바일 화면을 검수하고, 최신 UI와 실행에 필요한 소스를 `thehouserehab/carebridge`의 `main`에 게시한다. 실제 아이폰 시험은 이번 게시 조건에서 제외했다. PC 검수 결과를 실물 기기 검증이나 사람의 사용성 평가 결과로 해석하지 않는다.

원격 기준 커밋은 `9eb252df4167276f2924ef2464af915e2b8a1c16`이다. 기존 개발 폴더의 미커밋 작업을 보존하고 원격 `main`에서 만든 별도 게시용 사본에 최신 `local-api`, 서버, 실행 스크립트, 테스트와 문서를 구성했다. 기존 이력 위에 커밋하며 강제 푸시나 기존 기록 삭제를 사용하지 않는다.

## 화면 검수

설치된 Chrome `156.0.8078.80`을 PC에서 실행해 합성 계정·메모리 DB·루프백 HTTP로 검사했다. 실행 ID는 `d4cb237e-7609-4bca-9c30-71e9e05a9c5c`다.

- 기본 화면과 동작: 320/390/1440px, 3폭 통과.
- 추가 화면 구조: 보호자·치료사 각각 320/700/701/768/1024px에서 홈·기록·아이 정보, 단일 주요 메뉴와 선택 상태, 계정 메뉴 키보드 이동 확인.
- 대화: PC의 넓은 읽기 영역과 모바일 320×568, 390×844, 높이가 작은 390×420 화면에서 메시지 내부 스크롤·입력·전송 접근 확인.
- 홈 소식의 올바른 방/메시지 이동, 읽음 분리, 일정에서 기록 진입, 방별 미전송 초안, 지연 응답과 권한 변경 시 표시 규칙을 확인.
- 브라우저 오류·예상 밖 요청 0, 검사 시작/종료 소스 지문 일치. 소유한 브라우저·시험 서버·메모리 DB가 정상 종료됐고 해당 프로세스 2개·포트 3개의 부재를 확인.

제품 검사에 포함된 288개 소스 파일의 지문은 `52bf2b94aeecebded88702b5746a63e5de5a5d01dec45771edb948bf7625319d`이며 게시 사본과의 일치를 별도로 검사한다. 전체 저장소 커밋 지문과는 다르다.

합성 화면을 직접 열어 가독성과 배치도 검토했다.

| 화면 | 캡처 |
| --- | --- |
| PC 홈 | [보기](screenshots/20261106/desktop-home.png) |
| 모바일 홈 | [보기](screenshots/20261106/mobile-home.png) |
| 모바일 대화 | [보기](screenshots/20261106/mobile-chat.png) |
| 모바일 치료 기록 | [보기](screenshots/20261106/mobile-records.png) |
| 높이가 작은 모바일 대화 | [보기](screenshots/20261106/mobile-short-chat.png) |

## 게시 준비 중 수정

깨끗한 루트 설치로 Vercel과 같은 정적 빌드 명령을 실행했을 때, 루트 `npm test`에 서버 DB를 실제 생성하는 테스트 2개가 섞여 PGlite 의존성 누락으로 실패했다. 실패를 숨기거나 필수 검사를 조건부 성공으로 바꾸지 않고 아래처럼 명령을 분리했다.

- `tests/frontend-multiroom-fixture.test.mjs` → `tests/frontend-multiroom-fixture.integration.mjs`
- `tests/local-p0-study-fixture.test.mjs` → `tests/local-p0-study-fixture.integration.mjs`
- `npm run test:fixtures:local`: 서버 개발 의존성 설치 후 두 통합검사를 실제 실행. 기존 검증 내용은 유지하고 파일 이름·실행 안내만 변경했다.

README는 최신 UI와 기존 정적 데모를 구분한 실행 안내로 정리했다. `.gitignore`와 `.vercelignore`에는 개인키·인증서·DB/백업 확장자를 추가했다. 공개 사본의 문서에서는 개인 사용자 경로를 일반화하고, 업로드하지 않는 전체 검사 산출물 링크는 로컬 산출물 표기로 변경했다. 원본 상세 결과와 초기 실패 로그는 로컬에 보존한다.

## 검증 명령

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run check
npm test
npm run build
npm --prefix server ci --ignore-scripts --no-audit --no-fund
npm run test:fixtures:local
npm test
npm run test:server
```

화면 검사에는 설치된 Playwright·Chrome의 경로를 환경변수로 지정하고 `npm run test:local-product:browser`를 실행했다. 사용자 Chrome 프로필을 사용하지 않았다. 최종 명령별 결과는 [검증 요약 JSON](github-release-20261106-verification.json)에 기록했다.

| 검사 | 결과 |
| --- | --- |
| 서버 의존성 없는 루트 설치·구문 검사·정적 빌드 | 모두 종료 0 |
| 루트 테스트 | 1,888 통과, 실패 0, 조건부 제외 76 |
| 분리한 DB fixture 통합검사 | 8/8 통과, 제외 0 |
| 서버 의존성 설치 후 루트 테스트 | 1,888 통과, 실패 0, 조건부 제외 76 |
| 서버 전체 검사 | 1,838 통과, 실패 0, 조건부 제외 44 |

조건부 제외는 별도 PowerShell/네이티브 환경 지정 등이 필요한 검사이며 성공으로 집계하지 않았다. 정적 출력은 36파일로 서버·최신 API 앱·문서·시험 자료·비밀 파일이 포함되지 않았다. 초기 실패와 수정 후 성공 로그를 모두 로컬에 보존했다.

## 배포와 남은 범위

`npm run build`는 기존 정적 `src`만 `dist`에 포함한다. 최신 `local-api` UI와 서버 소스를 GitHub에 게시하더라도 Vercel에서 최신 API 앱이 바로 실행되는 것은 아니다. 운영 API를 공개하거나 정적 역할 전환 화면을 실제 인증으로 바꾸는 작업은 포함하지 않았다.

전체 검사 로그, 실제 DB·업로드 파일·계정 자격증명·인증키·개인 로컬 자료는 게시하지 않는다. 화면 캡처 5장은 모두 합성 자료다. 실제 아이폰 키보드/재접속, 사람의 작성 시간·이동 수·요약 이해도, 실제 자료 운영은 이 게시 결과로 완료 처리하지 않는다.
