# Carebridge 정지형 합성 DB·첨부파일 복원 검증

## 2026-10-24 최신 합성 복원 재검증

사용자의 아이폰 제외 PC 작업 요청으로 새 실행 `4e866a09-9cff-4e90-8be7-317bbaaefebf`를 수행했다. **78개 시나리오·exit0**, 001–023 migration과 실제 처리 PNG/MP4·공유 대상·비공개 검토의 복원/격리·별도 cluster 재시작이 통과했다. 503파일 소스 전후 불변과 보고서의 DB/worker/fixture/TLS/credential 종료·정리 플래그를 확인했다. 자세한 명령·해시·독립 감사·제한은 [2026-10-24 PC 검증](pc-verification-20261024.md#보존복원)에 있다.

과거 실패 `47669740…`의 TLS 5파일은 이번에도 존재함을 읽기 전용으로 확인했으며 삭제하지 않았다. 새 실행의 정리와 별개다. 아래 10월14일 결과·실패 기록은 당시 이력으로 보존한다.

## 2026-10-14 실제 미디어·최신 복원·격리 결합 검증 완료

사용자의 직접 답변 `call_b761197bc9ad4f7d87008044459edc2d` — **“새 가상 자료로 복원 검증부터 진행”**에 따라 실행했다. 새 실행 `f749cedc-43a0-42fc-9c82-447671d6c212`는 20:44–20:55 KST, **78개 native 시나리오 통과·실제 exit0**다. 아래 기존 UI·role 실행과 다른 자료/실행이며, 브라우저는 이번 결합 검증에서 열지 않았다.

결과: `test-results/native-recovery-f749cedc-43a0-42fc-9c82-447671d6c212-results.json` (SHA-256 `a0947a488bf1ea9281a5f3d7753b02ed2f04ad27fbc92cdd5a8485ce764917ee`). `passed=true`, `failure=null`, `reviewChecks` 6개 모두 true다. 467개 소스 파일 manifest 해시 `4e62097a4db2335e47b886517ed562570494bd5711ebd897a29581da1ee3637b`가 실행 전후 같았다. **이 sourceUnchanged는 코드 불변성이지 시험 DB 데이터 불변성이 아니다.**

| 검증 경계 | 이번 실제 증거 |
| --- | --- |
| 업로드→실제 처리→파일 조회 | 새 loopback HTTP API 및 별도 작업자로 PNG/APNG/MP4를 실제 ClamAV·FFmpeg 처리. DPAPI/TLS/DB 역할 경계, 미인증·다른 계정 거부와 종료/상위 연결 단절 시 작업 정리 확인. |
| 같은 파일의 백업·복원 | 원본/처리본 파일과 삭제 표식 총 27개(파일 10·표식 17)를 암호화 bundle로 묶음. 준비된 PNG·MP4 각각의 업로드/준비 원장과 원본·처리본 네 파일의 크기·전체 SHA-256/바이트를 연결해서 대조. |
| 같은 서버 안의 임시 복원 DB | 원본과 같은 역할 소유의 DB 두 개는 서비스 진입 정책상 양쪽 모두 거절되는 것을 확인. 정책을 완화하지 않음. 이 상태의 직접 역할 조회는 합성 fixture 검사일 뿐 API/서비스 가동이 아님. |
| 복원본 격리·쓰기 차단 | 62개 데이터 테이블 대조, 모든 사용자 비활성·세션/초대/비밀번호 재설정 닫힘. 022 비공개 메모·과거 요청 영수증·원문 버전은 보존하되 정상 조건의 메모 변경/영수증 생성이 정확한 격리 오류로 거부됨. |
| 손상·누락 및 오래된 백업 탐지 | PNG·MP4 처리본 변조/누락을 각각 탐지하고 시험용 바이트를 원복. 삭제 표식·알 수 없는 파일·약화된 제약과 백업 후 원본의 수정/숨김/삭제/공유 철회/계정 변경/파일 삭제 의도를 탐지. 자동 복구·서비스 전환 없음. |
| 별도 서버 환경의 복원·재시작 | 별도 PostgreSQL cluster에 백업 시점 전체 DB·파일 복원. 001–022 이름/체크섬, 전체 행·열·트리거, 다섯 역할 객체/열/함수/기본 권한, 역할별 조회와 독립 재시작 후 보존 확인. DB 연결 권한만 명시 재적용하며 객체 권한의 누락을 자동 수선하지 않음. 이 별도 cluster는 위 격리 대상과 다름. |

실행 결과의 `sourceStopped`, `restoredStopped`, `tlsFixtureCleanup`, `credentialService.cleanup`, 두 작업자 계통의 `allChildrenTerminal`, `nativeMedia.fixtureCleanup` 모두 true다. 이번 실행의 TLS/DPAPI·소유 미디어 검사 자원은 정리했고 합성 DB·계정 행·매체·덤프·bundle은 오프라인 보존한다. bundle key는 폐기했으므로 보존된 bundle을 장기 재개용 백업으로 간주하지 않는다. 기존 E 자료·실제 개인정보·방화벽·Windows 신뢰 저장소·배포는 바꾸지 않았다.

종료 후 독립 읽기 감사(20:56–20:57 KST): 해당 감독/PG/API/작업자 및 정확한 Docker 소유 label 자원 0개, 두 postmaster.pid·TLS·DPAPI·공통 실행 잠금 부재를 확인했다. source-media/state-media/restored-media의 파일명·크기·SHA-256가 각각 27개·6,475바이트로 완전히 같고 준비된 사진/영상 네 파일도 원장 증거와 일치한다. 이는 DB 내부 데이터를 다시 열어 대조한 감사가 아니다. `test-results/native-recovery-f749cedc-43a0-42fc-9c82-447671d6c212-cleanup-audit.json`에 저장했다.

### 검사 코드 변경과 재현

제품 UI/API·migration·권한 정책을 바꾸지 않고 시험 구성만 보완했다.

- `windows-postgres-policy.mjs`와 해당 시험, `package.json`: 단일 명시 모드 `--verify-native-recovery`/`test:native-recovery:e-drive` 추가. 기존 모드 유지, 모드 중복·기존 DB/키/주소 지정 거부.
- `recovery-prepared-native-check.mjs`, `recovery-prepared-faults.mjs` 및 각 시험: DB와 실제 처리본 네 파일의 읽기 전용 결합 검증, 새 복원 디렉터리의 사진/영상 손상·누락 역검증.
- `recovery-review-native-check.mjs` 및 시험: 022 메모/과거 영수증의 격리 후 보존과 정확한 쓰기 차단 검증.
- `windows-postgres-check.mjs`, `recovery-state-native-check.mjs`, `windows-native-worker-check.mjs`, `database-credential-service-native-check.mjs`, `native-recovery-wiring.test.mjs`: HTTP 미디어→같은 파일 복원→격리→별도 cluster 재시작 구성. 기존 native 브라우저 모드의 검증은 그대로 유지.
- `database-privilege-policy.test.mjs`: 같은 역할이 다른 DB도 소유하면 verify/configure 및 네 서비스 진입이 초기 검사에서 거절되고 권한 변경/업무 실행이 없다는 회귀 추가.

```text
node server/windows-postgres-check.mjs --verify-native-recovery --base E:/CarebridgeBeta --powershell <확인된 pwsh.exe 절대 경로> --confirm-synthetic-e-drive
node --test server/tests/native-recovery-wiring.test.mjs server/tests/recovery-prepared-faults.test.mjs server/tests/recovery-prepared-native-check.test.mjs server/tests/recovery-review-native-check.test.mjs server/tests/windows-postgres-policy.test.mjs server/tests/recovery-native-contract.test.mjs server/tests/recovery-state-comparison.test.mjs server/tests/recovery-media-comparison.test.mjs server/tests/windows-postgres-media-fixture.test.mjs
node --test server/tests/database-privilege-policy.test.mjs
node scripts/check.mjs
git diff --check
```

순서대로 native **78**, 집중 회귀 **92**, 권한 회귀 **22** 통과, 구문·공백 검사 exit0. 회귀와 native 개수는 별개의 증거다. native 재현은 매번 새 E 가상 DB·키·검사 자원을 생성하므로 단순 문서 열람용 명령이 아니다.

### 선행 실패 이력과 미정리 항목

첫 결합 실행 `47669740-1bb9-4b27-9887-263d767c78d1`는 49개 통과 후 `recovery-state-create`에서 exit1이었다. 기존 권한 정책은 같은 역할이 여러 DB를 소유하면 서비스 연결을 거절하는데, 새 시험 구성에서 같은 서버의 복원 DB까지 정상 서비스로 승인될 것으로 잘못 기대했다. 제품 정책은 그대로 두고 정확한 두 DB 소유권 조회→양쪽 서비스 진입 거절을 검증하도록 수정했다. 정상 권한 보존 검증은 별도 cluster에서 유지했다. 복원 단계별 진단도 세분화했다.

첫 실행의 서버/작업자·정확한 Docker 소유 자원 종료와 DB·매체 27개 보존을 독립 확인했다. 그러나 잔존 TLS 파일 삭제 명령이 실행 전 `blocked by policy`로 거절되어 우회하지 않았다. **첫 실행의 `tls` 안 인증서/키/receipt 5개(개인키 2개)는 미정리 상태**다. 원본 실패 결과는 덮어쓰지 않았으며 `test-results/failed-run-cleanup-audit-47669740-1bb9-4b27-9887-263d767c78d1.json`에 차단·보존 및 매체 해시 불변 근거를 남겼다. 새 성공 실행의 정리 결과를 이 실패 실행에도 적용하지 않는다.

남은 한계: 같은 E 복원은 독립 백업·디스크 고장·정전 복구가 아니다. DB 잠금은 파일 쓰기 프로세스 전체의 정지를 증명하지 않으며 `filesystemWriterQuiescenceVerified=false`, `serviceReleaseAllowed=false`다. 같은 cluster의 원본에는 백업 후 변경 탐지를 위한 의도적 가상 변경이 남는다. 이번 성공은 앞서 Chrome에서 작성한 동일 UI 레코드의 복원이나 iPhone/VoiceOver·실물 통신 단절·사람 사용성 검증이 아니다. 실제 아동 자료와 외부 공개는 계속 보류한다.

## 2026-10-14 승인 후 실제 Windows/E 022 복원 완료

19:25 KST에 `windows-postgres-check.mjs --verify-role-privileges --base E:/CarebridgeBeta --powershell <확인된 pwsh.exe> --confirm-synthetic-e-drive`를 실행했다. 19:28 KST에 **exit0, 48개 native 시나리오 통과**를 확인했다. 아래의 이전 무서비스 48개 시험과는 별도 실행이다. 신규 helper의 순수 시험은 `node --test server/tests/recovery-review-native-check.test.mjs`, **10/10 통과**다.

- 실행 ID: `54d874f0-e8e7-4744-864b-9de10e778136`.
- 권위 있는 결과: `test-results/database-privileges-54d874f0-e8e7-4744-864b-9de10e778136-results.json`. 기존 이름 없는 최신 요약은 덮어쓰지 않았다.
- 원본/복원 DB: `E:/CarebridgeBeta\private\checks\postgres-check-54d874f0-e8e7-4744-864b-9de10e778136\source`, `restored`. 실제 PostgreSQL 18.6, 서로 다른 postmaster·포트의 새 cluster다.
- 정확한 001–022 SQL 이름·체크섬, 모든 테이블 fingerprint, 열·트리거, 파일 bytes/fence hash, 다섯 역할의 권한을 실제 `pg_dump` → 암호화 bundle → 별도 `pg_restore` 후 비교했다. DB CONNECT 경계는 복원 대상의 별도 비밀번호로 명시 재적용했다.
- 022 비공개 메모 v1 → 원문 v2 → 메모 v2, 영수증 2개, 과거 요청 재전송 불변성, 보호자·비참여 관리자 접근 거부, 보호자 응답 비공개 필드 제외를 **원본·원본 재시작·복원·복원 재시작** 네 시점 모두 확인했다. 해당 테이블 PK/CHECK/FK·guard 함수 본문·트리거 정의와 활성 상태도 동일했다.
- 결과 필드: `reviewChecks` 네 값 모두 true, `sourceUnchanged=true`, `sourceStopped=true`, `restoredStopped=true`, `tlsFixtureCleanup=true`, `credentialService.cleanup=true`, `allChildrenTerminal=true`, `failure=null`.
- 종료 후 합성 DB·시험 계정 행·media·bundle·restore-input은 오프라인 보존한다. TLS/DPAPI 임시 연결 키는 정리했고 bundle key는 폐기했다. 보존된 폴더를 운영 재시작이나 장기 복구 백업으로 사용해서는 안 된다.

범위 제한: 이 role 경로의 매체는 합성 원본 PNG/fence와 프로토콜 대체 검사다. 최신 Chrome 화면에서 선택 공유한 사진/비공개 동영상의 동일 레코드를 복원한 검사가 아니며 실제 AV/decoder 승인도 아니다. 별도 Chrome 모바일 API 재시작 시험 결과와 혼합하지 않는다. terminal quarantine/cutover, 독립 백업 매체, 실제 아동 자료, 아이폰 실물·VoiceOver·사람 사용성은 이번 결과로 통과 처리하지 않는다.

독립 읽기 확인(19:29:21 KST): 위 native UUID의 source/restored/source-media/restored-media 일반 디렉터리 보존, 두 postmaster.pid·tls·credential-check 부재, 해당 UUID PG/pg_ctl/Node/PowerShell 프로세스 0개를 확인했다. 프로세스 조회는 성공했고 명령행을 읽을 수 없는 PG/pg_ctl도 없었다. 이것은 종료·보존 확인이며 파일 bytes 재검사는 아니다.

### 별도 Chrome 모바일 API 재시작 시험 — 같은 선택 공유 보존 확인 완료

19:28 KST 시작한 별도 UI 시험은 저장소 UUID `273f98aa-575b-4bd4-9e43-8412a681fee6`, 감독 관찰 ID `be06dc58-72bc-465a-b811-52f81c42a04a`, 감독 PID `9780`이다. 최초 origin은 `http://127.0.0.1:57249`이며 실제 AV fixture UUID는 `3126521d-62e9-4595-8b3d-e71ef119cce8`, worker fixture UUID는 `e6379ac3-efc4-4fd9-b50e-352f13bfe959`, encoder fixture UUID는 `299143b3-1960-4bad-85e7-66bd43cfbc69`다. DB/TLS/DPAPI와 native 미디어 환경을 정상 준비했다. 아래는 단계별 실제 관측이며 전체 완료를 의미하지 않는다.

Chrome 자동 진입과 일반 새로고침 두 요청은 앱의 `LOCAL_REQUEST_UNAVAILABLE`(HTTP403)를 반환했다. 헤더 위조·보안 설정 완화·우회는 하지 않았다. 사용자 직접 주소창 입력 후 로그인 화면이 열렸고, 그 탭을 인계받아 정상 계정으로 로그인했다. 인계받은 탭에 390×844를 다시 적용한 뒤 저장·공유를 검증했다. 최초 거절 화면은 `test-results/approved-restart-navigation-blocked-20261014.png`, 모바일 공유 미리보기는 `approved-restart-share-preview-390-20261014.png`다.

실제 native 검사 완료 사진 PNG와 동영상 MP4를 비공개 기록에 첨부하고 사진만 공유 선택했다. 기록 저장 201(`888209c3-e3a9-4398-a19d-2f645e2e85cb`, revision1), 공유 201(메시지 `464b1ac6-c4af-4541-9c97-45bbb5568121`, 공유본 `62d3579a-270e-4fc2-a257-a98521292170`)을 확인했다. 치료사 응답에는 메모·사진 share=true·동영상 share=false, 보호자 응답에는 사진 1개만 있으며 비공개 메모/동영상이 없다. 사진 열람 32×24 정상·bytes SHA-256 `b5942de479d452d10a7b4dc1aaf5db0be28026dc0eb3d636d30817b31c3c0f25`를 확인했다. 보호자 일반 메시지와 공유본을 인용한 답장을 각각 한 번 보냈고, 인용 답장 ID `02a40e5b-f209-4044-aa6e-83544528e423`의 quote가 위 공유 메시지를 가리켰다. 재시작 전 해당 방의 메시지는 seed·공유·일반 답장·인용 답장 총 4개였다.

19:38:37 KST 시험 API 정상 재시작을 요청했고 generation2, 새 origin `http://127.0.0.1:53938`을 받았다. 이전 API의 stopped/terminal/closeObserved/stdioClosed=true, exitCode=0 확인. DB/worker는 유지했다. 사용자 직접 주소창 입력으로 새 화면을 연 후 19:49~19:53 KST에 같은 보호자·치료사 계정으로 각각 재로그인했다. 별도 전체 구문 검사 `node scripts/check.mjs`는 exit0이다.

| 재접속 검증 경계 | 실제 결과 |
| --- | --- |
| 보호자 대화·공유본·인용 | 서버 응답의 메시지 4개를 재시작 전 객체와 `deepEqual` 비교해 전체 일치. 같은 공유본·인용 원문 ID, 내용, 첨부 ID와 개수 보존. 비공개 메모/동영상 없음. |
| 공유 사진 bytes → 화면 | 보호자 첨부 GET200, 재시작 전후 SHA-256 일치. 32×24 이미지 로딩 완료. |
| 치료사 원본 기록 | 기록 GET200의 전체 객체가 재시작 전과 동일. revision1, 연결 목표·일정, 기본 내용·내부 메모·첨부 ID 보존. 사진 share=true, 동영상 share=false 그대로. 새 저장/재공유를 하지 않음. |
| 비공개 동영상 | 치료사 권한 GET200, 처리본 SHA-256 `ef37ea0ee9a695063a68d60bed11d7d4500696d38cce822f25dd92a261ca71e5`. 브라우저에서 32×24·2초, 재생 시작 후 currentTime=2/ended=true/error=null 확인. 재시작 전 동영상 bytes를 관측하지 않았으므로 동영상 bytes의 전후 동일성 주장과 구분. |
| 모바일 표시 | Chrome 390×844, 문서 scrollWidth=390, 기록 dialog clientWidth/scrollWidth=336/336. 새 주소 탭의 오류·경고 조회 0개. 실제 iPhone/WebKit·키보드·VoiceOver 결과는 아님. |
| 종료 | UI 로그아웃 확인 후 19:53:20 KST 정상 close 요청. 19:53:28 종료 기록, 감독 exit0, API generation2 exit0·terminal·stdioClosed, worker exit0·drain·terminal·stdioClosed, storage.databaseStopped/secretsDisposed=true. `failure=null`, 실행 전후 290개 소스 manifest SHA-256 일치. |

증거: `test-results/approved-restart-be06dc58-72bc-465a-b811-52f81c42a04a-ui-final.json`, 같은 ID의 `-lifecycle.json`, `approved-restart-guardian-after-390-20261014.png`, `approved-restart-private-after-390-20261014.png`. `-ui-pending.json`은 재접속 전 중간 이력으로 그대로 보존하며 최종 결과로 사용하지 않는다. 정상 종료를 수동 요청해 40분 타이머 전에 종료했으므로 위 두 웹 주소는 더 이상 제공되지 않는다. DB·매체는 오프라인 보존하고 비밀번호 문자열 참조를 해제했으며, 메모리의 완전한 비밀 삭제나 기존 시험 계정 행 삭제를 의미하지 않는다.

독립 읽기 종료 감사(19:54:59~19:55:18 KST)도 통과했다. source/source-media 보존, 매체 4개·5,060바이트의 파일명·크기·SHA-256·시각이 **재시작 이후 19:40:26에 잡은 종료 전 기준값**과 모두 같았다. postmaster.pid·해당 TLS/DPAPI·실행/준비 잠금·소유 감독/API/worker/PostgreSQL 프로세스·57249/53938 리스너는 없었다. 세 미디어 UUID의 정확한 Docker label 대상 컨테이너·이미지·볼륨은 모두 0개이고 기존 일반 이미지 3개와 익명 볼륨은 보존됐다. 모든 조회가 성공했으며 DB 내부를 다시 조회한 감사는 아니다. 같은 ID의 `-cleanup-audit.json`에 범위를 기록했다.

## 2026-10-14 새 합성 자원 생성 승인 — 실행 근거

아래의 이전 “승인 대기” 기록 이후 사용자 승인이 도착했다. 현재 대화의 직접 답변은 `request_user_input_async`, call ID **`call_c5b4992248af4cdf96f209ecf7b7afbf`**, 항목0에 대한 **“새 로컬 가상 세션으로 검증 허용”**이다. 질문은 아래 승인 대기 기록의 원문과 같다. 같은 허용을 재요청하지 않으며 OS/도구의 별도 승인 거부가 발생하면 이를 우회하지 않는다.

연결된 작업에서 전달된 승인 근거 원문:

```text
<transcript_evidence>
Assistant (2026-10-14 10:05 UTC, Sentinel_794ad8527508819184b0180b98cf2a23): 케어브릿지 복원 검사 오류를 수정했고, 관련 검사 48개가 통과했어. 실제 복원 시험은 새 인증 자원이 필요해서 별도 허용이 필요해.

네 PC에 합성 데이터용 PostgreSQL DB·시험 계정·로컬 인증 키를 만들고, 시험 API만 재시작해도 될까? 접속은 PC 내부로 제한하고 운영 자료·방화벽은 건드리지 않아. 종료 후 키는 정리하지만 합성 DB와 시험 계정 기록은 남아. 필요한 검사 도구를 외부에서 다운로드할 수 있어.
User (2026-10-14 10:09 UTC, Sentinel_f86f426d80c0819183d3fcdeda80e8de): 진행해
</transcript_evidence>
```

실행 범위: 새 UUID의 실제 합성 로컬 DB·시험 계정·TLS/DPAPI, 시험 API 정상 재시작, 필요한 검사 도구 다운로드. 실제 자료·외부 공개·운영 서버·Windows 계정/신뢰 저장소·방화벽·지속 권한·비용은 제외한다. 정상 종료 후 이번 키·임시 자원만 정리하고 DB/계정행/첨부는 오프라인 보존한다. Linux 회귀 실행기는 정상 종료 시 DB와 tmpfs를 삭제하므로 이번 보존 승인의 실행 경로로 쓰지 않는다. Windows/E의 별도 cluster 복원과 CUA Chrome의 API 재시작은 서로 다른 가상 fixture이며, 어느 결과도 독립 장애 매체 백업이나 아이폰 실물/사람 평가를 의미하지 않는다. 실행 결과는 이후에 별도로 기록한다.

## 2026-10-14 최신 022 검증 코드 보완 — 실제 복원 재실행 아님

`recovery-native-test.mjs`의 21개 고정 기대값과 001–021 준비 문구를 제거했다. 단순히 22로 바꾸는 대신, DB 생성 전 **명시적으로 검토한 SQL 파일명 전체 목록**과 디스크 파일이 일치해야 하고, 적용 후 및 복원 후 migration 원장의 **각 이름·SHA-256**이 준비 시 읽은 파일과 일치해야 한다. 누락·추가·동일 개수 이름 교체·중복·체크섬 변경은 실패한다. 새 migration은 이 목록과 해당 데이터 fixture를 함께 검토해야 한다. 이 계약은 실제 복원 실행기와 무서비스 회귀가 같은 `server/recovery-native-contract.mjs`를 사용한다.

최신 native 실행기의 추가 검증 조건은 다음과 같다. **코드는 준비했지만 이번에 실행하지 않았다.**

- 서비스 호출로 일반 소식 → 비공개 메모 v1 → 원문 revision2 수정 → 메모 v2를 만든다. 메모 1행·요청 영수증 2행이 없으면 빈 테이블 비교를 성공으로 인정하지 않는다.
- 복원 후 최신 원문·메모·버전과 이전 요청의 v1 영수증을 확인한다. 이전 요청을 재시도해도 최신 메모, 감사 기록, 대화방 revision 및 전체 DB fingerprint가 바뀌면 실패한다.
- 보호자의 메모 조회와 센터 관리자의 비참여 대화 조회를 거부하고, 보호자 소식에는 비공개 메모/리뷰 버전을 노출하지 않아야 한다.
- 격리 전후 보존 대상에 메모·영수증·원문 head/revision을 포함한다. 평소에는 유효한 메모 버전 증가·새 영수증 INSERT와 두 테이블 TRUNCATE가 격리 후 거절되어야 한다.
- 기존 fingerprint 비교를 공용 순수 함수로 분리했다. 열/NOT NULL/default, CHECK/FK, trigger와 함수, 소유자·실효 권한을 그대로 비교한다. 14개 상위 native 시나리오의 내부 검사를 보강했으며 성공 집계 문구나 과거 결과 파일을 새 성공으로 바꾸지 않았다.

무서비스 검증 명령:

```text
node --test server/tests/recovery-native-contract.test.mjs server/tests/recovery-state-comparison.test.mjs server/tests/database-privilege-policy.test.mjs
node scripts/check.mjs
```

첫 명령 **48/48 통과, 실패·취소·건너뜀 0, exit0**. 두 번째 명령도 `JavaScript syntax checks passed`, exit0. 파일/원장 계약과 fingerprint 역검증, 022 메모·이전 영수증의 같은 행 수 변조 및 누락 탐지, 역할별 권한 정책을 확인했다. SQL/DB는 대체 객체로 응답하며 실제 DB·PGlite·앱 계정·TLS/DPAPI·HTTP·Docker·네트워크 서비스를 만들지 않았다. 비교기의 임시 메모리 HMAC와 자체 임시 파일 fixture는 연결 자격증명이 아니다. 이 결과는 실제 SQL trigger, 5개 DB 역할, `pg_dump`/`pg_restore`, E 저장소 재시작이나 독립 백업 검증을 대신하지 않는다.

### 새 가상 세션 생성 질문의 실제 대상과 대기 상태

질문은 `functions.request_user_input_async`로 등록됐고 결과는 `accepted:true`였다. 이것은 **질문 등록 성공이지 생성 승인이나 운영체제 승인 결과가 아니다.** 현재 확인 가능한 도구 결과에는 request/call ID가 노출되지 않았고 이 질문의 답변/`questionItemId`도 없다. ID를 추정하지 않는다. 이 제안 때문에 UAC·sandbox 승인 요청을 실행했다가 거부된 사실은 없으며, 과거 Wi-Fi 방화벽/UAC 문제와 구별한다. 신규 생성·재시작은 계속 보류한다.

질문 원문: “최신 선택 공유의 재시작 후 보존을 검증하려면, 새 로컬 가상 세션에 시험용 DB·계정·일회성 연결 키를 만들어야 합니다. 이 범위의 생성과 시험 API만의 정상 재시작을 허용할까요? 기존 E 자료·운영 계정·Windows 신뢰 저장소·방화벽은 변경하지 않으며, 실제 자료나 외부 접속은 사용하지 않습니다.”

코드 기준 분류(이번에는 생성하지 않음):

| 대상 | 범위와 수명 |
| --- | --- |
| OS/외부 계정 | Windows 사용자·서비스 계정, Google/AWS 등 외부 계정을 만들지 않는다. 현재 Windows 사용자 권한의 자식 프로세스다. |
| 실제 PostgreSQL | `E:/CarebridgeBeta\private\checks\postgres-check-<runId>\source`에 새 cluster와 `carebridge_synthetic` DB, 관리자 및 owner/runtime/bootstrap/backup/worker DB 역할을 만든다. 메모리 mock이 아니다. |
| 가상 앱 계정 | 새 DB 안의 관리자·치료사·보호자 행과 scrypt 비밀번호 해시다. `@synthetic.test`는 시험 식별자이며 외부 이메일 계정/메일 전송을 뜻하지 않는다. |
| DB TLS/임시 비밀 | 같은 run 폴더 `tls`의 good/wrong 인증서·개인키 파일은 생성 시점부터 2일 유효하다. 브라우저 신뢰 루트가 아니다. initdb용 평문 입력 파일은 생성 후 finally 정리한다. 실행 중 TLS 개인키는 파일로 존재한다. |
| DPAPI | `credential-check-<runId>\<credentialId>.dpapi`에서 DB runtime/worker 연결 비밀번호를 기존 Windows CurrentUser로 보호한다. 새로운 Windows 계정/신뢰 설정이 아니다. 파일 자체에 고정 TTL을 설정하지 않으며 ephemeral 종료 정리 대상이다. |
| 접속/클라이언트 | 웹 `http://127.0.0.1:<동적 포트>`, DB와 검사 중계도 loopback 동적 포트다. 정확한 Host/Origin·Fetch Metadata·정상 인증을 검사하고 POST에는 동일 Origin과 요청 표식을 요구한다. DB는 CA/IP 및 TLS 검증을 유지한다. 앱 로그인 기본 수명은 8시간이다. |
| 보존/정리 | 기본 ephemeral 정상 종료는 DB·첨부·시험 계정/역할의 저장 행을 보존하고 이번 TLS/DPAPI·잠금·소유 임시 검사 자원을 정리한다. **키 정리는 DB/계정 삭제가 아니다.** 소유권·종료가 불명확하면 잔존 자원을 보존하고 확인 필요 상태로 남긴다. 폐기한 키로 과거 세션을 재개하지 않는다. |
| 실행 제한/재시작 | 기본 CLI는 사용자 종료까지 유지되며, 30분은 이전 일회성 감독 파일의 제한이다. API만 재시작할 때 기존 API 실제 종료와 stdio 종료 후 새 API를 만들며 DB/worker는 유지한다(최대10회). |
| 신뢰·방화벽 | 기본 loopback 실행기는 Wi-Fi 전용 경로와 별개다. Windows 인증서 저장소·방화벽·예약 작업·관리자 승격을 추가하지 않는다. |
| 미디어 준비/통신 | 실제 ClamAV·디코더 검사 자원을 만든다. 정의 갱신과 decoder 이미지 빌드에는 외부 패키지 다운로드가 발생할 수 있다. **외부에 서버를 공개하지 않는 것과 인터넷 통신이 전혀 없는 것은 다르다.** 외부 통신을 금지한 이번 범위에서는 이 경로도 실행하지 않았다. |

분류 근거: `server/windows-synthetic-postgres-runtime.mjs`, `windows-synthetic-storage.mjs`, `windows-native-api-test-parent.mjs`, `native-interactive-seed.mjs`, `tests/windows-postgres-tls-fixture.ps1`, `local-api-listener.mjs`, `local-api-http.mjs`, `synthetic-session-lifetime.mjs`, `synthetic-secret-cleanup.mjs`, `clamav-container-policy.mjs`, `decoder-job.Dockerfile`, `scripts/synthetic-e-api.mjs`, `scripts/windows-database-credential-provider.ps1`를 읽기 전용으로 확인했다. 공개/실제 자료·비용·운영 재시작·보안 설정 변경은 이번 보완 범위가 아니다.

아래는 과거 native 실행 이력이며, 위 무서비스 검사 결과로 대체하거나 최신 022 복원 성공으로 올려 기록하지 않는다.

---

2026-10-08 후속: [계정 보안 사건019](account-security-events.md)까지 실제 native 복원14/14를 재실행했다. 비밀번호 변경/세션 폐기 사건2개를 실제 서비스로 생성해 전체 행/schema fingerprint에 포함하고 격리 후에도 보존되는지 확인했다. 최종 UUID `6e1a9a7a-2963-4912-954c-36688197e85a`, UTC `2026-10-07T15:02:53.651Z`. 이전 migration 수18 기대값으로 인한 중간 실패와 소유 자원 정리는 후속에 보존했다. 독립 매체·운영 cutover/키 회수는 미완료이며 아래9/538·001~016은 최초 단계 기록이다.

2026-10-06. 개편안의 기존 기록·첨부 보존 및 P1 저장 신뢰성을 위한 구현이다. **합성 환경의 실제 복원 시험이며 운영 백업/복원, 서버 이관, API 연결 또는 서비스 전환 승인이 아니다.** 기존 사용자 DB·브라우저·사진·영상과 001~016 SQL을 수정하지 않았다.

## 결과와 변경 범위

**최신 후속:** [복원 대상의 계정·작업 격리](recovery-quarantine.md)에서 017과 내부 모듈을 추가하고 아래 최초 9개에 실제 PG 격리 5개를 더했다. 최신 native는 14개, 서버 회귀는 547개다. 이 문서의 아래 9개/538개·001~016·초기 실행 ID는 최초 복원 단계의 이력이며 최신 게이트/한계와 실행 결과는 후속 문서 및 `test-results/recovery-results.json`을 따른다. 운영 cutover 전체 완료는 아니다.

`npm run test:recovery:local`로 실제 PostgreSQL 18.6의 custom dump를 암호화한 뒤, 새 DB와 새 비공개 파일 경로에 복원했다. 최종 native 9개 시나리오가 통과했다. 암호화/파일 경계 계약 19개 및 기존 PG 컨테이너 정책에 추가한 복원 작업자 제한 계약 1개를 포함한 **서버 회귀 538개**도 모두 통과했다. 단위 시험과 실제 PostgreSQL 결과는 별개다.

| 파일 | 변경 이유 |
| --- | --- |
| `server/recovery-bundle.mjs` | DB archive·snapshot·UUID 객체·삭제 fence를 하나의 암호화 묶음으로 보존. 전체 인증 전에 복원용 평문을 제공하지 않음. |
| `server/tests/recovery-bundle.test.mjs` | 전체 바이트, 변조/순서/누락/키/재시도/취소/경로/동시 소비 경계 19개. |
| `server/recovery-native-test.mjs` | 실제 dump/restore와 임상 이력·역할별 조회·파일·검사기 자체의 역검증. 모든 입력은 새로 생성한 가상 자료. |
| `server/recovery-test.Dockerfile`, 대응 `.dockerignore` | 로컬 캐시의 digest 고정 PG 도구와 Node만 사용. 비공개 자료·환경변수 파일을 build context에 포함하지 않음. |
| `server/postgres-container-test.mjs`, `postgres-container-fixture.mjs`, `postgres-container-policy.mjs`, 정책 시험 | 기존 소유 영수증·격리·정리 경계를 재사용하는 명시적 `--recovery` 경로. 복원 작업자만 512MiB, 기존 PG 작업자는 256MiB 유지. 이미지의 예상 밖 영구 VOLUME은 생성 전에 거부. |
| 루트/서버 `package.json`, README, 서버 기반·복구 검토 문서 | 재현 명령과 현재 검증/미완료 범위 연결. 설치 의존성·lockfile은 변경하지 않음. |

화면·인증 API·서비스 데이터·권한 규칙·파일 검사 승인 정책·배포는 바꾸지 않았다. 운영자의 DB 접속 주소나 암호화 키를 받는 운영 CLI도 아직 만들지 않았다. 실제 공급자·예산·주기·보존/파기·키 관리·복원 승인 절차를 먼저 확정해야 한다.

## 실제 시험의 9개 시나리오

| 번호 | 직접 확인한 결과 |
| --- | --- |
| 1 | 소유 영수증으로 새 DB 3개를 생성. 실제 PG 도구 18.6, Node 24.15.0, 001~016 적용과 재실행 확인. 기존 DB 채택 없음. |
| 2 | 기본 3항목·측정값 0/3과 서로 다른 단위/조건·내부 메모·사진 메시지 참고·재공유·철회·당시 답변을 원래 trigger를 통해 저장. |
| 3 | 실제 custom dump와 원본/후보 PNG, 삭제 fence, DB/객체 snapshot을 같은 묶음에 보존. 평문 SQL 임시 파일 없음. 사본 생성 후 원 DB 지문 불변. |
| 4 | 새 DB에서 전 테이블의 행 개수/내용 지문, 열 정의, effective ACL/owner, 함수, 제약과 trigger 연결/활성 상태 비교. 모든 파일 전체 크기/SHA-256/바이트와 fence·원본/후보 키 보존. |
| 5 | 복원된 실제 `Records`/`Conversations` 조회가 원래 조회와 일치. 보호자/센터의 임상 원본 거부, 내부 메모 비노출, 독립 답변/철회 표시와 불변 이력 보호 유지. |
| 6 | **검사기 역검증:** 복원 대상만의 CHECK를 약화하거나 임상 테이블을 PUBLIC에 허용하거나 NOT NULL을 해제하면 각각 비교 실패. 원래 정의로 돌리면 다시 일치. 원 DB는 변경되지 않음. |
| 7 | 복원된 후보 바이트를 손상시키면 제공 불가. 건강한 원본은 보존되지만 공유 후보로 우회되지 않음. |
| 8 | 인증된 묶음 안에 실제 custom dump의 잘린 버전을 넣어 복원하면 실패. 새 실패 대상에는 public 테이블이 없고 원본은 불변. 자동 전환 없음. |
| 9 | 완료 묶음의 암호문을 변조하면 DB/파일 복원 시작 전에 거부. 원본은 불변. |

파일은 32×24 가상 PNG 원본/후보다. SQL 준비 증거는 명시적 합성 fixture이므로 이번 결과를 ClamAV·FFmpeg 재검사/파일 신규 승인 또는 동영상 전체 복원 결과로 집계하지 않는다. 같은 클래스의 바이트 보존 기반이지만 다른 형식과 실제 운영 자료의 검증을 대신하지 않는다.

DB 비교는 PostgreSQL이 재생성하는 내부 OID/RI trigger 이름을 동일성 기준으로 삼지 않는다. FK의 실제 제약 연결·활성/지연 여부와 명시적 trigger 정의를 비교한다. raw ACL의 NULL/명시적 배열 표현 대신 실제 권한을 비교한다. CHECK의 BETWEEN/AND 재구문분석에서 생기는 괄호 표현 차이는 정규식으로 지우지 않고 PostgreSQL의 자체 parser로 빈 임시 표에 다시 구성해 비교한다. 제약식·강제/검증/지연 여부·NOT NULL을 빠뜨리지 않으며 6번 역검증으로 실제 약화를 거부하는지 확인했다. [PostgreSQL 제약 카탈로그](https://www.postgresql.org/docs/18/catalog-pg-constraint.html)

## 암호화 묶음의 실행 계약

- 운영자 측 내부 모듈이며 HTTP에 노출하지 않는다. caller는 모든 writer/검사/정리 프로세스의 종료와 원본/대상 소유를 따로 증명해야 한다. `quiesced=true` 같은 boolean이 운영 정지를 증명하지 않는다.
- 외부 전용 절대 경로만 사용한다. 프로젝트 공개 경로, 드라이브·홈·임시 폴더 전체, symlink/junction과 hard link는 거부한다. Linux에서는 본인 소유/그룹·다른 사용자 권한 없는 디렉터리와 0600 파일을 확인한다. Windows 계약 시험은 NTFS ACL·정전 내구성을 입증하지 않는다.
- 32바이트 키는 caller가 별도로 보관한다. 묶음/파일명/manifest/상태 보고에 키를 넣지 않는다. 새 salt에서 묶음별 HKDF 키를 파생하고, AES-256-GCM 16바이트 tag·순번/길이/version/salt AAD로 64KiB 단위와 전체 완료 manifest를 보호한다.
- 모든 항목의 인증·전체 크기/SHA-256·완료 manifest를 먼저 검증한다. 그 전에는 평문 stream을 얻을 수 없다. 이후에도 각 chunk의 인증 완료 후에만 SQL/파일 소비자에게 제공한다. 인증 모드는 `update()`만으로 평문 신뢰를 확정할 수 없기 때문에 `final()` 성공을 먼저 확인한다. [Node.js authenticated encryption](https://nodejs.org/docs/latest-v24.x/api/crypto.html#deciphersetauthtagbuffer-encoding)
- 평문 임시 archive를 만들지 않는다. `.partial`은 암호문만 남기며 완료 파일로 자동 채택하지 않는다. 같은 실행 ID는 기존 완료/부분 파일을 덮어쓰지 않는다. Linux에서 내용 sync와 no-clobber publication/디렉터리 sync를 수행한다. 성공 응답 유실·OS 장애는 별도 조사 대상이며 서비스 전환으로 해석하지 않는다.
- 구현 상한은 항목 256개, 항목당 512MiB, 전체 평문 2GiB, frame 131072개다. 초과 시 실패하며 일부 항목을 생략하지 않는다. 운영 규모/주기/성능을 결정한 것이 아니며 충분한 디스크와 승인된 규모 확장이 필요하다. 버전 없는 임의 형식 변경을 하지 않는다.

native suite는 `pg_restore --single-transaction`을 사용하며 `--clean`, trigger 비활성화, 원본 overwrite 또는 운영 DB 복원은 사용하지 않는다. 이 옵션은 해당 DB의 복원을 하나의 트랜잭션으로 처리하며, DB 밖 파일까지 원자적으로 바꾸는 기능은 아니다. 사본의 인증도 SQL 실행의 출처·권한·운영 승인을 대신하지 않는다. [pg_restore](https://www.postgresql.org/docs/18/app-pgrestore.html)

## 재현과 검사 산출물

```powershell
npm run test:recovery:local
npm run test:postgres:local
npm --prefix server test
npm test
npm run check
npm run build
git diff --check
```

Docker Desktop의 로컬 `desktop-linux` context, 캐시된 승인 이미지와 `server/node_modules`가 필요하다. 자동 pull/install, 원격 builder, host port/외부 network/host data mount는 없다. 격리 DB와 worker는 exact ID·이름·image·실행 label 영수증으로 확인한다. 성공 실행의 새 DB·임시 파일·컨테이너·worker image는 정리했다. 실패/불명확 실행은 그대로 남겨 조사하고, 터미널 상태·소유를 재확인한 실패 시험 컨테이너/이미지만 개별 정리했다.

이번 최종 회귀는 기존 native PG/작업자 35개, 서버 538개, 로컬 61개, 신규/변경 JS 구문, `npm run check`/`build`, `git diff --check`까지 모두 exit 0이다. 신규 소스/문서의 줄 끝 공백과 내부 링크를 확인했고 정적 출력 32개 파일에 서버/백업 모듈·archive·키·시험 결과가 들어가지 않음을 별도로 검사했다. UI/브라우저·실물 기기·ClamAV/FFmpeg 결합 시험을 이번 복원 단계에서 재실행했다고 주장하지 않는다.

최신 native 결과는 비공개 시험 산출물 `test-results/recovery-results.json`에 실행 ID/완료 시각/합격 여부/한계를 남긴다. DB 주소·암호·임상 원문·객체 ID·snapshot·archive/키는 포함하지 않는다. 이 파일은 Git에서 무시하며 정적 배포에 넣지 않는다. 이번 최종 native 실행 ID는 `f14f9d69-2175-434e-94bb-de0206f61431`이다.

초기 시험에서는 PG 기반 image의 자동 익명 VOLUME 때문에 격리 검사가 실패했다. 이를 Node 기반 image+PG 도구 allowlist 복사 및 생성 전 VOLUME 거부로 수정했다. 최초 실패 시각에 생성된 미사용 익명 볼륨 1개는 정확한 소유 연결 영수증을 확보하지 못해 **자동 삭제하지 않았다**. 그 볼륨을 운영 자료나 복구 성공 증거로 채택하지 않는다. 이후 시험은 해당 볼륨을 연결하지 않았으며 새 영구 볼륨을 만들지 않는다. 256MiB 작업자 제한에서 발생한 OOM도 정상 종료로 처리하지 않고 복원 suite에만 명시적 512MiB 프로필을 적용했다.

## 남은 위험과 다음 순서

[BR-01~10](recovery-readiness.md)의 **전체 운영 합격을 선언하지 않는다**.

| 범위 | 현재 판정 |
| --- | --- |
| BR-01~05 | 전용 합성 대상, 단일 writer, 실제 구조화 기록·PNG·fence·권한/제약 및 주요 실패 경로의 부분 증거 확보. 운영자 권한 모델, legacy 실제 이관, 모든 파일/중간 실패·응답 유실은 미완료. |
| BR-02의 role/grant 복구 | 같은 격리 PG cluster의 비-superuser 시험 owner와 실제 table 권한 비교만 완료. 별도 cluster의 최소 운영 role/암호/grant 재생성은 미완료. |
| BR-06~07 | 오래된 세션/비밀번호/초대/참여 해제/공유·삭제 및 engine/job/generation 상태의 최신 대조와 cutover 검증 미완료. 복원본의 worker/API를 자동 시작하지 않음. |
| BR-08~09 | tmpfs/메모리 키 시험만 완료. 국내 영구 매체·다른 장애 영역의 사본·키 보관/회수/회전·담당자·RPO/RTO·보관/파기·독립 보안 검토 미완료. |
| BR-10/P1 사용자 흐름 | API는 마지막. 실제 화면 서버 연결·서로 다른 실물 기기·재접속 검증 미완료. |

다음은 최신 권한/삭제/검사 원장 상태가 부족한 복원본을 운영에 열지 못하게 하는 명시적 cutover 검증이다. 공급자/예산, 기존 브라우저 자료의 보존/승인 이관, 키·보관/파기와 운영 책임은 사용자/운영 담당자 결정을 유지한다. 그 이후 마지막 API 연결과 실제 사용자 흐름을 검증한다.
