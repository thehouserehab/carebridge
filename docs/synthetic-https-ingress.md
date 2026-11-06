# 가상 두 기기 시험을 위한 HTTPS 연결부

작성일: 2026-10-11. **준비 코드이며 개인 Wi-Fi 접속을 활성화한 상태가 아니다.**

## 현재 상태

아이폰의 Wi-Fi IPv4는 사용자에게 확인했다. 실제 주소는 소스·시험·문서에 저장하지 않는다. PC 네트워크의 Windows 분류는 앞선 읽기 전용 조회에서 `Public`이었다. 같은 개인 Wi-Fi의 가상 시험 허용과 별개로, 지정 기기만 접근하는 임시 방화벽·HTTPS 신뢰 설정의 구체적인 활성화 범위는 확인 대기다.

이번 변경은 기존 인증·도메인 서비스를 직접 사용하는 HTTPS 연결부와 PC 내부 검증에 한정한다. 공개 배포, E 실행기, DB 자격증명, Windows 네트워크 분류, 방화벽, 공유기·DNS·포트포워딩, 인증서 저장소를 바꾸지 않았다. 실제 자료 수집과 공개 인터넷 접속은 계속 보류한다.

## 변경과 설계 이유

| 파일 | 변경 |
| --- | --- |
| `server/synthetic-https-transport.mjs` | 명시적인 시험 설정, 짧은 인증서 유효기간, 실제 TLS 소켓과 요청 출처 검사 |
| `server/local-api-listener.mjs` | 별도 `createSyntheticHttpsApiListener` 추가. 기존 HTTP 기본값은 유지. 같은 API·고정 정적 파일·종료 대기 재사용 |
| `server/local-api-http.mjs` | 신뢰된 연결부가 있을 때만 HTTPS 허용. 세션·이메일 nonce·초대 수락·로그아웃 쿠키에 `Secure` 적용 |
| `local-api/app.js` | 향후 서버가 개인 Wi-Fi 시험 모드를 지정하면 안내 문구도 해당 범위로 표시. 역할·권한과는 무관 |
| `server/tests/synthetic-https-*.test.mjs` | 루프백 TLS 경계 및 실제 메모리 DB 이메일 인증 시험 |
| `server/tests/synthetic-https-certificate-fixture.{mjs,ps1}` | PowerShell 7에서 메모리 인증서를 생성해 Node 자식 프로세스 파이프로만 전달 |

중간 HTTP 프록시 없이 같은 요청 객체를 기존 API에 전달한다. Origin·쿠키·업로드 본문을 변환하지 않으며, IP가 맞거나 TLS가 성립했다는 이유로 로그인·담당 관계 검사를 건너뛰지 않는다. 세션의 서버 역할·센터·아동 관계가 계속 접근 권한의 근거다.

### 연결 경계

- 기존 `createLocalApiListener`는 여전히 IPv4 루프백 HTTP 전용이다. `host`, `origin`, `transport` 등의 추가 옵션으로 확장할 수 없다.
- 새 연결부는 `confirmSynthetic: true`와 모든 정확한 설정 항목을 요구한다. `loopback-verification`은 양쪽 주소 모두 루프백만, `private-wifi`는 서로 다른 명시적 사설 IPv4만 받는다. 전체 인터페이스·공인 IP·DNS 주소를 허용하지 않는다.
- 생성한 서버에서 실제 TLS 핸드셰이크를 마친 소켓만 인정한다. 실제 로컬 IP·포트, 원격 IP, 정확한 Host·Origin, 요청 방법·경로, 중복 보안 헤더, 프록시 헤더를 검사한다. 허용 IP는 PC 자신과 지정 시험 기기뿐이며 사용자 인증을 대체하지 않는다.
- TLS 1.2 이상, 개인키와 인증서의 일치, 서버 인증 용도, 정확한 IP SAN, CA가 아닌 서버 인증서, RSA 2048 이상 또는 제한된 EC 곡선, 최대 48시간의 인증서 유효기간을 요구한다. 요청 시점에도 유효기간을 다시 확인한다.
- POST는 정확한 Origin과 기존 CSRF 의도 헤더를 요구한다. CORS 우회, X-Forwarded-Proto에 따른 `Secure` 판정, 공개 인증 경로, 임의 정적 파일 경로는 없다.
- Range 요청은 기존 계약대로 전체 파일 200 응답이다. 부분 전송·영상 탐색 최적화가 새로 구현된 것은 아니다.

