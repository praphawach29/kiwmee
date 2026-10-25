import { Anuphan, Mitr } from "next/font/google";
import "./globals.css";

// Kiwmee type: Mitr for headings, Anuphan for text (docs/BRAND_COLORS.md)
const mitr = Mitr({ weight: ["500", "600"], subsets: ["thai", "latin"], variable: "--font-mitr", display: "swap" });
const anuphan = Anuphan({ weight: ["400", "500", "600"], subsets: ["thai", "latin"], variable: "--font-anuphan", display: "swap" });

export const metadata = {
  title: { default: "Kiwmee · จองคิวง่าย ได้ทุกที่", template: "%s · Kiwmee" },
  description: "ระบบจองคิวออนไลน์สำหรับร้านเสริมสวย ร้านตัดผม สปา สนาม และทุกธุรกิจที่รับจอง ลูกค้าจองเองได้ทั้งเว็บและ LINE"
};

export const viewport = { themeColor: "#6A4CFF" };

export default function RootLayout({ children }) {
  return (
    <html lang="th" className={`${mitr.variable} ${anuphan.variable}`}>
      <body>{children}</body>
    </html>
  );
}
