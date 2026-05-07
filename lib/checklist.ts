export type CategoryKey =
  | "neck"
  | "shoulderArm"
  | "wristHand"
  | "trunkBack"
  | "standing"
  | "loadHandling"
  | "workflow";

export type Category = {
  key: CategoryKey;
  title: string;
  subtitle: string;
  description: string;
};

export type Question = {
  id: number;
  category: CategoryKey;
  text: string;
  intent: string;
};

export const categories: Category[] = [
  {
    key: "neck",
    title: "목·시선",
    subtitle: "NECK & GAZE",
    description: "고개 숙임, 시선 높이, 조명 문제를 확인합니다."
  },
  {
    key: "shoulderArm",
    title: "어깨·팔",
    subtitle: "SHOULDER & ARM",
    description: "팔 뻗기, 어깨 거상, 도구 위치 문제를 확인합니다."
  },
  {
    key: "wristHand",
    title: "손목·손",
    subtitle: "WRIST & HAND",
    description: "가위질, 포장, 리본 작업의 반복 부담을 확인합니다."
  },
  {
    key: "trunkBack",
    title: "허리·몸통",
    subtitle: "TRUNK & BACK",
    description: "허리 굽힘, 몸통 회전, 작업대 높이 문제를 확인합니다."
  },
  {
    key: "standing",
    title: "하지·서기",
    subtitle: "STANDING",
    description: "장시간 서기, 체중 편향, 바닥 환경을 확인합니다."
  },
  {
    key: "loadHandling",
    title: "힘 사용·운반",
    subtitle: "LOAD HANDLING",
    description: "물통, 화분, 꽃박스 등 중량물 취급 부담을 확인합니다."
  },
  {
    key: "workflow",
    title: "동선·배치",
    subtitle: "WORKFLOW",
    description: "도구 위치, 제작-포장-계산 동선, 정리 상태를 확인합니다."
  }
];

export const questions: Question[] = [
  { id: 1, category: "neck", text: "꽃다발을 만들거나 포장할 때 고개를 숙인 상태가 오래 지속된다.", intent: "목 굽힘 부담" },
  { id: 2, category: "neck", text: "작업물을 보기 위해 얼굴을 작업대 가까이 가져가는 경우가 많다.", intent: "작업대 높이 또는 조명 문제" },
  { id: 3, category: "neck", text: "작업 중 목이나 어깨 주변이 자주 뻐근하다.", intent: "목·어깨 부담 자각" },

  { id: 4, category: "shoulderArm", text: "작업 중 팔을 몸에서 멀리 뻗는 경우가 많다.", intent: "도구·재료 위치 문제" },
  { id: 5, category: "shoulderArm", text: "꽃, 포장지, 리본 등을 잡기 위해 어깨가 자주 올라간다.", intent: "어깨 거상 부담" },
  { id: 6, category: "shoulderArm", text: "자주 사용하는 도구가 작업대 가까운 곳에 정리되어 있지 않다.", intent: "주 작업영역 배치 문제" },

  { id: 7, category: "wristHand", text: "가위질을 할 때 손목이 꺾인 상태가 자주 발생한다.", intent: "손목 편위 부담" },
  { id: 8, category: "wristHand", text: "리본, 포장지, 테이프 작업 중 손목을 비트는 동작이 많다.", intent: "손목 회전 부담" },
  { id: 9, category: "wristHand", text: "같은 손동작을 짧은 시간에 여러 번 반복한다.", intent: "반복작업 부담" },

  { id: 10, category: "trunkBack", text: "작업대가 낮아 허리를 숙인 상태로 작업하는 경우가 많다.", intent: "몸통 굽힘 부담" },
  { id: 11, category: "trunkBack", text: "아래쪽 선반이나 바닥에 있는 물건을 자주 꺼낸다.", intent: "반복적인 굴곡 동작" },
  { id: 12, category: "trunkBack", text: "작업 중 몸을 비트는 동작이 자주 발생한다.", intent: "몸통 회전 부담" },

  { id: 13, category: "standing", text: "하루 작업 중 대부분을 서서 보낸다.", intent: "장시간 기립 부담" },
  { id: 14, category: "standing", text: "서 있을 때 한쪽 다리에 체중을 싣는 경우가 많다.", intent: "비대칭 지지" },
  { id: 15, category: "standing", text: "바닥이 미끄럽거나 오래 서 있기 불편하다.", intent: "바닥 환경 문제" },

  { id: 16, category: "loadHandling", text: "물통, 화분, 꽃박스 등 무거운 물건을 자주 든다.", intent: "중량물 취급 부담" },
  { id: 17, category: "loadHandling", text: "무거운 물건을 들 때 허리를 숙여 들어 올리는 경우가 많다.", intent: "부적절한 리프팅 자세" },
  { id: 18, category: "loadHandling", text: "무거운 물건이 낮은 위치나 먼 위치에 보관되어 있다.", intent: "보관 위치 문제" },

  { id: 19, category: "workflow", text: "자주 쓰는 도구를 찾기 위해 작업 중 자리를 자주 벗어난다.", intent: "도구 배치 문제" },
  { id: 20, category: "workflow", text: "제작, 포장, 계산, 주문 확인 동선이 서로 겹쳐 작업이 끊긴다.", intent: "작업 동선 문제" },
  { id: 21, category: "workflow", text: "작업대 위가 자주 어지럽고 필요한 물건을 바로 찾기 어렵다.", intent: "정리·수납 문제" }
];

export const answerOptions = [
  { label: "거의 없음", value: 0 },
  { label: "가끔 있음", value: 1 },
  { label: "자주 있음", value: 2 },
  { label: "거의 항상 있음", value: 3 }
] as const;
