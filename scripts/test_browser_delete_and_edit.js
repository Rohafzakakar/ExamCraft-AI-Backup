import puppeteer from '/root/.npm/_npx/7d92d9a2d2ccc630/node_modules/puppeteer/lib/puppeteer/puppeteer.js';

async function testInteractiveUI() {
  console.log('--- Testing Interactive UI for Edit and Delete in Chromium ---');
  const browser = await puppeteer.launch({
    executablePath: '/root/.cache/puppeteer/chrome/linux-155.0.8059.39/chrome-linux64/chrome',
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
  });

  try {
    const page = await browser.newPage();
    page.on('console', (msg) => console.log(`[Browser Console]:`, msg.text()));
    page.on('pageerror', (err) => console.error(`[Browser PageError]:`, err.toString()));

    await page.goto('http://localhost:3000', { waitUntil: 'networkidle0' });

    // 1. Navigate to Step 3
    await page.waitForFunction(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const s3 = btns.find((b) => b.innerText.includes('Review Groups & Answer Keys'));
      return s3 && !s3.disabled;
    });

    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const s3 = btns.find((b) => b.innerText.includes('Review Groups & Answer Keys'));
      s3.click();
    });

    await new Promise((r) => setTimeout(r, 800));

    // 2. Test Edit MCQ Options UI
    console.log('Testing MCQ Options Editing UI...');
    // Click "Edit" on the first question
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const editBtn = btns.find((b) => b.innerText === 'Edit' || b.innerText.includes('Edit'));
      editBtn.click();
    });

    // Check that option inputs and reorder arrows appear
    await page.waitForSelector('input[type="radio"]');
    const editFormState = await page.evaluate(() => {
      const radios = document.querySelectorAll('input[type="radio"]');
      const textInputs = document.querySelectorAll('input[type="text"]');
      const textareas = document.querySelectorAll('textarea');
      return {
        radioCount: radios.length,
        textInputCount: textInputs.length,
        hasTextarea: textareas.length > 0,
      };
    });

    console.log('Edit form state:', editFormState);
    if (editFormState.radioCount < 2) {
      throw new Error('Edit form did not render MCQ choice radios!');
    }

    // Cancel edit
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const cancelBtn = btns.find((b) => b.title === 'Cancel');
      if (cancelBtn) cancelBtn.click();
    });

    await new Promise((r) => setTimeout(r, 400));

    // 3. Test Delete Question Confirmation Dialog
    console.log('Testing Delete Question Confirmation Dialog...');
    const deleteBtn = await page.evaluateHandle(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      return btns.find((b) => b.innerText.includes('Delete Question'));
    });

    if (!deleteBtn.asElement()) {
      throw new Error('Delete Question button not found!');
    }

    await deleteBtn.asElement().click();

    // Verify modal is visible
    await page.waitForSelector('div[class*="backdrop-blur"]');
    const modalText = await page.evaluate(() => {
      const modal = document.querySelector('div[class*="backdrop-blur"]');
      return modal ? modal.innerText : '';
    });

    console.log('Delete modal text snippet:', modalText.slice(0, 150));
    if (!modalText.includes('Are you sure you want to delete this question?')) {
      throw new Error('Confirmation dialog missing expected warning text!');
    }

    // Click Cancel in the modal
    console.log('Testing Cancel button in confirmation modal...');
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const cancel = btns.find((b) => b.innerText === 'Cancel');
      cancel.click();
    });

    await new Promise((r) => setTimeout(r, 400));
    const modalClosed = await page.evaluate(() => {
      return document.querySelector('div[class*="backdrop-blur"]') === null;
    });

    console.log('Modal closed on cancel:', modalClosed);
    if (!modalClosed) {
      throw new Error('Modal did not close on Cancel!');
    }

    console.log('--- Interactive UI Test Passed Successfully! ---');
  } finally {
    await browser.close();
  }
}

testInteractiveUI().catch((err) => {
  console.error(err);
  process.exit(1);
});
