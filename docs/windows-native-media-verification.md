# Windows 실제 사진·영상 검사 연결 — 합성 검증

2026-10-07. **Windows의 기존 검사 클라이언트와 실제 ClamAV·파일별 FFmpeg를 연결한 시험 도구 후속이다. 운영 파일 승인이나 E 작업자 전체 결합 완료가 아니다.** 독립 백업 매체가 아직 없으므로 실제 아동 자료 베타 전환은 보류한다. API는 마지막 순서를 유지하며 전체 개편 목표는 진행 중이다.

이후 [Windows/E 작업자 결합 검증](windows-native-worker-verification.md)에서 실제 E/PG·DPAPI/TLS·상속 IPC·native 원장·전체 파일 복원/재시작을 합성 E40으로 확인했다. 이 문서의 9개는 당시 독립 전송 시험 범위이며 운영 승인/독립 백업/P1 전체 완료가 아니라는 경계는 유지한다.

## 현재 상태와 변경 범위

이전 Windows/E 시험은 PostgreSQL·DPAPI·TLS·작업자 IPC를 검증했지만 검사 상대에는 대역을 사용했다. 실제 ClamAV·디코더의 Linux 결합 증거도 Windows 프로세스의 접속 증거를 대신하지 않는다. 이번에는 Windows에서 실제 엔진으로 접근할 경로를 별도로 만들고 가상 사진·영상과 취소/종료 사례를 검증했다.

백엔드 설계 스킬의 책임 분리 원칙을 적용해 시험 전송·격리 정책·엔진 준비·사례 실행을 분리했다. 기존 제품 스택을 유지하며 Vercel 자원·새 프레임워크·의존성을 도입하지 않았다.

| 구성 | 이번 역할 |
| --- | --- |
| [Windows 중계](../server/windows-clamav-test-bridge.mjs) | 임시 127.0.0.1 listener와 연결별 Docker CLI의 제한된 바이너리 전송. 외부 주소/Docker 공개 포트 없음. |
| [중계 정책](../server/clamav-relay-test-policy.mjs) | 기존 offline worker 격리를 재사용하고 정확한 명령·stdin/non-TTY·환경·자원·소유권을 추가 검사. |
| [컨테이너 peer](../server/clamav-relay-peer-test.mjs) | 자기 namespace의 127.0.0.1:3310에만 연결하는 고정 Node 프로그램. 파일·환경 선택 endpoint·엔진 socket·내용 로그·승인 판단 없음. |
| [합성 fixture](../server/windows-native-media-test-fixture.mjs) | 새 UUID 정의 볼륨/이미지, 실제 ClamAV·FFmpeg, 합성 동영상 생성과 자기 자원 정리. DB·E 자료는 사용하지 않음. |
| [실제 사례](../server/windows-native-media-check.mjs) | 상태, PNG/APNG/동영상, 거부 경계, 실제 중계 취소·종료를 검증. |
| [정책 회귀](../server/tests/clamav-relay-test-policy.test.mjs) | Docker 없이 실행하는 9개 정책/입력/컨텍스트 시험. native 시험으로 계산하지 않음. |

고정 digest Node [Dockerfile](../server/clamav-relay-test.Dockerfile)과 전용 [컨텍스트 제한](../server/clamav-relay-test.Dockerfile.dockerignore)은 peer 1개만 복사한다. 두 package.json에는 명시적 opt-in 명령만 추가했다. 기본 서버 시험은 Docker 설치 없이 실행할 수 있다. 제품 scanner/decoder/MediaUploads·SQL/권한·인증/세션·API·UI·배포는 변경하지 않았다.

## 전송·종료 경계

1. Windows listener는 127.0.0.1의 임시 포트만 사용한다. scanner의 실제 engine/full ID/name/run label/image·실행/격리를 연결 전 다시 확인한다.
2. 연결마다 새 UUID/full-ID 중계 컨테이너를 만든다. scanner의 network namespace만 공유하고 호스트 파일·볼륨·엔진 socket을 주지 않는다. user node·읽기 전용 root·cap-drop·no-new-privileges·메모리 256MiB/CPU 1/PID 64·nofile 1024·log none/restart no를 확인한다.
3. 고정 Docker Desktop CLI/named pipe, shell:false, [최소 자식 환경](docker-test-environment.md)을 사용한다. 부모 앱/DB 비밀과 합성 비밀번호도 중계 CLI에 전달하지 않는다. 컨테이너의 추가 proxy/credential 환경도 거부한다.
4. 동시 수락 연결 2개, 연결 입력 53MiB·응답 4096byte·관측 시간 120초로 제한한다. 기존 ClamAV 클라이언트의 더 작은 파일/시간 한도와 엄격한 응답 검사는 유지한다. 처리 성능 목표나 인터넷 DoS 방어 검증이 아니다.
5. 정상 NUL 응답만으로 성공 EOF를 전달하지 않는다. CLI 실제 close·출력 전달 완료에 더해, 같은 엔진의 해당 중계가 실제 exited/code 0/no OOM인지 확인하고 정확한 ID를 제거·부재 확인한 뒤 EOF를 보낸다.
6. 취소/오류 때 CLI 종료를 컨테이너 종료로 간주하지 않는다. full-ID 소유권을 재확인하고 살아 있는 해당 중계만 종료·제거한다. scanner 전체를 연결별로 종료하지 않는다. 생성 ID나 정리가 불확실하면 fixture를 보존하고 새 작업/정상 결과를 거부한다.

