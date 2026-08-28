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

// === API อัปเดตสถานะงานกลับลง Google Sheets แบบ Batch ===
app.post('/api/waves/update-status', async (req, res) => {
  try {
    if (!isSheetsDbConfigured) return res.json({ success: true });

    const payload = req.body;
    if (!payload || payload.length === 0) return res.json({ success: true });

    // 1. ดึงข้อมูลชีตทั้งหมดเพื่อหาตำแหน่งแถว และตำแหน่งคอลัมน์
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: DB_SPREADSHEET_ID,
      range: 'Wave_Monitoring!A:ZZ',
    });
    
    const rows = response.data.values;
    if (!rows || rows.length === 0) return res.json({ success: true });
    
    const headers = rows[0];
    const updateData = []; // เก็บชุดข้อมูลที่จะไปอัปเดตหลายๆ ช่องพร้อมกัน

    // Helper: แปลงเลข Index ให้เป็นตัวอักษรคอลัมน์ (เช่น 0=A, 1=B, 26=AA)
    const getColLetter = (colIndex) => {
      let temp, letter = '';
      while (colIndex >= 0) {
        temp = colIndex % 26;
        letter = String.fromCharCode(temp + 65) + letter;
        colIndex = (colIndex - temp) / 26 - 1;
      }
      return letter;
    };

    // 2. วนลูปข้อมูลการกดปุ่มที่ส่งมาจากหน้าเว็บ
    payload.forEach((waveUpdate) => {
      const targetWaveId = standardizeWaveId(waveUpdate.id);
      // หาตำแหน่งแถว (บวก 1 เพราะ index เริ่มที่ 0 แต่ชีตเริ่มนับแถวที่ 1)
      const rowIndex = rows.findIndex(row => standardizeWaveId(row[0]) === targetWaveId) + 1;
      
      if (rowIndex > 1) { // ถ้าเจอข้อมูล
        (waveUpdate.steps || []).forEach(step => {
          const capKey = step.key.charAt(0).toUpperCase() + step.key.slice(1);
          
          // จับคู่ชื่อคอลัมน์ใน Sheets
          const statusColName = `Status_${capKey}`;
          const userColName = `User_${capKey}`;
          let timeColName = `Time_${capKey}`;
          
          if (step.key === 'pick') timeColName = 'Picked_Complete_Timestamp';
          if (step.key === 'check') timeColName = 'QC_Complete_Timestamp';
          if (step.key === 'truck') timeColName = 'Hist_Truck_Time';
          if (step.key === 'load') timeColName = 'Hist_Load_Time';

          const statusColIdx = headers.indexOf(statusColName);
          const userColIdx = headers.indexOf(userColName);
          const timeColIdx = headers.indexOf(timeColName);

          // เตรียมข้อมูลอัปเดตสถานะ (pending, doing, done)
          if (statusColIdx > -1) {
            updateData.push({
              range: `Wave_Monitoring!${getColLetter(statusColIdx)}${rowIndex}`,
              values: [[step.status === 'reverted' ? 'pending' : step.status]]
            });
          }
          
          // เตรียมข้อมูลอัปเดตชื่อผู้กด
          if (userColIdx > -1) {
            const userVal = (step.status === 'pending' || step.status === 'reverted') ? '' : (step.actionUser === '-' ? '' : step.actionUser);
            updateData.push({
              range: `Wave_Monitoring!${getColLetter(userColIdx)}${rowIndex}`,
              values: [[userVal]]
            });
          }
          
          // เตรียมข้อมูลอัปเดตเวลา
          if (timeColIdx > -1) {
            let timeVal = '';
            if (step.status !== 'pending' && step.status !== 'reverted' && step.actualTimestamp && step.actualTimestamp !== '-') {
              const d = new Date(Number(step.actualTimestamp));
              timeVal = d.toLocaleString('en-CA', { hour12: false, timeZone: 'Asia/Bangkok' }).replace(',', '');
            }
            updateData.push({
              range: `Wave_Monitoring!${getColLetter(timeColIdx)}${rowIndex}`,
              values: [[timeVal]]
            });
          }

          // จัดการพิเศษสำหรับประตูโหลดและป้ายทะเบียน
          if (step.key === 'load') {
            const dockColIdx = headers.indexOf('Dock_Door');
            const loadStartColIdx = headers.indexOf('Time_Load_Start');
            const licenseColIdx = headers.indexOf('License_Plate');

            if (step.status === 'pending' || step.status === 'reverted') {
              if (dockColIdx > -1) updateData.push({ range: `Wave_Monitoring!${getColLetter(dockColIdx)}${rowIndex}`, values: [['']] });
              if (loadStartColIdx > -1) updateData.push({ range: `Wave_Monitoring!${getColLetter(loadStartColIdx)}${rowIndex}`, values: [['']] });
            } else {
              if (dockColIdx > -1 && step.dockInfo && step.dockInfo !== '-') {
                updateData.push({ range: `Wave_Monitoring!${getColLetter(dockColIdx)}${rowIndex}`, values: [[step.dockInfo]] });
              }
              if (loadStartColIdx > -1 && step.doingDateObj && step.doingDateObj !== '-') {
                const dStart = new Date(Number(step.doingDateObj));
                const startVal = dStart.toLocaleString('en-CA', { hour12: false, timeZone: 'Asia/Bangkok' }).replace(',', '');
                updateData.push({ range: `Wave_Monitoring!${getColLetter(loadStartColIdx)}${rowIndex}`, values: [[startVal]] });
              }
            }
            if (licenseColIdx > -1 && waveUpdate.licensePlate) {
              updateData.push({ range: `Wave_Monitoring!${getColLetter(licenseColIdx)}${rowIndex}`, values: [[waveUpdate.licensePlate]] });
            }
          }
        });
      }
    });

    // 3. ยิงคำสั่งอัปเดตลง Google Sheets ในครั้งเดียว (Batch Update ช่วยลดปัญหาระบบค้าง)
    if (updateData.length > 0) {
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: DB_SPREADSHEET_ID,
        requestBody: {
          valueInputOption: 'USER_ENTERED',
          data: updateData,
        },
      });
      console.log(`✅ อัปเดตข้อมูลสำเร็จ: ${updateData.length} เซลล์`);
    }

    res.json({ success: true });
  } catch (err) {
    console.error('❌ อัปเดตสถานะขัดข้อง:', err.message);
    res.status(500).json({ success: false, message: err.toString() });
  }
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

