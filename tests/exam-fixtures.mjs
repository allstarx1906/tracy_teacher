/**
 * Internal test-only minimal PDF bytes (text operators, digital PDF).
 */

function escapePdfText(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function buildPageContent(textOps) {
  return `${textOps.join('\n')}\n`;
}

function wrapPdf(pages) {
  const objects = [];
  let objId = 1;
  const add = (body) => {
    const id = objId++;
    objects.push({ id, body });
    return id;
  };

  const fontId = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const pageIds = [];
  const contentIds = [];

  for (const ops of pages) {
    const stream = buildPageContent(ops);
    const contentId = add(`<< /Length ${Buffer.byteLength(stream, 'utf8')} >>\nstream\n${stream}endstream`);
    contentIds.push(contentId);
    const pageId = add(
      `<< /Type /Page /Parent 0 0 R /MediaBox [0 0 612 792] `
      + `/Contents ${contentId} 0 R /Resources << /Font << /F1 ${fontId} 0 R >> >> >>`,
    );
    pageIds.push(pageId);
  }

  const kids = pageIds.map((id) => `${id} 0 R`).join(' ');
  const pagesId = add(`<< /Type /Pages /Kids [ ${kids} ] /Count ${pageIds.length} >>`);
  for (const p of objects) {
    if (p.body.includes('/Parent 0 0 R')) {
      p.body = p.body.replace('/Parent 0 0 R', `/Parent ${pagesId} 0 R`);
    }
  }
  const catalogId = add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);

  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const obj of objects) {
    offsets.push(Buffer.byteLength(pdf, 'utf8'));
    pdf += `${obj.id} 0 obj\n${obj.body}\nendobj\n`;
  }
  const xrefPos = Buffer.byteLength(pdf, 'utf8');
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += '0000000000 65535 f \n';
  for (let i = 1; i <= objects.length; i++) {
    const off = String(offsets[i]).padStart(10, '0');
    pdf += `${off} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\n`;
  pdf += `startxref\n${xrefPos}\n%%EOF\n`;
  return Buffer.from(pdf, 'utf8');
}

function textLine(x, y, text) {
  return `BT /F1 12 Tf ${x} ${y} Td (${escapePdfText(text)}) Tj ET`;
}

/** Two-question sample with shared passage header and answer key page. */
export function buildSampleExamPdf() {
  const page1 = [
    textLine(72, 700, 'Reading Passage'),
    textLine(72, 680, 'Questions 1-2'),
    textLine(72, 660, 'The quick brown fox jumps.'),
    textLine(72, 620, '1. What color?'),
    textLine(90, 600, '(A) red'),
    textLine(90, 580, '(B) brown'),
    textLine(90, 560, '(C) blue'),
    textLine(90, 540, '(D) green'),
    textLine(72, 500, '2. What animal?'),
    textLine(90, 480, '(A) cat'),
    textLine(90, 460, '(B) dog'),
    textLine(90, 440, '(C) fox'),
    textLine(90, 420, '(D) bird'),
  ];
  const page2 = [
    textLine(72, 700, 'Answer Key'),
    textLine(72, 680, '1: B'),
    textLine(72, 660, '2: C'),
  ];
  return wrapPdf([page1, page2]);
}

/** Page with no text content — should report needsOCR. */
export function buildBlankDigitalPdf() {
  return wrapPdf([[]]);
}

/** Invalid PDF bytes for upload rejection or parse failure. */
export function buildBrokenPdfBuffer() {
  return Buffer.from('%PDF-1.4\nbroken', 'utf8');
}

/** Two-column style lines (still digital text). */
export function buildTwoColumnExamPdf() {
  const page1 = [
    textLine(72, 700, '1. Left column question?'),
    textLine(90, 680, '(A) one'),
    textLine(90, 660, '(B) two'),
    textLine(320, 700, '2. Right column question?'),
    textLine(338, 680, '(A) alpha'),
    textLine(338, 660, '(B) beta'),
  ];
  const page2 = [textLine(72, 700, '1: A'), textLine(72, 680, '2: B')];
  return wrapPdf([page1, page2]);
}

export async function waitForImportJob(base, jar, jobId, { timeoutMs = 30_000 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await fetch(`${base}/api/teacher/exams/imports/${encodeURIComponent(jobId)}`, {
      headers: { cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ') },
    });
    const data = await res.json();
    const job = data.job;
    if (['ready', 'needs-review', 'failed', 'cancelled'].includes(job.status)) {
      return job;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('import-timeout');
}
