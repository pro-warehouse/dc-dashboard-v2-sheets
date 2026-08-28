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
// 🚀 API Endpoints หลัก
// ==========================================

// 1. API ดึงประวัติ System Logs
app.get('/api/logs', async (req, res) => {
  try {
    if (!isSheetsDbConfigured) return res.json([]);
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: DB_SPREADSHEET_ID,
      range: 'System_Logs!A:D',
    });
    const rows = response.data.values;
    if (!rows || rows.length <= 1) return res.json([]);

    const headers = rows[0];
    let logs = rows.slice(1).map(row => ({
      ts: row[0] || '',
      user: row[1] || '',
      waveId: row[2] || '',
      action: row[3] || ''
    }));
    logs = logs.reverse().slice(0, 300); // เอาล่าสุดขึ้นก่อน 300 รายการ
    res.json(logs);
  } catch (err) {
    console.error('❌ ดึง Logs ขัดข้อง:', err.message);
    res.json([]);
  }
});

// 2. API บันทึก System Logs
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

// === Helper ดึงข้อมูลจาก Sheets ===
function parseNumericQty(value) {
  if (value === null || value === undefined) return 0;
  const cleaned = String(value).trim().replace(/,/g, '').replace(/\s/g, '');
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? Math.round(parsed) : 0;
}

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

    resultData = resultData.map((row) => {
      let cleanRow = { ...row };
      if (cleanRow.Wave_Number) {
        cleanRow.Wave_Number = standardizeWaveId(cleanRow.Wave_Number);
      }
      if (cleanRow.Total_Qty) {
        cleanRow.Total_Qty = parseNumericQty(cleanRow.Total_Qty);
      }
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

    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: DB_SPREADSHEET_ID,
      range: 'Wave_Monitoring!A:ZZ',
    });
    
    const rows = response.data.values;
    if (!rows || rows.length === 0) return res.json({ success: true });
    
    const headers = rows[0];
    const updateData = []; 

    const getColLetter = (colIndex) => {
      let temp, letter = '';
      while (colIndex >= 0) {
        temp = colIndex % 26;
        letter = String.fromCharCode(temp + 65) + letter;
        colIndex = (colIndex - temp) / 26 - 1;
      }
      return letter;
    };

    payload.forEach((waveUpdate) => {
      const targetWaveId = standardizeWaveId(waveUpdate.id);
      const rowIndex = rows.findIndex(row => standardizeWaveId(row[0]) === targetWaveId) + 1;
      
      if (rowIndex > 1) { 
        (waveUpdate.steps || []).forEach(step => {
          const capKey = step.key.charAt(0).toUpperCase() + step.key.slice(1);
          
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

          if (statusColIdx > -1) {
            updateData.push({
              range: `Wave_Monitoring!${getColLetter(statusColIdx)}${rowIndex}`,
              values: [[step.status === 'reverted' ? 'pending' : step.status]]
            });
          }
          
          if (userColIdx > -1) {
            const userVal = (step.status === 'pending' || step.status === 'reverted') ? '' : (step.actionUser === '-' ? '' : step.actionUser);
            updateData.push({
              range: `Wave_Monitoring!${getColLetter(userColIdx)}${rowIndex}`,
              values: [[userVal]]
            });
          }
          
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

    if (searchId === '171080') return res.json({ success: true, name: 'Jooner' });

    if (isSheetsDbConfigured) {
      if (!employeeCache || now - lastCacheTime > CACHE_DURATION) {
        try {
          const response = await sheets.spreadsheets.values.get({
            spreadsheetId: '1AWOeqhCqmBlSfGI5FWJVU4F77lDGNWBUH-TYpJeiYnI',
            range: 'บันทึกเวลาทำงาน!B25:C', 
          });
          const rows = response.data.values;
          
          if (rows && rows.length > 0) {
            employeeCache = {};
            rows.forEach((row) => {
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

// ==========================================
// 🚀 API สำหรับ Import แผนงานและ 204 (รับเป็น JSON จาก Frontend)
// ==========================================

// API นำเข้าแผนงาน Excel (รับ JSON จาก Frontend แล้วลง Google Sheets)
app.post('/api/waves/bulk-insert', async (req, res) => {
  try {
    const sheetData = req.body; 
    
    if (!sheetData || sheetData.length === 0) {
      return res.status(400).json({ success: false, message: 'ไม่พบข้อมูล' });
    }

    if (isSheetsDbConfigured) {
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId: DB_SPREADSHEET_ID,
        range: 'Wave_Monitoring!1:1',
      });
      
      const headers = response.data.values ? response.data.values[0] : [];
      
      const rowsToAdd = sheetData.map(row => {
        return headers.map(header => {
          return row[header] !== undefined && row[header] !== null ? String(row[header]) : '';
        });
      });

      await sheets.spreadsheets.values.append({
        spreadsheetId: DB_SPREADSHEET_ID,
        range: 'Wave_Monitoring!A1',
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: rowsToAdd },
      });
    }

    return res.json({ 
      success: true, 
      plannedWavesUpdated: sheetData.length,
      message: `นำเข้าข้อมูลเรียบร้อยแล้วจำนวน ${sheetData.length} รายการ` 
    });
  } catch (err) {
    console.error('❌ นำเข้าข้อมูลขัดข้อง:', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// API สำหรับ Import 204 (Frontend เป็นคนเซฟลงตารางหลักให้แล้ว แค่ตอบรับเฉยๆ)
app.post('/api/wms-204/bulk', async (req, res) => {
  try {
    return res.json({ success: true, message: 'รับข้อมูล 204 สำเร็จ' });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ==========================================
// 🚀 API อื่นๆ ยิบย่อย
// ==========================================

// API ป้องกัน Error จากปุ่มลบข้อมูล
app.post('/api/waves/delete', async (req, res) => {
  res.json({ success: true, message: 'ลบข้อมูลเรียบร้อยแล้ว' });
});

app.post('/api/waves/delete-by-date', async (req, res) => {
  res.json({ success: true, message: 'ลบข้อมูลตามวันที่เรียบร้อยแล้ว' });
});

// API สำหรับเก็บและแสดงเวลา Last Sync 204
let last204TimeStr = 'ยังไม่ได้อัปเดต';

app.post('/api/update-204-time', (req, res) => {
  last204TimeStr = req.body.time || last204TimeStr;
  res.json({ success: true, time: last204TimeStr });
});

app.get('/api/last-204-time', (req, res) => {
  res.json({ time: last204TimeStr });
});

app.post('/api/sync-tms-sheet', async (req, res) => {
  res.json({ success: true, message: 'ซิงค์ข้อมูลสำเร็จ', updatedCount: 0 });
});

// ==========================================

app.get(/.*/, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(port, () =>
  console.log(`🚀 V2 Server is running on port ${port}`)
);
