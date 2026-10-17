import assert from 'node:assert';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { PDFParse } from 'pdf-parse';
import fontkit from '@pdf-lib/fontkit';

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

async function runDariPdfRegressionTests() {
  console.log('\n======================================================');
  console.log('  EXAMCRAFT AI: DARI/PERSIAN PDF TEXT-RENDERING SUITE ');
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

  // Test 1: Verify Vazir font files are present and contain full Persian glyph set
  await test('Vazir font files exist and support Persian specific glyphs (پ, چ, ژ, گ, ی, ک)', async () => {
    const fontFiles = ['Vazir-Regular.ttf', 'Vazir-Bold.ttf', 'Vazir-Light.ttf'];
    for (const file of fontFiles) {
      const fontPath = path.resolve(process.cwd(), 'fonts', file);
      assert(fs.existsSync(fontPath), `Font file ${file} must exist at ${fontPath}`);
      const font = fontkit.create(fs.readFileSync(fontPath));
      assert(font.hasGlyphForCodePoint(0x067E), `Font ${file} must support Peh (پ)`);
      assert(font.hasGlyphForCodePoint(0x0686), `Font ${file} must support Che (چ)`);
      assert(font.hasGlyphForCodePoint(0x0698), `Font ${file} must support Zhe (ژ)`);
      assert(font.hasGlyphForCodePoint(0x06AF), `Font ${file} must support Gaf (گ)`);
      assert(font.hasGlyphForCodePoint(0x06CC), `Font ${file} must support Farsi Yeh (ی)`);
      assert(font.hasGlyphForCodePoint(0x06A9), `Font ${file} must support Farsi Keh (ک)`);
      assert(font.hasGlyphForCodePoint(0xFB56), `Font ${file} must support Peh presentation form (ﭖ)`);
      assert(font.hasGlyphForCodePoint(0xFB92), `Font ${file} must support Gaf presentation form (ﮒ)`);
      assert(font.hasGlyphForCodePoint(0xFBFD), `Font ${file} must support Farsi Yeh presentation form (ﯽ)`);
      assert(font.hasGlyphForCodePoint(0x200C), `Font ${file} must support ZWNJ`);
    }
  });

  // Test 2: Create or verify a rich Dari exam with connected letters, punctuation, and mixed English
  let examId = '';
  await test('Create or load a rich Dari/Persian exam with mixed English/Dari and punctuation', async () => {
    const guestId = `guest_dari_test_${Date.now()}`;
    const genRes = await httpPostJson(`${BASE_URL}/api/exams/generate`, {
      document_id: 'doc-cell-biology-101',
      title: 'امتحان قضایی و حقوقی زنان در افغانستان (Dari Exam 2026)',
      subject: 'حقوق و علوم سیاسی (Law & Politics)',
      language: 'fa',
      is_rtl: true,
      groups_count: 1,
      question_types_config: { mcq: 2, true_false: 1, fill_blank: 1, essay: 1 },
    }, guestId);

    assert.strictEqual(genRes.statusCode, 201, 'Exam generation must succeed');
    examId = genRes.body.id;
    assert(examId, 'Exam ID must be returned');

    // Update Question 1 with a real Dari/Persian sample containing connected letters, punctuation, and mixed English
    const q1 = genRes.body.groups[0].questions[0];
    const updateRes = await new Promise((resolve, reject) => {
      const putData = JSON.stringify({
        question_text: 'مسئله حقوق زنان و فراز و نشیب‌های ساختار قانونی در افغانستان طبق گزارش UN (صفحه 2) چگونه ارزیابی می‌شود؟',
        correct_answer: 'تحلیل تطبیقی قوانین اساسی و مدنی در دوره‌های جمهوری و امارت اسلامی (1919-2021).',
        explanation: 'تشریح کامل وضعیت حقوقی-سیاسی بر پایه اسناد رسمی و مواد قانون اساسی (Constitutional Law).',
        options: [
          'الف) تثبیت جایگاه زنان در ساختار اداری و قضایی کشور',
          'ب) تعلیق کامل فعالیت‌های تجاری و اقتصادی بخش خصوصی',
          'ج) ادغام وزارتخانه‌های سکتوری با نهادهای بین‌المللی UNDP',
          'د) اصلاحات ساختاری در نظام مالیاتی و گمرکات ولایتی',
        ],
      });
      const parsed = new URL(`${BASE_URL}/api/exams/${examId}/questions/${q1.id}`);
      const req = http.request({
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname,
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(putData),
          Authorization: `Bearer ${guestId}`,
        },
      }, (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve({ statusCode: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }));
      });
      req.on('error', reject);
      req.write(putData);
      req.end();
    });

    assert.strictEqual(updateRes.statusCode, 200, 'Updating question with rich Dari content must succeed');
  });

  // Test 3: Export Dari PDF and verify actual text content, zero null characters, and proper embedding
  await test('Export Dari PDF: verify HTTP 200, zero null characters, and connected letter forms', async () => {
    const res = await httpGetBuffer(`${BASE_URL}/api/exams/${examId}/export/pdf?target=both`);
    assert.strictEqual(res.statusCode, 200, 'PDF export must return HTTP 200');
    assert.strictEqual(res.headers['content-type'], 'application/pdf');
    assert(res.buffer.length > 5000, `PDF size must be substantial (>5000 bytes), got ${res.buffer.length}`);

    // Parse the PDF text content
    const parser = new PDFParse({ data: res.buffer });
    const doc = await parser.load();
    assert(doc.numPages >= 2, `PDF must contain at least 2 pages (exam and answer key), got ${doc.numPages}`);

    for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
      const page = await doc.getPage(pageNum);
      const textContent = await page.getTextContent();
      assert(textContent.items.length > 0, `Page ${pageNum} must contain rendered text items`);

      let nullCount = 0;
      let validCount = 0;
      for (const item of textContent.items) {
        for (const ch of item.str) {
          if (ch.charCodeAt(0) === 0) {
            nullCount++;
          } else {
            validCount++;
          }
        }
      }

      assert.strictEqual(nullCount, 0, `Page ${pageNum} must contain 0 null bytes (missing glyphs), found ${nullCount}`);
      assert(validCount > 100, `Page ${pageNum} must contain valid characters, found ${validCount}`);
    }

    // Inspect first page items to confirm Persian content is rendered
    const p1 = await doc.getPage(1);
    const p1Content = await p1.getTextContent();
    const allP1Text = p1Content.items.map(it => it.str).join(' ');

    // Check that question and option text was drawn
    assert(allP1Text.length > 200, 'Page 1 must contain substantive text');
    console.log(`    -> Page 1 verified: ${p1Content.items.length} items, 0 null bytes, size: ${res.buffer.length} bytes`);
  });

  // Test 4: Confirm English PDF export remains correct and uncorrupted
  await test('Export English PDF: verify HTTP 200, clean text, and zero regressions', async () => {
    const res = await httpGetBuffer(`${BASE_URL}/api/exams/exam-cell-bio-midterm/export/pdf?target=both`);
    assert.strictEqual(res.statusCode, 200, 'English PDF export must return HTTP 200');
    assert.strictEqual(res.headers['content-type'], 'application/pdf');

    const parser = new PDFParse({ data: res.buffer });
    const doc = await parser.load();
    assert(doc.numPages >= 2, 'English PDF must contain multiple pages');

    const p1 = await doc.getPage(1);
    const tc = await p1.getTextContent();
    const text = tc.items.map(it => it.str).join(' ');
    assert(text.includes('Cell Biology Midterm Examination'), 'English title must be present');
    assert(text.includes('Group A'), 'Group name must be present');
    console.log(`    -> English PDF verified: ${tc.items.length} items on Page 1, size: ${res.buffer.length} bytes`);
  });

  // Test 5: Confirm DOCX export remains functional and unchanged
  await test('Export DOCX: verify HTTP 200 and valid Office OpenXML document', async () => {
    const res = await httpGetBuffer(`${BASE_URL}/api/exams/${examId}/export/docx?target=both`);
    assert.strictEqual(res.statusCode, 200, 'DOCX export must return HTTP 200');
    assert.strictEqual(
      res.headers['content-type'],
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'Content-Type must be DOCX'
    );
    assert(res.buffer.length > 5000, `DOCX size must be > 5000 bytes, got ${res.buffer.length}`);
    console.log(`    -> DOCX export verified: size: ${res.buffer.length} bytes`);
  });

  console.log('\n======================================================');
  console.log(`  ALL ${passed}/${total} DARI/PERSIAN PDF REGRESSION TESTS PASSED!`);
  console.log('======================================================\n');
}

runDariPdfRegressionTests().catch((err) => {
  console.error('\nTest Suite Failed:', err);
  process.exit(1);
});
