import { NextResponse } from "next/server";
import { buildRuleBasedAnalysis, calculateScores, type Answers } from "@/lib/scoring";

const resultSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    resultTitle: { type: "string" },
    summary: { type: "string" },
    mainRisks: { type: "array", items: { type: "string" } },
    priorityActions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          priority: { type: "number" },
          target: { type: "string" },
          recommendation: { type: "string" }
        },
        required: ["priority", "target", "recommendation"]
      }
    },
    quickActions: { type: "array", items: { type: "string" } },
    lowCostActions: { type: "array", items: { type: "string" } },
    structuralActions: { type: "array", items: { type: "string" } },
    warning: { type: "string" }
  },
  required: [
    "resultTitle",
    "summary",
    "mainRisks",
    "priorityActions",
    "quickActions",
    "lowCostActions",
    "structuralActions",
    "warning"
  ]
};

export async function POST(request: Request) {
  const body = (await request.json()) as { answers?: Answers; workInfo?: Record<string, string> };
  const answers = body.answers ?? {};
  const scoreResult = calculateScores(answers);

  if (!process.env.OPENAI_API_KEY) {
    return NextResponse.json({
      mode: "rule-based",
      scoreResult,
      analysis: buildRuleBasedAnalysis(scoreResult)
    });
  }

  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
        input: [
          {
            role: "system",
            content:
              "너는 작업환경 인체공학 리포트 작성 보조자다. 공식 RULA 진단처럼 말하지 말고, 자가진단형 스크리닝 결과를 바탕으로 작업환경 개선 우선순위를 제시한다. 의학적 진단, 질환 확정, 치료 권고 표현은 금지한다."
          },
          {
            role: "user",
            content: JSON.stringify({
              workInfo: body.workInfo ?? {},
              scoreResult
            })
          }
        ],
        text: {
          format: {
            type: "json_schema",
            name: "florist_screening_analysis",
            strict: true,
            schema: resultSchema
          }
        }
      })
    });

    if (!response.ok) {
      throw new Error(`OpenAI API error: ${response.status}`);
    }

    const data = await response.json();
    const text = data.output_text ?? data.output?.[0]?.content?.[0]?.text;
    const analysis = text ? JSON.parse(text) : buildRuleBasedAnalysis(scoreResult);

    return NextResponse.json({
      mode: "openai",
      scoreResult,
      analysis
    });
  } catch (error) {
    console.error(error);
    return NextResponse.json({
      mode: "fallback",
      scoreResult,
      analysis: buildRuleBasedAnalysis(scoreResult)
    });
  }
}
