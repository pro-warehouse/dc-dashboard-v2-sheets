const express = require('express');
const cors = require('cors');
const { google } = require('googleapis');
const path = require('path');
const fs = require('fs');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ==========================================
// ⚙️ การตั้งค่า Google Sheets
// ==========================================
const DB_SPREADSHEET_ID = '1TL-tj-BrvYM7i_wNHlA0x641_VOqfT9SLpmm2NZATOo';
const keyFilePath = path.join(__dirname, 'key.json');
let sheets = null;
let isSheetsDbConfigured = false;

if (fs.existsSync(keyFilePath)) {
  const sheetsAuth = new google.auth.GoogleAuth({
    keyFile: keyFilePath,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  sheets = google.sheets({ version: 'v4', auth: sheetsAuth });
  isSheetsDbConfigured = true;
  console.log('✅ โหลดการตั้งค่า Google Sheets สำเร็จ');
  initSheetsHeaders(); // สร้างหัวตารางอัตโนมัติ
} else {
  console.warn('⚠️ ไม่พบไฟล์ key.json ระบบอาจทำงานไม่สมบูรณ์');
}

// ==========================================
// 🛠️ ฟังก์ชันตั้งค่าตาราง & Helper
// ==========================================
async function initSheetsHeaders() {
  if (!isSheetsDbConfigured) return;
  try {
    const waveHeaders = [
      'Wave_Number', 'Planned_Pick_Date', 'Planned_Pick_Time', 'Planned_Load_Date', 'Planned_Load_Time',
      'Trip_No', 'Transporter', 'Vehicle_Type', 'Vehicle_Booking_No', 'Branch_Name', 'Branch_Code',
      'Order_Number', 'Owner_Code', 'Order_Type', 'Is_HUB', 'Time_Change_Count', 'Total_Qty',
      'Status_Allocate', 'User_Allocate', 'Time_Allocate',
      'Status_Print', 'User_Print', 'Time_Print',
      'Status_Pick', 'User_Pick', 'Picked_Complete_Timestamp',
      'Status_Check', 'User_Check', 'QC_Complete_Timestamp',
      'Status_Truck', 'User_Truck', 'Hist_Truck_Time',
      'Status_Load', 'User_Load', 'Hist_Load_Time', 'Time_Load_Start', 'Dock_Door', 'License_Plate',
      'Created_At', 'Imported_At'
    ];
    const logHeaders = ['timestamp', 'user', 'waveId', 'action'];

    const checkAndSetHeaders = async (sheetName, headers) => {
      const res = await sheets.spreadsheets.values.get({
        spreadsheetId: DB_SPREADSHEET_ID,
        range: `${sheetName}!A1:Z1`,
      });
      if (!res.data.values || res.data.values.length === 0) {
        await sheets.spreadsheets.values.update({
          spreadsheetId: DB_SPREADSHEET_ID,
          range: `${sheetName}!A1`,
          valueInputOption: 'USER_ENTERED',
          requestBody: { values: [headers] },
        });
        console.log(`✅ สร้างหัวตารางสำหรับ ${sheetName} สำเร็จ`);
      }
    };

    await checkAndSetHeaders('Wave_Monitoring', waveHeaders);
    await checkAndSetHeaders('System_Logs', logHeaders);
  } catch (error) {
    console.error('❌ ตรวจสอบหัวตาราง Google Sheets ไม่สำเร็จ:', error.message);
  }
}

function standardizeWaveId(id) {
  if (!id) return '';
  const num = String(id).replace(/^WAVE-?/i, '').replace(/^W-?/i, '').replace(/^0+/, '');
  const paddedNum = (num === '' ? '0' : num).padStart(10, '0');
  return `Wave-${paddedNum}`;
}

// ==========================================
// 🚀 API Endpoints
// ==========================================

// 1. API ดึงประวัติ System Logs (ย้ายมาดึงจาก Google Sheets)
app.get('/api/logs', async (req, res) => {
  try {
    if (!isSheetsDbConfigured) return res.json([]);
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: DB_SPREADSHEET_ID,
      range: 'System_Logs!A2:D',
    });
    const rows = response.data.values;
    if (!rows || rows.length === 0) return res.json([]);

    let logs = rows.map(row => ({
      ts: row[0] || '',
      user: row[1] || '',
      waveId: row[2] || '',
      action: row[3] || ''
    }));
    logs = logs.reverse().slice(0, 300); // เอาล่าสุดขึ้นก่อน
    res.json(logs);
  } catch (err) {
    console.error('❌ ดึง Logs ขัดข้อง:', err.message);
    res.status(500).json([]);
  }
});

// 2. API บันทึก System Logs (ย้ายมาเขียนลง Google Sheets)
app.post('/api/logs/save', async (req, res) => {
  try {
    if (!isSheetsDbConfigured) return res.json({ success: true });
    const rowData = [
      new Date(req.body.ts).toISOString(),
      req.body.user || '',
      req.body.waveId || '',
      req.body.action || ''
    ];
    await sheets.spreadsheets.values.append({
      spreadsheetId: DB_SPREADSHEET_ID,
      range: 'System_Logs!A:D',
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [rowData] },
    });
    res.json({ success: true });
  } catch (e) {
    console.error('❌ บันทึก Log ไม่สำเร็จ:', e.message);
    res.status(500).json({ success: false });
  }
});

