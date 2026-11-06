import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { syntheticSessionOptions } from '../server/synthetic-e-session-options.mjs';
import { syntheticWifiNetwork } from '../server/synthetic-wifi-network.mjs';
import { syntheticWifiTcpBlockRule } from '../server/synthetic-wifi-exception-policy.mjs';
import { writeSyntheticWifiDiagnostic } from '../server/synthetic-wifi-diagnostic.mjs';

export function syntheticWifiCliOptions(args) {
  try {
    if (!Array.isArray(args) || ![12, 14].includes(args.length) || args.some(value => typeof value !== 'string') ||
        args[0] !== '--host' || args[2] !== '--peer' || args[4] !== '--interface-index' ||
        !/^[1-9][0-9]{0,8}$/.test(args[5]) || args[6] !== '--confirm-private-wifi') throw Error();
    let temporaryTcpBlockRule;
    if (args.length === 14) {
      if (args[12] !== '--temporary-tcp-block-rule') throw Error();
      temporaryTcpBlockRule = syntheticWifiTcpBlockRule(args[13]);
    }
    const selected = syntheticSessionOptions(args.slice(7, 12));
    if (selected.mode !== 'ephemeral') throw Error();
    return Object.freeze({ postgresArgs: selected.postgresArgs, powershell: selected.postgresArgs[3],
      interfaceIndex: Number(args[5]), network: syntheticWifiNetwork({ host: args[1], peerAddress: args[3],
        port: 8443, confirmSynthetic: true }),
      ...(temporaryTcpBlockRule === undefined ? {} : { temporaryTcpBlockRule }) });
  } catch { throw new Error('SYNTHETIC_WIFI_CLI_CONFIGURATION'); }
}

async function loadRuntime() {
  const [certificate, lease, session] = await Promise.all([
    import('../server/synthetic-wifi-certificate.mjs'), import('../server/synthetic-wifi-lease.mjs'),
    import('../server/windows-synthetic-wifi-session.mjs'),
  ]);
  return { ...certificate, ...lease, ...session };
}
async function publishCertificate(material) {
  // Only a public DER root is written. No leaf/private key, login credential,
  // environment dump or web session is persisted by this CLI.
  const directory = await mkdtemp(join(tmpdir(), 'carebridge-public-certificate-'));
  const path = join(directory, 'Carebridge-Synthetic-WiFi.cer');
  await writeFile(path, material.publicCertificate, { flag: 'wx', mode: 0o600 });
  return path;
}

