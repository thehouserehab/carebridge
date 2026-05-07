import { categories, CategoryKey, questions } from "./checklist";

export type Answers = Record<number, number>;

export type RiskLevel = "낮음" | "주의" | "높음" | "매우 높음";

export type CategoryScore = {
  key: CategoryKey;
  title: string;
  score: number;
  maxScore: number;
  risk: RiskLevel;
  description: string;
};

export type ScoreResult = {
  totalScore: number;
  maxScore: number;
  overallRisk: RiskLevel;
  categoryScores: CategoryScore[];
  highRiskCategories: CategoryScore[];
  answeredCount: number;
};

export type AnalysisResult = {
  resultTitle: string;
  summary: string;
  mainRisks: string[];
  priorityActions: { priority: number; target: string; recommendation: string }[];
  quickActions: string[];
  lowCostActions: string[];
  structuralActions: string[];
  warning: string;
};

export function getCategoryRisk(score: number): RiskLevel {
  if (score <= 2) return "낮음";
  if (score <= 5) return "주의";
  if (score <= 7) return "높음";
  return "매우 높음";
}

export function getOverallRisk(totalScore: number): RiskLevel {
  if (totalScore <= 15) return "낮음";
  if (totalScore <= 30) return "주의";
  if (totalScore <= 45) return "높음";
  return "매우 높음";
}

export function calculateScores(answers: Answers): ScoreResult {
  const categoryScores = categories.map((category) => {
    const categoryQuestions = questions.filter((question) => question.category === category.key);
    const score = categoryQuestions.reduce((sum, question) => sum + (answers[question.id] ?? 0), 0);

    return {
      key: category.key,
      title: category.title,
      score,
      maxScore: categoryQuestions.length * 3,
      risk: getCategoryRisk(score),
      description: category.description
    };
  });

  const totalScore = categoryScores.reduce((sum, category) => sum + category.score, 0);
  const maxScore = questions.length * 3;
  const highRiskCategories = categoryScores
    .filter((category) => category.risk === "높음" || category.risk === "매우 높음")
    .sort((a, b) => b.score - a.score);

  return {
    totalScore,
    maxScore,
    overallRisk: getOverallRisk(totalScore),
    categoryScores,
    highRiskCategories,
    answeredCount: Object.keys(answers).length
  };
}

export function buildRuleBasedAnalysis(scoreResult: ScoreResult): AnalysisResult {
  const top = scoreResult.categoryScores.slice().sort((a, b) => b.score - a.score).slice(0, 3);
  const title = top
    .filter((item) => item.score >= 6)
    .map((item) => toTypeLabel(item.key))
    .slice(0, 2)
    .join(" + ") || "작업환경 점검형";

  const mainRisks = top.map((item) => `${item.title} 영역의 위험도는 '${item.risk}'이며, ${item.description}`);
  const actions = makeActions(top.map((item) => item.key));

  return {
    resultTitle: title,
    summary: `전체 위험도는 '${scoreResult.overallRisk}'입니다. 특히 ${top
      .map((item) => item.title)
      .join(", ")} 영역을 우선적으로 확인해야 합니다. 본 결과는 공식 RULA 평가를 대체하지 않고, 작업환경 개선 우선순위를 잡기 위한 참고자료입니다.`,
    mainRisks,
    priorityActions: actions.priorityActions,
    quickActions: actions.quickActions,
    lowCostActions: actions.lowCostActions,
    structuralActions: actions.structuralActions,
    warning: "본 결과는 의학적 진단이 아니라 작업환경 개선을 위한 자가진단형 스크리닝 결과입니다. 통증이 지속되거나 악화되는 경우 의료 전문가와 상담해야 합니다."
  };
}

function toTypeLabel(key: CategoryKey): string {
  const labels: Record<CategoryKey, string> = {
    neck: "목 굽힘형",
    shoulderArm: "팔 뻗기 부담형",
    wristHand: "손목 반복작업형",
    trunkBack: "허리 굽힘형",
    standing: "장시간 기립형",
    loadHandling: "중량물 취급형",
    workflow: "동선 혼잡형"
  };
  return labels[key];
}

