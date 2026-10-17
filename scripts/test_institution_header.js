import assert from 'node:assert';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { PDFParse } from 'pdf-parse';

const BASE_URL = 'http://localhost:3000';

function httpGetBuffer(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          buffer: Buffer.concat(chunks),
        });
      });
    }).on('error', reject);
  });
}

function httpPostJson(url, data, token) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(data);
    const parsed = new URL(url);
    const req = http.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          resolve({ statusCode: res.statusCode, headers: res.headers, body });
        } catch {
          resolve({ statusCode: res.statusCode, headers: res.headers, raw: Buffer.concat(chunks).toString('utf8') });
        }
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

function httpPatchJson(url, data, token) {
  return new Promise((resolve, reject) => {
    const patchData = JSON.stringify(data);
    const parsed = new URL(url);
    const req = http.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(patchData),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          resolve({ statusCode: res.statusCode, headers: res.headers, body });
        } catch {
          resolve({ statusCode: res.statusCode, headers: res.headers, raw: Buffer.concat(chunks).toString('utf8') });
        }
      });
    });
    req.on('error', reject);
    req.write(patchData);
    req.end();
  });
}

function extractDocxText(buffer) {
  const tmpFile = path.resolve(process.cwd(), `tmp_${Date.now()}_${Math.random().toString(36).slice(2)}.docx`);
  fs.writeFileSync(tmpFile, buffer);
  try {
    const xml = execSync(`unzip -p "${tmpFile}" word/document.xml`, { encoding: 'utf8' });
    return xml;
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
}

async function runInstitutionHeaderTests() {
  console.log('\n======================================================');
  console.log('  EXAMCRAFT AI: CONFIGURABLE INSTITUTION HEADER SUITE ');
  console.log('======================================================\n');

  let passed = 0;
  let total = 0;

  async function test(name, fn) {
    total++;
    try {
      await fn();
      passed++;
      console.log(`  [PASS] ${name}`);
    } catch (err) {
      console.error(`  [FAIL] ${name}:`, err.message);
      throw err;
    }
  }

  const guestSession = `guest_test_${Date.now()}`;

  // Test 1: Teacher entering "Faculty of Law"
  let examFacultyOfLawId = '';
  await test('Create exam with custom English "Faculty of Law": renders in PDF and DOCX', async () => {
    const res = await httpPostJson(`${BASE_URL}/api/exams/generate`, {
      document_id: 'doc-cell-biology-101',
      title: 'Jurisprudence & Legal Theory Exam',
      subject: 'Constitutional Law',
      institution: 'Kabul University',
      faculty: 'Faculty of Law',
      duration_minutes: 90,
      groups_count: 1,
      question_types_config: { mcq: 1, true_false: 1 },
    }, guestSession);

    assert.strictEqual(res.statusCode, 201, 'Exam creation must return 201');
    assert.strictEqual(res.body.institution, 'Kabul University');
    assert.strictEqual(res.body.faculty, 'Faculty of Law');
    examFacultyOfLawId = res.body.id;

    // Verify PDF
    const pdfRes = await httpGetBuffer(`${BASE_URL}/api/exams/${examFacultyOfLawId}/export/pdf?target=exam`);
    assert.strictEqual(pdfRes.statusCode, 200);
    const parser = new PDFParse({ data: pdfRes.buffer });
    const doc = await parser.load();
    const p1 = await doc.getPage(1);
    const tc = await p1.getTextContent();
    const text = tc.items.map(i => i.str).join(' ');

    assert(text.includes('Faculty of Law'), 'PDF must include custom "Faculty of Law"');
    assert(text.includes('Kabul University'), 'PDF must include custom "Kabul University"');
    assert(!text.includes('Faculty of Sciences'), 'PDF must NOT include hardcoded "Faculty of Sciences"');

    // Verify DOCX
    const docxRes = await httpGetBuffer(`${BASE_URL}/api/exams/${examFacultyOfLawId}/export/docx?target=exam`);
    assert.strictEqual(docxRes.statusCode, 200);
    const docxXml = extractDocxText(docxRes.buffer);
    assert(docxXml.includes('Faculty of Law'), 'DOCX must contain "Faculty of Law"');
    assert(docxXml.includes('Kabul University'), 'DOCX must contain "Kabul University"');
    assert(!docxXml.includes('Faculty of Sciences'), 'DOCX must NOT contain "Faculty of Sciences"');
  });

  // Test 2: Teacher entering a Dari/Persian institution name
  let examDariId = '';
  await test('Create exam with Dari/Persian institution name: renders in PDF and DOCX with RTL', async () => {
    const res = await httpPostJson(`${BASE_URL}/api/exams/generate`, {
      document_id: 'doc-cell-biology-101',
      title: 'امتحان حقوق و علوم سیاسی',
      subject: 'حقوق اساسی',
      institution: 'دانشگاه کابل',
      faculty: 'پوهنځی حقوق و علوم سیاسی',
      language: 'fa',
      is_rtl: true,
      groups_count: 1,
      question_types_config: { mcq: 1, true_false: 1 },
    }, guestSession);

    assert.strictEqual(res.statusCode, 201, 'Dari exam creation must return 201');
    assert.strictEqual(res.body.institution, 'دانشگاه کابل');
    assert.strictEqual(res.body.faculty, 'پوهنځی حقوق و علوم سیاسی');
    examDariId = res.body.id;

    // Verify PDF
    const pdfRes = await httpGetBuffer(`${BASE_URL}/api/exams/${examDariId}/export/pdf?target=exam`);
    assert.strictEqual(pdfRes.statusCode, 200);
    const parser = new PDFParse({ data: pdfRes.buffer });
    const doc = await parser.load();
    const p1 = await doc.getPage(1);
    const tc = await p1.getTextContent();
    const text = tc.items.map(i => i.str).join(' ');

    assert(text.includes('دانشگاه کابل'), 'PDF must include custom Dari institution');
    assert(text.includes('پوهنځی حقوق'), 'PDF must include custom Dari faculty');
    assert(!text.includes('Faculty of Sciences'), 'PDF must NOT include "Faculty of Sciences"');

    // Verify DOCX
    const docxRes = await httpGetBuffer(`${BASE_URL}/api/exams/${examDariId}/export/docx?target=exam`);
    assert.strictEqual(docxRes.statusCode, 200);
    const docxXml = extractDocxText(docxRes.buffer);
    assert(docxXml.includes('دانشگاه کابل'), 'DOCX must contain Dari institution');
    assert(docxXml.includes('پوهنځی حقوق و علوم سیاسی'), 'DOCX must contain Dari faculty');
  });

  // Test 3: Both fields being left blank, resulting in NO hardcoded or fabricated institution name
  let examBlankId = '';
  await test('Create exam with both institution and faculty left blank: NO hardcoded or fabricated name rendered', async () => {
    const res = await httpPostJson(`${BASE_URL}/api/exams/generate`, {
      document_id: 'doc-cell-biology-101',
      title: 'General Independent Assessment',
      subject: 'Applied Mathematics',
      institution: '',
      faculty: '',
      groups_count: 1,
      question_types_config: { mcq: 1, true_false: 1 },
    }, guestSession);

    assert.strictEqual(res.statusCode, 201, 'Blank exam creation must return 201');
    assert.strictEqual(res.body.institution, null, 'Blank institution must be null');
    assert.strictEqual(res.body.faculty, null, 'Blank faculty must be null');
    examBlankId = res.body.id;

    // Verify PDF
    const pdfRes = await httpGetBuffer(`${BASE_URL}/api/exams/${examBlankId}/export/pdf?target=exam`);
    assert.strictEqual(pdfRes.statusCode, 200);
    const parser = new PDFParse({ data: pdfRes.buffer });
    const doc = await parser.load();
    const p1 = await doc.getPage(1);
    const tc = await p1.getTextContent();
    const text = tc.items.map(i => i.str).join(' ');

    assert(!text.includes('Faculty of Sciences'), 'PDF must NOT contain "Faculty of Sciences"');
    assert(!text.includes('ACADEMIC INSTITUTION'), 'PDF must NOT contain "ACADEMIC INSTITUTION"');
    assert(!text.includes('Academic Faculty'), 'PDF must NOT contain "Academic Faculty"');
    assert(!text.includes('دانشکده و مؤسسه تحصیلات عالی'), 'PDF must NOT contain Persian fabricated default');

    // Verify DOCX
    const docxRes = await httpGetBuffer(`${BASE_URL}/api/exams/${examBlankId}/export/docx?target=exam`);
    assert.strictEqual(docxRes.statusCode, 200);
    const docxXml = extractDocxText(docxRes.buffer);
    assert(!docxXml.includes('Faculty of Sciences'), 'DOCX must NOT contain "Faculty of Sciences"');
    assert(!docxXml.includes('ACADEMIC INSTITUTION'), 'DOCX must NOT contain "ACADEMIC INSTITUTION"');
    assert(!docxXml.includes('دانشکده و مؤسسه تحصیلات عالی'), 'DOCX must NOT contain Persian fabricated default');
  });

  // Test 4: Updating an existing exam via PATCH endpoint preserves persistence
  await test('Update exam metadata with PATCH /api/exams/:id updates institution and faculty', async () => {
    const patchRes = await httpPatchJson(`${BASE_URL}/api/exams/${examBlankId}`, {
      institution: 'Herat High School',
      faculty: 'Department of Natural Sciences',
    }, guestSession);

    assert.strictEqual(patchRes.statusCode, 200);
    assert.strictEqual(patchRes.body.institution, 'Herat High School');
    assert.strictEqual(patchRes.body.faculty, 'Department of Natural Sciences');

    // Verify updated PDF now has updated institution
    const pdfRes = await httpGetBuffer(`${BASE_URL}/api/exams/${examBlankId}/export/pdf?target=exam`);
    assert.strictEqual(pdfRes.statusCode, 200);
    const parser = new PDFParse({ data: pdfRes.buffer });
    const doc = await parser.load();
    const p1 = await doc.getPage(1);
    const tc = await p1.getTextContent();
    const text = tc.items.map(i => i.str).join(' ');
    assert(text.includes('Herat High School'));
    assert(text.includes('Department of Natural Sciences'));
  });

  // Test 5: Existing and older exams load cleanly without crashes or missing field errors
  await test('Compatibility with existing saved exams: older exams load cleanly without crashes', async () => {
    const res = await httpGetBuffer(`${BASE_URL}/api/exams`);
    assert.strictEqual(res.statusCode, 200);
    const exams = JSON.parse(res.buffer.toString('utf8'));
    assert(Array.isArray(exams) && exams.length > 0, 'Exams list must be non-empty');

    for (const ex of exams) {
      assert(ex.id, 'Exam ID must exist');
      assert(typeof ex.title === 'string', 'Title must be string');
      assert(ex.faculty === undefined || ex.faculty === null || typeof ex.faculty === 'string');
    }
  });

  console.log('\n======================================================');
  console.log(`  ALL ${passed}/${total} INSTITUTION HEADER TESTS PASSED!`);
  console.log('======================================================\n');
}

runInstitutionHeaderTests().catch((err) => {
  console.error('\nTest Suite Failed:', err);
  process.exit(1);
});
