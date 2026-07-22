const express = require('express');
const cors = require('cors');
const { google } = require('googleapis');
const nodemailer = require('nodemailer');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── CORS ────────────────────────────────────────────────────────────────────
const allowedOrigins = [
  process.env.ALLOWED_ORIGIN,
  'http://127.0.0.1:5500',
  'http://localhost:5500',
].filter(Boolean);

app.use(cors({
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  methods: ['POST', 'OPTIONS'],
}));

app.use(express.json());

// ─── Google Sheets Auth ───────────────────────────────────────────────────────
const auth = new google.auth.GoogleAuth({
  credentials: {
    client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  },
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const sheets = google.sheets({ version: 'v4', auth });

const SHEET_ID  = process.env.GOOGLE_SHEET_ID;
const SHEET_TAB = process.env.GOOGLE_SHEET_TAB;

// Cache the numeric sheetId for the target tab
let numericSheetId = null;
async function getNumericSheetId() {
  if (numericSheetId !== null) return numericSheetId;
  const res = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const sheet = res.data.sheets.find(s => s.properties.title === SHEET_TAB);
  if (!sheet) throw new Error(`Sheet tab "${SHEET_TAB}" not found`);
  numericSheetId = sheet.properties.sheetId;
  return numericSheetId;
}

// ─── Nodemailer ───────────────────────────────────────────────────────────────
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_PASS,
  },
});

// ─── Timestamp: MM.DD.YYYY HH:mm ─────────────────────────────────────────────
function getTimestamp() {
  const now = new Date();
  const mm   = String(now.getMonth() + 1).padStart(2, '0');
  const dd   = String(now.getDate()).padStart(2, '0');
  const yyyy = now.getFullYear();
  const hh   = String(now.getHours()).padStart(2, '0');
  const min  = String(now.getMinutes()).padStart(2, '0');
  return `${mm}.${dd}.${yyyy} ${hh}:${min}`;
}

// ─── POST /api/contact ────────────────────────────────────────────────────────
app.post('/api/contact', async (req, res) => {
  const { 연락처, 설치주소, 설치내용, website } = req.body;

  // Honeypot
  if (website) {
    return res.status(400).json({ success: false, message: 'Spam detected' });
  }

  // Validation
  if (!연락처 || !설치주소) {
    return res.status(400).json({ success: false, message: '연락처와 설치주소를 입력해주세요.' });
  }

  const timestamp = getTimestamp();

  // Column order: 현황 | 시간 | 경로 | 연락처 | 타입 | 주소
  const row = [
    '대기중',
    timestamp,
    '캡스홈',
    연락처,
    설치내용 || '',
    설치주소,
  ];

  let sheetSuccess = false;
  let emailSuccess = false;

  // ── 1. Google Sheet (insert at row 2) ────────────────────────────────────────
  try {
    const sheetId = await getNumericSheetId();

    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: {
        requests: [{
          insertDimension: {
            range: {
              sheetId,
              dimension: 'ROWS',
              startIndex: 1,
              endIndex: 2,
            },
            inheritFromBefore: false,
          },
        }],
      },
    });

    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `'${SHEET_TAB}'!A2:F2`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [row] },
    });

    sheetSuccess = true;
    console.log(`[Sheet] Row inserted at row 2 — ${timestamp}`);
  } catch (err) {
    console.error('[Sheet] Error:', err.message);
  }

  // ── 2. Email (Nodemailer) ────────────────────────────────────────────────────
  try {
    const emailSubject = `[캡스홈 신규] ${설치주소}`;
    const emailBody = `시간: ${timestamp}

연락처: ${연락처}

설치주소: ${설치주소}

설치내용: ${설치내용 || '-'}

경로: 캡스홈`;

    await transporter.sendMail({
      from: `캡스홈 알림 <${process.env.GMAIL_USER}>`,
      to: [process.env.EMAIL_TO_1, process.env.EMAIL_TO_2],
      subject: emailSubject,
      text: emailBody,
    });

    emailSuccess = true;
    console.log(`[Email] Sent to both recipients — ${timestamp}`);
  } catch (err) {
    console.error('[Email] Error:', err.message);
  }

  if (sheetSuccess || emailSuccess) {
    return res.json({ success: true });
  }

  return res.status(500).json({
    success: false,
    message: '접수 중 오류가 발생했습니다. 다시 시도해주세요.',
  });
});

// Health check
app.get('/health', (_, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => {
  console.log(`캡스홈 contact backend running on port ${PORT}`);
});