function makeActions(keys: CategoryKey[]) {
  const map: Record<CategoryKey, { target: string; recommendation: string; quick: string; low: string; structural: string }> = {
    neck: {
      target: "작업물 높이와 시선 위치",
      recommendation: "꽃다발 제작 높이를 팔꿈치와 가슴 사이 수준으로 올리고, 작업대 조명을 보강합니다.",
      quick: "작업물을 몸 쪽으로 당기고 고개 숙임을 줄입니다.",
      low: "작업대 위 받침대 또는 높이 조절 보조대를 사용합니다.",
      structural: "제작 작업대 높이를 재조정하고 조명을 작업면 중심으로 배치합니다."
    },
    shoulderArm: {
      target: "도구와 재료 위치",
      recommendation: "가위, 테이프, 리본, 철사 등 자주 쓰는 도구를 작업대 전면 30~40cm 이내에 고정 배치합니다.",
      quick: "자주 쓰는 도구를 한쪽 트레이에 모아 작업대 가장 가까운 위치에 둡니다.",
      low: "도구함, 자석 홀더, 작은 수납 트레이를 설치합니다.",
      structural: "제작대 주변을 주 작업영역과 보조 작업영역으로 재배치합니다."
    },
    wristHand: {
      target: "가위질과 포장 동작",
      recommendation: "손목이 꺾이지 않도록 재료 방향을 돌려 작업하고, 가위질과 포장 작업 사이에 짧은 미세휴식을 넣습니다.",
      quick: "가위질 방향을 바꾸기보다 꽃과 포장지를 회전시켜 손목 편위를 줄입니다.",
      low: "손에 맞는 가위, 미끄럼 방지 매트, 테이프 고정 디스펜서를 사용합니다.",
      structural: "절단·포장·리본 작업 구역을 분리해 반복 동작의 각도 변화를 줄입니다."
    },
    trunkBack: {
      target: "작업대 높이와 하단 보관",
      recommendation: "허리를 숙이는 빈도를 줄이기 위해 자주 쓰는 물품은 허리~가슴 높이에 배치합니다.",
      quick: "바닥에 둔 자주 쓰는 물품을 즉시 작업대 주변 선반으로 올립니다.",
      low: "이동식 2~3단 카트 또는 중간 높이 선반을 사용합니다.",
      structural: "작업대 높이를 팔꿈치 높이에 맞추고 하부 수납을 재구성합니다."
    },
    standing: {
      target: "장시간 서기와 바닥 환경",
      recommendation: "피로방지 매트와 짧은 앉은 휴식 구조를 적용하고, 한쪽 다리 체중 쏠림을 줄입니다.",
      quick: "작업 사이 30~60초 체중 이동과 종아리 펌핑을 넣습니다.",
      low: "피로방지 매트와 발 받침대를 배치합니다.",
      structural: "제작 구역에 앉거나 기대어 쉴 수 있는 보조 의자를 배치합니다."
    },
    loadHandling: {
      target: "화분·물통·꽃박스 보관과 운반",
      recommendation: "무거운 물건은 바닥이나 높은 선반이 아니라 무릎~허리 높이에 보관하고, 이동식 카트를 사용합니다.",
      quick: "무거운 물건을 한 번에 많이 들지 말고 나누어 옮깁니다.",
      low: "소형 카트, 손잡이 바구니, 미끄럼 방지 장갑을 사용합니다.",
      structural: "입고 위치에서 보관 위치까지의 직선 동선을 확보합니다."
    },
    workflow: {
      target: "제작·포장·계산 동선",
      recommendation: "제작, 포장, 계산, 주문 확인 구역이 서로 겹치지 않도록 작업 흐름을 한 방향으로 정리합니다.",
      quick: "작업대 위 물건을 사용 빈도별로 분류하고 불필요한 물건을 제거합니다.",
      low: "라벨링 수납함과 작업별 트레이를 사용합니다.",
      structural: "중앙 작업대를 기준으로 보관, 제작, 포장, 고객응대 구역을 분리합니다."
    }
  };

  const picked = keys.map((key) => map[key]);
  return {
    priorityActions: picked.map((item, index) => ({
      priority: index + 1,
      target: item.target,
      recommendation: item.recommendation
    })),
    quickActions: picked.map((item) => item.quick),
    lowCostActions: picked.map((item) => item.low),
    structuralActions: picked.map((item) => item.structural)
  };
}
