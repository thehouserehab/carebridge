# Carebridge 복원본과 최신 상태의 대조

2026-10-09 · 비API 내부 운영자 구성요소. **검사 기능을 추가했으며 운영 복구·격리 해제·전체 개편 완료를 뜻하지 않는다.**

## 목적과 현재 상태

오래된 백업에는 현재 삭제된 소식, 해제된 참여자, 철회된 공유, 이전 비밀번호가 남을 수 있다. [복원 격리](recovery-quarantine.md)가 계정·세션·초대·작업자를 먼저 닫고, `server/recovery-state-comparison.mjs`는 최신 원본과 격리된 복원본의 차이를 확인한다. 차이를 덮어쓰거나 임상 이력을 병합하지 않는다.

최초 구현 단계에서는 001~021·권한 v5·화면·발신/임상 원본을 유지했다. 백엔드 설계 스킬의 기존 구조 우선 원칙에 따라 PostgreSQL/E 내부 모듈로 구현했고, Vercel 자원·외부 저장소·새 의존성·API·배포를 추가하지 않았다. 아래 과거 실행 숫자는 해당 단계 당시의 증거다.

2026-10-09 [소식 반영 메모022·권한 v6](local-api-connection.md#2026-10-09-일반-소식의-비공개-반영-메모) 후 현재 명시 목록은 63테이블이며 격리 영수증을 제외한 비교 대상은 62개다. 새 메모 요청 영수증도 기존 registry 기반 대조에 포함한다. 비교 알고리즘·격리 해제 금지는 바꾸지 않았다. 이번에는 검사 기대값과 단위 회귀를 갱신했으며 E/native 복원 대조를 재실행하지 않았다.

## 최초 DB 대조 단계의 변경 파일

- 내부 구현: `server/recovery-state-comparison.mjs`.
- 합성 실행/시험 도구: `server/recovery-state-native-check.mjs`, `server/windows-postgres-check.mjs`, `server/windows-postgres-policy.mjs`, `server/recovery-native-test.mjs`, `server/postgres-container-test.mjs`, `package.json`.
- 자동 시험: `server/tests/recovery-state-comparison.test.mjs`, `server/tests/recovery-constraint-shape.test.mjs`, `server/tests/windows-native-worker-test-policy.test.mjs`.
- 문서: 이 보고서·`README.md`·`docs/recovery-quarantine.md`·`docs/recovery-readiness.md`·`docs/server-foundation.md`·`docs/communication-acceptance.md`.

## 실행 계약과 보호 경계

`compareRestoredDatabaseState(sourceDatabase, targetDatabase, input)`은 명시적으로 주입한 두 DB 연결과 기존 격리 요청을 받는다. 외부 파일도 검사하려면 별도로 승인된 `mediaRoots`를 추가한다. 호출자는 연결 시간 제한·종료 책임과 사본의 출처/무결성·전체 writer 중단을 별도로 확보해야 한다.

```text
operationId, bundleId,
sourceReceipt: { name, oid, ownerOid },
targetReceipt: { name, oid, ownerOid },
confirmTarget: targetReceipt.name,
mediaRoots?: {
  source: { path, dev, ino },
  target: { path, dev, ino }
}
```

- 지원 범위는 **같은 PostgreSQL 18 서버의 서로 다른 소유 DB**다. DB 이름/OID/소유자·직접 로그인 역할·대상 확인을 검증하고 원본이 이미 격리된 경우 거부한다. 최신 원본이 없거나 잘못 연결됐으면 성공 보고서를 만들지 않는다.
- 대상의 격리 영수증이 같은 operation/bundle/source/target이어야 한다. 전체 사용자 비활성·전체 세션 폐기·미수락 초대 폐기를 실제 조회한다. 이 상태를 해제하는 경로는 없다.
- 63개 영구 테이블의 소유·종류·행 필터 유무와 체크인된 마이그레이션 이력을 확인한다. 열·제약의 적용/검증/지연/상속 상태·사용자 트리거·함수·인덱스 정의를 대조한다. DB 역할/ACL 전체 검사는 기존 [권한 검증](database-privilege-separation.md)의 별도 게이트다.
- 원본→대상 순서로 고정 테이블 목록에 SHARE 잠금을 유지한다. 기존 테이블의 동시 쓰기는 대조 종료까지 차단하며 운영 데이터에 INSERT/UPDATE/DELETE/DDL을 실행하지 않는다. 기존 연결의 잠금/쿼리 제한과 별도로 전체 트랜잭션은 30초에 묶는다. 외부 파일 IO·새 스키마 객체 생성·프로세스 종료를 이 잠금으로 입증하지 않는다.
- 원본의 무작위 트랜잭션 advisory lock을 대상에서 `pg_locks`로 관측해 같은 서버인지 확인한다. advisory lock 자체는 DB별이고 `pg_locks`는 서버 전체를 보여준다. 다른 DB에서 같은 키를 다시 잠가 동일 서버를 증명할 수는 없다. [PostgreSQL 18 잠금 명세](https://www.postgresql.org/docs/18/view-pg-locks.html)
- 격리 영수증을 제외한 **62개 테이블 전체**를 128행씩 읽어 비교한다. 실행마다 무작위 HMAC 키를 사용하고 키 버퍼는 종료 시 지운다. 원문·계정 식별자·비밀번호/토큰 해시·행 수·테이블 해시는 반환/로그/파일에 남기지 않는다. JS 문자열의 메모리 완전 소거를 보장한다는 의미는 아니다.

격리로 더 엄격해진 네 필드만 비교에서 제외한다: `cb_users.active`, `cb_auth_sessions.revoked_at`, `cb_auth_invitations.revoked_at`, `cb_auth_password_resets.revoked_at`. 반드시 대상의 접근이 전부 닫혀 있어야 하며, 나머지 행/필드와 비밀번호·보안 사건·관계·과거 공개 경계·공유/메시지/파일/작업 원장은 그대로 비교한다. 사용자 정지를 재활성화하는 기능은 없고 일치 결과도 계정 재승인 근거가 아니다.

결과는 `dataMatches`, 차이가 난 **테이블 이름** 목록, operation/bundle, 비교 테이블 수와 닫힘 상태다. `mediaRoots`가 없으면 종전처럼 `externalFilesChecked:false`이며, 승인된 루트까지 검사하면 파일 일치 여부를 별도 필드로 보고한다. **`serviceReleaseAllowed:false`는 항상 유지한다.** 차이/정보 부족/연결 또는 COMMIT 응답 불명확 상태에서 자동 재시도·부분 성공·자동 복구는 하지 않는다. 결과는 잠금 구간의 관측이며 재사용 가능한 운영 승인서·암호학적 원본 증명서가 아니다.

## 2026-10-08 외부 파일·삭제 차단 표식 후속

`server/recovery-media-comparison.mjs`는 같은 DB 잠금 구간 안에서 객체 원장·업로드 manifest·준비 증명의 연결과 승인된 두 디렉터리의 실제 바이트를 읽기 전용으로 확인한다. 폴더/누락 파일을 생성하는 기존 저장소 메서드는 사용하지 않으며 복사·삭제·수정·자동 정리도 하지 않는다.

이번 변경 파일은 다음과 같다.

- 내부 구현: 신규 `server/recovery-media-comparison.mjs`, 기존 `server/recovery-state-comparison.mjs`의 선택적 연결.
- 합성 실행기: `server/recovery-state-native-check.mjs`, `server/windows-postgres-check.mjs`, `server/windows-postgres-policy.mjs`.
- 시험: 신규 `server/tests/recovery-media-comparison.test.mjs`, 기존 `server/tests/recovery-state-comparison.test.mjs`, `server/tests/windows-postgres-policy.test.mjs`, `server/tests/auth-password-recovery-native-policy.test.mjs`.
- 문서: 이 보고서, `README.md`, `docs/communication-acceptance.md`, `docs/recovery-readiness.md`.

- `path`는 서로 다른 비중첩 전용 절대 경로, `dev`/`ino`는 호출자가 경로 생성 시 확보한 bigint 정체성의 10진 문자열이다. 입력은 첫 비동기 작업 전에 복사한다. 단순 영수증은 Windows ACL·소유권이나 신뢰 가능한 최신 원본의 증명이 아니다.
- 원본의 크기/해시, 후보의 준비 증명·원본 연결·별도 크기/해시를 대조한다. 기존 준비 증명 없는 과거 자료에 새 승인을 만들지 않는다. 불확실한 수신/검사/삭제 대기 상태는 일치로 채택하지 않는다.
- UUID `.blob`와 빈 `.blocked`만 허용한다. 원장 생성 전 취소로 생긴 차단 표식도 별도로 비교하며 버리지 않는다. 누락·변조·차단 표식 차이나 blob과 차단 표식 공존은 정상 일치가 아니다. 원장 밖 blob, 잘못된 이름/파일 종류, 비어 있지 않은 차단 표식은 거부한다.
- 디렉터리와 모든 상위 경로, 파일 핸들과 실제 경로를 확인한다. 심볼릭 링크/접합점·하드링크·정체성 교체를 거부하며, 두 루트 전체를 읽은 뒤 전체 이름 집합·모든 파일의 정체성/크기/수정시각을 다시 확인한다. 2026-10-09 보완으로 각 파일의 전체 바이트도 다시 읽어 최초 해시와 대조한다. 읽기 자체로 바뀔 수 있는 접근시각은 비교하지 않는다.
- 원장별 10,000행·루트별 20,000파일/2GiB·파일별 50MiB의 검사 상한을 넘으면 거부한다(이미지 manifest의 기존 10MiB 제한도 유지). 해시는 64KiB 버퍼로 읽는다. IO 전후의 20초 제한 검사는 협력적 중단이며 멈춘 OS 호출의 강제 취소 보장이 아니다. 열린 핸들의 종료는 기다리고 읽기 버퍼를 지운다.
- 반환은 `externalFilesChecked`, `externalFilesMatch`, 고정 범주 `file-inventory`·`file-content`·`deletion-fence`뿐이며 경로·파일명·객체 ID·해시·원문을 노출하지 않는다. `filesystemWriterQuiescenceVerified:false`를 명시한다. 알려지지 않은 IO/DB 오류는 고정 오류로 제한하고 부분 성공을 반환하지 않는다.

이는 제한된 시점의 관측이다. PostgreSQL SHARE 잠금은 파일 쓰기를 막지 않으며, 이식 가능한 Node 경로 검사만으로 악의적인 순간 교체 후 복귀까지 완전히 방지했다고 주장하지 않는다. 운영 중단·OS 격리·독립 백업·키/ACL·최종 복구 전환은 별도다. UI/API는 이번 변경에 포함하지 않았다.

### 이번 실제 E 검증

최종 실행 `b4b527a1-2c61-4cf7-9473-b9388f38514e`, `2026-10-08T12:05:56.444Z`: **27/27**, 종료 코드 0. 기존 E9·DB 대조13에 외부 파일5를 더했다. 결과는 `test-results/recovery-state-b4b527a1-2c61-4cf7-9473-b9388f38514e-results.json`이며 원본/복원 cluster 종료와 두 `postmaster.pid` 부재를 확인했다. 비교 모듈의 최종 SHA-256은 `08538b2c0105865f17560c49ac0033bc0738b007e6f3908722c00e23d094e7fc`다. 오류 코드 고정 보강 전의 초기 실행 `bf62ab10-8df3-4522-828b-5e139b5630e2`도 27개를 통과했으나 둘을 서로 다른 54개 시나리오로 합산하지 않는다.

인증된 묶음에서 새 `state-media`에 PNG 1개·빈 차단 표식 1개를 복원한 뒤 같은 서버의 격리 DB와 연결했다. 정확한 일치, 같은 DB에서 바이트 변조/누락, 최신 원본에만 취소 차단 표식 추가, 원장 밖 blob/비어 있지 않은 차단 표식 거부를 확인했다. 성공·실패 모두 검사 전후 DB fingerprint와 파일 목록/크기/해시/정체성이 보존되고 사용자·세션·초대·분실 복구 토큰이 닫혀 있음을 검사했다.

준비 후보/증명 연결의 이번 검사는 단위 계약으로 분리하며, 위 E 실행에 실제 ClamAV/FFmpeg 후보 생성까지 포함됐다고 주장하지 않는다. 일반 별도 cluster 복원·재시작도 이어서 통과했지만 동일 서버 전용 격리/최신 대조를 별도 cluster에 적용한 것은 아니다. 생성된 가상 DB/파일/사본은 종료된 진단 자료로 남겼고 생성 키/비밀번호는 폐기했다. 운영 백업이나 독립 매체가 아니다.

독립 읽기 검토에서 open/opendir 성공 직후 시간 제한이 발생하면 핸들 소유를 놓칠 수 있는 경로를 수정했고 두 자원의 종료 회귀를 추가했다. 검사 취소 후 준비 증명 없이 삭제된 후보도 바이트 승인 대신 차단 표식으로 대조하도록 처리했다. 임의 오류 코드/추가 속성을 재전파하지 않도록 허용된 고정 코드로 오류를 새로 구성한다.

집중 검사 **46/46**(신규 파일 검사24·DB 통합15·제약 재파싱2·E 정책3·기존 분실 복구 실행기 정책2), 로컬 `npm test` **157/157**, `npm run check`, `npm run build` 통과. 24개에는 여러 청크의 원본/후보, 과거 자료/삭제된 후보, 양쪽 동일 손상, 최신 취소 표식, 경합·링크·핸들 종료·민감 오류·파일 수/단일 크기/총 용량 상한의 직접 검사를 포함한다. 큰 용량 경계는 IO 모의로 확인해 거대 시험 파일을 만들지 않았다.

최종 전체 서버 **813/813**, 실패/취소/누락 0, 종료 코드 0. 결과는 `test-results/recovery-media-server-6760bd74-0a24-4b34-aa92-dfeb983747de.xml`이다. 이번 전체 실행 시간은 약 78초이며 운영 복구 시간(RTO) 측정값이 아니다. 기존 추적 파일의 `git diff --check`와 이번 새 파일의 후행 공백 검사도 통과했다.

```powershell
node --test --test-concurrency=2 --test-reporter=junit --test-reporter-destination=test-results/recovery-media-server-6760bd74-0a24-4b34-aa92-dfeb983747de.xml server/tests/*.test.mjs
node --test server/tests/recovery-media-comparison.test.mjs server/tests/recovery-state-comparison.test.mjs server/tests/recovery-constraint-shape.test.mjs server/tests/windows-postgres-policy.test.mjs server/tests/auth-password-recovery-native-policy.test.mjs
npm test
npm run check
npm run build
```

E 명령은 아래 재현 절차를 사용했다. 새로운 실행을 보존하려면 JUnit 결과 경로도 새 이름으로 지정한다. 실제 자료·운영 계정/서비스·API·공개 배포는 활성화하지 않았고, 문서상 운영 완료표도 완료로 전환하지 않았다.

공개34자산은 소스/dist와 동일하고 추가 산출물은 기존 `build.json`뿐이다. 기존 snapshot 방식의 SHA-256은 `3d3f8c9aa5e5f7e80ab3508c6cbc9d3eeff920f2ed8bd4c806589ac6ba3f009b`로 직전 UI 단계와 동일하다. 이번에는 UI를 바꾸지 않아 브라우저/사람/실물 검사를 재실행하지 않았다.

## 2026-10-09 동일 크기 파일 변경 재현과 보완

새 합성 localhost 첨부 전달 작업 중 전체 서버 회귀에서 기존 파일 대조 시험이 실패했다. `test-results/local-media-delivery-server-20261009.xml`의 실패는 `recovery-media-comparison.test.mjs`의 읽기 도중 덮어쓰기 단계이며, 뒤의 inode 교체 단계가 아니다. 첨부 전달 모듈의 변경에서 생긴 결함이 아니라 기존 파일 대조의 관측 한계를 회귀 실행으로 발견한 것이다.

- 기존 집중 시험 40회 중 3회에서 기대한 변경 예외가 발생하지 않았다.
- 실제 Windows 임시 파일과 제품 대조 함수를 이용한 180,031바이트 계측 100회에서 89회는 변경 예외, 11회는 `file-content` 불일치를 반환했다. 후자의 열린 핸들에서 크기·inode·수정/변경 시각이 덮어쓰기 전후 동일하게 관측됐다.
- 한 번의 청크 읽기에 들어가는 1,024바이트로 계측하니 100회 중 17회에서 실제 파일이 변경됐는데도 `externalFilesMatch:true`가 반환됐다. 최초 읽기 버퍼는 이전 전체 내용이고 최종 단계는 stat만 검사하므로 내용 변경을 놓친 경우다. 나머지 83회는 변경 예외였다. 이 반복 횟수는 성능·발생 확률·운영 안정성 지표가 아니다.

새 결정적 회귀는 실제 1KiB 파일을 최초 읽기 직후 같은 크기로 바꾸면서 해당 파일의 stat 반환만 최초 값으로 고정한다. Windows에서 관측한 동일 메타데이터 조건을 모델링하며, 바이트 IO나 해시 결과를 가짜로 만들지 않는다. 기존 제품에서 `Missing expected rejection`(종료 코드 1)로 실패하는 것을 먼저 확인한 뒤 최종 내용 재검사로 보완했다.

최초 전체 해시 이후 최종 점검에서 각 파일을 다시 읽고 최초 해시와 다르면 `RECOVERY_MEDIA_CHANGED`로 거부하도록 수정했다. 기존 정체성·이름 집합·크기·시각 검사와 20초 기한·파일/전체 용량 상한·64KiB 버퍼를 유지하며, 추가 읽기 때문에 기한을 넘으면 성공으로 전환하지 않고 거부한다. 정상 완료에는 파일 바이트를 두 번 읽으므로 IO 비용이 늘어나며, 지원 크기의 실제 운영 완료 시간은 별도 검증 대상이다.

수정 후 파일 비교 집중 검사 **25/25**, 제품 구문 검사와 세 변경 파일의 별도 후행 공백 검사를 통과했다. `git diff --check`도 실행했지만 이 세 파일은 미추적 상태라 별도 파일 검사를 증거로 사용했다. 기존 덮어쓰기/정체성 교체와 새 동일 stat 회귀의 두 시험을 40회 반복해 **80회 모두 통과**했다(실패 0, 종료 코드 0). 이는 80개 서로 다른 시나리오가 아니며 전체 서버·E·브라우저 재검사 성공으로 합산하지 않는다. 사용한 명령은 다음과 같다.

```powershell
node --check server/recovery-media-comparison.mjs
node --test server/tests/recovery-media-comparison.test.mjs
node --test --test-name-pattern='mid-stream mutation|same-size single-chunk' server/tests/recovery-media-comparison.test.mjs
```

두 번 읽기도 원자적 파일 스냅샷이나 작성자 중단 증거가 아니다. 최종 관측 뒤의 변경과 악의적인 교체·복귀까지 보장하지 않는다. `filesystemWriterQuiescenceVerified:false` 및 운영 해제 금지는 유지하고, 실제 E 복구나 독립 백업 완료로 확대 해석하지 않는다. 진단용 임시 파일과 핸들은 소유 경계를 확인한 뒤 정리했으며 실제 자료는 사용하지 않았다.

## 종전 DB 대조의 실제 검증과 실패 이력

최종 E 실행은 `1e9246cb-24e7-4fda-9197-7aeeb458a71c`, 결과 시각 `2026-10-08T07:50:00.936Z`다. `test-results/recovery-state-1e9246cb-24e7-4fda-9197-7aeeb458a71c-results.json`에 **22/22**, 종료 코드 0, 원본/별도 복원 cluster 종료 확인을 보존했다. 최신 요약은 `test-results/recovery-state-results.json`이다.

22개는 기존 E 복원 9개와 새 대조 13개다. 실제 PG 18.6-5 비슈퍼유저 소유 연결, native dump/restore, 같은 서버의 별도 격리 DB를 사용했다. 이후 기존의 **별도 cluster 복원/재시작 및 PNG 1개·차단 fence 1개**도 확인했다. 새 대조/격리는 같은 서버 대상에만 적용했다. 별도 cluster 격리·다섯 역할/DPAPI/TLS/native 검사 전체 재검증은 아니다.

새 시험은 미격리/다른 영수증 거부, 60테이블 일치와 접근 닫힘, 다른 실제 연결의 쓰기 거부(55P03), 실제 약화 CHECK 거부, 백업 이후 본문 수정/본인 숨김/전체 삭제/공유 철회/참여 해제/소속 정지/비밀번호 변경/초대 철회/파일 삭제 의도 감지 및 반복 조회의 불변을 확인했다. 후속 변경은 합성 원본에 의도적으로 가했고, 대조가 두 DB를 수정하지 않는지도 전후 fingerprint로 확인했다.

중간 실패는 통과로 집계하지 않는다.

| 실행 ID | 관측 및 처리 |
| --- | --- |
| `c2e659a8-29eb-49bb-9358-a9f037caf3f8` | 대조 단계, 기존 E 6개 후 실패. 세부 원인은 기록되지 않아 단정하지 않는다. 이후 DB별 advisory lock 가정 오류를 코드 검토로 수정했다. |
| `cb40e86f-f45f-447e-91c3-0fadbadb7749` | source-init, 1개 후 실패. 세부 원인 미확정. |
| `d7963fb1-85e3-446f-852b-4b08bc1db05d` | 새 대조 3번째에서 스키마 불일치로 거부. |
| `d3bc585b-58ef-452c-b45b-c6e16165c0de`, `07327baa-44b2-41d5-88eb-3db33600e106` | 잘못된 비밀번호의 28P01 확인 지점에서 실패. 실제 연결 오류 종류는 당시 미기록. 연결 제한 4초 시험도 해결을 입증하지 못해 원래 1.5초로 되돌렸다. |
| `ded70d6e-5506-481b-9731-cf633bd7a349` | 스키마의 제약 정의 문자열 차이 확인. 아래 PostgreSQL deparser 대응으로 수정했다. |
| `3028cc8b-3c04-492c-8a80-43a7a8ab8956` | 잘못된 비밀번호 확인에서 31ms 만에 일반 연결 오류. 비밀번호 수락 증거도, 기대한 28P01 증거도 아니다. 원인 미확정. |
| `3dde274a-2b13-4ee5-9e6c-968ec0a253f0` | 실제 일치·쓰기 차단·약화 CHECK 거부·본문 수정 감지까지 통과 후 시험용 본인 숨김의 `confirmed:true` 누락으로 중단. 시험 호출만 수정하고 제품 확인 규칙은 유지했다. |

최초 세 실행 JSON은 당시 최신 요약으로 덮어쓰여 개별 JSON이 남아 있다고 주장하지 않는다. 이후부터 실행별 결과를 독점 생성으로 보존한다. 모든 실행의 생성 영수증과 `postmaster.pid` 부재를 별도로 확인했고 소유 프로세스 종료 핸들도 확인했다. E 합성 DB/파일/사본은 진단용으로 남겼다. 생성 비밀번호·묶음 키는 폐기했으며 운영 백업이 아니다. 다른 사용자의 프로세스·폴더는 종료/삭제하지 않았다.

제약 거부의 재현 원인은 `BETWEEN`의 중첩 AND가 dump 재파싱 후 평탄해져, 의미는 같지만 기본 deparser의 괄호 문자열이 달라진 것이었다. `pg_get_constraintdef(...,true)`를 사용하니 사본 스키마를 메모리 PostgreSQL로 재현한 896개 정의가 일치했다. 정규식으로 조건/괄호를 지우지 않으며 적용·검증 상태도 비교한다. 제품의 동일 조회 SQL로 재파싱 동등성·실제 조건 약화·OR/AND·NOT VALID 차이를 검사했고, 실제 E에서도 약화 CHECK 거부를 확인했다.

최종 서버 **748/748**(실패/오류/누락 0), 로컬 **124/124**, 문법 `check`, 정적 `build`, `git diff --check` 통과. 서버는 `node --test --test-concurrency=2 --test-reporter=junit --test-reporter-destination=<임시 결과.xml> server/tests/*.test.mjs`로 실행했다. 집중 신규 11개와 기존 격리/실행 옵션 18개도 통과했다. 초기 서버 746개는 마지막 두 deparser 시험 추가 전 결과다.

재실행에는 이미 설치·확인된 E 전용 PG와 PowerShell이 필요하다. 아래 PowerShell 경로는 설치 위치에 맞게 지정한다. 설치/기존 cluster 채택·운영 활성화 옵션은 없다.

```powershell
npm run test:recovery-state:e-drive -- --base E:/CarebridgeBeta --powershell C:\Tools\pwsh.exe --confirm-synthetic-e-drive
```

함께 발견한 기존 Docker 시험의 019/20 마이그레이션 기대값과 일반 PG 보고서의 47/53 집계 불일치도 현재 코드에 맞췄다. 이번 Docker 14/53 실행 성공으로 주장하지 않는다. 제품 화면은 바꾸지 않아 브라우저·사람·실물 기기는 이번 단계에서 재실행하지 않았다.

## 남은 위험과 우선순위

1. **원본 소실 시 최신 거부 근거:** 현재는 연결 가능한 신뢰 원본이 필요하다. 별도 최신 원장/독립 매체가 없는 장애 상황에서 재공개를 승인하지 않는다. 결과만 보관했다가 나중에 재승인하는 기능도 없다.
2. **작업자·운영 경계 후속:** 승인된 외부 바이트/fence의 읽기 전용 대조를 추가했지만 실행 엔진/프로세스·누적 실행 한도·실제 파일 writer 중단·키/ACL까지 검증하지 않는다. 별도 cluster의 최종 대조·복구 경로도 남아 있다.
3. **새 서비스 대상과 명시적 cutover:** 불변 임상/메시지 이력을 유지하면서 최신 거부 상태를 안전하게 적용하는 별도 설계·검증이 필요하다. 기존 격리본은 점검용으로 남기며 자동 해제하지 않는다.
4. **운영 조건:** 간헐적 native 인증 연결 종료의 원인, 독립 백업/키 회수·서비스 계정·보존/파기·RPO/RTO·센터 승인과 담당자는 미완료다. 보관 기한이나 실제 자료 동의를 임의로 확정하지 않았다.
5. **마지막 API/P1 및 P0 사람 검증:** 실제 계정 화면·다른 기기의 전달/단절/재접속, 원 6흐름의 실물 기기, 사람의 작성 시간·공유 요약 이해도는 남아 있다.

독립 백업 매체가 없어 실제 아동 자료 수집과 외부 접속은 계속 보류한다. [전체 완료표](communication-acceptance.md)의 개편 목표와 BR-06~10 전체를 완료로 바꾸지 않는다.
