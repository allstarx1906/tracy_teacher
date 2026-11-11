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

/** Page with no text content — genuinely blank (no paint operators). */
export function buildBlankDigitalPdf() {
  return wrapPdf([[]]);
}

/** Full-page image XObject, no text layer — should report needsOcr. */
export function buildRasterImageOnlyPdf() {
  const chunks = [];
  let size = 0;
  const offsets = [0];
  const append = (buf) => {
    chunks.push(buf);
    size += buf.length;
  };
  append(Buffer.from('%PDF-1.4\n', 'utf8'));
  const imageDict = '<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB '
    + '/BitsPerComponent 8 /Length 3 >>\nstream\n';
  offsets.push(size);
  append(Buffer.from('1 0 obj\n', 'utf8'));
  append(Buffer.from(imageDict, 'utf8'));
  append(Buffer.from([200, 40, 40]));
  append(Buffer.from('\nendstream\nendobj\n', 'utf8'));
  const contentStream = 'q\n612 0 0 792 0 0 cm\n/Im1 Do\nQ\n';
  offsets.push(size);
  append(Buffer.from(`2 0 obj\n<< /Length ${Buffer.byteLength(contentStream, 'utf8')} >>\nstream\n${contentStream}endstream\nendobj\n`, 'utf8'));
  offsets.push(size);
  append(Buffer.from('3 0 obj\n<< /Type /Page /Parent 4 0 R /MediaBox [0 0 612 792] /Contents 2 0 R /Resources << /XObject << /Im1 1 0 R >> >> >>\nendobj\n', 'utf8'));
  offsets.push(size);
  append(Buffer.from('4 0 obj\n<< /Type /Pages /Kids [ 3 0 R ] /Count 1 >>\nendobj\n', 'utf8'));
  offsets.push(size);
  append(Buffer.from('5 0 obj\n<< /Type /Catalog /Pages 4 0 R >>\nendobj\n', 'utf8'));
  const xrefPos = size;
  let xref = 'xref\n0 6\n0000000000 65535 f \n';
  for (let i = 1; i <= 5; i++) {
    xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  xref += 'trailer\n<< /Size 6 /Root 5 0 R >>\n';
  xref += `startxref\n${xrefPos}\n%%EOF\n`;
  append(Buffer.from(xref, 'utf8'));
  return Buffer.concat(chunks);
}

/** One question page plus an intentionally blank separator page. */
export function buildQuestionPageWithBlankPagePdf() {
  const page1 = [
    textLine(72, 700, '1. Sample question on page one?'),
    textLine(90, 680, '(A) yes'),
    textLine(90, 660, '(B) no'),
  ];
  const page2 = [];
  const page3 = [textLine(72, 700, '1: A')];
  return wrapPdf([page1, page2, page3]);
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

function textLineSmall(x, y, text) {
  return `BT /F1 10 Tf ${x} ${y} Td (${escapePdfText(text)}) Tj ET`;
}

/** Part 5-like dual question columns with tight 10pt baselines (regression for line clustering). */
export function buildDualColumnPart5Pdf() {
  const page1 = [
    textLine(52, 720, 'PART 5'),
    textLine(52, 680, '101. Alpha stem one line'),
    textLine(74, 668, '(A) a1'),
    textLine(74, 658, '(B) a2'),
    textLine(74, 648, '(C) a3'),
    textLine(74, 638, '(D) a4'),
    textLine(52, 620, '102. Beta stem here'),
    textLine(74, 608, '(A) b1'),
    textLine(74, 598, '(B) b2'),
    textLine(74, 588, '(C) b3'),
    textLine(74, 578, '(D) b4'),
    textLine(320, 680, '103. Gamma stem right col'),
    textLine(342, 668, '(A) g1'),
    textLine(342, 658, '(B) g2'),
    textLine(342, 648, '(C) g3'),
    textLine(342, 638, '(D) g4'),
    textLine(320, 620, '104. Delta stem right col'),
    textLine(342, 608, '(A) d1'),
    textLine(342, 598, '(B) d2'),
    textLine(342, 588, '(C) d3'),
    textLine(342, 578, '(D) d4'),
  ];
  const page2 = [
    textLine(350, 680, '101'),
    textLine(418, 680, 'A'),
    textLine(350, 660, '102'),
    textLine(418, 660, 'B'),
    textLine(350, 640, '103'),
    textLine(418, 640, 'C'),
    textLine(350, 620, '104'),
    textLine(418, 620, 'D'),
  ];
  return wrapPdf([page1, page2]);
}

/** Wrapped stem + options split across lines. */
export function buildWrappedStemOptionsPdf() {
  const page1 = [
    textLine(72, 700, 'Questions 1-1'),
    textLine(72, 680, '1. First line of stem only'),
    textLine(72, 665, 'second line completes stem'),
    textLine(90, 645, '(A) opt one'),
    textLine(90, 630, '(B) opt two'),
    textLine(90, 615, '(C) opt three'),
    textLine(90, 600, '(D) opt four'),
  ];
  const page2 = [textLine(72, 700, '1: C')];
  return wrapPdf([page1, page2]);
}

/** Inline numbered question with first option on same line (Part 6 style). */
export function buildInlineFirstOptionPdf() {
  const page1 = [
    textLine(52, 700, 'Questions 131-134 refer to the following e-mail.'),
    textLine(52, 660, 'Body line with gap marker 132.'),
    textLine(44, 620, '131. (A) choice-one'),
    textLine(74, 605, '(B) choice-two'),
    textLine(74, 590, '(C) choice-three'),
    textLine(74, 575, '(D) choice-four'),
  ];
  const page2 = [textLine(72, 700, '131: A')];
  return wrapPdf([page1, page2]);
}

/** Full-width passage above two-column Part 7-style blocks. */
export function buildPassageWithSideQuestionsPdf() {
  const page1 = [
    textLine(52, 720, 'Questions 147-148 refer to the following advertisement.'),
    textLine(52, 700, 'Shared passage line across the full width of page.'),
    textLine(52, 680, 'Second passage line continues here.'),
    textLine(52, 640, '147. Left question stem?'),
    textLine(74, 625, '(A) L1'),
    textLine(74, 610, '(B) L2'),
    textLine(320, 640, '148. Right question stem?'),
    textLine(342, 625, '(A) R1'),
    textLine(342, 610, '(B) R2'),
  ];
  const page2 = [textLine(72, 700, '147: A'), textLine(72, 680, '148: B')];
  return wrapPdf([page1, page2]);
}

/** Small 10pt font lines that must not merge across baselines. */
export function buildSmallBaselineFontPdf() {
  const page1 = [
    textLineSmall(52, 700, '201. Tight line one'),
    textLineSmall(74, 689, '(A) x'),
    textLineSmall(74, 678, '(B) y'),
    textLineSmall(52, 660, '202. Another stem'),
    textLineSmall(74, 649, '(A) p'),
    textLineSmall(74, 638, '(B) q'),
  ];
  const page2 = [textLine(72, 700, '201: A'), textLine(72, 680, '202: B')];
  return wrapPdf([page1, page2]);
}

/** Part 7-style: left column one question, right column one question (151-only regression). */
export function buildSingleRightColumnQuestionPdf() {
  const page1 = [
    textLine(52, 720, 'Questions 149-151 refer to the following article.'),
    textLine(220, 680, 'Article body line one.'),
    textLine(45, 640, '150. Left column question stem?'),
    textLine(74, 625, '(A) L1'),
    textLine(74, 610, '(B) L2'),
    textLine(74, 595, '(C) L3'),
    textLine(74, 580, '(D) L4'),
    textLine(308, 640, '151. Right column question stem?'),
    textLine(342, 625, '(A) R1'),
    textLine(342, 610, '(B) R2'),
    textLine(342, 595, '(C) R3'),
    textLine(342, 580, '(D) R4'),
  ];
  const page2 = [
    textLine(350, 680, '150'),
    textLine(418, 680, 'A'),
    textLine(350, 660, '151'),
    textLine(418, 660, 'C'),
  ];
  return wrapPdf([page1, page2]);
}

/** Full-width notice above dual-column Part 7 questions (email/regression). */
export function buildFullWidthPassageDualQuestionsPdf() {
  const page1 = [
    textLine(45, 720, 'Questions 196-200 refer to the following e-mail.'),
    textLine(45, 700, 'To: Staff'),
    textLine(45, 685, 'From: Director'),
    textLine(45, 670, 'Subject: Update'),
    textLine(45, 655, 'Please review the attached schedule before Friday.'),
    textLine(45, 620, '196. First question under email?'),
    textLine(74, 605, '(A) a1'),
    textLine(74, 590, '(B) a2'),
    textLine(74, 575, '(C) a3'),
    textLine(74, 560, '(D) a4'),
    textLine(308, 620, '197. Right column question?'),
    textLine(342, 605, '(A) b1'),
    textLine(342, 590, '(B) b2'),
    textLine(342, 575, '(C) b3'),
    textLine(342, 560, '(D) b4'),
  ];
  const page2 = [textLine(72, 700, '196: B'), textLine(72, 680, '197: D')];
  return wrapPdf([page1, page2]);
}

/** Passage on page 1; question header and items on page 2 (Cambridge-style). */
export function buildPreviousPageContextPdf() {
  const page1 = [
    textLine(72, 700, 'Skill Team article paragraph one.'),
    textLine(72, 680, 'David Storey continued the story here.'),
    textLine(72, 660, 'Paragraph mentions age 60. years of experience.'),
    textLine(72, 640, '60. An employee joined Skill Team at age fifty-five.'),
  ];
  const page2 = [
    textLine(72, 700, 'Questions 1-2'),
    textLine(72, 680, '1 What is the topic?'),
    textLine(90, 660, '(A) art'),
    textLine(90, 645, '(B) sport'),
    textLine(90, 630, '(C) music'),
    textLine(90, 615, '(D) food'),
    textLine(72, 590, '2 Who is named?'),
    textLine(90, 575, '(A) Anna'),
    textLine(90, 560, '(B) David Storey'),
    textLine(90, 545, '(C) Chen'),
    textLine(90, 530, '(D) Lee'),
  ];
  const page3 = [textLine(72, 700, '1: B'), textLine(72, 680, '2: B')];
  return wrapPdf([page1, page2, page3]);
}

/** Bare-number question labels (no dot) within declared range. */
export function buildBareNumberRangePdf() {
  const page1 = [
    textLine(72, 700, 'Questions 11-12'),
    textLine(72, 680, 'Article text for shared reading group.'),
    textLine(72, 640, '11 First bare-number stem?'),
    textLine(90, 625, '(A) a1'),
    textLine(90, 610, '(B) a2'),
    textLine(90, 595, '(C) a3'),
    textLine(90, 580, '(D) a4'),
    textLine(72, 555, '12 Second bare stem?'),
    textLine(90, 540, '(A) b1'),
    textLine(90, 525, '(B) b2'),
    textLine(90, 510, '(C) b3'),
    textLine(90, 495, '(D) b4'),
  ];
  const page2 = [textLine(72, 700, '11: C'), textLine(72, 680, '12: D')];
  return wrapPdf([page1, page2]);
}

/** Part 6-style gap markers in email body plus four real questions. */
export function buildPart6FourQuestionPdf() {
  const page1 = [
    textLine(52, 700, 'Questions 131-134 refer to the following e-mail.'),
    textLine(52, 670, 'Dear team, please note gap 131.'),
    textLine(52, 655, 'Another gap 132. in the letter body.'),
    textLine(52, 620, '131. (A) opt131a'),
    textLine(74, 605, '(B) opt131b'),
    textLine(74, 590, '(C) opt131c'),
    textLine(74, 575, '(D) opt131d'),
    textLine(52, 550, '132. (A) opt132a'),
    textLine(74, 535, '(B) opt132b'),
    textLine(74, 520, '(C) opt132c'),
    textLine(74, 505, '(D) opt132d'),
    textLine(52, 480, '133. (A) opt133a'),
    textLine(74, 465, '(B) opt133b'),
    textLine(74, 450, '(C) opt133c'),
    textLine(74, 435, '(D) opt133d'),
    textLine(52, 410, '134. (A) opt134a'),
    textLine(74, 395, '(B) opt134b'),
    textLine(74, 380, '(C) opt134c'),
    textLine(74, 365, '(D) opt134d'),
  ];
  const page2 = [
    textLine(72, 700, '131: C'),
    textLine(72, 680, '132: A'),
    textLine(72, 660, '133: D'),
    textLine(72, 640, '134: B'),
  ];
  return wrapPdf([page1, page2]);
}

/** Passage-only page with dotted 60. prose; next page declares Questions 1-4 (IELTS-style). */
export function buildProseSixtyNextPageRangeOneToFourPdf() {
  const page1 = [
    textLine(72, 700, 'Skill Team passage paragraph one.'),
    textLine(72, 680, 'IBM set up Skill Team for early retired staff.'),
    textLine(72, 660, '60. An employee joined Skill Team at age fifty-five.'),
    textLine(72, 640, 'David Storey studied older entrepreneurs.'),
  ];
  const page2 = [
    textLine(72, 700, 'Questions 1-4'),
    textLine(72, 680, '1 First question stem here?'),
    textLine(90, 665, '(A) opt1a'),
    textLine(90, 650, '(B) opt1b'),
    textLine(90, 635, '(C) opt1c'),
    textLine(90, 620, '(D) opt1d'),
    textLine(72, 595, '2 Second question stem here?'),
    textLine(90, 580, '(A) opt2a'),
    textLine(90, 565, '(B) opt2b'),
    textLine(90, 550, '(C) opt2c'),
    textLine(90, 535, '(D) opt2d'),
    textLine(72, 510, '3 Third question stem here?'),
    textLine(90, 495, '(A) opt3a'),
    textLine(90, 480, '(B) opt3b'),
    textLine(90, 465, '(C) opt3c'),
    textLine(90, 450, '(D) opt3d'),
    textLine(72, 425, '4 Fourth question stem here?'),
    textLine(90, 410, '(A) opt4a'),
    textLine(90, 395, '(B) opt4b'),
    textLine(90, 380, '(C) opt4c'),
    textLine(90, 365, '(D) opt4d'),
  ];
  const page3 = [
    textLine(72, 700, '1: A'),
    textLine(72, 680, '2: B'),
    textLine(72, 660, '3: C'),
    textLine(72, 640, '4: D'),
  ];
  return wrapPdf([page1, page2, page3]);
}

/** Cambridge-style 2x2 boxed options for one question (geometry regression). */
export function buildGridBoxOptionsQuestionPdf() {
  const page1 = [
    textLine(72, 700, 'Questions 15-15'),
    textLine(72, 680, 'Shared article paragraph for context.'),
    textLine(57, 328, '15'),
    textLine(83, 328, 'Which introduction fits this article?'),
    textLine(84, 298, 'A'),
    textLine(333, 298, 'B'),
    textLine(113, 282, 'Left option alpha text here.'),
    textLine(363, 282, 'Right option beta text here.'),
    textLine(113, 268, 'Left option alpha line two.'),
    textLine(363, 268, 'Right option beta line two.'),
    textLine(84, 199, 'C'),
    textLine(333, 199, 'D'),
    textLine(113, 182, 'Left option gamma text here.'),
    textLine(363, 182, 'Right option delta text here.'),
    textLine(72, 24, '7 Turn over'),
  ];
  const page2 = [textLine(72, 700, '15: B')];
  return wrapPdf([page1, page2]);
}

/** choose TWO instructions — unsupported reading task. */
export function buildChooseTwoUnsupportedPdf() {
  const page1 = [
    textLine(72, 700, 'Questions 20-21'),
    textLine(72, 680, 'Choose TWO letters, A-E.'),
    textLine(72, 660, 'Shared context paragraph for choose-two task.'),
  ];
  return wrapPdf([page1]);
}

/** Cambridge-style Reading Part 3 label must not trigger Listening skip. */
export function buildCambridgeReadingPart3Pdf() {
  const page1 = [
    textLine(72, 720, 'Part 3'),
    textLine(72, 700, 'Questions 19-20'),
    textLine(72, 680, 'You will read a short article about local transport.'),
    textLine(72, 660, 'The council published a summary last week.'),
    textLine(72, 620, '19. What is the article about?'),
    textLine(90, 605, '(A) buses'),
    textLine(90, 590, '(B) trains'),
    textLine(90, 575, '(C) bikes'),
    textLine(90, 560, '(D) taxis'),
    textLine(72, 535, '20. When was the summary published?'),
    textLine(90, 520, '(A) yesterday'),
    textLine(90, 505, '(B) last week'),
    textLine(90, 490, '(C) last month'),
    textLine(90, 475, '(D) last year'),
  ];
  const page2 = [textLine(72, 700, '19: A'), textLine(72, 680, '20: B')];
  return wrapPdf([page1, page2]);
}

/** Explicit LISTENING TEST header without readable items — warning only. */
export function buildExplicitListeningHeaderOnlyPdf() {
  const page1 = [
    textLine(52, 740, 'LISTENING TEST'),
    textLine(52, 720, 'PART 1'),
    textLine(52, 700, 'Directions: You will hear some questions. They will not be printed in your test book.'),
  ];
  return wrapPdf([page1]);
}

/** Listening PART 2 instruction bleed — must not become fake question 2. */
export function buildListeningPart2InstructionBleedPdf() {
  const page1 = [
    textLine(52, 740, 'LISTENING TEST'),
    textLine(52, 720, 'PART 2'),
    textLine(52, 700, 'PART 2 be printed in your test book and will be spoken only one time.'),
    textLine(52, 680, 'Select the best response to the question'),
    textLine(74, 660, '(C) on your answer sheet. PART 3 answer three questions'),
    textLine(74, 640, '(D) on your answer sheet. The conversations will not be printed'),
  ];
  const page2 = [
    textLine(52, 720, 'READING TEST'),
    textLine(52, 680, 'PART 5'),
    textLine(52, 640, '101. Valid reading item?'),
    textLine(74, 620, '(A) yes'),
    textLine(74, 600, '(B) no'),
    textLine(74, 580, '(C) maybe'),
    textLine(74, 560, '(D) never'),
  ];
  const page3 = [textLine(350, 680, '101'), textLine(418, 680, 'A')];
  return wrapPdf([page1, page2, page3]);
}

/**
 * Dual-column staggered stems (geometry like TOEIC page 19): split anchors,
 * continuation row before next left-column question.
 */
export function buildDualColumnStaggeredStemPdf() {
  const page1 = [
    textLine(45, 734, 'Questions 176-180 refer to the following advertisement and e-mail.'),
    textLine(44, 700, '176.'),
    textLine(71, 700, 'Why visit the demo site?'),
    textLine(307, 700, '179.'),
    textLine(334, 700, 'Which service is NOT offered?'),
    textLine(71, 680, '(A) To hear samples'),
    textLine(334, 680, '(A) Voice talent'),
    textLine(71, 660, '(B) To add a line'),
    textLine(334, 660, '(B) On-hold messages'),
    textLine(71, 640, '(C) To pay by card'),
    textLine(334, 640, '(C) Script writing'),
    textLine(71, 620, '(D) To request gear'),
    textLine(334, 620, '(D) Multilingual production'),
    textLine(307, 600, '180.'),
    textLine(334, 600, 'What will the client most likely do within'),
    textLine(44, 580, '177.'),
    textLine(71, 580, 'What is suggested about the vendor?'),
    textLine(334, 580, '24 hours?'),
    textLine(71, 560, '(A) Weekly orders'),
    textLine(334, 560, '(A) Meet an actor'),
    textLine(71, 540, '(B) Newspaper ads'),
    textLine(334, 540, '(B) Visit a studio'),
    textLine(71, 520, '(C) Data services'),
    textLine(334, 520, '(C) Write a script'),
    textLine(71, 500, '(D) Recent expansion'),
    textLine(334, 500, '(D) Speak with staff'),
    textLine(44, 480, '178.'),
    textLine(71, 480, 'Who most likely is the client?'),
    textLine(71, 460, '(A) An actor'),
    textLine(71, 440, '(B) A writer'),
    textLine(71, 420, '(C) A sales associate'),
    textLine(71, 400, '(D) A business owner'),
  ];
  const page2 = [
    textLine(350, 700, '176'),
    textLine(418, 700, 'A'),
    textLine(350, 680, '179'),
    textLine(418, 680, 'B'),
    textLine(350, 660, '180'),
    textLine(418, 660, 'D'),
    textLine(350, 640, '177'),
    textLine(418, 640, 'C'),
    textLine(350, 620, '178'),
    textLine(418, 620, 'A'),
  ];
  return wrapPdf([page1, page2]);
}

/** Text painted outside the visible MediaBox — operator list has showText but viewport is white. */
export function buildOffViewportTextOnlyPdf() {
  const page1 = [
    'BT /F1 12 Tf 1 0 0 1 -361 400 Tm () Tj ET',
  ];
  return wrapPdf([page1]);
}

/** Vector stroke outside the visible MediaBox — constructPath ops without visible ink. */
export function buildOffViewportPathOnlyPdf() {
  const page1 = [
    'q 1 w -200 700 m -50 700 l S Q',
  ];
  return wrapPdf([page1]);
}

/** Visible stroke inside the page — must remain OCR even with empty text layer. */
export function buildVisiblePathInkPdf() {
  const page1 = [
    'q 1 w 72 700 m 540 700 l S Q',
  ];
  return wrapPdf([page1]);
}

/**
 * Dual-column tail: left-column test-end directive must not block right-column questions;
 * trailing script/answer-key pages must not append to options.
 */
export function buildTrailingBackmatterDualColumnPdf() {
  const page1 = [
    textLine(45, 734, 'Questions 9-11 refer to the following memo.'),
    textLine(44, 700, '9. What is the topic?'),
    textLine(71, 700, '(A) Alpha topic'),
    textLine(71, 680, '(B) Beta topic'),
    textLine(71, 660, '(C) Gamma topic'),
    textLine(71, 640, '(D) Delta topic'),
    textLine(44, 620, '10. When is the deadline for the project?'),
    textLine(71, 600, '(A) Monday'),
    textLine(71, 580, '(B) Tuesday'),
  ];
  const page2 = [
    textLine(71, 700, '(C) Wednesday'),
    textLine(71, 680, '(D) Thursday exact'),
    textLine(44, 640, 'Stop! This is the end of the test.'),
    textLine(44, 620, 'NO TEST MATERIAL ON THIS PAGE'),
    textLine(44, 600, 'General Directions This test is designed to measure your English'),
    textLine(307, 700, '11. Which option is correct?'),
    textLine(334, 700, '(A) Wrong one'),
    textLine(334, 680, '(B) Also wrong'),
    textLine(334, 660, '(C) Still wrong'),
    textLine(334, 640, '(D) The instructions were too confusing.'),
  ];
  const page3 = [
    textLine(45, 734, 'TOEIC Sample Form Script - 99 -'),
    textLine(45, 710, 'SCRIPT FOR THE LISTENING COMPREHENSION SECTION'),
    textLine(45, 690, '(N) Questions 32 through 34 refer to the following conversation.'),
    textLine(45, 670, 'Sample Form Correct Answers'),
    textLine(45, 650, 'Item Number Key Item Number Key'),
    textLine(45, 630, '9 A 10 D 11 D'),
  ];
  const page4 = [
    textLine(350, 700, '9'),
    textLine(418, 700, 'A'),
    textLine(350, 680, '10'),
    textLine(418, 680, 'D'),
    textLine(350, 660, '11'),
    textLine(418, 660, 'D'),
  ];
  return wrapPdf([page1, page2, page3, page4]);
}

/**
 * Reading ends with test-end directive; following page is publisher back-cover prose only
 * (no question anchors) and must not append into passage bodies.
 */
export function buildTerminalBackcoverAfterTestEndPdf() {
  const page1 = [
    textLine(45, 734, 'Questions 1-2 refer to the following notice.'),
    textLine(44, 700, '1. What is announced?'),
    textLine(71, 700, '(A) Schedule change'),
    textLine(71, 680, '(B) Office closure'),
    textLine(71, 660, '(C) New policy'),
    textLine(71, 640, '(D) Holiday hours'),
    textLine(44, 610, '2. Who should readers contact?'),
    textLine(71, 590, '(A) HR'),
    textLine(71, 570, '(B) Reception'),
    textLine(71, 550, '(C) Manager'),
    textLine(71, 530, '(D) Security'),
  ];
  const page2 = [
    textLine(44, 700, 'Stop! This is the end of the test.'),
    textLine(44, 680, 'NO TEST MATERIAL ON THIS PAGE'),
  ];
  const page3 = [
    textLine(72, 720, 'International English assessment programs.'),
    textLine(72, 690, 'Visit our website for preparation materials and score reports.'),
    textLine(72, 660, 'Copyright notice. All rights reserved.'),
  ];
  return wrapPdf([page1, page2, page3]);
}

/** B1-style midterm: listening header must not poison vocabulary MCQs (16–20, 3 options). */
export function buildSchoolMidtermVocabularyPdf() {
  const page1 = [
    textLine(72, 740, 'LISTENING (25 MINUTES)'),
    textLine(72, 720, 'A. LISTENING COMPREHENSION (15 points)'),
    textLine(72, 700, 'Questions 1 - 9. Listen and choose the correct answer to complete'),
    textLine(72, 680, 'each sentence.'),
    textLine(81, 660, '1. Wale comes from _________.'),
    textLine(126, 640, 'A. the United States'),
    textLine(126, 620, 'B. Wales'),
    textLine(126, 600, 'C. Nigeria'),
  ];
  const page2 = [
    textLine(72, 740, 'B. VOCABULARY (10 points)'),
    textLine(72, 720, 'Questions 16 - 20. Choose the correct answer that best completes'),
    textLine(72, 700, 'each sentence.'),
    textLine(81, 680, '16. Examples of public transportation are _________'),
    textLine(126, 660, 'A. buses and trains.'),
    textLine(126, 640, 'B. cars and trucks.'),
    textLine(126, 620, 'C. airplanes and motorcycles.'),
    textLine(81, 600, '17. Power is what we get from _________'),
    textLine(126, 580, 'A. electricity and gas.'),
    textLine(126, 560, 'B. traffic.'),
    textLine(126, 540, 'C. pollution.'),
  ];
  return wrapPdf([page1, page2]);
}

/** Grade 7 outline: Ex1 stress items + inline A–D options, scoped numbering per exercise. */
export function buildGrade7ExerciseScopedPdf() {
  const page1 = [
    textLine(72, 740, 'II. GRAMMAR:'),
    textLine(72, 720, '*Cách dùng'),
    textLine(72, 700, 'Ex: We go to school everyday.'),
    textLine(72, 660, 'IV. EXERCISES'),
    textLine(72, 640, 'Ex1. Choose the word (A, B, C or D) whose stress is different from the others.'),
    textLine(81, 620, '1. A. dollhouse B. affect C. jogging D. patient'),
    textLine(81, 600, '2. A. dirty B. active C. avoid D. outdoor'),
    textLine(72, 570, 'Ex2. Choose the word (A, B, C or D) with a different pronunciation.'),
    textLine(81, 550, '1. A. chemistry B. school C. character D. chorus'),
    textLine(81, 530, '2. A. game B. gather C. garden D. guess'),
  ];
  return wrapPdf([page1]);
}

/** Grammar revision theory page must not become fake MCQ. */
export function buildGrammarTheoryOutlinePdf() {
  const page1 = [
    textLine(72, 740, 'II. GRAMMAR:'),
    textLine(72, 720, 'POSSESSIVE PRONOUNS (page 88)'),
    textLine(72, 700, 'Example: It is mine (it is my shirt).'),
    textLine(72, 680, 'Grammar - Ngữ pháp Example : The girl who dances on the stage is my sister.'),
    textLine(72, 660, '1. PAST CONTINUOUS (Page 102) that happened at a specific time in the past.'),
  ];
  const page2 = [
    textLine(72, 720, 'Exercises'),
    textLine(72, 700, 'Unit 8: Celebrations Vocabulary pages 106, 111'),
  ];
  return wrapPdf([page1, page2]);
}

/** Grade 7 pattern: undotted numbered row (`5 A. leaf B. favourite…`) is its own question. */
export function buildGrade7UndottedInlineRowPdf() {
  const page1 = [
    textLine(72, 660, 'IV. EXERCISES'),
    textLine(72, 640, 'Ex2. Choose the word whose underlined part is pronounced differently from the others.'),
    textLine(81, 620, '4. A. verb B. herb C. never D. person'),
    textLine(81, 600, '5 A. leaf B. favourite C. farm D. of'),
    textLine(81, 580, '6. A. orphanage B. patient C. agree D. about'),
  ];
  return wrapPdf([page1]);
}

/** Sample test header must not reuse prior ex10 instruction stems. */
export function buildSampleTestResetsExerciseScopePdf() {
  const page1 = [
    textLine(72, 720, 'Ex10. Reading signs'),
    textLine(81, 700, '1. Look at the sign. Choose the best answer.'),
    textLine(126, 680, 'A. Stop here'),
    textLine(126, 660, 'B. Turn left'),
    textLine(126, 640, 'C. No parking'),
    textLine(126, 620, 'D. Exit only'),
    textLine(72, 590, 'SAMPLE TEST 1'),
    textLine(
      72,
      575,
      'Mark the letter A, B, C or D on your answer sheet to indicate the word whose underlined part differs',
    ),
    textLine(72, 560, 'from the other three in pronunciation in each of the following questions.'),
    textLine(81, 540, 'Question 1. A. enough B. light C. bright D. sight'),
  ];
  return wrapPdf([page1]);
}

/** Theory prose prefixed before exercises must not steal ex3 MCQs via pending-context prose routing. */
export function buildGrade7Ex3AfterTheoryProsePdf() {
  const page1 = [
    textLine(72, 740, 'Phân biệt âm /f/ và âm /v/: đặt một mảnh giấy trước miệng khi phát âm.'),
    textLine(72, 660, 'IV. EXERCISES'),
    textLine(72, 640, 'Ex2. Choose pronunciation items.'),
    textLine(81, 620, '10. A. eat B. head C. dead D. bread'),
    textLine(72, 590, 'Ex3. Choose the best word or phrase (A, B, C or D) to complete each sentence.'),
    textLine(81, 570, '1. The train usually __________ in Ha Noi at 8 a.m.'),
    textLine(64, 550, 'A. arrive B. will arrive C. arrives D. is arriving'),
    textLine(81, 530, '4. We should follow the advice from doctors and health _________ in order to keep fit.'),
  ];
  const page2 = [
    textLine(50, 730, 'A. people B. workers C. managers D. experts'),
  ];
  return wrapPdf([page1, page2]);
}

export function buildGrade7Ex5ClozeSuriPdf() {
  const page1 = [
    textLine(72, 700, 'Ex5. Read the passage and choose the correct answer (A, B, C or D) to fill in the blanks.'),
    textLine(72, 680, "My cousin's name is Suri. She loves drawing and (1) __________ paper flowers."),
    textLine(72, 660, 'Sometimes she (2) __________ these hobbies with me.'),
    textLine(81, 640, '1. A. making B. makes C. made D. is making'),
    textLine(81, 620, '2. A. gets B. has C. shares D. gives'),
  ];
  return wrapPdf([page1]);
}

export function buildRevisionHaveEverTheoryPdf() {
  const page1 = [
    textLine(231, 740, 'Grammar - Ngữ pháp'),
    textLine(126, 720, '1. HAVE + EVER + simple past'),
    textLine(108, 700, 'Use Have + ever + simple past … ? to ask if people tried different things in the past.'),
    textLine(108, 680, 'Have + ever + simple past..? Yes, I have. No, I haven\'t.'),
  ];
  return wrapPdf([page1]);
}

export function buildSentenceOrderingLowercaseStemPdf() {
  const page1 = [
    textLine(72, 660, 'SAMPLE TEST 1'),
    textLine(
      72,
      640,
      'Question 18. Put the sentences (a-c) in the correct order, then fill in the blank to make a logical text.',
    ),
    textLine(72, 620, 'a. It also helps us feel more energetic and sleep better.'),
    textLine(72, 600, 'b. You do not need to go to the gym – walking is enough.'),
    textLine(72, 580, 'c. Secondly, exercise keeps our heart healthy.'),
    textLine(72, 560, 'A. b-a-c B. c-b-a C. a-c-b D. c-a-b'),
  ];
  return wrapPdf([page1]);
}

export function buildHealthyDietMismatchedDeclaredRangePdf() {
  const page1 = [
    textLine(72, 720, 'IV. EXERCISES'),
    textLine(72, 700, 'Ex10. Exercise header (passage line follows).'),
    textLine(72, 685, 'Read the following passage and choose the correct answer from 31 to 36.'),
    textLine(72, 670, 'HEALTHY DIET'),
    textLine(72, 655, 'There are two important matters in eating. First is eating enough food.'),
    textLine(81, 620, '27. How many important matters do we need to care in eating?'),
    textLine(126, 600, 'A. One'),
    textLine(126, 580, 'B. Two'),
    textLine(126, 560, 'C. Three'),
    textLine(126, 540, 'D. Four'),
    textLine(81, 500, '28. Which matters are important?'),
    textLine(126, 480, 'A. Sleeping'),
    textLine(126, 460, 'B. Writing'),
    textLine(126, 440, 'C. Reading'),
    textLine(126, 420, 'D. Drawing'),
    textLine(81, 380, '29. What do we need for enough food?'),
    textLine(126, 360, 'A. The right amount'),
    textLine(126, 340, 'B. The right type'),
    textLine(126, 320, 'C. The right time'),
    textLine(126, 300, 'D. The right amount and type'),
    textLine(72, 260, 'Questions 30 - 34. Complete the sentences using NO MORE THAN TWO WORDS.'),
  ];
  return wrapPdf([page1]);
}

export function buildGrade7Ex5MultiWordInlineOptionPdf() {
  const page1 = [
    textLine(72, 700, 'Ex5. Read the passage and choose the correct answer (A, B, C or D) to fill in the blanks.'),
    textLine(72, 680, "My cousin's name is Suri. She loves drawing and (1) __________ paper flowers."),
    textLine(81, 640, '1. A. making B. makes C. made D. is making'),
    textLine(81, 620, '2. A. gets B. has C. shares D. gives'),
  ];
  return wrapPdf([page1]);
}

export function buildHealthyDietPassageBindingPdf() {
  const page1 = [
    textLine(72, 720, 'IV. EXERCISES'),
    textLine(72, 700, 'Ex10. Read the passage and choose the correct answer (A, B, C or D) to fill in the blanks.'),
    textLine(72, 680, 'HEALTHY DIET'),
    textLine(72, 660, 'There are two important matters in eating. First is eating enough food.'),
    textLine(72, 640, 'Questions 27 - 29. Choose the correct answer.'),
    textLine(81, 620, '27. How many important matters do we need to care in eating?'),
    textLine(126, 600, 'A. One'),
    textLine(126, 580, 'B. Two'),
    textLine(126, 560, 'C. Three'),
    textLine(126, 540, 'D. Four'),
    textLine(81, 500, '28. Which matters are important?'),
    textLine(126, 480, 'A. Sleeping'),
    textLine(126, 460, 'B. Writing'),
    textLine(126, 440, 'C. Reading'),
    textLine(126, 420, 'D. Drawing'),
    textLine(81, 380, '29. What do we need for enough food?'),
    textLine(126, 360, 'A. The right amount'),
    textLine(126, 340, 'B. The right type'),
    textLine(126, 320, 'C. The right time'),
    textLine(126, 300, 'D. The right amount and type'),
    textLine(72, 260, 'Questions 30 - 34. Complete the sentences using NO MORE THAN TWO WORDS.'),
    textLine(81, 240, '30. The first writing task should not appear in the diet passage.'),
  ];
  return wrapPdf([page1]);
}

export function buildUnsupportedGapFillBlockPdf() {
  const page1 = [
    textLine(72, 700, 'Questions 21 - 25. Complete the paragraph with the words in the'),
    textLine(72, 680, 'box. There is one extra word that you do not need.'),
    textLine(81, 660, '21. There is a beautiful metal ____________________ of a soldier.'),
  ];
  return wrapPdf([page1]);
}

/** Orphan passage from unsupported gap-fill must not remain after school output filter. */
export function buildSchoolOrphanUnsupportedPassagePdf() {
  const page1 = [
    textLine(72, 720, 'Questions 21 - 25. Complete the sentences using NO MORE THAN TWO WORDS.'),
    textLine(72, 700, 'box. There is one extra word that you do not need.'),
    textLine(72, 680, '21. Orphan passage body that must not block publish.'),
    textLine(72, 640, 'IV. EXERCISES'),
    textLine(
      72,
      620,
      'Ex1. Choose the word (A, B, C or D) whose underlined part is pronounced differently from the others.',
    ),
    textLine(81, 600, '1. A. alpha B. beta C. gamma D. delta'),
    textLine(81, 580, '2. A. north B. south C. east D. west'),
  ];
  return wrapPdf([page1]);
}

/** Grade 7: message MCQ without readable message body (image-only in real PDF). */
export function buildSchoolMessageVisualContextMissingPdf() {
  const page1 = [
    textLine(72, 720, 'IV. EXERCISES'),
    textLine(72, 700, 'Ex10. Read the following message and choose the best answer (A, B, C or D).'),
    textLine(81, 660, '2. What does Paul request from Alice in his message?'),
    textLine(126, 640, 'A. help'),
    textLine(126, 620, 'B. money'),
    textLine(126, 600, 'C. food'),
    textLine(126, 580, 'D. book'),
  ];
  return wrapPdf([page1]);
}

/** Grade 7: same stem with extracted message text as digital context. */
export function buildSchoolMessageVisualContextWithTextPdf() {
  const page1 = [
    textLine(72, 720, 'IV. EXERCISES'),
    textLine(72, 700, 'Ex10. Read the following message from 1 to 1 and choose the best answer.'),
    textLine(72, 680, 'From: Paul'),
    textLine(72, 660, 'To: Alice'),
    textLine(72, 640, 'Please bring my English book to class tomorrow morning. Thank you.'),
    textLine(81, 600, '1. What does Paul request from Alice in his message?'),
    textLine(126, 580, 'A. help'),
    textLine(126, 560, 'B. money'),
    textLine(126, 540, 'C. bring his book'),
    textLine(126, 520, 'D. food'),
  ];
  return wrapPdf([page1]);
}

/** Sample test: wrapped Mark header opens cloze group 17-18 after announcement 13-16. */
export function buildSampleTestMarkWrappedCloze1718Pdf() {
  const page1 = [
    textLine(72, 760, 'SAMPLE TEST 1'),
    textLine(72, 740, 'Read the following announcement and choose the correct answer.'),
    textLine(72, 720, 'SCHOOL HEALTH WEEK'),
    textLine(72, 700, 'Join us for activities about healthy eating and exercise.'),
    textLine(81, 660, '13. What is the announcement about?'),
    textLine(126, 640, 'A. Sports'),
    textLine(126, 620, 'B. Health'),
    textLine(126, 600, 'C. Music'),
    textLine(126, 580, 'D. Art'),
    textLine(
      72,
      540,
      'Mark the letter A, B, C or D on your answer sheet to indicate the correct answer to each of the',
    ),
    textLine(72, 520, 'following questions 17 to 18.'),
    textLine(
      72,
      500,
      '(17) ________ It helps us stay strong and avoid illness. (18) ________ So, doing regular exercise is a',
    ),
    textLine(72, 480, 'good habit.'),
    textLine(81, 440, '17. Choose the best answer for blank (17).'),
    textLine(126, 420, 'A. Exercise'),
    textLine(126, 400, 'B. Food'),
    textLine(126, 380, 'C. Water'),
    textLine(126, 360, 'D. Music'),
    textLine(81, 320, '18. Choose the best answer for blank (18).'),
    textLine(126, 300, 'A. Therefore'),
    textLine(126, 280, 'B. However'),
    textLine(126, 260, 'C. Moreover'),
    textLine(126, 240, 'D. Otherwise'),
    textLine(72, 200, 'Questions 19 - 24. Read the following passage and choose the correct answer.'),
    textLine(72, 180, 'Most students need eight to ten hours of sleep each night.'),
    textLine(81, 140, '19. How many hours of sleep are recommended?'),
    textLine(126, 120, 'A. Six'),
    textLine(126, 100, 'B. Eight to ten'),
    textLine(126, 80, 'C. Twelve'),
    textLine(126, 60, 'D. Fourteen'),
  ];
  return wrapPdf([page1]);
}

/**
 * Sample test cloze 17-18: passage carries blank markers; question rows keep explicit
 * TOPIC SENTENCE / Put-the-sentences instructions (content-isolated-5 regression).
 */
export function buildSampleTestExplicitStemCloze1718Pdf() {
  const page1 = [
    textLine(72, 760, 'SAMPLE TEST 1'),
    textLine(
      72,
      540,
      'Mark the letter A, B, C or D on your answer sheet to indicate the correct answer to each of the',
    ),
    textLine(72, 520, 'following questions 17 to 18.'),
    textLine(
      72,
      500,
      '(17) ________ It helps us stay strong and avoid illness. (18) ________ So, doing regular exercise is a',
    ),
    textLine(72, 480, 'good habit.'),
    textLine(
      81,
      440,
      '17. Choose the TOPIC SENTENCE that can BEGIN the text most appropriately.',
    ),
    textLine(126, 420, 'A. Exercise'),
    textLine(126, 400, 'B. Food'),
    textLine(126, 380, 'C. Water'),
    textLine(126, 360, 'D. Music'),
    textLine(
      81,
      320,
      '18. Put the sentences (a-c) in the correct order, then fill in the blank to make a logical text.',
    ),
    textLine(81, 300, 'a. It also helps us feel more energetic and sleep better.'),
    textLine(81, 280, 'b. You do not need to go to the gym – walking is enough.'),
    textLine(81, 260, 'c. Secondly, exercise keeps our heart healthy.'),
    textLine(81, 240, 'A. b-a-c B. c-b-a C. a-c-b D. c-a-b'),
  ];
  return wrapPdf([page1]);
}

/** Sample test: adjacent reading groups (announcement, cloze 17-18, passage 19+). */
export function buildSampleTestAdjacentReadGroupsPdf() {
  const page1 = [
    textLine(72, 740, 'SAMPLE TEST 1'),
    textLine(72, 720, 'Read the following announcement and choose the correct answer.'),
    textLine(72, 700, 'SCHOOL HEALTH WEEK'),
    textLine(72, 680, 'Join us for activities about healthy eating and exercise.'),
    textLine(81, 640, '13. What is the announcement about?'),
    textLine(126, 620, 'A. Sports'),
    textLine(126, 600, 'B. Health'),
    textLine(126, 580, 'C. Music'),
    textLine(126, 560, 'D. Art'),
    textLine(72, 520, 'Questions 17 - 18. Choose the correct answer.'),
    textLine(72, 500, '(17)____ It helps us stay strong and avoid illness. (18)____ So we need to rest.'),
    textLine(81, 460, '17. Choose the best answer for blank (17).'),
    textLine(126, 440, 'A. Sleep'),
    textLine(126, 420, 'B. Food'),
    textLine(126, 400, 'C. Water'),
    textLine(126, 380, 'D. Music'),
    textLine(81, 340, '18. Choose the best answer for blank (18).'),
    textLine(126, 320, 'A. Therefore'),
    textLine(126, 300, 'B. However'),
    textLine(126, 280, 'C. Moreover'),
    textLine(126, 260, 'D. Otherwise'),
    textLine(72, 220, 'Questions 19 - 24. Read the following passage and choose the correct answer.'),
    textLine(72, 200, 'Most students need eight to ten hours of sleep each night.'),
    textLine(81, 160, '19. How many hours of sleep are recommended?'),
    textLine(126, 140, 'A. Six'),
    textLine(126, 120, 'B. Eight to ten'),
    textLine(126, 100, 'C. Twelve'),
    textLine(126, 80, 'D. Fourteen'),
  ];
  return wrapPdf([page1]);
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
