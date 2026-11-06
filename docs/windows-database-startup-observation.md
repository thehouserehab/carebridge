# 가상 E API의 DB 준비·종료 관측 보완

2026-10-09. 원 소통 중심 개편안의 서버 메시지·파일 저장과 재접속 검증을 위한 후속이다. 가상 계정·가상 자료·같은 PC 루프백 범위를 유지한다. 실제 아동 자료, 외부 접속, 공개 배포, 자동 시작은 열지 않는다.

## 기준 실패와 조사 목적

기존 확장 실행 `2b92e616-abf8-4fef-a0a1-dab58ed1f7ce`는 phase 609에서 네 번째 작업자의 `db-open failed`로 실패했다. 앞 세 작업자는 DB 열기·닫기에 성공했고 신규 직접 사용 세션도 성공했으므로, 공통 PG 설정이 일괄 잘못되었다고 단정할 수 없다. 반대로 성공 실행만으로 간헐 실패를 해결했다고 볼 수도 없다.

기존 `started`는 bootstrap IPC 전송 완료만 기다려, 작업자 준비 실패 뒤에도 브라우저 사진 시험이 180초 대기했다. API 종료는 exit 0·파이프 닫힘이 관측됐지만 `closeObserved:false`와 관측 시간 초과가 남았다. DB 실패와 종료 관측은 별도 조사 경계이며, 이전 `0xC0000409` 종료와 같은 원인이라는 증거도 없다.

## 구현

| 경계 | 보완 | 바꾸지 않은 것 |
| --- | --- | --- |
| 자격증명·DB 준비 | 선택적 신뢰된 내부 관측으로 읽기 → 복호화 → 동일 파일 재검증, 실제 연결, 동일 연결 권한 검사, 트랜잭션을 구분 | DPAPI 목적·사용자 바인딩, TLS, SCRAM, 권한 재검증, 오류 은닉, 비밀 버퍼 제거 |
| 작업자 준비 | 실행별 UUID의 일회성 admission 신호와 기존 제어 준비 상태를 모두 확인한 뒤 시험 진행 | 큐·파일 검사 결과 및 실제 종료 증거를 readiness로 대체하지 않음 |
| API 종료 | 고정 이벤트 최초 관측 시각과 늦게 오는 child close를 기록 | 30초 관측 제한, 실패 결과, 실제 exit/close/파이프 조건, 정리 권한 |
| 결과 보관 | native 실행마다 UUID별 새 결과 파일을 독점 생성 | 기존 최신 결과 파일과 원 실패 로그 보존 |

DB 단계는 `credential-read`, `credential-unprotect`, `credential-recheck`, `connection`, `privilege-check`, `transaction`이다. 이벤트에는 동결된 `{stage, edge, elapsedMs}`만 있다. `begin`은 0ms, 종료 이벤트는 해당 단계 시작 후 소요 시간이다. 전체 실행 시각이나 서로 다른 단계의 절대 타임라인이 아니다.

연결 단계는 풀에서 실제 연결을 확보하는 전체 과정이며 자격증명 획득도 그 안에 포함된다. TCP/TLS/SCRAM을 각각 분리한 추적은 아니다. 트랜잭션 완료는 커밋 응답까지의 정상 반환이며, 실패만으로 롤백이나 미커밋을 단정하지 않는다.

콜백은 HTTP·IPC 설정에서 받지 않으며 서버의 신뢰된 구성 코드만 전달한다. 반환값·예외·거절된 Promise는 본 작업을 승인하거나 실패를 지우지 못하고, 진단을 기다리느라 작업을 중단하지 않는다. DB 관측 미지정 시 기존 권한 검사 경로를 그대로 사용한다. worker는 초기 DB 열기 구간만 전달하고 이후 반복 연결/업무에서는 진단을 내보내지 않는다.

native DB 프레임은 기존 NS1 미디어 단계와 다른 ND1 채널이다. 고정 단계 번호·상태·정수 시간만 보내며 128건 뒤 생략 표식을 한 번 보낸다. 최근 64건과 고정 단계별 횟수만 보관하고 stderr 전체 16KiB 제한을 유지한다. 비밀번호·암호문·SQL·경로·사용자 식별자·원문 오류는 포함하지 않는다.

