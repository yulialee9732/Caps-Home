const express = require('express');
const cors = require('cors');
const { google } = require('googleapis');
const { Resend } = require('resend');

const app = express();
const PORT = process.env.PORT || 3000;

const allowedOrigins = [
  process.env.ALLOWED_ORIGIN,
  'http://127.0.0.1:5500',
  'http://localhost:5500',
].filter(Boolean);

app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (e.g. curl, Postman)
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
    // Render stores the key as a single line with literal \n — convert back to real newlines
    private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  },
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const sheets = google.sheets({ version: 'v4', auth });

const SHEET_ID  = process.env.GOOGLE_SHEET_ID;
const SHEET_TAB = process.env.GOOGLE_SHEET_TAB;

// Cache the numeric sheetId for the target tab (looked up once at first request)
let numericSheetId = null;
async function getNumericSheetId() {
  if (numericSheetId !== null) return numericSheetId;
  const res = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const sheet = res.data.sheets.find(s => s.properties.title === SHEET_TAB);
  if (!sheet) throw new Error(`Sheet tab "${SHEET_TAB}" not found`);
  numericSheetId = sheet.properties.sheetId;
  return numericSheetId;
}

// ─── Resend ───────────────────────────────────────────────────────────────────
const resend = new Resend(process.env.RESEND_API_KEY);

// ─── Timestamp: MM.DD.YYYY HH:mm (e.g. 06.29.2026 22:09) ────────────────────
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

  // Honeypot — bots fill this hidden field, humans don't
  if (website) {
    return res.status(400).json({ success: false, message: 'Spam detected' });
  }

  // Validate required fields
  if (!연락처 || !설치주소) {
    return res.status(400).json({ success: false, message: '연락처와 설치주소를 입력해주세요.' });
  }

  const timestamp = getTimestamp();

  // Column order must match Sheet: 현황 | 시간 | 경로 | 연락처 | 타입 | 주소
  const row = [
    '대기중',           // 현황
    timestamp,          // 시간
    '캡스홈',           // 경로
    연락처,             // 연락처
    설치내용 || '',     // 타입  (설치내용 maps to this column)
    설치주소,           // 주소
  ];

  let sheetSuccess = false;
  let emailSuccess = false;

  // ── 1. Write to Google Sheet at row 2 (newest entry always on top) ──────────
  try {
    const sheetId = await getNumericSheetId();

    // Insert a blank row just below the header (index 1 = row 2, 0-indexed)
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

    // Write the submission data into the freshly inserted row 2
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

  // ── 2. Send email notification via Resend ────────────────────────────────────
  try {
    await resend.emails.send({
      from: process.env.EMAIL_FROM,
      to: [process.env.EMAIL_TO_1, process.env.EMAIL_TO_2],
      subject: `[캡스홈 상담신청] ${연락처}`,
      html: `
        <div style="font-family:sans-serif;max-width:560px;margin:0 auto">
          <h2 style="color:#1a39c7;border-bottom:2px solid #1a39c7;padding-bottom:8px">
            새로운 상담 신청
          </h2>
          <table style="width:100%;border-collapse:collapse;font-size:15px">
            <tr>
              <td style="padding:10px 12px;border:1px solid #ddd;background:#f5f7ff;font-weight:600;width:110px">접수시간</td>
              <td style="padding:10px 12px;border:1px solid #ddd">${timestamp}</td>
            </tr>
            <tr>
              <td style="padding:10px 12px;border:1px solid #ddd;background:#f5f7ff;font-weight:600">연락처</td>
              <td style="padding:10px 12px;border:1px solid #ddd">${연락처}</td>
            </tr>
            <tr>
              <td style="padding:10px 12px;border:1px solid #ddd;background:#f5f7ff;font-weight:600">설치주소</td>
              <td style="padding:10px 12px;border:1px solid #ddd">${설치주소}</td>
            </tr>
            <tr>
              <td style="padding:10px 12px;border:1px solid #ddd;background:#f5f7ff;font-weight:600">설치내용</td>
              <td style="padding:10px 12px;border:1px solid #ddd">${설치내용 || '-'}</td>
            </tr>
          </table>
          <p style="font-size:12px;color:#888;margin-top:24px">
            캡스홈 상담신청 자동발송 · capshome.netlify.app
          </p>
        </div>
      `,
    });

    emailSuccess = true;
    console.log(`[Email] Sent to both recipients — ${timestamp}`);
  } catch (err) {
    console.error('[Email] Error:', err.message);
  }

  // Respond success if at least one of the two operations succeeded
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