// === ฟังก์ชันสำหรับดึงข้อมูลจาก Sheets ===
async function fetchWaveDataFromSheets() {
  if (!isSheetsDbConfigured) return [];
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: DB_SPREADSHEET_ID,
      range: 'Wave_Monitoring!A:ZZ',
    });
    const rows = response.data.values;
    if (!rows || rows.length === 0) return [];
    
    const headers = rows[0];
    const data = rows.slice(1).map((row, index) => {
      let obj = { _rowIndex: index + 2 };
      headers.forEach((header, i) => {
        obj[header] = (row[i] !== undefined && row[i] !== '') ? row[i] : null; 
      });
      return obj;
    });
    return data;
  } catch (err) {
    console.error('❌ อ่านข้อมูล Wave_Monitoring ขัดข้อง:', err.message);
    return [];
  }
}

// 3. API โหลดข้อมูล Wave ขึ้นหน้าจอ Dashboard
app.get('/api/waves/live', async (req, res) => {
  try {
    if (!isSheetsDbConfigured) return res.json([]);
    
    let resultData = await fetchWaveDataFromSheets();

    // ทำความสะอาดตัวเลขและเลข Wave ให้ตรงฟอร์แมตที่หน้าเว็บต้องการ
    resultData = resultData.map((row) => {
      let cleanRow = { ...row };
      if (cleanRow.Wave_Number) {
        cleanRow.Wave_Number = standardizeWaveId(cleanRow.Wave_Number);
      }
      if (cleanRow.Total_Qty) {
        cleanRow.Total_Qty = parseNumericQty(cleanRow.Total_Qty);
      }
      // ดึง Owner_Code มาใช้เป็นกลุ่มแบ่งสี
      cleanRow.Allocation_Owner_Group = cleanRow.Owner_Code || 'Other';
      return cleanRow;
    });

    res.json(resultData);
  } catch (err) {
    console.error('❌ ข้อผิดพลาดใน /api/waves/live:', err);
    res.status(500).json([]);
  }
});

app.post('/api/waves/update-status', async (req, res) => {
  res.json({ success: true }); // จำลองการเซฟผ่าน
});

// === ตัวแปรเก็บ Cache รายชื่อพนักงาน (อัปเดตทุก 1 ชม. ลดการโหลดช้า) ===
let employeeCache = null;
let lastCacheTime = 0;
const CACHE_DURATION = 60 * 60 * 1000;

app.post('/api/verify-employee', async (req, res) => {
  const empId = req.body.employeeId;
  if (!empId || empId.trim() === '') {
    return res.json({ success: false, message: 'กรุณาระบุรหัสพนักงาน' });
  }

  try {
    const now = Date.now();
    const searchId = String(empId).trim();

    // ข้อยกเว้นพิเศษสำหรับแอดมินระบบ
    if (searchId === '171080') return res.json({ success: true, name: 'Jooner' });

    if (isSheetsDbConfigured) {
      // ถ้าไม่มี Cache หรือหมดอายุ ให้ไปดึงใหม่จาก Sheets
      if (!employeeCache || now - lastCacheTime > CACHE_DURATION) {
        try {
          const response = await sheets.spreadsheets.values.get({
            spreadsheetId: '1AWOeqhCqmBlSfGI5FWJVU4F77lDGNWBUH-TYpJeiYnI',
            // อ้างอิงจากโค้ดเดิม ใช้ชื่อแท็บ "บันทึกเวลาทำงาน"
            range: 'บันทึกเวลาทำงาน!B25:C', 
          });
          const rows = response.data.values;
          
          if (rows && rows.length > 0) {
            employeeCache = {};
            rows.forEach((row) => {
              // row[0] คือคอลัมน์ B (รหัส), row[1] คือคอลัมน์ C (ชื่อ)
              if (row[0] && row[1]) {
                employeeCache[String(row[0]).trim()] = String(row[1]).trim();
              }
            });
            lastCacheTime = now;
            console.log(`✅ โหลดข้อมูลพนักงานสำเร็จ: ${Object.keys(employeeCache).length} คน`);
          }
        } catch (sheetErr) {
          console.error('❌ ดึงข้อมูลพนักงานไม่สำเร็จ:', sheetErr.message);
        }
      }

      // เช็ครหัสพนักงานกับข้อมูลที่ดึงมา
      if (employeeCache && employeeCache[searchId]) {
        return res.json({ success: true, name: employeeCache[searchId] });
      }
    }

    res.json({ success: false, message: 'ไม่พบรหัสพนักงานในฐานข้อมูล' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดภายในระบบเซิร์ฟเวอร์' });
  }
});

app.get('/api/version', (req, res) => res.json({ version: '1.3.0' }));
app.get('/api/settings', (req, res) => res.json({}));

app.get(/.*/, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(port, () =>
  console.log(`🚀 V2 Server is running on port ${port}`)
);