준비 확인의 30초 제한은 관측 실패와 협조적 종료 요청만 발생시킨다. 기존 프로세스 수명을 계속 소유하며, 시간 초과를 실제 종료로 취급하거나 강제 종료·자동 재시작하지 않는다. 준비 완료 후 발생할 수 있는 실패는 이후 작업 결과·종료 검증에서 별도로 처리한다.

API 이벤트는 관측자 생성 이후 단조 경과 시간과 고정 이름만 기록한다. 이미 실패로 정산한 뒤 child close가 도착하면 관측만 갱신하고 리스너를 해제한다. 실패·시간 초과 플래그나 기존 Promise 결과를 성공으로 바꾸지 않는다. 늦은 close 리스너 자체는 프로세스를 유지하는 타이머가 아니다.

## 변경 파일

- `server/windows-database-observation.mjs`, `windows-database-service.mjs`, `windows-database-credential-store.mjs`, `windows-private-secret-io.mjs`, `database.mjs`: 실제 DB/비밀 로드 경계 관측.
- `server/windows-media-worker-process.mjs`, `windows-native-worker-test-policy.mjs`, `windows-native-worker-test-child.mjs`: 초기 DB 관측 연결과 고정 프로토콜.
- `server/native-worker-admission.mjs`, `windows-native-worker-check.mjs`: 실제 작업자 admission 대기.
- `server/windows-native-api-test-parent.mjs`: 종료 이벤트 관측과 늦은 close 보존.
- `server/windows-postgres-check.mjs`: 실행별 독립 결과 보존.
- 관련 `server/tests`: 콜백 오류/권한 유지, 실패 구분, 바이트·시간 제한, readiness/종료 경계 회귀.

## 검증

- 서버 전체 직렬 회귀: **1,205/1,205**, 실패·취소·skip 0, 실제 exit 0. `test-results/db-startup-observation-server-20261009.{tap,xml}`.
- 화면·클라이언트 전체 직렬 회귀: **471/471**, 실패·취소·skip 0, 실제 exit 0. `test-results/db-startup-observation-local-20261009.{tap,xml}`.
- `npm run check`, `npm run build`: exit 0. 마지막 결과 보존 문구 변경 후 해당 실행기 구문도 다시 검사했다.

집중 대역 시험에는 잘못된 readiness·조기 실패·추가 출력·시간 초과, 콜백 오류/미완료에 대한 실제 결과 보존, 기존 SQL/권한 검사 동일성, 비밀 파일 복호화 후 변조 재검증, 실제 Node 자식 IPC 종료와 늦은 close 관측이 포함된다. 이 성공은 실제 E·DPAPI·TLS·검사기·브라우저 성공을 대체하지 않는다.

### 실제 확장 native 실행

`978112a3-2fbf-406b-aa95-a09b3cfe784d`는 **55/55 통과**, 실제 프로세스 exit **0**이다. 전체 로그는 `test-results/db-startup-observation-native-20261009-a.log`, 개별 결과는 `test-results/windows-native-worker-978112a3-2fbf-406b-aa95-a09b3cfe784d-results.json`이다. 이번 소스의 55개 재검증 성공이며, 이전 실패 원인의 해결을 입증하는 것은 아니다.

- 작업자 4개 모두 실제 admission을 통과하고 DB 초기 6단계가 각각 begin/complete 12건으로 관측됐다. DB 단계 실패·생략·전체 출력 한도 초과는 없었다. 초기 트랜잭션은 순서대로 1,865/1,907/2,059/2,078ms였다. 이 한 번의 가상 실행 수치를 서비스 성능 기준으로 사용하지 않는다.
- 정상 종료 작업자 3개는 exit 0·실제 close·파이프 종료를 확인했다. 의도적으로 IPC를 끊은 세 번째 작업자는 exit 1·실제 채널 단절·파이프 종료로 실패 종료를 확인했으며 `closeObserved:false`를 그대로 보존했다. 정상 close로 바꾸거나 정상 drain으로 집계하지 않았다.
- API는 stop 요청 후 stopped·disconnect·파이프 닫힘·exit 0·child close를 관측했고 관측 시간 초과가 없었다. 이번 stop→child close 간격은 31ms였다. 기존 실패 실행의 빠진 close 원인까지 확인한 것은 아니다.
- 독립 시험 브라우저의 실제 PNG/영상 검사·전달·디코딩/재생·재조회·PNG 응답 유실 후 동일 요청 재시도가 통과했다. 오류와 예상 밖 요청은 0건이며 브라우저 컨텍스트·프로세스도 종료됐다. 320px 영상 뷰어를 직접 확인했다. 분홍 영역은 가상 계정 마스킹이다.
- 브라우저 전후 소스 249개 지문은 `50d1e456f4095cfce1f86ad67a69058edb44aeb0954360b3d332042f05ae0d01`로 일치했다.
- 원본·복원 PostgreSQL 정지, TLS·DPAPI 정리를 확인했다. 해당 실행의 ClamAV·decoder·encoder 라벨 3개를 각각 다시 조회해 컨테이너/이미지/볼륨이 모두 0개이고, 해당 PG PID 파일·TLS·credential 디렉터리가 없는 것도 확인했다. E 가상 DB·미디어 진단 자료는 남긴다.

