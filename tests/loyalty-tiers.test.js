// Membership tiers in words (src/v2/loyalty.js): where a member stands and the "moved up" LINE card.
const test = require("node:test");
const assert = require("node:assert/strict");
const { tierStanding, tierUpCard } = require("../src/v2/loyalty");
const { themeOf } = require("../src/v2/tier-themes");

const tiers = [
  { rank: 0, name: "Member", minSpend: 0, minVisits: 0, earnMultiplier: 1, cardTheme: "classic", benefits: [] },
  { rank: 1, name: "Silver", minSpend: 3000, minVisits: 0, earnMultiplier: 1.2, cardTheme: "silver", benefits: [] },
  { rank: 2, name: "Gold", minSpend: 10000, minVisits: 12, earnMultiplier: 1.5, cardTheme: "gold", benefits: ["เครื่องดื่มฟรี"] }
];

test("standing: the tier, the next one, how far along and what is left, in baht or visits", () => {
  const silver = tierStanding(tiers, { rank: 1, spend: 4000, visits: 9 });
  assert.equal(silver.name, "Silver");
  assert.equal(silver.next.name, "Gold");
  assert.equal(silver.next.text, "อีก 6,000 บาท หรือ 3 ครั้ง ถึง Gold");
  assert.equal(silver.next.progress, 0.75, "the closer of the two ways");
  const gold = tierStanding(tiers, { rank: 2, spend: 12000, visits: 3 });
  assert.equal(gold.next, null);
  assert.equal(tierStanding([], { rank: null, spend: 0, visits: 0 }), null);
  assert.equal(tierStanding(tiers, { rank: 0, spend: 0, visits: 0 }).next.text, "อีก 3,000 บาท ถึง Silver");
});

test("the moved-up card: the tier on its colours, the bonus and perks, and the button to the card", () => {
  const card = tierUpCard({ shopName: "Bloom", programName: "Bloom Club", standing: tierStanding(tiers, { rank: 2, spend: 10000, visits: 4 }), link: "https://liff.line.me/x/bloom/me" });
  assert.match(card.altText, /ระดับ Gold ของ Bloom/);
  const json = JSON.stringify(card.contents);
  assert.ok(json.includes(themeOf("gold").from));
  for (const t of ["Gold", "ได้คะแนน ×1.5", "เครื่องดื่มฟรี", "ดูบัตรสมาชิก", "https://liff.line.me/x/bloom/me"]) assert.ok(json.includes(t), t);
  assert.ok(!JSON.stringify(tierUpCard({ shopName: "B", programName: "P", standing: tierStanding(tiers, { rank: 1, spend: 3000, visits: 1 }), link: null })).includes("footer"));
});