export async function runSyntheticWifiApi(args, { input = process.stdin, output = process.stdout,
  diagnostic = process.stderr, target = process, runtime = loadRuntime, publish = publishCertificate,
  persistDiagnostic = writeSyntheticWifiDiagnostic } = {}) {
  let options;
  try {
    options = syntheticWifiCliOptions(args);
    if (!input.isTTY || !output.isTTY) throw Error();
  } catch {
    target.exitCode = 1;
    diagnostic.write('개인 Wi-Fi 시험은 직접 사용하는 터미널에서만 실행합니다.\n사용법: node scripts/synthetic-wifi-api.mjs --host <PC IPv4> --peer <아이폰 IPv4> --interface-index <Wi-Fi 번호> --confirm-private-wifi --base <E 기본 경로> --powershell <pwsh.exe 절대경로> --confirm-synthetic-e-drive [--temporary-tcp-block-rule <별도 승인한 기존 TCP 차단 규칙의 정확한 Name>]\n');
    return;
  }
  let material, lease, session, stopRequested = false, failed = false, closing, restarted, leaseWasReady = false;
  const diagnosticEvents = new Set();
  let command = '', discard = false, inputOwned = false, ended = false;
  let stopResolve;
  const requested = new Promise(resolveStop => { stopResolve = resolveStop; });
  const keepAlive = setInterval(() => {}, 60000);
  const warn = text => { failed = true; target.exitCode = 1; try { diagnostic.write(text); } catch {} };
  const check = () => { if (stopRequested || !input.isTTY || !output.isTTY) throw Error('SYNTHETIC_WIFI_CANCELLED'); };
  const forget = () => { session?.forgetCredentials(); material?.key.fill(0); };
  const recordDiagnostic = async event => {
    if (!lease || diagnosticEvents.has(event)) return;
    diagnosticEvents.add(event); // At most one uncertain and one confirmed close artifact.
    try {
      const path = await persistDiagnostic(event, lease.diagnostics);
      output.write(`시험 단계 진단 파일: ${path}\n이 파일은 상태 관측용이며 관리자 승인·정리 완료를 대신 증명하지 않습니다.\n`);
    } catch {
      // Diagnostic IO must not change admission, ownership, cleanup or retry.
      try { diagnostic.write('시험 단계 진단 파일을 저장하지 못했습니다. 원본 오류나 계정 정보는 출력하지 않습니다.\n'); } catch {}
    }
  };
  const cleanup = () => {
    if (closing) return closing;
    closing = (async () => {
      try { forget(); } catch { failed = true; }
      // Ask both boundaries to stop even if one cannot yet confirm cleanup.
      // No forced process kill, recursive deletion or unowned rule cleanup.
      const result = await Promise.allSettled([
        Promise.resolve().then(() => lease?.close()), Promise.resolve().then(() => session?.close()),
      ]);
      if (result.some(value => value.status === 'rejected')) throw Error();
      if (session && session.status().phase !== 'stopped') throw Error();
      if (session && result[1].value?.failed) failed = true;
      ended = true; clearInterval(keepAlive);
      input.off('data', onInput); input.off('end', stop); input.off('error', inputError);
      if (inputOwned && input.listenerCount('data') === 0) input.pause?.();
      target.off('SIGINT', stop); target.off('SIGTERM', stop);
      if (failed) target.exitCode = 1;
      // Best-effort observation is not on the cleanup/retry critical path.
      // A stalled filesystem must not retain ownership or delay status output.
      void recordDiagnostic('cleanup-confirmed');
      output.write('\n시험 종료: HTTPS·작업자·DB 및 임시 방화벽 정리를 확인했습니다. 공개 인증서 파일과 가상 진단 자료만 보존합니다. 아이폰에 설치한 시험 프로파일은 직접 삭제하세요.\n');
    })().catch(() => {
      void recordDiagnostic('cleanup-unconfirmed');
      warn('종료가 아직 확인되지 않았습니다. 이 창을 닫지 말고 Ctrl+C로 정리를 재확인하세요. 기존 파일·규칙을 임의 삭제하지 않습니다.\n');
    }).finally(() => { closing = undefined; });
    return closing;
  };
  function stop() {
    stopRequested = true; stopResolve();
    // During preparation the outer finally owns the remaining allocation.
    // Once interactive, repeated Ctrl+C retries an unconfirmed cleanup.
    if (inputOwned) void cleanup();
    else {
      // Cancellation must reach an owned UAC/preparation lease immediately,
      // not wait for ready (which itself may be waiting for user approval).
      if (lease) void Promise.resolve().then(() => lease.close()).catch(() => {});
      if (session) void Promise.resolve().then(() => session.close()).catch(() => {});
    }
  }
  function inputError() { warn('터미널 입력을 확인하지 못해 시험을 종료합니다.\n'); stop(); }
  async function restart() {
    if (stopRequested || restarted || !session) return;
    restarted = Promise.resolve().then(() => session.restartApi()).then(result => {
      if (!stopRequested) output.write(`API 재시작 완료: ${result.origin}\n같은 가상 계정으로 다시 로그인하세요.\n`);
    }).catch(() => { warn('API 재시작을 확인하지 못해 시험을 종료합니다.\n'); stop(); }).finally(() => { restarted = undefined; });
  }
  function onInput(chunk) {
    if (stopRequested) return;
    try {
      check(); const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      if (!Buffer.isBuffer(bytes)) throw Error();
      for (const byte of bytes) {
        if (byte === 10 || byte === 13) {
          const action = discard ? '' : command.trim().toLowerCase(); command = ''; discard = false;
          if (action === 'r') void restart(); else if (action === 'q') stop();
        } else if (!discard) {
          if (![32, 81, 82, 113, 114].includes(byte) || command.length >= 16) { command = ''; discard = true; }
          else command += String.fromCharCode(byte);
        }
      }
    } catch { inputError(); }
  }
  target.on('SIGINT', stop); target.on('SIGTERM', stop);
  try {
    output.write('Carebridge 개인 Wi-Fi 가상 시험을 준비합니다. 실제 아동 자료는 입력하지 마세요.\n방화벽 도우미에만 Windows 관리자 승인이 필요합니다. 앱과 DB는 일반 권한으로 실행합니다.\n');
    const tools = await runtime(); check();
    material = await tools.generateSyntheticWifiCertificate({ host: options.network.host, powershell: options.powershell }); check();
    const certificatePath = await publish(material); check();
    output.write(`\n아이폰 설치용 공개 인증서: ${certificatePath}\nSHA-256: ${material.fingerprint}\n인증서 유효기한(UTC): ${material.expiresAt}\n`);
    output.write('인증서 설치/신뢰는 아이폰에서 직접 진행하며, 경고를 무시하여 접속하지 마세요. 시험 뒤 설치한 Carebridge 시험 프로파일을 삭제하세요.\n');
    if (options.temporaryTcpBlockRule !== undefined) {
      output.write('별도 승인된 기존 TCP 차단 규칙 하나의 8443 임시 예외 모드입니다. 다른 포트·주소의 차단을 유지하며, 종료 시 원상복구 확인 전에는 정리 완료로 표시하지 않습니다.\n');
    }
    lease = tools.createSyntheticWifiLease({ network: options.network, powershell: options.powershell,
      interfaceIndex: options.interfaceIndex, maxLifetimeSeconds: 7200,
      ...(options.temporaryTcpBlockRule === undefined ? {} : { temporaryTcpBlockRule: options.temporaryTcpBlockRule }) });
    void lease.waitForStop().then(result => {
      if (!stopRequested) {
        if (result?.stage === 'failed') warn(leaseWasReady
          ? '실행 중 방화벽 시험 경계를 유지하지 못해 종료합니다.\n'
          : '관리자 요청·방화벽 준비를 확인하지 못해 중단합니다. 앱과 DB는 시작하지 않았습니다.\n');
        stop();
      }
    }, () => { if (!stopRequested) { warn(leaseWasReady
      ? '실행 중 방화벽 시험 경계를 확인하지 못해 종료합니다.\n'
      : '관리자 요청·방화벽 준비를 확인하지 못해 중단합니다. 앱과 DB는 시작하지 않았습니다.\n'); stop(); } });
    await lease.ready; check(); leaseWasReady = true;
    session = tools.createWindowsSyntheticWifiSession({ postgresArgs: options.postgresArgs, network: options.network,
      cert: material.cert, key: material.key });
    material.key.fill(0);
    const ready = await session.ready; check();
    output.write(`\n접속 주소: ${ready.origin}\n허용한 아이폰 한 대와 이 PC에서만 사용하세요. 유효 시간은 최대 2시간입니다.\n`);
    try {
      for (const account of session.credentials) {
        check();
        output.write(`\n${account.role === 'therapist' ? '가상 치료사' : '가상 보호자'}\n이메일: ${account.email}\n시험 비밀번호: ${account.password}\n`);
      }
    } finally { session.forgetCredentials(); }
    inputOwned = true; input.on('data', onInput); input.on('end', stop); input.on('error', inputError);
    output.write('\nr + Enter: API 재시작 · q + Enter 또는 Ctrl+C: 종료\n이번 Wi-Fi 시험은 전체 종료 후 재개되지 않습니다. 기존 PC 전용 재개 모드는 변경하지 않았습니다.\n');
    await Promise.race([requested, session.waitForStop()]);
  } catch {
    if (!stopRequested) warn('Wi-Fi 시험 준비에 실패했습니다. 네트워크·관리자 승인·기존 방화벽 규칙·로컬 런타임을 확인해야 합니다. 개인정보나 내부 오류는 출력하지 않습니다.\n');
  } finally {
    stopRequested = true;
    await cleanup();
    // An unconfirmed close keeps the process/ownership and Ctrl+C retry alive.
    if (!ended) inputOwned = true;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runSyntheticWifiApi(process.argv.slice(2));