### 종료와 자원 소유권

리스너 종료는 새 요청을 막고, 핸드셰이크 전 TCP와 기존 소켓을 닫고, 진행 API 처리 및 실제 첨부 열기·스트림 해제를 기다린다. 시간 초과를 정상 정리로 보고하지 않으며 호출자가 자원을 유지하고 재시도해야 한다.

HTTPS는 새로운 독립 `MediaAccess` 수명을 요구한다. 다른 HTTP/HTTPS 연결부와 공유하거나 이미 종료한 객체를 재사용할 수 없다. 기존 HTTP끼리의 계약은 유지하지만, 새 HTTPS와 혼용할 수 없도록 소유자 집합과 사용 이력을 기록한다. 시작 실패는 자신의 소유권만 정리한다. 동시 시작 중 다른 HTTP 소유권까지 삭제하던 초기 구현 문제는 이 방식으로 수정했다.

Node 24의 HTTPS 서버는 이 경로에서 `PrivateKeyObject`를 직접 받지 않는다. 생성 직전에 PEM Buffer로 변환하고 `finally`에서 그 Buffer를 지운다. JS 문자열·TLS 내부 객체까지 RAM에서 완전히 소거한다는 보장은 하지 않는다. 이 변경은 키 보관·재개 정책을 대체하지 않는다. [Node HTTPS](https://nodejs.org/api/https.html#httpscreateserveroptions-requestlistener), [Node TLS](https://nodejs.org/api/tls.html), [인증서 검사 API](https://nodejs.org/api/crypto.html#class-x509certificate).

## 검증 방법과 증거

새 시험은 Windows와 명시적인 PowerShell 7 실행 경로가 필요하다. 환경변수를 지정하지 않은 일반 테스트에서는 이유를 표시하고 생략한다. 명시한 경로가 잘못된 경우에는 실패하며 PATH에서 대체 프로그램을 자동 선택하지 않는다.

```powershell
# 실제 설치를 확인한 PowerShell 7 실행 파일의 절대 경로로 지정한다.
$env:CAREBRIDGE_TEST_POWERSHELL = 'C:/absolute/path/to/pwsh.exe'
node --test --test-concurrency=1 --test-reporter=tap server/tests/synthetic-https-transport.test.mjs server/tests/synthetic-https-email-login.test.mjs
```

인증서는 RSA 2048/SHA-256, 루프백과 가상의 사설 시험 주소 SAN, 약 31분의 유효기간으로 프로세스 메모리에서 생성한다. 인증서·키 파일 저장 및 OS 신뢰 등록은 없다. 요청마다 해당 시험 인증서만 CA로 전달하며 인증서 검증을 끄지 않는다. 실제 iPhone용 설치 인증서나 신뢰 프로파일로 재사용하지 않는다.

확인 범위:

- 인증서·호스트명 검증 성공, 신뢰하지 않은 인증서·다른 호스트명·오래된 TLS 거절.
- 다른 루프백 원격 주소, 잘못된 Host·Origin·CSRF·프록시/중복 헤더, 프로토콜 전환 거절.
- 무인증·다른 계정 사전조건 차단, 기존 서버 역할 유지, HTTPS 쿠키 설정과 삭제.
- 실제 메모리 PostgreSQL/Auth에서 이메일 요청→내부 시험 메일함→코드 검증→보호자/센터/소속 없는 계정→세션→로그아웃. 실제 메일 발송은 아님.
- 원본 업로드 바이트와 전체 첨부 응답 보존, 인증 전 첨부 열기 없음.
- 인증 처리 중 종료, TLS 핸드셰이크 전 종료, 연결이 끊어진 뒤 늦은 첨부 열기·비동기 정리 대기.
- 전송 객체 재사용·포트 충돌, HTTP/HTTPS 첨부 수명 혼용, 실패한 HTTP와 성공한 HTTP의 동시 시작 경합.

최종 집중 회귀는 **348/348 통과, 실패·취소·생략 0**, 실제 종료 코드 0이었다. 증거는 `test-results/synthetic-https-regression-20261011.tap`이며 새 HTTPS 시험 19개와 아래 기존 329개를 포함한다. 전체 저장소/native 시험 전부를 실행한 결과는 아니다.

```powershell
node --test --test-concurrency=1 --test-reporter=tap `
  server/tests/synthetic-https-transport.test.mjs server/tests/synthetic-https-email-login.test.mjs `
  server/tests/local-api-listener.test.mjs server/tests/local-api-http.test.mjs server/tests/local-api-sandbox.test.mjs `
  server/tests/local-email-login-http.test.mjs server/tests/local-invitations-http.test.mjs `
  server/tests/local-recovery-listener.test.mjs server/tests/local-recovery-http.test.mjs `
  server/tests/local-media-http.test.mjs server/tests/local-media-content-http.test.mjs server/tests/local-media-delivery.test.mjs `
  server/tests/local-care-http.test.mjs server/tests/local-message-http.test.mjs `
  server/tests/local-operations-http.test.mjs server/tests/local-self-profile-http.test.mjs `
  server/tests/windows-local-api-service.test.mjs tests/local-api-client.test.mjs `
  tests/local-product-ui.test.mjs tests/local-email-login-ui.test.mjs tests/local-approval-pending-ui.test.mjs
```

`node scripts/check.mjs`와 `node scripts/build.mjs`도 실제 종료 0으로 통과했다. 공개 빌드는 기존 정적 화면만 포함하며 배포하지 않았다. `git diff --check` 통과(기존 LF→CRLF 안내만 출력). Windows 실행기 검사는 순수 service 테스트이며 이번에 E native 서버를 실행했다는 뜻은 아니다. 종료 후 읽기 전용 조회에서 8443 리스너와 Carebridge 이름의 방화벽 규칙은 없었다.

초기 검증에서 다른 Host를 지정한 Node 시험 클라이언트가 그 Host를 SNI로 사용해 HTTP 403 전에 인증서 검증에서 연결을 끊었다. 보안 검사를 완화하지 않고 시험 클라이언트의 SNI를 명시해 IP 검증과 HTTP Host 차단 검사를 분리했다. 다른 TLS 호스트명 거절 시험은 별도로 유지한다.

## 활성화 전 남은 일

1. **범위 승인:** PC의 시험용 TCP 8443에 지정 아이폰만 임시 접근, 가상 자료 전용, 사용자에 의한 인증서 신뢰 설치·시험 후 해제, 종료 후 방화벽/리스너 정리. 네트워크 분류 변경이나 공개 접속 허용으로 확대하지 않는다.
2. **실행기 통합:** 아직 CLI·E 실행기는 새 factory를 호출하지 않는다. 한 세션에서 연결부 하나만 선택하고, 실제 PC 주소와 기기 주소의 재확인, 인증서 생성/전달/보관/폐기, 실패 중단·정리, 프로세스 간 상태 확인을 연결해야 한다. 기존 PostgreSQL용 인증서를 웹 인증서로 재사용하지 않는다.
3. **사용자 기기:** 승인된 방식으로 별도 시험용 인증서 신뢰를 설치하고 종료 후 해제한다. 시험용 helper의 루프백 인증서를 설치하거나 Safari 경고를 무시하는 방식은 사용하지 않는다.
4. **실물 검증:** PC↔아이폰의 서로 다른 시험 계정으로 메시지·사진·영상 수신, 권한 경계, Wi-Fi 단절·재접속, 화면 복원과 로그아웃을 실제로 확인한다. 현재 시험은 이 성공의 증거가 아니다.
5. **운영 준비:** 독립 백업·복구, 운영 책임, 실제 계정/메일, 민감정보 처리 검토가 남아 있다. 이 로컬 준비를 실서비스 보안·전체 국내 통제 완료로 표현하지 않는다.

실제 아이폰 Safari/인증서 신뢰·네트워크 방화벽·E native 실행기·영상 재생과 사람 사용성은 이번에 검증하지 않았다. 이 문서는 P1 준비 진행을 기록하며 전체 개편 완료 판정은 아니다.
