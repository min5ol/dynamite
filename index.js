require("dotenv").config();

const express = require("express");
const Database = require("better-sqlite3");
const line = require("@line/bot-sdk");

const {
  CHANNEL_ACCESS_TOKEN,
  CHANNEL_SECRET,
  GROUP1_ID,
  GROUP2_ID,
  REPORT_TOKEN,
  PORT = 3000,
  DEBUG = "0",
} = process.env;

// 환경변수 체크
if (!CHANNEL_ACCESS_TOKEN || !CHANNEL_SECRET || !GROUP1_ID || !GROUP2_ID || !REPORT_TOKEN) {
  throw new Error("Missing required environment variables in .env file.");
}

const config = {
  channelAccessToken: CHANNEL_ACCESS_TOKEN,
  channelSecret: CHANNEL_SECRET,
};

// Messaging API Client 설정
const client = new line.messagingApi.MessagingApiClient({
  channelAccessToken: CHANNEL_ACCESS_TOKEN,
});

const app = express();

// ---- DB 설정 ----
const db = new Database("counts.db");
db.exec(`
CREATE TABLE IF NOT EXISTS daily_counts (
  ymd TEXT NOT NULL,
  group_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (ymd, group_id, user_id)
);
`);

// 날짜 포맷팅 함수 (YYYY-MM-DD)
function ymdOf(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// 이모지 및 공백 제거 함수
function stripEmojiAndSpaces(s) {
  let t = (s || "").replace(/\s+/g, "");
  try {
    t = t.replace(/\p{Extended_Pictographic}/gu, "");
  } catch {
    t = t.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, "");
  }
  return t;
}

// 집계 대상 텍스트인지 확인 (3글자 이상)
function isCountableText(text) {
  const cleaned = stripEmojiAndSpaces(text);
  return cleaned.length >= 3;
}

// 사용자 닉네임 가져오기
async function getDisplayName(groupId, userId) {
  try {
    const profile = await client.getGroupMemberProfile(groupId, userId);
    return profile.displayName || "Unknown";
  } catch (err) {
    return userId; // 프로필 못 가져오면 ID 그대로 반환
  }
}

// 카운트 증가 함수
function incCount(ymd, groupId, userId) {
  const stmt = db.prepare(`
    INSERT INTO daily_counts (ymd, group_id, user_id, count)
    VALUES (@ymd, @groupId, @userId, 1)
    ON CONFLICT(ymd, group_id, user_id)
    DO UPDATE SET count = count + 1
  `);
  stmt.run({ ymd, groupId, userId });
}

// 리포트 생성 및 전송 함수
async function sendDailyReportForYmd(ymd) {
  const rows = db
    .prepare(
      `SELECT user_id, count FROM daily_counts
       WHERE ymd = ? AND group_id = ?
       ORDER BY count DESC`
    )
    .all(ymd, GROUP1_ID);

  console.log(`[REPORT] Processing report for ${ymd}, rows: ${rows.length}`);

  let reportMessage = "";

  if (rows.length === 0) {
    reportMessage = `(${ymd}) 1번 단톡 마디수 집계: 기록 없음`;
  } else {
    const lines = [];
    // 닉네임 변환 (순차 처리)
    for (const r of rows) {
      const name = await getDisplayName(GROUP1_ID, r.user_id);
      lines.push(`${name}: ${r.count}`);
    }
    reportMessage =
      `(${ymd}) 1번 단톡 마디수(사진/이모티콘 제외, 3글자 이상)\n` +
      lines.join("\n");
  }

  // GROUP2_ID로 결과 전송
  try {
    await client.pushMessage({
      to: GROUP2_ID,
      messages: [{ type: "text", text: reportMessage }],
    });
    console.log("[REPORT] Push Success to Group 2");

    // 전송 후 데이터 삭제 (필요하면 활성화)
    // db.prepare(`DELETE FROM daily_counts WHERE ymd = ? AND group_id = ?`).run(ymd, GROUP1_ID);
  } catch (e) {
    console.error("[REPORT] Push Failed:", e.message);
  }
}

// ---- Webhook ----
app.post("/webhook", line.middleware(config), (req, res) => {
  res.status(200).send("OK");
  const events = req.body.events || [];
  Promise.all(events.map(handleEvent)).catch((e) => console.error("[WEBHOOK_ERR]", e));
});

async function handleEvent(event) {
  if (!event?.source || event.source.type !== "group") return;

  const groupId = event.source.groupId;
  const userId = event.source.userId;

  // 1번 단톡방 메시지만 집계
  if (groupId !== GROUP1_ID || !userId) return;
  if (event.type !== "message" || event.message.type !== "text") return;

  const text = event.message.text || "";
  if (!isCountableText(text)) return;

  const today = ymdOf(new Date());
  incCount(today, groupId, userId);

  if (DEBUG === "1") {
    console.log(`[COUNT] ${today} user=${userId} text="${text}"`);
  }
}

// ---- Report Trigger Endpoint ----
app.get("/run-report", (req, res) => {
  if (req.query.token !== REPORT_TOKEN) {
    return res.status(401).send("Unauthorized");
  }

  res.status(200).send("Report process started");

  (async () => {
    const now = new Date();
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    const ymd = ymdOf(yesterday);

    console.log("[TRIGGER] Running report for:", ymd);
    await sendDailyReportForYmd(ymd);
  })().catch((e) => console.error("[TRIGGER_ERR]", e));
});

app.get("/", (_, res) => res.send("LINE bot is running..."));

app.listen(PORT, () => console.log(`Server is listening on port ${PORT}`));