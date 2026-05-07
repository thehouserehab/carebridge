"use client";

import { useMemo, useState } from "react";
import { answerOptions, categories, questions, type CategoryKey } from "@/lib/checklist";
import { buildRuleBasedAnalysis, calculateScores, type AnalysisResult, type Answers, type ScoreResult } from "@/lib/scoring";

type View = "landing" | "checklist" | "result";

type ApiResult = {
  mode: "rule-based" | "openai" | "fallback";
  scoreResult: ScoreResult;
  analysis: AnalysisResult;
};

export default function SelfCheckApp() {
  const [view, setView] = useState<View>("landing");
  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState<Answers>({});
  const [result, setResult] = useState<ApiResult | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const currentCategory = categories[step];
  const currentQuestions = questions.filter((question) => question.category === currentCategory.key);
  const answeredCount = Object.keys(answers).length;
  const progress = Math.round((answeredCount / questions.length) * 100);

  const previewScores = useMemo(() => calculateScores(answers), [answers]);

  function setAnswer(id: number, value: number) {
    setAnswers((previous) => ({ ...previous, [id]: value }));
  }

  function canMoveNext() {
    return currentQuestions.every((question) => answers[question.id] !== undefined);
  }

  async function submit() {
    setIsLoading(true);
    try {
      const response = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          answers,
          workInfo: {
            target: "제작 중심형 1인 꽃집",
            purpose: "작업환경 개선 우선순위 도출"
          }
        })
      });

      if (!response.ok) throw new Error("분석 API 호출 실패");
      const data = (await response.json()) as ApiResult;
      setResult(data);
    } catch (error) {
      console.error(error);
      const scoreResult = calculateScores(answers);
      setResult({
        mode: "fallback",
        scoreResult,
        analysis: buildRuleBasedAnalysis(scoreResult)
      });
    } finally {
      setIsLoading(false);
      setView("result");
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  }

  function reset() {
    setAnswers({});
    setResult(null);
    setStep(0);
    setView("landing");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  return (
    <main>
      {view === "landing" && <Landing onStart={() => setView("checklist")} />}

      {view === "checklist" && (
        <section className="survey-screen page-shell">
          <HeaderKicker kicker="SELF CHECKLIST" title="꽃집 작업환경 자가진단" />

          <div className="survey-layout">
            <aside className="survey-side card-dark">
              <p className="side-label">진행률</p>
              <strong>{progress}%</strong>
              <div className="progress-track">
                <span style={{ width: `${progress}%` }} />
              </div>
              <p className="side-copy">총 {questions.length}문항 중 {answeredCount}문항 응답</p>

              <div className="mini-score-list">
                {previewScores.categoryScores.map((category) => (
                  <div key={category.key}>
                    <span>{category.title}</span>
                    <b>{category.score}/9</b>
                  </div>
                ))}
              </div>
            </aside>

            <div className="survey-main panel-light">
              <div className="step-header">
                <span>STEP {step + 1} / {categories.length}</span>
                <h2>{currentCategory.title}</h2>
                <p>{currentCategory.description}</p>
              </div>

              <div className="question-stack">
                {currentQuestions.map((question) => (
                  <article className="question-card" key={question.id}>
                    <div className="question-title">
                      <span>Q{question.id}</span>
                      <h3>{question.text}</h3>
                    </div>
                    <div className="option-grid" role="radiogroup" aria-label={question.text}>
                      {answerOptions.map((option) => {
                        const selected = answers[question.id] === option.value;
                        return (
                          <button
                            key={option.value}
                            className={selected ? "option selected" : "option"}
                            onClick={() => setAnswer(question.id, option.value)}
                            type="button"
                          >
                            <span>{option.label}</span>
                            <b>{option.value}</b>
                          </button>
                        );
                      })}
                    </div>
                    <p className="intent">평가 의도: {question.intent}</p>
                  </article>
                ))}
              </div>

              <div className="button-row">
                <button className="ghost-button" type="button" onClick={() => (step === 0 ? setView("landing") : setStep(step - 1))}>
                  이전
                </button>
                {step < categories.length - 1 ? (
                  <button className="primary-button" type="button" disabled={!canMoveNext()} onClick={() => setStep(step + 1)}>
                    다음 영역
                  </button>
                ) : (
                  <button className="primary-button" type="button" disabled={!canMoveNext() || isLoading} onClick={submit}>
                    {isLoading ? "분석 중..." : "결과 분석하기"}
                  </button>
                )}
              </div>
            </div>
          </div>
        </section>
      )}

      {view === "result" && result && <ResultView result={result} onReset={reset} />}
    </main>
  );
}

