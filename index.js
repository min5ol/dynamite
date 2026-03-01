require("dotenv").config();

const express = require("express");
const cron = require("node-cron");
const Database = require("better-sqlite3");
const line = require("@line/bot-sdk");

const {
  CHANNEL_ACCESS_TOKEN,
  CHANNEL_SECRET,
  GROUP1_ID,
  GROUP2_ID,
  PORT = 3000,
  DEBUG = "0", // .env에 DEBUG=1 넣으면 로그 좀 더 나옴
} = process.env;

if (!CHANNEL_ACCESS_TOKEN || !CHANNEL_SECRET || !GROUP1_ID || !GROUP2_ID) {
  throw new Error(
    "Missing env vars: CHANNEL_ACCESS_TOKEN/CHANNEL_SECRET/GROUP1_ID/GROUP2_ID"
  );
}

const config = {
  channelAccessToken: CHANNEL_ACCESS_TOKEN,
  channelSecret: CHANNEL_SECRET,
};

const client = new line.messagingApi.MessagingApiClient({
  channelAccessToken: CHANNEL_ACCESS_TOKEN,
});

const app = express();

app.post("/webhook", line.middleware(config), (req, res) => {
  // ✅ LINE이 요구하는 건 "빠른 200 OK"
  res.status(200).send("OK");

  // ✅ 처리는 뒤에서 비동기로
  const events = req.body.events || [];
  Promise.all(events.map(handleEvent)).catch((e) => console.error("[WEBHOOK_ERR]", e));
});

// ---- DB ----
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

function ymdOf(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function stripEmojiAndSpaces(s) {
  let t = (s || "").replace(/\s+/g, "");
  try {
    t = t.replace(/\p{Extended_Pictographic}/gu, "");
  } catch {
    t = t.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, "");
  }
  return t;
}

function isCountableText(text) {
  const cleaned = stripEmojiAndSpaces(text);
  return cleaned.length >= 3;
}

async function getDisplayName(groupId, userId) {
  try {
    const profile = await client.getGroupMemberProfile(groupId, userId);
    return profile.displayName || userId;
  } catch {
    return userId;
  }
}

function incCount(ymd, groupId, userId) {
  const stmt = db.prepare(`
    INSERT INTO daily_counts (ymd, group_id, user_id, count)
    VALUES (@ymd, @groupId, @userId, 1)
    ON CONFLICT(ymd, group_id, user_id)
    DO UPDATE SET count = count + 1
  `);
  stmt.run({ ymd, groupId, userId });
}

// ---- Webhook handler ----
async function handleEvent(event) {
  // 단톡만
  if (!event?.source || event.source.type !== "group") return;

  const groupId = event.source.groupId;
  const userId = event.source.userId;

  // 1번 단톡만 집계
  if (!groupId || groupId !== GROUP1_ID) return;
  if (!userId) return;

  if (event.type !== "message") return;

  const message = event.message || {};

  // 텍스트만 (사진/스티커/파일 등 제외)
  if (message.type !== "text") return;

  const text = message.text || "";
  if (!isCountableText(text)) return;

  const today = ymdOf(new Date());
  incCount(today, groupId, userId);

  if (DEBUG === "1") {
    console.log(`[COUNT] ${today} group=${groupId} user=${userId} text="${text}"`);
  }
}

// ---- Daily report at 00:00 Asia/Seoul ----
cron.schedule(
  "0 0 * * *",
  async () => {
    const now = new Date();
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);

    const ymd = ymdOf(yesterday);

    try {
      const rows = db
        .prepare(
          `SELECT user_id, count FROM daily_counts
           WHERE ymd = ? AND group_id = ?
           ORDER BY count DESC`
        )
        .all(ymd, GROUP1_ID);

      if (rows.length === 0) {
        await client.pushMessage({
          to: GROUP2_ID,
          messages: [{ type: "text", text: `(${ymd}) 1번 단톡 마디수 집계: 기록 없음` }],
        });
        return;
      }

      const lines = [];
      for (const r of rows) {
        const name = await getDisplayName(GROUP1_ID, r.user_id);
        lines.push(`${name}: ${r.count}`);
      }

      const text =
        `(${ymd}) 1번 단톡 마디수(사진/이모티콘 제외, 3글자 이상)\n` +
        lines.join("\n");

      await client.pushMessage({
        to: GROUP2_ID,
        messages: [{ type: "text", text }],
      });

      // 전날 데이터 삭제(원하면 주석처리해서 누적도 가능)
      db.prepare(`DELETE FROM daily_counts WHERE ymd = ? AND group_id = ?`).run(
        ymd,
        GROUP1_ID
      );

      if (DEBUG === "1") console.log(`[REPORT_SENT] ${ymd} rows=${rows.length}`);
    } catch (e) {
      console.error("[CRON_ERR]", e);
    }
  },
  { timezone: "Asia/Seoul" }
);

app.get("/", (_, res) => res.send("LINE bot OK"));
app.listen(PORT, () => console.log(`Listening on ${PORT}`));