Docker의 start --attach/--interactive는 표준 IO 연결 옵션이다. CLI 관측과 실제 컨테이너 상태를 별도로 확인하는 것은 이 시험의 안전 정책이다. [Docker start](https://docs.docker.com/reference/cli/docker/container/start/), [Docker attach](https://docs.docker.com/reference/cli/docker/container/attach/)

ClamAV TCP는 인증하지 않는다. 임시 listener 역시 같은 PC의 다른 프로세스가 접근할 수 있으므로 가상 자료 전용이며 운영 보안 경계로 채택하지 않는다. scanner/중계/디코더는 외부 네트워크 없는 실행을 사용하지만 정의 갱신 컨테이너와 공개 의존성 build는 외부 통신을 사용한다. 전체 시험을 완전 오프라인이라고 주장하지 않는다. [ClamAV TCP 주의사항](https://docs.clamav.net/manual/Usage/Scanning.html)

## 첫 실행의 실패와 수정

첫 run **13058895-7b92-4308-8b1d-5c0f9d6856ed**는 앞의 6개 사례를 통과한 뒤 해시 불일치 사례의 종료 대기에 멈췄다. 해당 중계는 실제 created/Running false였고 시험 Node의 Docker 자식은 없었다. 취소된 CLI stdout이 end 없이 닫히면 pipe가 해제되고 Transform의 finished가 끝나지 않을 수 있는 대기를 확인했다.

취소 시 입력·출력 Transform도 destroy하고 stdout의 비정상 close를 취소로 처리하도록 수정했다. 실제 컨테이너 종료·소유권·제거 확인을 우회하거나 실패를 정상 성공으로 바꾸지는 않았다.

기존 실행은 PID·부모 PID·생성 시각·정확한 명령·자식 없음 영수증을 확인한 뒤 멈춘 시험 관측 프로세스만 강제 종료했다. 정상 drain/서비스 종료 증거로 계산하지 않는다. 같은 엔진·full ID·name/label/image·상태·volume/tag를 확인하고 이번 실패 fixture의 컨테이너 3개, 정의 볼륨 1개, 이미지 태그 4개만 정리했다. 무관한 익명 볼륨·공식 base 이미지·기존 E 실패 진단은 유지했다. 제거한 것은 다시 생성 가능한 합성 자원뿐이다.

## 최종 실행 결과

수정 후 새 run **081ea796-b77b-4592-9d8e-9b740beb176d**는 **9/9**를 통과하고 정상 fixture close/자기 자원 정리를 완료했다. 실제 ClamAV **1.4.6**, loaded definitions **28146**, 정의 UTC **2026-10-07T06:24:18.000Z**였다. 다음 실행의 정의 값은 달라질 수 있으며 고정 성공값으로 사용하지 않는다.

| 사례 | 실제 관측 |
| --- | --- |
| 승인 버전·UTC 상태 | Windows loopback에서 실제 daemon PING/버전/정의 확인. mediaAcceptanceReady false 유지. |
| PNG | 원본·후보 AV 검사 2회, 별도 FFmpeg 원본/후보 디코딩·바이너리 반환·1프레임/timeline/hash·원본 불변·합성 metadata 제거. |
| APNG | 같은 결합 경로, 2프레임 및 전후 timeline/hash 보존. |
| 동영상 | 공개 합성 H.264 MP4의 전후 AV/디코딩·프레임 수/timeline/hash. 사용자 영상 사용 없음. |
| 무해한 악성코드 대조 문자열 | 실제 AV 원본 거부, 디코더 생성 수 불변·후보 bytes 없음. 실제 악성 프로그램 실행 없음. |
| 불법 PNG 필터 | 실제 AV clean이어도 유효 CRC/zlib 뒤의 불법 행 필터는 SCAN_INVALID. AV clean만으로 승인 불가. |
| 원본 해시 불일치 | SCAN_INVALID, 정상 scan 종료 마커/후보로 진행하지 않음. 취소 중계 대기·정리 회귀 포함. |
| 실행 중 중계 취소 | 실제 Running/full ID 관측 뒤 연결 취소, 해당 ID 부재 확인 후 새 scanner 상태 성공. |
| 실행 중 bridge close | 실제 Running 중계에서 멱등 close·drain/부재 확인. 종료된 listener의 이후 조회 실패, uncertain false. scanner는 fixture 최종 정리까지 유지. |

각 사례 후 decoder retained jobs/실제 ancestor 및 tracked ID 부재, 중계 retained 없음도 확인했다. 결과는 prepared이고 mediaAcceptanceReady false다. DB 원장/영구 객체/권한 트랜잭션을 통과한 업로드 ready나 실제 서비스 제공 성공이 아니다.

```powershell
npm run test:media-preparation:windows
node --test server/tests/clamav-relay-test-policy.test.mjs server/tests/clamav-container-policy.test.mjs server/tests/local-docker-test-environment.test.mjs
npm run test:server
npm test
npm run check
npm run build
git diff --check
```

집중 **33/33**, 전체 서버 **682/682**, 로컬 **87/87**, 구문/정적 빌드·tracked whitespace 통과. 실패·취소·skip 각각 0이며 집중 수치는 서버 수치에 별도 합산하지 않는다. 화면·브라우저·실물 기기, E DB/DPAPI/TLS·IPC 전체 결합은 이번에 재실행하지 않았다.

최종 QA: 이번 변경 파일 14개·로컬 링크 128개의 UTF-8/whitespace/대상 존재를 확인했다. dist는 원본과 바이트가 같은 공개 자산 31개와 build metadata 1개뿐이며 서버·문서·시험·비밀/기타 파일은 없다. 같은 엔진에서 실패/최종 run의 AV container/image/volume와 decoder job container/test image를 재조회해 잔여 0을 확인했다. 첫 일회용 재조회 명령의 구문 오류는 native IO 전에 실패했으며 수정한 읽기 전용 조회가 통과했다. 전역 prune/무관 자원 정리·기존 E 실패 진단 삭제는 하지 않았다. 마지막 4173 listener 조회는 0이며 이 단계에서 개발 서버를 중지/재시작하지 않았다.

재현 전제: Windows·Node 24, 기존 Docker Desktop Linux engine/context/local builder·RAM 6GiB 이상·캐시된 pinned Node/ClamAV base 이미지·기존 FFmpeg 공개 소스 build 준비. 엔진 설치/기동이나 이미지 자동 pull을 하지 않는다. 정의 갱신/공개 build에는 네트워크가 필요할 수 있고 매 실행 임시 자원을 생성·제거한다. 불확실한 실패를 자동 prune/재사용하지 않는다.

## 장점·한계·다음 우선순위

- 장점: 제품 클라이언트/파일별 디코더를 실제 Windows IO에서 검증했고 대역 AV만의 성공과 구분했다. 공개 Docker port/host 파일 mount 없이 연결하며 정리 실패는 닫힌 상태로 처리한다.
- 한계: trusted 시험 런처이지 운영 Windows 어댑터가 아니다. CLI/부모 경로 ACL·서명·named pipe 권한·전용 OS 계정/SCM·운영 이미지 승인/업데이트·영속 감시/경보는 입증하지 않는다. scanner 내부 개별 작업 종료·악성코드 완전 탐지·모든 기기/코덱 호환성·익명화도 보장하지 않는다.
- 후속 구현: 이 합성 fixture의 E 파일/실제 PG + worker 전용 DPAPI/TLS + durable decoder 원장 + Windows 프로세스/IPC 결합은 위 별도 보고서에서 검증했다. 당시 가상 worker 증거를 자동으로 native 성공으로 올리지 않았으며 운영 Windows 실행/감독 경계는 남아 있다.
- 운영 전제: 보존/파기·복구 책임과 RPO/RTO, 독립 백업 매체·키 회수/복원·현재 삭제/권한 대조가 필요하다. 같은 E의 사본은 독립 백업이 아니다. 실제 자료 수신/외부 보호자 접속은 열지 않는다.
- 제품 흐름: [전체 완료표](communication-acceptance.md)의 P0 사람/실물 관측·메시지 정책 확인 후 API/화면·독립 기기 전달/재접속 연결은 마지막, P2는 관찰 필요성이 있는 것부터 진행한다.

운영 전환 정책을 시험 중계로 대신하지 않았으며 이 단계만으로 전체 개편안을 완료 처리하지 않았다.