function Landing({ onStart }: { onStart: () => void }) {
  return (
    <>
      <section className="hero page-shell">
        <p className="top-label">FLORIST WORK ENVIRONMENT SCREENING</p>
        <div className="bracket-title">
          <p>작업환경이 신체 부담을 결정합니다</p>
          <h1>꽃집 작업환경 자가진단 시스템</h1>
        </div>

        <div className="hero-visual">
          <div className="hero-image" aria-hidden="true">
            <div className="worktable" />
            <div className="flower-dot dot-1" />
            <div className="flower-dot dot-2" />
            <div className="flower-dot dot-3" />
          </div>
        </div>

        <div className="hero-band">
          <div>
            <strong>RULA 기반</strong>
            <span>상지·목·몸통 부담요인 참고</span>
          </div>
          <i />
          <div>
            <strong>자가진단형</strong>
            <span>전문가 없이 3분 내 입력</span>
          </div>
          <i />
          <div>
            <strong>AI 개선안</strong>
            <span>결과에 따른 우선순위 제시</span>
          </div>
        </div>

        <button className="primary-button hero-button" onClick={onStart} type="button">
          자가진단 시작하기
        </button>
      </section>

      <section className="page-shell section-gap">
        <HeaderKicker kicker="SCREENING AREAS" title="7가지 평가 영역" />
        <div className="domain-grid">
          {categories.map((category, index) => (
            <article className="domain-card" key={category.key}>
              <span>{String(index + 1).padStart(2, "0")}</span>
              <h3>{category.title}</h3>
              <p>{category.description}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="page-shell section-gap">
        <HeaderKicker kicker="SYSTEM INFRASTRUCTURE" title="자동 분석 구조" />
        <div className="feature-list">
          {[
            ["체크리스트 입력", "21개 문항에 사용자가 직접 응답합니다."],
            ["점수 자동 계산", "총점과 영역별 점수를 코드가 직접 산출합니다."],
            ["위험도 분류", "낮음·주의·높음·매우 높음으로 구분합니다."],
            ["AI 결과 분석", "고위험 영역의 원인과 개선 방향을 문장화합니다."],
            ["개선 우선순위", "즉시 가능·저비용·구조 변경 개선안을 나눠 제시합니다."]
          ].map(([title, body], index) => (
            <article className="feature-row" key={title}>
              <div>
                <h3>{title}</h3>
                <p>{body}</p>
              </div>
              <b>{index + 1}</b>
            </article>
          ))}
        </div>
      </section>

      <section className="page-shell section-gap">
        <HeaderKicker kicker="STEP GUIDE" title="3분이면 끝나는 자가진단" />
        <div className="step-guide">
          {[
            ["STEP 1.", "체크리스트 입력", "작업 자세와 환경 문항에 응답합니다."],
            ["STEP 2.", "자동 점수화", "영역별 점수와 전체 위험도를 계산합니다."],
            ["STEP 3.", "결과 확인", "AI 기반 작업환경 개선안을 확인합니다."]
          ].map(([stepName, title, body]) => (
            <article key={stepName} className="step-card card-dark">
              <span>{stepName}</span>
              <h3>{title}</h3>
              <p>{body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="page-shell section-gap final-cta">
        <HeaderKicker kicker="NOTICE" title="진단이 아니라 개선 우선순위입니다" />
        <p>
          본 시스템은 공식 RULA 평가를 대체하지 않습니다. 결과는 꽃집 작업환경의 부담요인을 선별하고,
          어떤 공간·도구·동선을 먼저 개선해야 하는지 파악하기 위한 참고자료입니다.
        </p>
        <button className="primary-button" onClick={onStart} type="button">
          지금 자가진단하기
        </button>
      </section>
    </>
  );
}

function ResultView({ result, onReset }: { result: ApiResult; onReset: () => void }) {
  const { scoreResult, analysis } = result;

  return (
    <section className="result-screen page-shell">
      <HeaderKicker kicker="ANALYSIS REPORT" title="자가진단 결과 리포트" />

      <div className="result-hero card-dark">
        <p>당신의 작업환경 유형은</p>
        <h1>{analysis.resultTitle}</h1>
        <span>전체 위험도: {scoreResult.overallRisk} · {scoreResult.totalScore}/{scoreResult.maxScore}점</span>
      </div>

      <div className="result-grid">
        <section className="panel-light result-summary">
          <h2>AI 분석 요약</h2>
          <p>{analysis.summary}</p>
          <ul>
            {analysis.mainRisks.map((risk) => (
              <li key={risk}>{risk}</li>
            ))}
          </ul>
        </section>

        <section className="panel-light score-panel">
          <h2>영역별 점수</h2>
          <div className="score-bars">
            {scoreResult.categoryScores.map((category) => (
              <div className="score-bar" key={category.key}>
                <div>
                  <span>{category.title}</span>
                  <b>{category.score}/9 · {category.risk}</b>
                </div>
                <em><i style={{ width: `${(category.score / category.maxScore) * 100}%` }} /></em>
              </div>
            ))}
          </div>
        </section>
      </div>

      <section className="page-section">
        <HeaderKicker kicker="PRIORITY ACTIONS" title="개선 우선순위" />
        <div className="priority-grid">
          {analysis.priorityActions.map((action) => (
            <article className="priority-card" key={action.priority}>
              <span>{action.priority}</span>
              <h3>{action.target}</h3>
              <p>{action.recommendation}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="action-layout">
        <ActionBox title="즉시 가능한 개선" items={analysis.quickActions} />
        <ActionBox title="저비용 개선" items={analysis.lowCostActions} />
        <ActionBox title="구조 변경 개선" items={analysis.structuralActions} />
      </section>

      <section className="warning-box">
        <strong>주의사항</strong>
        <p>{analysis.warning}</p>
        <small>분석 모드: {result.mode}</small>
      </section>

      <div className="button-row center">
        <button className="ghost-button" onClick={() => window.print()} type="button">결과 인쇄</button>
        <button className="primary-button" onClick={onReset} type="button">처음으로</button>
      </div>
    </section>
  );
}

function ActionBox({ title, items }: { title: string; items: string[] }) {
  return (
    <article className="action-box panel-light">
      <h3>{title}</h3>
      <ul>
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </article>
  );
}

function HeaderKicker({ kicker, title }: { kicker: string; title: string }) {
  return (
    <header className="section-header">
      <span>{kicker}</span>
      <h2>{title}</h2>
    </header>
  );
}
