import { today } from "./config.js";
export function seed() {
  const date = today();
  const ago = (days) => {
    const d = new Date(`${date}T12:00:00`);
    d.setDate(d.getDate() - days);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  return {
    schema: 2,
    revision: 0,
    children: [
      {
        id: "c1",
        name: "하루",
        age: 5,
        therapistId: "t1",
        guardianIds: ["p1"],
        concern: "놀이터에서 친구들과 더 편하게 어울렸으면 좋겠어요.",
        color: "blue",
      },
      {
        id: "c2",
        name: "나무",
        age: 7,
        therapistId: "t1",
        guardianIds: ["p2"],
        concern: "아침 준비를 스스로 해 보고 싶어 해요.",
        color: "green",
      },
      {
        id: "c3",
        name: "여울",
        age: 4,
        therapistId: "t2",
        guardianIds: ["p3"],
        concern: "가족과 함께하는 놀이 시간을 늘리고 싶어요.",
        color: "peach",
      },
    ],
    goals: [
      {
        id: "g1",
        childId: "c1",
        title: "놀이에 스스로 참여하기",
        description:
          "아이와 가족이 즐거워하는 놀이를 찾고, 참여한 상황을 함께 살펴봐요.",
        status: "active",
        updatedAt: ago(7),
      },
      {
        id: "g2",
        childId: "c1",
        title: "일상에서 편안하게 이동하기",
        description:
          "가정과 센터에서 관찰한 이동 경험을 모아 다음 목표를 함께 정해요.",
        status: "active",
        updatedAt: ago(7),
      },
      {
        id: "g3",
        childId: "c2",
        title: "아침 준비에 참여하기",
        description: "가족과 정한 작은 역할부터 시도해요.",
        status: "active",
        updatedAt: ago(5),
      },
    ],
    records: [
      {
        id: "r1",
        childId: "c1",
        goalId: "g1",
        date: ago(2),
        title: "놀이 참여 관찰",
        privateNote:
          "가상 내부 메모: 다음 회기에서 환경에 따른 참여 차이를 확인.",
        summary:
          "좋아하는 놀이를 직접 고르고 시작하는 모습을 보였어요. 가정에서의 반응도 함께 알려주세요.",
        nextPlan: "보호자 피드백을 확인하고 다음 놀이를 함께 고르기",
        assessment: null,
        activity: {
          title: "좋아하는 놀이 함께 고르기",
          instruction:
            "아이가 좋아하는 놀이 두 가지 중 하나를 고르고 함께한 경험을 남겨 주세요.",
          frequency: "편한 시간에 한 번",
          caution:
            "이 내용은 화면 체험용 예시입니다. 실제 활동은 담당 치료사와 정해 주세요.",
        },
        publicationId: "pub1",
        appointmentId: "",
        updatedAt: ago(2),
      },
      {
        id: "r2",
        childId: "c1",
        goalId: "g2",
        date: ago(1),
        title: "일상 이동 관찰",
        privateNote: "가상 내부 메모: 보호자 확인 전 초안.",
        summary: "센터에서 관찰한 내용을 정리하고 있어요.",
        nextPlan: "관찰 조건 확인 후 공유 내용 작성",
        assessment: {
          tool: "직접 관찰",
          item: "놀이 참여 시간",
          value: 6,
          unit: "분",
          context: "동일한 놀이 공간 · 가상 관찰값",
        },
        activity: null,
        publicationId: null,
        appointmentId: "",
        updatedAt: ago(1),
      },
    ],
    publications: [
      {
        id: "pub1",
        recordId: "r1",
        childId: "c1",
        goalId: "g1",
        date: ago(2),
        title: "놀이 참여 관찰",
        summary:
          "좋아하는 놀이를 직접 고르고 시작하는 모습을 보였어요. 가정에서의 반응도 함께 알려주세요.",
        activity: {
          title: "좋아하는 놀이 함께 고르기",
          instruction:
            "아이가 좋아하는 놀이 두 가지 중 하나를 고르고 함께한 경험을 남겨 주세요.",
          frequency: "편한 시간에 한 번",
          caution:
            "이 내용은 화면 체험용 예시입니다. 실제 활동은 담당 치료사와 정해 주세요.",
        },
        sharedAt: ago(2),
      },
    ],
    feedback: [],
    appointments: [
      {
        id: "a1",
        childId: "c1",
        date,
        time: "10:00",
        duration: 40,
        title: "물리치료",
        room: "1번 치료실",
        status: "scheduled",
      },
      {
        id: "a2",
        childId: "c2",
        date,
        time: "11:00",
        duration: 40,
        title: "물리치료",
        room: "1번 치료실",
        status: "scheduled",
      },
      {
        id: "a3",
        childId: "c3",
        date,
        time: "14:00",
        duration: 40,
        title: "보호자 상담",
        room: "상담실",
        status: "scheduled",
      },
    ],
  };
}