이전 실패 `2b92e616-abf8-4fef-a0a1-dab58ed1f7ce`의 로그와 보존된 가상 키 파일은 삭제하거나 새 실행 성공으로 덮어쓰지 않았다. 이번에는 DB 열기 실패와 API close 시간 초과가 재현되지 않았다. 원인 미확정 위험은 계속 남는다.

### 직접 사용 세션의 실제 흐름 재검증

확장 시험이 실제 종료된 뒤 별도로 실행한 `95641c87-71fe-43c7-9ad5-c0785f8e550f`도 **통과**, 실제 exit **0**이다. 결과는 `test-results/synthetic-e-session-95641c87-71fe-43c7-9ad5-c0785f8e550f.json`, 로그는 `test-results/db-startup-observation-session-20261009-a.log`다.

일정에서 기록 진입·구조화 기록 저장·비공개 내용 제외 미리보기·보호자 공유본 수신·치료사 피드백 수신·재접속 재열람 6항목을 실제 UI/API로 확인했다. PNG/MP4도 격리→검사 중→준비 완료를 거쳐 서로 다른 시험 로그인에서 열람했다. 오류·예상 밖 요청은 0건이고 소스 249개 전후 지문은 위 확장 시험과 동일했다.

API와 작업자 모두 exit 0·실제 close·파이프 닫힘, PG 종료·키/잠금 정리를 확인했다. 이 실행의 검사 라벨 3개에서도 컨테이너·이미지·볼륨 각 0개, `postmaster.pid`·TLS·credential·interactive 잠금 파일 없음이 확인됐다. 시험 서버를 백그라운드로 남기지 않았다. E의 가상 DB/미디어만 진단 자료로 보존한다.

최종 변경 범위 24파일의 UTF-8·충돌 표식·후행 공백 검사와 추적 문서의 `git diff --check`를 통과했고, 제품/시험 소스 19개의 동결 후 지문 불일치는 0개였다. 인증·검사/종료 판정·저장 정책과 화면 기능을 바꾸지 않았고, 원격 push·배포·설치·런타임 교체는 하지 않았다.

재현은 프로젝트 루트에서 `node --test --test-concurrency=1 tests/*.test.mjs`, `server`에서 같은 명령, 루트에서 `npm run check`와 `npm run build`를 사용한다. 실제 E 명령은 [가상 E 세션 실행법](synthetic-e-session.md)의 동일 E/PowerShell 인수와 Playwright/Chromium 경로를 사용해 `node server/windows-postgres-check.mjs --verify-native-media …`, `npm run test:synthetic-e -- …` 순으로 각각 종료를 확인하고 실행한다. 기존 실행/잠금은 임의로 지우거나 재사용하지 않는다.

## 남은 목표

원 개편안 전체는 완료되지 않았다. 연결 실패·종료 관측의 실제 원인 확인과 재검증 이후, 기록 첨부의 기본 비공유 저장 → 선택 파일 미리보기 → 공유 카드 열람을 기존 저장·권한 서비스에 연결한다. 이어서 피드백 버전별 첨부와 당시 참고 파일, 종료 후 동일 세션 재개, 실물 기기·사람 사용성 검증이 남는다. 독립 백업 없는 실제 자료 운영은 계속 보류한다.
