import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "꽃집 작업환경 자가진단 시스템",
  description: "RULA 기반 꽃집 작업환경 자가진단형 스크리닝 및 AI 개선안 추천 시스템"
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
