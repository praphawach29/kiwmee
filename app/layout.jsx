import localFont from "next/font/local";
import "./globals.css";

// Kiwmee type: Mitr for headings, Anuphan for text (docs/BRAND_COLORS.md).
// Files live in app/fonts (SIL OFL 1.1 — see app/fonts/OFL.txt) so a build never depends on
// fonts.googleapis.com; that network call failed repeatedly on CI and on Railway.
const mitr = localFont({
  src: [
    { path: "./fonts/Mitr-Medium.ttf", weight: "500" },
    { path: "./fonts/Mitr-SemiBold.ttf", weight: "600" }
  ],
  variable: "--font-mitr",
  display: "swap"
});

const anuphan = localFont({
  src: "./fonts/Anuphan-Variable.ttf",
  weight: "100 700",
  variable: "--font-anuphan",
  display: "swap"
});

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