// === 1. API สำหรับปุ่ม "นำเข้าแผนงาน" (Import Excel) ===
app.post('/api/upload-excel', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'กรุณาเลือกไฟล์ Excel' });
    }

    // อ่านไฟล์ Excel ที่อัปโหลดเข้ามา
    const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const sheetData = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName]);

    if (!sheetData || sheetData.length === 0) {
      return res.status(400).json({ success: false, message: 'ไม่พบข้อมูลในไฟล์ Excel' });
    }

    if (isSheetsDbConfigured) {
      // ดึงหัวตารางปัจจุบันจาก Google Sheets
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId: DB_SPREADSHEET_ID,
        range: 'Wave_Monitoring!1:1',
      });
      
      const headers = response.data.values ? response.data.values[0] : [];
      
      // แปลงข้อมูลจาก Excel ให้ตรงกับช่องใน Google Sheets
      const rowsToAdd = sheetData.map(row => {
        return headers.map(header => {
          return row[header] !== undefined ? String(row[header]) : '';
        });
      });

      // นำข้อมูลใหม่ไปต่อท้ายตาราง (Append) ใน Google Sheets
      await sheets.spreadsheets.values.append({
        spreadsheetId: DB_SPREADSHEET_ID,
        range: 'Wave_Monitoring!A1',
        valueInputOption: 'USER_ENTERED',
        requestBody: {
          values: rowsToAdd,
        },
      });
    }

    return res.json({ success: true, message: `นำเข้าข้อมูลเรียบร้อยแล้วจำนวน ${sheetData.length} รายการ` });
  } catch (err) {
    console.error('❌ นำเข้าไฟล์ Excel ขัดข้อง:', err.message);
    return res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดในการนำเข้าไฟล์: ' + err.message });
  }
});

// === 2. API สำหรับปุ่ม "Import 204" ===
app.post('/api/import-204', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'กรุณาเลือกไฟล์สำหรับ 204' });
    }

    const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const sheetData = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName]);

    if (isSheetsDbConfigured && sheetData.length > 0) {
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId: DB_SPREADSHEET_ID,
        range: 'Wave_Monitoring!1:1',
      });
      
      const headers = response.data.values ? response.data.values[0] : [];
      const rowsToAdd = sheetData.map(row => {
        return headers.map(header => row[header] !== undefined ? String(row[header]) : '');
      });

      await sheets.spreadsheets.values.append({
        spreadsheetId: DB_SPREADSHEET_ID,
        range: 'Wave_Monitoring!A1',
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: rowsToAdd },
      });
    }

    return res.json({ success: true, message: 'นำเข้าข้อมูล 204 สำเร็จ' });
  } catch (err) {
    console.error('❌ Import 204 ขัดข้อง:', err.message);
    return res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดในการนำเข้า 204: ' + err.message });
  }
});
